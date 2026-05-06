/**
 * Lab-Api-Stacks
 *
 * REST surface for Phase 8 stacks. Consumed by PictView-Lab-Stacks via
 * PictProvider-Lab-Api.
 *
 * Routes:
 *   GET    /api/lab/stack-presets                    -- read-only preset library
 *   GET    /api/lab/stacks                           -- list saved stacks
 *   GET    /api/lab/stacks/:hash                     -- one stack (full spec + status)
 *   POST   /api/lab/stacks                           -- upsert by Hash
 *   POST   /api/lab/stacks/clone-preset/:presetHash  -- materialize a preset clone (no save)
 *   DELETE /api/lab/stacks/:hash                     -- hard delete + remove file mirror
 *                                                       (?force=1 skips compose-down)
 *   POST   /api/lab/stacks/:hash/preflight           -- run preflight against {InputValues}
 *   POST   /api/lab/stacks/:hash/up                  -- preflight + compose + up -d
 *   POST   /api/lab/stacks/:hash/down                -- compose down
 *   GET    /api/lab/stacks/:hash/status              -- compose ps rollup
 *   GET    /api/lab/stacks/:hash/compose-yaml        -- generated YAML preview
 */

'use strict';

module.exports = function registerStackRoutes(pCore)
{
	let tmpOrator      = pCore.Orator;
	let tmpStore       = pCore.StackStore;
	let tmpResolver    = pCore.StackResolver;
	let tmpPreflight   = pCore.StackPreflight;
	let tmpComposer    = pCore.StackComposer;
	let tmpLifecycle   = pCore.StackLifecycle;
	let tmpOpStore     = pCore.OperationStore;
	let tmpInitializer = pCore.StackInitializer;

	// ── Preset library ─────────────────────────────────────────────────

	tmpOrator.serviceServer.doGet('/api/lab/stack-presets',
		(pReq, pRes, pNext) =>
		{
			let tmpPresets = tmpStore.listPresets();
			// Strip the heavyweight Components / Inputs subtrees from
			// the list response — the editor fetches the full spec
			// per-preset on clone.
			let tmpSummary = tmpPresets.map((pP) => (
				{
					Hash:          pP.Hash,
					Name:          pP.Name,
					Description:   pP.Description || '',
					ComponentCount: Array.isArray(pP.Components) ? pP.Components.length : 0,
					InputCount:    pP.Inputs ? Object.keys(pP.Inputs).length : 0
				}));
			pRes.send({ Presets: tmpSummary });
			return pNext();
		});

	tmpOrator.serviceServer.doGet('/api/lab/stack-presets/:presetHash',
		(pReq, pRes, pNext) =>
		{
			let tmpPreset = tmpStore.getPresetByHash(pReq.params.presetHash);
			if (!tmpPreset)
			{
				pRes.send(404, { Error: `Preset [${pReq.params.presetHash}] not found.` });
				return pNext();
			}
			pRes.send({ Preset: tmpPreset });
			return pNext();
		});

	// ── Stack CRUD ─────────────────────────────────────────────────────

	tmpOrator.serviceServer.doGet('/api/lab/stacks',
		(pReq, pRes, pNext) =>
		{
			let tmpStacks = tmpStore.listStacks();
			// List view doesn't need the inflated Spec object on every
			// row — strip it so the response stays small.
			let tmpSummary = tmpStacks.map((pS) => (
				{
					IDStack:       pS.IDStack,
					Hash:          pS.Hash,
					Name:          pS.Name,
					Description:   pS.Description || '',
					PresetSource:  pS.PresetSource || '',
					SchemaVersion: pS.SchemaVersion,
					Status:        pS.Status || 'stopped',
					StatusDetail:  pS.StatusDetail || '',
					ComponentCount: pS.Spec && Array.isArray(pS.Spec.Components) ? pS.Spec.Components.length : 0,
					CreateDate:    pS.CreateDate,
					UpdateDate:    pS.UpdateDate
				}));
			pRes.send({ Stacks: tmpSummary });
			return pNext();
		});

	tmpOrator.serviceServer.doGet('/api/lab/stacks/:hash',
		(pReq, pRes, pNext) =>
		{
			let tmpRecord = tmpStore.getByHash(pReq.params.hash);
			if (!tmpRecord)
			{
				pRes.send(404, { Error: `Stack [${pReq.params.hash}] not found.` });
				return pNext();
			}
			pRes.send({ Stack: tmpRecord });
			return pNext();
		});

	tmpOrator.serviceServer.doPost('/api/lab/stacks',
		(pReq, pRes, pNext) =>
		{
			let tmpSpec = pReq.body && pReq.body.Spec;
			if (!tmpSpec || !tmpSpec.Hash)
			{
				pRes.send(400, { Error: '"Spec" with a "Hash" field is required.' });
				return pNext();
			}
			// InputValues is optional; when omitted the store preserves
			// any existing values for this stack.
			let tmpInputValues = (pReq.body && pReq.body.InputValues) || undefined;
			try
			{
				let tmpSaved = tmpStore.save(tmpSpec, tmpInputValues);
				pRes.send({ Stack: tmpSaved });
				return pNext();
			}
			catch (pErr)
			{
				pRes.send(400, { Error: pErr.message });
				return pNext();
			}
		});

	tmpOrator.serviceServer.doPost('/api/lab/stacks/clone-preset/:presetHash',
		(pReq, pRes, pNext) =>
		{
			let tmpName = pReq.body && pReq.body.Name;
			try
			{
				let tmpClone = tmpStore.cloneFromPreset(pReq.params.presetHash, tmpName);
				// Save immediately so the editor has a stable hash to
				// reference. Subsequent edits go through POST /stacks.
				let tmpSaved = tmpStore.save(tmpClone);
				pRes.send({ Stack: tmpSaved });
				return pNext();
			}
			catch (pErr)
			{
				pRes.send(400, { Error: pErr.message });
				return pNext();
			}
		});

	tmpOrator.serviceServer.doDel('/api/lab/stacks/:hash',
		(pReq, pRes, pNext) =>
		{
			// `?force=1` short-circuits the best-effort compose-down. Use it
			// when the stack is in a wedged state (compose hangs, containers
			// vanished, etc.) and the operator just wants the row gone — they
			// take responsibility for cleaning up any remaining containers via
			// `docker ps` / `docker rm` themselves.
			let tmpForce = !!(pReq.query && (pReq.query.force === '1' || pReq.query.force === 'true'));
			let tmpHash = pReq.params.hash;

			let removeRow = () =>
			{
				let tmpDeleted = tmpStore.remove(tmpHash);
				pRes.send({ Deleted: tmpDeleted, Forced: tmpForce });
				return pNext();
			};

			if (tmpForce) return removeRow();

			// Default best-effort: try compose-down first, ignore failures.
			tmpLifecycle.down(tmpHash, removeRow);
		});

	// ── Preflight ──────────────────────────────────────────────────────

	tmpOrator.serviceServer.doPost('/api/lab/stacks/:hash/preflight',
		(pReq, pRes, pNext) =>
		{
			let tmpRecord = tmpStore.getByHash(pReq.params.hash);
			if (!tmpRecord || !tmpRecord.Spec)
			{
				pRes.send(404, { Error: `Stack [${pReq.params.hash}] not found.` });
				return pNext();
			}
			let tmpInputs = (pReq.body && pReq.body.InputValues) || {};
			let tmpResolved = tmpResolver.resolve(tmpRecord.Spec, tmpInputs);
			tmpPreflight.run(tmpResolved, (pErr, pReport) =>
			{
				if (pErr)
				{
					pRes.send(500, { Error: pErr.message });
					return pNext();
				}
				pRes.send(
				{
					Report:          pReport,
					ResolvedInputs:  tmpResolved.Inputs,
					Unresolved:      tmpResolved.Unresolved
				});
				return pNext();
			});
		});

	// ── Lifecycle ──────────────────────────────────────────────────────

	tmpOrator.serviceServer.doPost('/api/lab/stacks/:hash/up',
		(pReq, pRes, pNext) =>
		{
			let tmpInputs = (pReq.body && pReq.body.InputValues) || {};
			let tmpStackHash = pReq.params.hash;

			// If the client disconnects (curl timeout, browser navigated
			// away, etc.) before lifecycle.up's callback fires, release
			// the in-flight lock so the next /up call doesn't 409. The
			// background work continues (we can't cancel docker-compose),
			// but the lock-release lets the user retry.
			let tmpResponded = false;
			pReq.on('close', () =>
			{
				if (tmpResponded) return;
				tmpLifecycle.clearLaunchLock(tmpStackHash);
				if (pCore.Fable && pCore.Fable.log)
				{
					pCore.Fable.log.warn(`Lab-Api-Stacks: client disconnected mid-up for [${tmpStackHash}] — released in-flight lock`);
				}
			});

			tmpLifecycle.up(tmpStackHash, tmpInputs, (pErr, pResult) =>
			{
				tmpResponded = true;
				if (pErr)
				{
					pRes.send(500, { Error: pErr.message });
					return pNext();
				}
				// 409 conflict for a double-clicked Launch — the lifecycle
				// rejected because an up() is already in flight for this hash.
				// The client uses the status code (and the Status field) to
				// render a friendly "Already launching..." toast without
				// kicking off a duplicate background init.
				if (pResult && pResult.Status === 'already-launching')
				{
					pRes.send(409, { Status: 'already-launching', Error: 'A launch is already in progress for this stack.' });
					return pNext();
				}
				// Lifecycle.up succeeded — containers are starting / running.
				// If the spec carries an InitOperation, kick the initializer
				// off in the background so the response returns promptly.
				// The init result is queryable at /api/lab/stacks/:hash/init.
				let tmpReply = pResult || { Status: 'unknown' };
				let tmpStack = tmpStore.getByHash(tmpStackHash);
				let tmpHasInit = tmpStack && tmpStack.Spec && tmpStack.Spec.InitOperation;
				if (tmpHasInit && tmpInitializer)
				{
					tmpReply.Init = { Phase: 'queued' };
					setImmediate(() =>
					{
						tmpInitializer.run(tmpStackHash, tmpInputs, (pInitErr, pInitResult) =>
						{
							if (pInitErr)
							{
								// Already persisted by the initializer; just log.
								if (pCore.Fable && pCore.Fable.log)
								{
									pCore.Fable.log.warn(`Lab-Api-Stacks: stack [${tmpStackHash}] init returned error — ${pInitErr.message}`);
								}
							}
						});
					});
				}
				pRes.send(tmpReply);
				return pNext();
			});
		});

	// Init result for a stack — returns the persisted init-state.json (if
	// any). Phase ∈ { skipped, queued, running, completed, failed, error }.
	tmpOrator.serviceServer.doGet('/api/lab/stacks/:hash/init',
		(pReq, pRes, pNext) =>
		{
			if (!tmpInitializer)
			{
				pRes.send(501, { Error: 'StackInitializer not available.' });
				return pNext();
			}
			let tmpResult = tmpInitializer.getResult(pReq.params.hash);
			if (!tmpResult)
			{
				pRes.send({ StackHash: pReq.params.hash, Phase: 'never-run' });
				return pNext();
			}
			pRes.send(tmpResult);
			return pNext();
		});

	// Force-release the in-flight launch lock for a stack. The lock
	// auto-clears on (a) successful up() completion, (b) client
	// disconnect mid-up, and (c) UP_LOCK_TTL_MS elapsed at the next up()
	// call's stale-sweep. This is the operator escape hatch for the rare
	// case where none of those fire (e.g. an uncaught exception that
	// somehow bypasses the wrappers, plus no one issues a follow-up
	// up()). Returns whether a lock was actually held + how long.
	tmpOrator.serviceServer.doPost('/api/lab/stacks/:hash/clear-launch-lock',
		(pReq, pRes, pNext) =>
		{
			let tmpHash = pReq.params.hash;
			let tmpState = tmpLifecycle.getLaunchLockState(tmpHash);
			let tmpReleased = tmpLifecycle.clearLaunchLock(tmpHash);
			pRes.send(
			{
				Released: tmpReleased,
				PriorState: tmpState
			});
			return pNext();
		});

	// Manual re-run of init — useful when a stack came up but init failed
	// transiently (e.g. the auth-beacon UV wasn't ready yet) and the
	// operator wants to retry without bouncing the whole stack.
	tmpOrator.serviceServer.doPost('/api/lab/stacks/:hash/init/run',
		(pReq, pRes, pNext) =>
		{
			if (!tmpInitializer)
			{
				pRes.send(501, { Error: 'StackInitializer not available.' });
				return pNext();
			}
			let tmpInputs = (pReq.body && pReq.body.InputValues) || null;
			tmpInitializer.run(pReq.params.hash, tmpInputs, (pErr, pResult) =>
			{
				if (pErr)
				{
					pRes.send(500, { Error: pErr.message, Init: pResult || null });
					return pNext();
				}
				// 409 conflict — the initializer rejected because a run() is
				// already in flight (e.g. background init from a prior up()
				// hasn't finished yet, and the operator hit Re-run init).
				if (pResult && pResult.Phase === 'already-running')
				{
					pRes.send(409, { Init: pResult, Error: 'An init run is already in progress for this stack.' });
					return pNext();
				}
				pRes.send(pResult);
				return pNext();
			});
		});

	// Operation library — list everything Service-OperationStore has loaded
	// (bundled + AdditionalOperationDirs from setupLabServer).
	tmpOrator.serviceServer.doGet('/api/lab/operations',
		(pReq, pRes, pNext) =>
		{
			if (!tmpOpStore)
			{
				pRes.send({ Operations: [] });
				return pNext();
			}
			let tmpAll = tmpOpStore.listOperations();
			let tmpSummary = tmpAll.map((pO) => (
				{
					Hash:        pO.Hash,
					Name:        pO.Name || '',
					Description: pO.Description || '',
					NodeCount:   (pO.Graph && Array.isArray(pO.Graph.Nodes)) ? pO.Graph.Nodes.length : 0
				}));
			pRes.send({ Operations: tmpSummary });
			return pNext();
		});

	tmpOrator.serviceServer.doGet('/api/lab/operations/:hash',
		(pReq, pRes, pNext) =>
		{
			if (!tmpOpStore)
			{
				pRes.send(404, { Error: 'OperationStore not available.' });
				return pNext();
			}
			let tmpOp = tmpOpStore.getByHash(pReq.params.hash);
			if (!tmpOp)
			{
				pRes.send(404, { Error: `Operation [${pReq.params.hash}] not found.` });
				return pNext();
			}
			pRes.send(tmpOp);
			return pNext();
		});

	tmpOrator.serviceServer.doPost('/api/lab/stacks/:hash/down',
		(pReq, pRes, pNext) =>
		{
			tmpLifecycle.down(pReq.params.hash, (pErr, pResult) =>
			{
				if (pErr)
				{
					pRes.send(500, { Error: pErr.message });
					return pNext();
				}
				pRes.send(pResult || { Status: 'unknown' });
				return pNext();
			});
		});

	tmpOrator.serviceServer.doGet('/api/lab/stacks/:hash/status',
		(pReq, pRes, pNext) =>
		{
			tmpLifecycle.getStatus(pReq.params.hash, (pErr, pStatus) =>
			{
				if (pErr)
				{
					pRes.send(500, { Error: pErr.message });
					return pNext();
				}
				pRes.send(pStatus);
				return pNext();
			});
		});

	// ── Compose YAML preview ──────────────────────────────────────────

	tmpOrator.serviceServer.doGet('/api/lab/stacks/:hash/compose-yaml',
		(pReq, pRes, pNext) =>
		{
			// Render against the saved spec with input *defaults* (the
			// preview is only meaningful when launched, but operators
			// often want to inspect the YAML before filling inputs).
			// If the stack already has an on-disk compose file (i.e. it
			// was launched recently), prefer that — it reflects the
			// inputs that were actually used.
			let tmpRecord = tmpStore.getByHash(pReq.params.hash);
			if (!tmpRecord || !tmpRecord.Spec)
			{
				pRes.send(404, { Error: `Stack [${pReq.params.hash}] not found.` });
				return pNext();
			}
			let tmpComposePath = tmpComposer.getComposePath(pReq.params.hash);
			let tmpFs = require('fs');
			if (tmpFs.existsSync(tmpComposePath))
			{
				try
				{
					let tmpYaml = tmpFs.readFileSync(tmpComposePath, 'utf8');
					pRes.send(
					{
						YAML:        tmpYaml,
						Path:        tmpComposePath,
						Source:      'on-disk (last-launched values)'
					});
					return pNext();
				}
				catch (pErr) { /* fall through to fresh render */ }
			}
			// No on-disk file — render with defaults so the preview
			// shows roughly what would be produced.
			let tmpInputs = (pReq.query && pReq.query.inputs)
				? _safeParseQuery(pReq.query.inputs) : {};
			let tmpResolved = tmpResolver.resolve(tmpRecord.Spec, tmpInputs);
			try
			{
				let tmpComposed = tmpComposer.compose(tmpResolved);
				pRes.send(
				{
					YAML:        tmpComposed.ComposeYAML,
					Path:        tmpComposed.ComposePath,
					Source:      'rendered (preview with defaults)'
				});
				return pNext();
			}
			catch (pErr)
			{
				pRes.send(500, { Error: pErr.message });
				return pNext();
			}
		});
};

function _safeParseQuery(pStr)
{
	try { return JSON.parse(pStr); }
	catch (pErr) { return {}; }
}
