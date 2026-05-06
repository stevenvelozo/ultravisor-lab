/**
 * Service-StackInitializer
 *
 * Runs a stack's `InitOperation` against its newly-launched Ultravisor.
 * Called by Lab-Api-Stacks after a successful StackLifecycle.up — the stack
 * is now running but unconfigured; this service drives the configuration
 * via an operation graph that ultravisor manifests, audits, and replays.
 *
 * Stack spec extension:
 *   "InitOperation":
 *   {
 *       "OperationHash":  "op-foo-init",                     // looked up via OperationStore
 *       "UltravisorURL":  "http://127.0.0.1:${input.UVPort}", // host-side URL to the stack's UV
 *       "Settings":       { ...arbitrary key/value bag... }   // available to graph nodes via ${input.<key>} substitution
 *   }
 *
 * After StackLifecycle.up:
 *   1. Resolve spec with input values (StackResolver) so all ${} refs are
 *      already substituted in InitOperation.UltravisorURL etc.
 *   2. Wait for the resolved UltravisorURL/status to respond.
 *   3. Load operation graph from OperationStore by OperationHash.
 *   4. Substitute ${input.X} / ${component.Y.host} placeholders inside the
 *      graph (same shape StackResolver supports — applied here so node
 *      Data fields can reference stack inputs without ultravisor needing
 *      to know about lab variables).
 *   5. Re-hash the substituted graph with `op-<original>-<stackhash>` so
 *      multiple stacks can run "the same" init op without colliding inside
 *      a shared UV.
 *   6. POST /Operation (upsert into UV's HypervisorState).
 *   7. POST /Operation/:Hash/Execute/Async with Settings as initial state.
 *   8. Poll /Manifest/:RunHash until terminal (Complete / Failed / Error).
 *   9. Persist the init result to ${DataDir}/stacks/<stackhash>/init-state.json
 *      so the API can surface it after process restarts.
 *
 * Public API (callback-based):
 *   run(pStackHash, pInputValues, fCallback)        — execute steps 1-9
 *   getResult(pStackHash)                            — read persisted init state JSON or null
 *
 * The runtime never throws into the StackLifecycle.up callback — Init is
 * a follow-on phase the lab tracks separately, so an init failure leaves
 * the stack "running but uninitialized" and the operator can retry.
 */

'use strict';

const libPath = require('path');
const libFs = require('fs');
const libHttp = require('http');
const libHttps = require('https');
const libUrl = require('url');
const libCrypto = require('crypto');
const libFableServiceProviderBase = require('fable-serviceproviderbase');

const DEFAULT_READY_TIMEOUT_MS = 60000;
const DEFAULT_RUN_TIMEOUT_MS = 300000;
const DEFAULT_POLL_INTERVAL_MS = 1000;

class ServiceStackInitializer extends libFableServiceProviderBase
{
	constructor(pFable, pOptions, pServiceHash)
	{
		super(pFable, pOptions, pServiceHash);
		this.serviceType = 'LabStackInitializer';

		this._DataDir = (pOptions && pOptions.DataDir)
			|| (this.fable.settings && this.fable.settings.LabDataDir)
			|| libPath.resolve(__dirname, '..', '..', 'data');
		this._StacksDir = libPath.join(this._DataDir, 'stacks');

		this._ReadyTimeoutMs = (pOptions && pOptions.ReadyTimeoutMs) || DEFAULT_READY_TIMEOUT_MS;
		this._RunTimeoutMs   = (pOptions && pOptions.RunTimeoutMs)   || DEFAULT_RUN_TIMEOUT_MS;
		this._PollIntervalMs = (pOptions && pOptions.PollIntervalMs) || DEFAULT_POLL_INTERVAL_MS;

		// Per-stack-hash set of init runs currently mid-flight. run() rejects
		// a second concurrent call for the same hash so a double-clicked
		// Launch (which schedules init via setImmediate) doesn't push the
		// same operation graph twice — most beacon /connection-style endpoints
		// are CREATE not UPSERT, and a duplicate run would leave duplicate
		// connections behind.
		this._RunInFlight = new Set();
	}

	// ====================================================================
	// Public API
	// ====================================================================

	run(pStackHash, pInputValues, fCallback)
	{
		// Reject a second concurrent run() for the same stack. The route layer
		// turns this into a 409 so the client can render a friendly toast.
		if (this._RunInFlight.has(pStackHash))
		{
			let tmpInflight = this._buildResult(pStackHash, 'already-running', null, null, 'An init run is already in flight for this stack.');
			return fCallback(null, tmpInflight);
		}
		this._RunInFlight.add(pStackHash);

		// Wrap fCallback so every exit path clears the in-flight marker.
		let tmpDoneOnce = false;
		let tmpSelf = this;
		let tmpDone = (pErr, pResult) =>
		{
			if (tmpDoneOnce) return;
			tmpDoneOnce = true;
			tmpSelf._RunInFlight.delete(pStackHash);
			fCallback(pErr, pResult);
		};
		fCallback = tmpDone;

		let tmpStore     = this._svc('LabStackStore');
		let tmpResolver  = this._svc('LabStackResolver');
		let tmpOpStore   = this._svc('LabOperationStore');
		if (!tmpStore || !tmpResolver || !tmpOpStore)
		{
			return fCallback(new Error('StackInitializer: required services missing (LabStackStore / LabStackResolver / LabOperationStore).'));
		}

		let tmpStack = tmpStore.getByHash(pStackHash);
		if (!tmpStack)
		{
			return fCallback(new Error(`StackInitializer: stack [${pStackHash}] not found.`));
		}

		let tmpSpec = tmpStack.Spec || tmpStack.spec || null;
		if (!tmpSpec)
		{
			return fCallback(new Error(`StackInitializer: stack [${pStackHash}] missing parsed Spec.`));
		}

		if (!tmpSpec.InitOperation)
		{
			// Not an error — many stacks don't need init. Persist a "skipped"
			// marker so the API can surface it cleanly.
			let tmpSkipped = this._buildResult(pStackHash, 'skipped', null, null, 'No InitOperation declared on stack spec.');
			this._persistResult(pStackHash, tmpSkipped);
			return fCallback(null, tmpSkipped);
		}

		let tmpInputValues = pInputValues || (tmpStack.InputValues || {});
		let tmpResolved;
		try
		{
			tmpResolved = tmpResolver.resolve(tmpSpec, tmpInputValues, process.env);
		}
		catch (pError)
		{
			let tmpFailed = this._buildResult(pStackHash, 'error', null, null, `Spec resolution failed: ${pError.message}`);
			this._persistResult(pStackHash, tmpFailed);
			return fCallback(pError, tmpFailed);
		}

		let tmpInitSpec = tmpResolved.Spec.InitOperation || {};
		let tmpUVUrl = tmpInitSpec.UltravisorURL;
		let tmpOpHash = tmpInitSpec.OperationHash;
		let tmpInitSettings = tmpInitSpec.Settings || {};

		if (!tmpUVUrl || !tmpOpHash)
		{
			return fCallback(new Error('StackInitializer: InitOperation must declare both UltravisorURL and OperationHash.'));
		}

		let tmpOperation = tmpOpStore.getByHash(tmpOpHash);
		if (!tmpOperation)
		{
			let tmpMissing = this._buildResult(pStackHash, 'error', tmpOpHash, null, `Operation [${tmpOpHash}] not found in OperationStore (check AdditionalOperationDirs registration).`);
			this._persistResult(pStackHash, tmpMissing);
			return fCallback(new Error(tmpMissing.Message), tmpMissing);
		}

		// Walk the operation graph and substitute the same input/component
		// references the resolver applied to the rest of the spec. The
		// graph is a JSON tree; reuse the resolver's _walk via a tiny shim
		// (we don't have direct access — clone + manual walk).
		let tmpOpClone = JSON.parse(JSON.stringify(tmpOperation));
		this._substituteRefs(tmpOpClone, tmpResolved.Inputs, tmpResolved.Components, process.env);

		// Stack-scoped op hash so two stacks with the same op don't collide.
		let tmpOriginalHash = tmpOpClone.Hash;
		let tmpScopedHash = `${tmpOriginalHash}-${this._shortHash(pStackHash)}`;
		tmpOpClone.Hash = tmpScopedHash;

		// Bake init settings into the operation's InitialOperationState so
		// the engine seeds them before the first node runs. The singular
		// /Operation/:Hash/Execute/Async route does not honor a body-level
		// OperationState, only RunMode — InitialOperationState on the
		// operation definition itself is the dependable seeding path.
		let tmpExistingInitial = (tmpOpClone.InitialOperationState && typeof tmpOpClone.InitialOperationState === 'object') ? tmpOpClone.InitialOperationState : {};
		tmpOpClone.InitialOperationState = Object.assign({}, tmpExistingInitial, tmpInitSettings);

		let tmpStarted = new Date().toISOString();
		this.fable.log.info(`StackInitializer[${pStackHash}]: pushing op [${tmpScopedHash}] to ${tmpUVUrl}...`);

		this._waitForReady(tmpUVUrl, this._ReadyTimeoutMs, (pReadyError) =>
		{
			if (pReadyError)
			{
				let tmpFailed = this._buildResult(pStackHash, 'failed', tmpScopedHash, null, `Ultravisor not reachable at ${tmpUVUrl} within ${this._ReadyTimeoutMs}ms: ${pReadyError.message}`, tmpStarted);
				this._persistResult(pStackHash, tmpFailed);
				return fCallback(pReadyError, tmpFailed);
			}

			this._pushOperation(tmpUVUrl, tmpOpClone, (pPushError) =>
			{
				if (pPushError)
				{
					let tmpFailed = this._buildResult(pStackHash, 'failed', tmpScopedHash, null, `Operation push failed: ${pPushError.message}`, tmpStarted);
					this._persistResult(pStackHash, tmpFailed);
					return fCallback(pPushError, tmpFailed);
				}

				this._executeAsync(tmpUVUrl, tmpScopedHash, tmpInitSettings, (pExecError, pRunHash) =>
				{
					if (pExecError)
					{
						let tmpFailed = this._buildResult(pStackHash, 'failed', tmpScopedHash, null, `Operation kick failed: ${pExecError.message}`, tmpStarted);
						this._persistResult(pStackHash, tmpFailed);
						return fCallback(pExecError, tmpFailed);
					}

					this._pollManifest(tmpUVUrl, pRunHash, this._RunTimeoutMs, (pPollError, pManifest) =>
					{
						let tmpCompleted = new Date().toISOString();
						if (pPollError)
						{
							let tmpFailed = this._buildResult(pStackHash, 'failed', tmpScopedHash, pRunHash, `Operation polling failed: ${pPollError.message}`, tmpStarted, tmpCompleted, pManifest);
							this._persistResult(pStackHash, tmpFailed);
							return fCallback(pPollError, tmpFailed);
						}
						let tmpStatus = (pManifest && pManifest.Status) || 'unknown';
						let tmpPhase = (tmpStatus === 'Complete' || tmpStatus === 'Completed') ? 'completed' : 'failed';
						let tmpResult = this._buildResult(pStackHash, tmpPhase, tmpScopedHash, pRunHash, `Operation finished with Status=${tmpStatus}`, tmpStarted, tmpCompleted, pManifest);
						this._persistResult(pStackHash, tmpResult);
						this.fable.log.info(`StackInitializer[${pStackHash}]: ${tmpPhase} (run ${pRunHash}, status ${tmpStatus}).`);
						return fCallback(null, tmpResult);
					});
				});
			});
		});
	}

	getResult(pStackHash)
	{
		let tmpPath = this._resultPath(pStackHash);
		if (!libFs.existsSync(tmpPath)) return null;
		try { return JSON.parse(libFs.readFileSync(tmpPath, 'utf8')); }
		catch (pErr) { return null; }
	}

	// ====================================================================
	// Internals
	// ====================================================================

	_svc(pName)
	{
		let tmpMap = this.fable.servicesMap && this.fable.servicesMap[pName];
		if (!tmpMap) return null;
		return Object.values(tmpMap)[0] || null;
	}

	_buildResult(pStackHash, pPhase, pOperationHash, pRunHash, pMessage, pStartedAt, pCompletedAt, pManifest)
	{
		return {
			StackHash:     pStackHash,
			Phase:         pPhase, // 'skipped' | 'running' | 'completed' | 'failed' | 'error'
			OperationHash: pOperationHash || null,
			RunHash:       pRunHash || null,
			Message:       pMessage || '',
			StartedAt:     pStartedAt || null,
			CompletedAt:   pCompletedAt || null,
			Manifest:      pManifest || null
		};
	}

	_resultPath(pStackHash)
	{
		return libPath.join(this._StacksDir, pStackHash, 'init-state.json');
	}

	_persistResult(pStackHash, pResult)
	{
		try
		{
			let tmpDir = libPath.join(this._StacksDir, pStackHash);
			libFs.mkdirSync(tmpDir, { recursive: true });
			libFs.writeFileSync(this._resultPath(pStackHash), JSON.stringify(pResult, null, 2));
		}
		catch (pErr)
		{
			this.fable.log.warn(`StackInitializer[${pStackHash}]: persist failed: ${pErr.message}`);
		}
	}

	_shortHash(pStackHash)
	{
		return libCrypto.createHash('sha1').update(String(pStackHash)).digest('hex').substring(0, 8);
	}

	_substituteRefs(pNode, pInputs, pComponents, pEnv)
	{
		// Walk the operation graph and apply the same ${input.X},
		// ${component.Y.host|port|containerName}, ${env.VAR} substitution
		// pattern Service-StackResolver does. We deliberately reimplement
		// here (small surface) rather than re-export the resolver's
		// internals, to keep the resolver's public API compact.
		if (pNode === null || pNode === undefined) return;
		if (typeof pNode === 'string') return; // strings handled by parent assignment
		if (Array.isArray(pNode))
		{
			for (let i = 0; i < pNode.length; i++)
			{
				if (typeof pNode[i] === 'string')
				{
					pNode[i] = this._substituteString(pNode[i], pInputs, pComponents, pEnv);
				}
				else
				{
					this._substituteRefs(pNode[i], pInputs, pComponents, pEnv);
				}
			}
			return;
		}
		if (typeof pNode === 'object')
		{
			let tmpKeys = Object.keys(pNode);
			for (let i = 0; i < tmpKeys.length; i++)
			{
				let tmpV = pNode[tmpKeys[i]];
				if (typeof tmpV === 'string')
				{
					pNode[tmpKeys[i]] = this._substituteString(tmpV, pInputs, pComponents, pEnv);
				}
				else
				{
					this._substituteRefs(tmpV, pInputs, pComponents, pEnv);
				}
			}
		}
	}

	_substituteString(pStr, pInputs, pComponents, pEnv)
	{
		return pStr.replace(/\$\{([^}]+)\}/g, (pMatch, pRef) =>
		{
			let tmpRef = pRef.trim();
			if (tmpRef.indexOf('input.') === 0)
			{
				let tmpName = tmpRef.substring(6);
				return (pInputs && pInputs[tmpName] !== undefined) ? String(pInputs[tmpName]) : '';
			}
			if (tmpRef.indexOf('component.') === 0)
			{
				let tmpRest = tmpRef.substring(10);
				let tmpDot = tmpRest.indexOf('.');
				if (tmpDot < 0) return '';
				let tmpHash = tmpRest.substring(0, tmpDot);
				let tmpAttr = tmpRest.substring(tmpDot + 1);
				let tmpC = pComponents && pComponents[tmpHash];
				if (!tmpC) return '';
				return (tmpC[tmpAttr] !== undefined) ? String(tmpC[tmpAttr]) : '';
			}
			if (tmpRef.indexOf('env.') === 0)
			{
				let tmpName = tmpRef.substring(4);
				return (pEnv && pEnv[tmpName] !== undefined) ? String(pEnv[tmpName]) : '';
			}
			// Unknown — leave intact for visibility in logs.
			return pMatch;
		});
	}

	_waitForReady(pUVUrl, pTimeoutMs, fCallback)
	{
		let tmpDeadline = Date.now() + pTimeoutMs;
		let tmpStatusUrl = pUVUrl.replace(/\/+$/, '') + '/status';
		let tmpTry = () =>
		{
			this._httpRequest({ method: 'GET', url: tmpStatusUrl, timeoutMs: 1500 }, null, (pError, pStatus) =>
			{
				if (!pError && pStatus >= 200 && pStatus < 500) return fCallback(null);
				if (Date.now() >= tmpDeadline) return fCallback(new Error(pError ? pError.message : `last status ${pStatus}`));
				setTimeout(tmpTry, 500);
			});
		};
		tmpTry();
	}

	_pushOperation(pUVUrl, pOperation, fCallback)
	{
		let tmpUrl = pUVUrl.replace(/\/+$/, '') + '/Operation';
		this._httpRequest({ method: 'POST', url: tmpUrl, timeoutMs: 10000 }, pOperation, (pError, pStatus, pBody) =>
		{
			if (pError) return fCallback(pError);
			if (pStatus < 200 || pStatus >= 300)
			{
				return fCallback(new Error(`POST /Operation returned ${pStatus}: ${pBody && pBody.substring(0, 200)}`));
			}
			return fCallback(null);
		});
	}

	_executeAsync(pUVUrl, pOpHash, pSettings, fCallback)
	{
		let tmpUrl = pUVUrl.replace(/\/+$/, '') + `/Operation/${encodeURIComponent(pOpHash)}/Execute/Async`;
		// pSettings becomes initial state (OperationState) on the run.
		// /Operation/Execute/Batch supports per-entry Settings; the singular
		// /Execute/Async route only honors RunMode at the body level. To get
		// settings into the run we wrap them under OperationState which the
		// engine merges into the run's initial state.
		let tmpBody = { OperationState: pSettings || {} };
		this._httpRequest({ method: 'POST', url: tmpUrl, timeoutMs: 10000 }, tmpBody, (pError, pStatus, pBody, pJSON) =>
		{
			if (pError) return fCallback(pError);
			if (pStatus < 200 || pStatus >= 300)
			{
				return fCallback(new Error(`POST /Operation/.../Execute/Async returned ${pStatus}: ${pBody && pBody.substring(0, 200)}`));
			}
			if (!pJSON || !pJSON.RunHash)
			{
				return fCallback(new Error(`POST /Operation/.../Execute/Async missing RunHash in response: ${pBody}`));
			}
			return fCallback(null, pJSON.RunHash);
		});
	}

	_pollManifest(pUVUrl, pRunHash, pTimeoutMs, fCallback)
	{
		let tmpDeadline = Date.now() + pTimeoutMs;
		let tmpUrl = pUVUrl.replace(/\/+$/, '') + `/Manifest/${encodeURIComponent(pRunHash)}`;
		let tmpLastManifest = null;
		let tmpTry = () =>
		{
			this._httpRequest({ method: 'GET', url: tmpUrl, timeoutMs: 5000 }, null, (pError, pStatus, pBody, pJSON) =>
			{
				if (pError)
				{
					if (Date.now() >= tmpDeadline) return fCallback(pError, tmpLastManifest);
					setTimeout(tmpTry, this._PollIntervalMs);
					return;
				}
				if (pStatus === 404)
				{
					if (Date.now() >= tmpDeadline) return fCallback(new Error(`Run ${pRunHash} never materialized.`), tmpLastManifest);
					setTimeout(tmpTry, this._PollIntervalMs);
					return;
				}
				if (pStatus < 200 || pStatus >= 300)
				{
					if (Date.now() >= tmpDeadline) return fCallback(new Error(`Manifest poll returned ${pStatus}.`), tmpLastManifest);
					setTimeout(tmpTry, this._PollIntervalMs);
					return;
				}
				tmpLastManifest = pJSON || tmpLastManifest;
				let tmpRunStatus = pJSON && pJSON.Status;
				if (tmpRunStatus === 'Complete' || tmpRunStatus === 'Completed' || tmpRunStatus === 'Failed' || tmpRunStatus === 'Error')
				{
					return fCallback(null, pJSON);
				}
				if (Date.now() >= tmpDeadline)
				{
					return fCallback(new Error(`Run ${pRunHash} did not reach a terminal state within ${pTimeoutMs}ms (last status: ${tmpRunStatus}).`), tmpLastManifest);
				}
				setTimeout(tmpTry, this._PollIntervalMs);
			});
		};
		tmpTry();
	}

	_httpRequest(pOptions, pBody, fCallback)
	{
		let tmpParsed = libUrl.parse(pOptions.url);
		let tmpClient = (tmpParsed.protocol === 'https:') ? libHttps : libHttp;

		let tmpBodyStr = '';
		let tmpHeaders = { 'Accept': 'application/json' };
		if (pBody !== null && pBody !== undefined)
		{
			tmpBodyStr = (typeof pBody === 'string') ? pBody : JSON.stringify(pBody);
			tmpHeaders['Content-Type'] = 'application/json';
			tmpHeaders['Content-Length'] = Buffer.byteLength(tmpBodyStr);
		}

		let tmpReqOptions =
			{
				method: pOptions.method || 'GET',
				hostname: tmpParsed.hostname,
				port: tmpParsed.port || (tmpParsed.protocol === 'https:' ? 443 : 80),
				path: tmpParsed.path,
				headers: tmpHeaders,
				timeout: pOptions.timeoutMs || 10000
			};

		let tmpReq = tmpClient.request(tmpReqOptions, (pResponse) =>
		{
			let tmpChunks = [];
			pResponse.on('data', (pChunk) => tmpChunks.push(pChunk));
			pResponse.on('end', () =>
			{
				let tmpRaw = Buffer.concat(tmpChunks).toString('utf8');
				let tmpJSON = null;
				try { tmpJSON = tmpRaw ? JSON.parse(tmpRaw) : null; } catch (e) { /* not JSON */ }
				fCallback(null, pResponse.statusCode, tmpRaw, tmpJSON);
			});
		});
		tmpReq.on('error', (pError) => fCallback(pError));
		tmpReq.on('timeout', () => { tmpReq.destroy(new Error(`HTTP ${tmpReqOptions.method} ${pOptions.url} timed out`)); });
		if (tmpBodyStr) tmpReq.write(tmpBodyStr);
		tmpReq.end();
	}
}

module.exports = ServiceStackInitializer;
