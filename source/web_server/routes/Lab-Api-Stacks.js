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
 *   POST   /api/lab/stacks/:hash/preflight           -- run preflight against {InputValues}
 *   POST   /api/lab/stacks/:hash/up                  -- preflight + compose + up -d
 *   POST   /api/lab/stacks/:hash/down                -- compose down
 *   GET    /api/lab/stacks/:hash/status              -- compose ps rollup
 *   GET    /api/lab/stacks/:hash/compose-yaml        -- generated YAML preview
 */

'use strict';

module.exports = function registerStackRoutes(pCore)
{
	let tmpOrator     = pCore.Orator;
	let tmpStore      = pCore.StackStore;
	let tmpResolver   = pCore.StackResolver;
	let tmpPreflight  = pCore.StackPreflight;
	let tmpComposer   = pCore.StackComposer;
	let tmpLifecycle  = pCore.StackLifecycle;

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
			// Best-effort: try to bring the stack down before deleting,
			// in case the operator forgot. Ignore down-failures since
			// the user has already asked us to remove the row.
			tmpLifecycle.down(pReq.params.hash, () =>
			{
				let tmpDeleted = tmpStore.remove(pReq.params.hash);
				pRes.send({ Deleted: tmpDeleted });
				return pNext();
			});
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
			tmpLifecycle.up(pReq.params.hash, tmpInputs, (pErr, pResult) =>
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
