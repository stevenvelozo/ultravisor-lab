/**
 * Service-StackLifecycle (Phase 8 — Pillar 3)
 *
 * Drives `docker compose` against generated stack YAMLs. Owns the
 * verb path — up / down / status / logs — and the status rollup that
 * turns N-component compose-ps output into a single Phase the UI shows.
 *
 * Compose CLI detection:
 *   At construction we probe `docker compose version` (V2 plugin); if
 *   that fails we fall back to `docker-compose --version` (V1 standalone)
 *   and warn. The decided default is V2; V1 is a courtesy fallback for
 *   dev hosts that haven't installed the plugin yet.
 *
 * Public API:
 *   isReady()                              → true if compose CLI is usable
 *   composeBinary()                        → the CLI we'll invoke (debug/UI)
 *   up(pHash, pInputValues, fCallback)     → resolve → preflight → compose → up -d
 *   down(pHash, fCallback)                 → docker compose -p stack-<hash> down
 *   getStatus(pHash, fCallback)            → docker compose ps --format json + rollup
 *   tailLogs(pHash, pComponentHash, pOptions, fCallback)
 *                                           → returns a child_process for streaming
 *
 * Status shape (returned by getStatus, also written to Stack.Status):
 *   { Phase: 'stopped'|'starting'|'running'|'unhealthy'|'stopping'|'error',
 *     Components: [{ Hash, ContainerID, State, Health, Uptime }],
 *     Reason: string,
 *     LastCheckedAt: ISO }
 *
 * Lifecycle does NOT poll on its own — the UI / API layer drives the
 * cadence (every 5s when a stack page is open, every 30s otherwise).
 * Lifecycle's job is to give a fresh snapshot on each call.
 */

'use strict';

const libFs = require('fs');
const libPath = require('path');
const libChildProcess = require('child_process');
const libFableServiceProviderBase = require('fable-serviceproviderbase');

// First-time `up` of a build-from-folder stack has to npm-install +
// build the webinterface for ultravisor, install MariaDB inside the
// retold-data-service image, etc. — easily 10+ minutes on a cold cache.
// Subsequent ups hit the docker layer cache and finish in seconds.
// 30 minutes is the upper bound for an honest first-time build.
const COMPOSE_TIMEOUT_MS_DEFAULT = 1800000;
const STATUS_TIMEOUT_MS = 10000;

class ServiceStackLifecycle extends libFableServiceProviderBase
{
	constructor(pFable, pOptions, pServiceHash)
	{
		super(pFable, pOptions, pServiceHash);
		this.serviceType = 'LabStackLifecycle';

		this._ComposeCmd = null;       // 'docker' (with 'compose' subcommand) or 'docker-compose'
		this._ComposeArgsPrefix = [];  // ['compose'] for v2, [] for v1
		this._ComposeVersion = null;
		this._ComposeProbed = false;
	}

	// ====================================================================
	// CLI detection
	// ====================================================================

	_probeCompose(fCallback)
	{
		if (this._ComposeProbed) { return fCallback(null); }
		let tmpSelf = this;

		// Try V2 plugin first.
		libChildProcess.execFile('docker', ['compose', 'version'], { timeout: 5000 },
			function (pErr, pStdout)
			{
				if (!pErr && pStdout)
				{
					tmpSelf._ComposeCmd = 'docker';
					tmpSelf._ComposeArgsPrefix = ['compose'];
					tmpSelf._ComposeVersion = ('v2: ' + pStdout.trim().split('\n')[0]);
					tmpSelf._ComposeProbed = true;
					tmpSelf.fable.log.info('StackLifecycle: using ' + tmpSelf._ComposeVersion);
					return fCallback(null);
				}
				// Fall back to V1 standalone.
				libChildProcess.execFile('docker-compose', ['--version'], { timeout: 5000 },
					function (pErr2, pStdout2)
					{
						if (pErr2 || !pStdout2)
						{
							tmpSelf._ComposeProbed = true;
							tmpSelf.fable.log.warn('StackLifecycle: no docker compose CLI found (v2 or v1); stacks cannot launch.');
							return fCallback(new Error('no docker compose CLI available'));
						}
						tmpSelf._ComposeCmd = 'docker-compose';
						tmpSelf._ComposeArgsPrefix = [];
						tmpSelf._ComposeVersion = ('v1: ' + pStdout2.trim().split('\n')[0]);
						tmpSelf._ComposeProbed = true;
						tmpSelf.fable.log.warn(
							'StackLifecycle: using ' + tmpSelf._ComposeVersion
							+ ' (V1 fallback — install the docker compose v2 plugin for full feature parity).');
						fCallback(null);
					});
			});
	}

	isReady()
	{
		return !!this._ComposeCmd;
	}

	composeBinary()
	{
		if (!this._ComposeCmd) return null;
		return this._ComposeCmd + (this._ComposeArgsPrefix.length ? (' ' + this._ComposeArgsPrefix.join(' ')) : '');
	}

	// Build the [cmd, args[]] tuple for spawn / execFile, prepending
	// `-f <composePath> -p <projectName>`.
	_composeArgs(pComposePath, pProjectName, pVerbAndArgs)
	{
		let tmpArgs = this._ComposeArgsPrefix.slice();
		tmpArgs.push('-f', pComposePath, '-p', pProjectName);
		for (let i = 0; i < pVerbAndArgs.length; i++) { tmpArgs.push(pVerbAndArgs[i]); }
		return tmpArgs;
	}

	// ====================================================================
	// Service handles (resolved lazily)
	// ====================================================================

	_svc(pName)
	{
		let tmpMap = this.fable.servicesMap && this.fable.servicesMap[pName];
		return tmpMap ? Object.values(tmpMap)[0] : null;
	}

	// ====================================================================
	// Public verbs
	// ====================================================================

	/**
	 * Bring a stack up.
	 *
	 * Steps:
	 *   1. Load spec from StackStore.
	 *   2. Resolve variables (StackResolver) with pInputValues.
	 *   3. Run preflight (StackPreflight). If blockers, abort with the report.
	 *   4. Generate compose YAML (StackComposer).
	 *   5. mkdir-recursive any missing volume host paths.
	 *   6. Shell `docker compose -f ... -p ... up -d --remove-orphans`.
	 *   7. Update Stack.Status to "starting" pre-launch, "running" or "unhealthy"
	 *      after the first ps poll completes.
	 *
	 * fCallback: (err, { Status, ComposePath, PreflightReport, RawOutput })
	 */
	up(pHash, pInputValues, fCallback)
	{
		let tmpSelf = this;
		this._probeCompose(function (pProbeErr)
		{
			if (pProbeErr) return fCallback(pProbeErr);

			let tmpStore = tmpSelf._svc('LabStackStore');
			let tmpResolver = tmpSelf._svc('LabStackResolver');
			let tmpPreflight = tmpSelf._svc('LabStackPreflight');
			let tmpComposer = tmpSelf._svc('LabStackComposer');
			if (!tmpStore || !tmpResolver || !tmpPreflight || !tmpComposer)
			{
				return fCallback(new Error('StackLifecycle.up: required services not available'));
			}

			let tmpRecord = tmpStore.getByHash(pHash);
			if (!tmpRecord || !tmpRecord.Spec)
			{
				return fCallback(new Error('StackLifecycle.up: stack [' + pHash + '] not found'));
			}

			tmpSelf._recordEvent(tmpRecord,
				{
					EventType: 'stack-launch-started',
					Severity:  'info',
					Message:   `Launching stack "${tmpRecord.Name || tmpRecord.Hash}"`
				});

			let tmpResolved = tmpResolver.resolve(tmpRecord.Spec, pInputValues || {});
			tmpPreflight.run(tmpResolved, function (pPfErr, pReport)
			{
				if (pPfErr)
				{
					tmpSelf._recordEvent(tmpRecord,
						{
							EventType: 'stack-launch-failed',
							Severity:  'error',
							Message:   `Preflight crashed: ${pPfErr.message}`
						});
					return fCallback(pPfErr);
				}
				if (pReport && pReport.Status === 'blockers')
				{
					let tmpBlockers = (pReport.Items || []).filter(function (pI) { return pI.Severity === 'block'; });
					tmpSelf._recordEvent(tmpRecord,
						{
							EventType: 'stack-launch-blocked',
							Severity:  'warn',
							Message:   `Preflight blocked launch (${tmpBlockers.length} issue${tmpBlockers.length === 1 ? '' : 's'})`,
							Detail:    { Blockers: tmpBlockers.slice(0, 10) }
						});
					return fCallback(null,
					{
						Status: 'preflight-blocked',
						PreflightReport: pReport
					});
				}

				// mkdir any missing volume hosts BEFORE compose runs;
				// docker would mount them as root-owned otherwise.
				try { tmpSelf._ensureVolumeFolders(tmpResolved); }
				catch (pMkErr)
				{
					return fCallback(new Error('StackLifecycle.up: folder pre-create failed: ' + pMkErr.message));
				}

				// Generate compose YAML.
				let tmpComposed;
				try { tmpComposed = tmpComposer.compose(tmpResolved); }
				catch (pComposeErr) { return fCallback(pComposeErr); }

				// Mark starting.
				tmpStore.updateStatus(pHash, 'starting', '');

				// --build so Dockerfile / source changes are picked up on
				// every launch — the lab is for iterating on code, not
				// running a production binary. Compose's layer cache
				// keeps incremental rebuilds fast.
				let tmpArgs = tmpSelf._composeArgs(
					tmpComposed.ComposePath, tmpComposed.ProjectName,
					['up', '-d', '--build', '--remove-orphans']);

				libChildProcess.execFile(tmpSelf._ComposeCmd, tmpArgs,
					{ timeout: COMPOSE_TIMEOUT_MS_DEFAULT, maxBuffer: 8 * 1024 * 1024 },
					function (pErr, pStdout, pStderr)
					{
						let tmpRaw = (pStdout || '') + (pStderr ? ('\n[stderr]\n' + pStderr) : '');
						if (pErr)
						{
							tmpStore.updateStatus(pHash, 'error',
								'compose up failed: ' + (pErr.message || '').slice(0, 400));
							tmpSelf._recordEvent(tmpRecord,
								{
									EventType: 'stack-launch-failed',
									Severity:  'error',
									Message:   `compose up failed: ${tmpSelf._summarizeRaw(tmpRaw) || pErr.message}`,
									Detail:    { ComposePath: tmpComposed.ComposePath, RawOutput: tmpRaw.slice(-4000) }
								});
							return fCallback(null,
							{
								Status: 'error',
								ComposePath: tmpComposed.ComposePath,
								PreflightReport: pReport,
								RawOutput: tmpRaw
							});
						}
						// Compose returned 0 — derive status by polling once.
						tmpSelf.getStatus(pHash, function (pStErr, pStatus)
						{
							let tmpFinal = pStErr ? 'starting' : pStatus.Phase;
							tmpStore.updateStatus(pHash, tmpFinal,
								(pStatus && pStatus.Reason) || '');
							let tmpSeverity = (tmpFinal === 'unhealthy' || tmpFinal === 'error') ? 'warn' : 'info';
							tmpSelf._recordEvent(tmpRecord,
								{
									EventType: 'stack-launch-ready',
									Severity:  tmpSeverity,
									Message:   `Stack "${tmpRecord.Name || tmpRecord.Hash}" came up (${tmpFinal})`,
									Detail:    { Phase: tmpFinal, Components: (pStatus && pStatus.Components) || [] }
								});
							fCallback(null,
							{
								Status: tmpFinal,
								ComposePath: tmpComposed.ComposePath,
								PreflightReport: pReport,
								RawOutput: tmpRaw
							});
						});
					});
			});
		});
	}

	/**
	 * Bring a stack down.
	 * `docker compose -f ... -p ... down` removes containers + the
	 * compose-managed network. Host-mounted volumes survive (that's
	 * the whole point of binding to a user-chosen folder).
	 */
	down(pHash, fCallback)
	{
		let tmpSelf = this;
		this._probeCompose(function (pProbeErr)
		{
			if (pProbeErr) return fCallback(pProbeErr);
			let tmpStore = tmpSelf._svc('LabStackStore');
			let tmpComposer = tmpSelf._svc('LabStackComposer');
			if (!tmpStore || !tmpComposer)
			{
				return fCallback(new Error('StackLifecycle.down: required services not available'));
			}
			let tmpRecord = tmpStore.getByHash(pHash);
			if (!tmpRecord) { return fCallback(new Error('StackLifecycle.down: stack [' + pHash + '] not found')); }

			let tmpComposePath = tmpComposer.getComposePath(pHash);
			if (!libFs.existsSync(tmpComposePath))
			{
				// No compose file = nothing was launched. Mark stopped
				// and exit clean.
				tmpStore.updateStatus(pHash, 'stopped', '');
				return fCallback(null, { Status: 'stopped' });
			}

			tmpStore.updateStatus(pHash, 'stopping', '');
			tmpSelf._recordEvent(tmpRecord,
				{
					EventType: 'stack-teardown-started',
					Severity:  'info',
					Message:   `Tearing down stack "${tmpRecord.Name || tmpRecord.Hash}"`
				});

			let tmpArgs = tmpSelf._composeArgs(
				tmpComposePath, tmpComposer.getProjectName(pHash),
				['down', '--remove-orphans']);

			libChildProcess.execFile(tmpSelf._ComposeCmd, tmpArgs,
				{ timeout: COMPOSE_TIMEOUT_MS_DEFAULT, maxBuffer: 8 * 1024 * 1024 },
				function (pErr, pStdout, pStderr)
				{
					let tmpRaw = (pStdout || '') + (pStderr ? ('\n[stderr]\n' + pStderr) : '');
					if (pErr)
					{
						tmpStore.updateStatus(pHash, 'error',
							'compose down failed: ' + (pErr.message || '').slice(0, 400));
						tmpSelf._recordEvent(tmpRecord,
							{
								EventType: 'stack-teardown-failed',
								Severity:  'error',
								Message:   `compose down failed: ${tmpSelf._summarizeRaw(tmpRaw) || pErr.message}`,
								Detail:    { RawOutput: tmpRaw.slice(-4000) }
							});
						return fCallback(null, { Status: 'error', RawOutput: tmpRaw });
					}
					tmpStore.updateStatus(pHash, 'stopped', '');
					tmpSelf._recordEvent(tmpRecord,
						{
							EventType: 'stack-teardown-complete',
							Severity:  'info',
							Message:   `Stack "${tmpRecord.Name || tmpRecord.Hash}" stopped`
						});
					fCallback(null, { Status: 'stopped', RawOutput: tmpRaw });
				});
		});
	}

	/**
	 * Snapshot status. Runs `docker compose ps --format json` and rolls
	 * up to a single Phase.
	 */
	getStatus(pHash, fCallback)
	{
		let tmpSelf = this;
		this._probeCompose(function (pProbeErr)
		{
			if (pProbeErr) return fCallback(pProbeErr);
			let tmpStore = tmpSelf._svc('LabStackStore');
			let tmpComposer = tmpSelf._svc('LabStackComposer');
			if (!tmpStore || !tmpComposer)
			{
				return fCallback(new Error('StackLifecycle.getStatus: required services not available'));
			}
			let tmpComposePath = tmpComposer.getComposePath(pHash);
			if (!libFs.existsSync(tmpComposePath))
			{
				return fCallback(null,
				{
					Phase: 'stopped',
					Components: [],
					Reason: 'no compose file on disk',
					LastCheckedAt: new Date().toISOString()
				});
			}

			let tmpArgs = tmpSelf._composeArgs(
				tmpComposePath, tmpComposer.getProjectName(pHash),
				['ps', '--format', 'json']);

			libChildProcess.execFile(tmpSelf._ComposeCmd, tmpArgs,
				{ timeout: STATUS_TIMEOUT_MS, maxBuffer: 4 * 1024 * 1024 },
				function (pErr, pStdout)
				{
					if (pErr)
					{
						return fCallback(null,
						{
							Phase: 'error',
							Components: [],
							Reason: 'compose ps failed: ' + (pErr.message || '').slice(0, 200),
							LastCheckedAt: new Date().toISOString()
						});
					}

					let tmpStatus = tmpSelf._rollupStatus(pStdout);
					fCallback(null, tmpStatus);
				});
		});
	}

	/**
	 * `docker compose logs [-f] [<service>]`. Returns the spawned
	 * child process so the caller can pipe stdout/stderr or kill it.
	 *
	 * pOptions:
	 *   Follow:    boolean — pass -f
	 *   Tail:      number  — pass --tail <N>
	 *
	 * fCallback: (err, child) — child is null if compose isn't ready.
	 */
	tailLogs(pHash, pComponentHash, pOptions, fCallback)
	{
		let tmpSelf = this;
		this._probeCompose(function (pProbeErr)
		{
			if (pProbeErr) return fCallback(pProbeErr, null);
			let tmpComposer = tmpSelf._svc('LabStackComposer');
			if (!tmpComposer) return fCallback(new Error('StackLifecycle.tailLogs: composer not available'), null);
			let tmpComposePath = tmpComposer.getComposePath(pHash);
			if (!libFs.existsSync(tmpComposePath))
			{
				return fCallback(new Error('StackLifecycle.tailLogs: stack not launched yet'), null);
			}
			let tmpVerb = ['logs'];
			if (pOptions && pOptions.Follow) { tmpVerb.push('-f'); }
			if (pOptions && Number.isFinite(pOptions.Tail)) { tmpVerb.push('--tail', String(pOptions.Tail)); }
			if (pComponentHash) { tmpVerb.push(pComponentHash); }
			let tmpArgs = tmpSelf._composeArgs(
				tmpComposePath, tmpComposer.getProjectName(pHash), tmpVerb);
			let tmpChild = libChildProcess.spawn(tmpSelf._ComposeCmd, tmpArgs,
				{ stdio: ['ignore', 'pipe', 'pipe'] });
			fCallback(null, tmpChild);
		});
	}

	// ====================================================================
	// Helpers
	// ====================================================================

	_recordEvent(pRecord, pEvent)
	{
		let tmpStore = this.fable.LabStateStore;
		if (!tmpStore || typeof tmpStore.recordEvent !== 'function') return;
		try
		{
			// Stacks are addressed by Hash, not numeric ID — fold the
			// Hash into Detail so the events view can build a link to
			// /stacks/<hash> without a schema change.
			let tmpDetail = Object.assign({}, pEvent.Detail || {});
			if (pRecord && pRecord.Hash) { tmpDetail.Hash = pRecord.Hash; }
			tmpStore.recordEvent(Object.assign({}, pEvent,
				{
					EntityType: 'Stack',
					EntityID:   (pRecord && pRecord.IDStack) || 0,
					EntityName: (pRecord && (pRecord.Name || pRecord.Hash)) || '',
					Detail:     tmpDetail
				}));
		}
		catch (pErr)
		{
			this.fable.log.warn('StackLifecycle: recordEvent failed: ' + pErr.message);
		}
	}

	// Pull the most useful single line out of compose stdout/stderr —
	// preferring the last `Error response from daemon: ...` style line.
	_summarizeRaw(pRaw)
	{
		if (!pRaw) return '';
		let tmpLines = String(pRaw).split('\n').map(function (pL) { return pL.trim(); })
			.filter(function (pL) { return pL.length > 0 && pL !== '[stderr]'; });
		for (let i = tmpLines.length - 1; i >= 0; i--)
		{
			if (/error/i.test(tmpLines[i])) return tmpLines[i].slice(0, 240);
		}
		return (tmpLines[tmpLines.length - 1] || '').slice(0, 240);
	}

	_ensureVolumeFolders(pResolved)
	{
		let tmpComponents = (pResolved && pResolved.Spec && pResolved.Spec.Components) || [];
		for (let i = 0; i < tmpComponents.length; i++)
		{
			let tmpC = tmpComponents[i];
			if (!tmpC || !Array.isArray(tmpC.Volumes)) continue;
			for (let v = 0; v < tmpC.Volumes.length; v++)
			{
				let tmpVol = tmpC.Volumes[v];
				if (!tmpVol || !tmpVol.Host) continue;
				let tmpAbs = libPath.resolve(tmpVol.Host);
				if (!libFs.existsSync(tmpAbs))
				{
					libFs.mkdirSync(tmpAbs, { recursive: true });
				}
			}
		}
	}

	// Roll up `docker compose ps --format json` output. Compose V2
	// emits NDJSON (one object per line); V1 emits a JSON array.
	// Handle both.
	_rollupStatus(pRawOutput)
	{
		let tmpRaw = (pRawOutput || '').trim();
		let tmpEntries = [];
		if (tmpRaw.length > 0)
		{
			if (tmpRaw.charAt(0) === '[')
			{
				try { tmpEntries = JSON.parse(tmpRaw); }
				catch (pErr) { tmpEntries = []; }
			}
			else
			{
				let tmpLines = tmpRaw.split('\n');
				for (let i = 0; i < tmpLines.length; i++)
				{
					let tmpLine = tmpLines[i].trim();
					if (!tmpLine) continue;
					try { tmpEntries.push(JSON.parse(tmpLine)); }
					catch (pErr) { /* skip non-JSON noise */ }
				}
			}
		}

		let tmpComponents = [];
		let tmpAllRunning = true;
		let tmpAnyRunning = false;
		let tmpAnyUnhealthy = false;
		let tmpAnyStarting = false;

		for (let i = 0; i < tmpEntries.length; i++)
		{
			let tmpE = tmpEntries[i];
			if (!tmpE) continue;
			let tmpHash = tmpE.Service || tmpE.Name || '';
			let tmpState = tmpE.State || tmpE.Status || '';
			let tmpHealth = tmpE.Health || '';
			let tmpUp = tmpE.RunningFor || tmpE.Status || '';

			let tmpStateLower = String(tmpState).toLowerCase();
			let tmpHealthLower = String(tmpHealth).toLowerCase();

			let tmpRunningish = tmpStateLower === 'running'
				|| (tmpHealthLower === 'healthy' || tmpHealthLower === 'starting');

			if (tmpRunningish) { tmpAnyRunning = true; }
			else { tmpAllRunning = false; }
			if (tmpHealthLower === 'unhealthy') { tmpAnyUnhealthy = true; }
			if (tmpHealthLower === 'starting'
				|| tmpStateLower === 'created'
				|| tmpStateLower === 'restarting')
			{
				tmpAnyStarting = true;
			}

			tmpComponents.push({
				Hash:        tmpHash,
				ContainerID: tmpE.ID || tmpE.ContainerID || '',
				State:       tmpState,
				Health:      tmpHealth,
				Uptime:      tmpUp
			});
		}

		let tmpPhase;
		if (tmpComponents.length === 0)               { tmpPhase = 'stopped'; }
		else if (tmpAnyUnhealthy)                     { tmpPhase = 'unhealthy'; }
		else if (tmpAnyStarting)                      { tmpPhase = 'starting'; }
		else if (tmpAllRunning)                       { tmpPhase = 'running'; }
		else                                          { tmpPhase = 'unhealthy'; }

		return {
			Phase:         tmpPhase,
			Components:    tmpComponents,
			Reason:        '',
			LastCheckedAt: new Date().toISOString()
		};
	}
}

module.exports = ServiceStackLifecycle;
