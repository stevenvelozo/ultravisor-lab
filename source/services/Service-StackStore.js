/**
 * Service-StackStore (Phase 8 — Pillar 1)
 *
 * Persistence layer for stack specs. SQLite (Stack table) is canonical;
 * every save also flushes a pretty-printed JSON file under
 * `${dataDir}/stacks/<Hash>.json` for inspection / hand-edit / version
 * control. The lab does NOT read those files back — if an operator
 * hand-edits one, they need to paste the JSON into the form for the
 * lab to pick it up. SQLite is the source of truth.
 *
 * Also owns the read-only preset library at
 * `source/stacks/presets/preset-*.json` which ships with the lab and
 * shows up under `listPresets()`.
 *
 * Public API:
 *   listStacks()                     → [{ Hash, Name, Description, ... }]
 *   listPresets()                    → [{ Hash, Name, Description, Spec }]
 *   getByHash(pHash)                 → full stack record (with parsed Spec) or null
 *   save(pSpec)                      → upsert by Hash; mirrors to disk
 *   remove(pHash)                    → hard delete; removes mirror file
 *   getMirrorPath(pHash)             → absolute path to the mirror file
 *
 * Spec validation lives in a separate service (Service-StackResolver,
 * Pillar 2). This store accepts whatever object you hand it; it only
 * enforces shape at the column level (Hash present, SchemaVersion
 * numeric).
 */

'use strict';

const libPath = require('path');
const libFs = require('fs');
const libCrypto = require('crypto');
const libFableServiceProviderBase = require('fable-serviceproviderbase');

const PRESETS_DIR = libPath.resolve(__dirname, '..', 'stacks', 'presets');
const TABLE_NAME = 'Stack';
const ID_COLUMN  = 'IDStack';
const SCHEMA_VERSION_CURRENT = 1;

class ServiceStackStore extends libFableServiceProviderBase
{
	constructor(pFable, pOptions, pServiceHash)
	{
		super(pFable, pOptions, pServiceHash);
		this.serviceType = 'LabStackStore';

		// DataDir → ${labDataDir}/stacks/. Created on first save.
		this._DataDir = (pOptions && pOptions.DataDir)
			|| (this.fable.settings && this.fable.settings.LabDataDir)
			|| libPath.resolve(__dirname, '..', '..', 'data');
		this._MirrorDir = libPath.join(this._DataDir, 'stacks');

		// Cached preset library — read once at boot, not re-scanned at
		// runtime. Touch the disk if you really must to add a preset
		// then restart the lab.
		this._Presets = null;
	}

	// ====================================================================
	// State store handle (lazy — LabStateStore registers after us in some
	// orderings; resolve at call time rather than constructor time)
	// ====================================================================

	_stateStore()
	{
		let tmpMap = this.fable.servicesMap && this.fable.servicesMap['LabStateStore'];
		if (!tmpMap) return null;
		return Object.values(tmpMap)[0] || null;
	}

	// ====================================================================
	// Preset library
	// ====================================================================

	listPresets()
	{
		if (this._Presets) return this._Presets;
		this._Presets = [];
		try
		{
			if (!libFs.existsSync(PRESETS_DIR)) { return this._Presets; }
			let tmpFiles = libFs.readdirSync(PRESETS_DIR)
				.filter((pF) => pF.endsWith('.json'))
				.sort();
			for (let i = 0; i < tmpFiles.length; i++)
			{
				let tmpPath = libPath.join(PRESETS_DIR, tmpFiles[i]);
				try
				{
					let tmpSpec = JSON.parse(libFs.readFileSync(tmpPath, 'utf8'));
					if (!tmpSpec.Hash || !tmpSpec.Name)
					{
						this.fable.log.warn(`StackStore: preset ${tmpFiles[i]} missing Hash or Name; skipping.`);
						continue;
					}
					this._Presets.push(tmpSpec);
				}
				catch (pErr)
				{
					this.fable.log.warn(`StackStore: preset ${tmpFiles[i]} failed to parse: ${pErr.message}`);
				}
			}
		}
		catch (pErr)
		{
			this.fable.log.warn(`StackStore: preset scan failed: ${pErr.message}`);
		}
		return this._Presets;
	}

	getPresetByHash(pHash)
	{
		let tmpAll = this.listPresets();
		for (let i = 0; i < tmpAll.length; i++)
		{
			if (tmpAll[i].Hash === pHash) return tmpAll[i];
		}
		return null;
	}

	// ====================================================================
	// Stack CRUD
	// ====================================================================

	listStacks()
	{
		let tmpStore = this._stateStore();
		if (!tmpStore) return [];
		let tmpRows = tmpStore.list(TABLE_NAME) || [];
		// Hydrate Spec + InputValues for each row so the caller doesn't
		// have to do JSON.parse on every list iteration.
		for (let i = 0; i < tmpRows.length; i++)
		{
			tmpRows[i].Spec        = this._safeParseSpec(tmpRows[i].SpecJSON);
			tmpRows[i].InputValues = this._safeParseInputValues(tmpRows[i].InputValuesJSON);
		}
		return tmpRows;
	}

	getByHash(pHash)
	{
		if (!pHash) return null;
		let tmpStore = this._stateStore();
		if (!tmpStore) return null;
		let tmpRows = tmpStore.list(TABLE_NAME, { Hash: pHash }) || [];
		if (tmpRows.length === 0) return null;
		// Hash *should* be unique. If duplicates somehow exist (manual
		// SQLite edit?), prefer the most-recently-updated row.
		tmpRows.sort(function (pA, pB)
		{
			let tmpA = pA.UpdateDate || pA.CreateDate || '';
			let tmpB = pB.UpdateDate || pB.CreateDate || '';
			return tmpA < tmpB ? 1 : tmpA > tmpB ? -1 : 0;
		});
		let tmpRow = tmpRows[0];
		tmpRow.Spec        = this._safeParseSpec(tmpRow.SpecJSON);
		tmpRow.InputValues = this._safeParseInputValues(tmpRow.InputValuesJSON);
		return tmpRow;
	}

	/**
	 * Upsert a stack spec by Hash. Returns the persisted record
	 * (including IDStack and the canonical Spec round-tripped through
	 * the JSON column).
	 *
	 * pInputValues is optional — when provided, the user's per-launch
	 * input values are persisted to the InputValuesJSON column so they
	 * survive reload. When omitted on update, existing values are
	 * preserved (so a save() that only edits the spec doesn't wipe
	 * them).
	 *
	 * Creates the file mirror at the same time. The mirror only carries
	 * the Spec — InputValues stay in SQLite so secrets don't leak into
	 * the on-disk JSON intended for git tracking.
	 */
	save(pSpec, pInputValues)
	{
		if (!pSpec || typeof pSpec !== 'object')
		{
			throw new Error('StackStore.save: spec must be an object');
		}
		if (!pSpec.Hash || typeof pSpec.Hash !== 'string')
		{
			throw new Error('StackStore.save: spec.Hash is required');
		}
		let tmpStore = this._stateStore();
		if (!tmpStore)
		{
			throw new Error('StackStore.save: LabStateStore not initialized');
		}

		// Stamp SchemaVersion if absent.
		if (!Number.isFinite(pSpec.SchemaVersion))
		{
			pSpec.SchemaVersion = SCHEMA_VERSION_CURRENT;
		}

		let tmpExisting = this.getByHash(pSpec.Hash);
		// Preserve existing input values if caller didn't pass any —
		// a spec-only save shouldn't blow away the user's inputs.
		let tmpInputValues = (pInputValues !== undefined && pInputValues !== null)
			? pInputValues
			: (tmpExisting ? tmpExisting.InputValues : {});

		let tmpRow =
		{
			Hash:            pSpec.Hash,
			Name:            pSpec.Name || '',
			Description:     pSpec.Description || '',
			PresetSource:    pSpec.PresetSource || '',
			SchemaVersion:   pSpec.SchemaVersion,
			SpecJSON:        this._stringifySpec(pSpec),
			InputValuesJSON: this._stringifyInputValues(tmpInputValues),
			Status:          (tmpExisting && tmpExisting.Status) || 'stopped',
			StatusDetail:    (tmpExisting && tmpExisting.StatusDetail) || ''
		};

		let tmpID;
		if (tmpExisting)
		{
			tmpStore.update(TABLE_NAME, ID_COLUMN, tmpExisting[ID_COLUMN], tmpRow);
			tmpID = tmpExisting[ID_COLUMN];
		}
		else
		{
			tmpID = tmpStore.insert(TABLE_NAME, tmpRow);
		}

		// File mirror — best effort.
		try { this._writeMirror(pSpec); }
		catch (pErr)
		{
			this.fable.log.warn(`StackStore: mirror write failed for ${pSpec.Hash}: ${pErr.message}`);
		}

		// Re-read so the caller gets the canonical row (audit columns
		// populated, SpecJSON round-tripped).
		let tmpSaved = this.getByHash(pSpec.Hash);

		this._recordEvent(tmpSaved,
			{
				EventType: tmpExisting ? 'stack-saved' : 'stack-created',
				Severity:  'info',
				Message:   tmpExisting
					? `Stack "${tmpSaved.Name || tmpSaved.Hash}" updated`
					: `Stack "${tmpSaved.Name || tmpSaved.Hash}" created${pSpec.PresetSource ? ` from preset "${pSpec.PresetSource}"` : ''}`,
				Detail:    pSpec.PresetSource ? { PresetSource: pSpec.PresetSource } : undefined
			});

		return tmpSaved;
	}

	/**
	 * Update only the Status / StatusDetail without touching the spec.
	 * Used by Pillar 3 (lifecycle) when containers transition. Distinct
	 * from save() so that a status update doesn't rewrite the mirror
	 * file — operators don't need to see status changes in their JSON
	 * file checkout.
	 */
	updateStatus(pHash, pStatus, pStatusDetail)
	{
		let tmpStore = this._stateStore();
		if (!tmpStore) return null;
		let tmpExisting = this.getByHash(pHash);
		if (!tmpExisting) return null;
		tmpStore.update(TABLE_NAME, ID_COLUMN, tmpExisting[ID_COLUMN],
			{
				Status: pStatus || 'stopped',
				StatusDetail: pStatusDetail || ''
			});
		return this.getByHash(pHash);
	}

	remove(pHash)
	{
		let tmpStore = this._stateStore();
		if (!tmpStore) return 0;
		let tmpExisting = this.getByHash(pHash);
		if (!tmpExisting) return 0;
		let tmpDeleted = tmpStore.remove(TABLE_NAME, ID_COLUMN, tmpExisting[ID_COLUMN]);
		try { this._removeMirror(pHash); }
		catch (pErr)
		{
			this.fable.log.warn(`StackStore: mirror delete failed for ${pHash}: ${pErr.message}`);
		}
		this._recordEvent(tmpExisting,
			{
				EventType: 'stack-removed',
				Severity:  'info',
				Message:   `Stack "${tmpExisting.Name || tmpExisting.Hash}" removed`
			});
		return tmpDeleted;
	}

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
			this.fable.log.warn('StackStore: recordEvent failed: ' + pErr.message);
		}
	}

	// ====================================================================
	// Cloning
	// ====================================================================

	/**
	 * Clone a preset into an editable stack. Generates a fresh Hash
	 * suffixed with a short random token so two clones of the same
	 * preset don't collide.
	 *
	 * Doesn't persist — caller is expected to .save() after any
	 * customizations (or to save immediately for a no-edit clone).
	 */
	cloneFromPreset(pPresetHash, pNameOverride)
	{
		let tmpPreset = this.getPresetByHash(pPresetHash);
		if (!tmpPreset)
		{
			throw new Error(`StackStore.cloneFromPreset: preset [${pPresetHash}] not found`);
		}
		let tmpClone = JSON.parse(JSON.stringify(tmpPreset));
		let tmpSuffix = libCrypto.randomBytes(3).toString('hex');
		// Drop the "preset-" prefix on clones; they're editable now.
		let tmpBaseHash = tmpPreset.Hash.replace(/^preset-/, '');
		tmpClone.Hash = `${tmpBaseHash}-${tmpSuffix}`;
		tmpClone.Name = pNameOverride || tmpPreset.Name;
		tmpClone.PresetSource = tmpPreset.Hash;
		return tmpClone;
	}

	// ====================================================================
	// Mirror file I/O
	// ====================================================================

	getMirrorPath(pHash)
	{
		return libPath.join(this._MirrorDir, this._sanitizeHash(pHash) + '.json');
	}

	_sanitizeHash(pHash)
	{
		// Hashes are user-supplied; defend against path traversal even
		// though save() also validates Hash presence.
		return String(pHash || '').replace(/[^a-zA-Z0-9_.-]/g, '-').slice(0, 200);
	}

	_writeMirror(pSpec)
	{
		if (!libFs.existsSync(this._MirrorDir))
		{
			libFs.mkdirSync(this._MirrorDir, { recursive: true });
		}
		let tmpPath = this.getMirrorPath(pSpec.Hash);
		// Pretty-print + sort keys for diff legibility.
		let tmpText = JSON.stringify(this._stableKeys(pSpec), null, '\t');
		libFs.writeFileSync(tmpPath, tmpText + '\n', 'utf8');
	}

	_removeMirror(pHash)
	{
		let tmpPath = this.getMirrorPath(pHash);
		if (libFs.existsSync(tmpPath))
		{
			libFs.unlinkSync(tmpPath);
		}
	}

	// Sort top-level keys deterministically so two saves of the same
	// spec produce byte-identical files (clean git diffs).
	_stableKeys(pObj)
	{
		if (Array.isArray(pObj))
		{
			return pObj.map((pV) => this._stableKeys(pV));
		}
		if (pObj && typeof pObj === 'object')
		{
			let tmpOut = {};
			let tmpKeys = Object.keys(pObj).sort();
			for (let i = 0; i < tmpKeys.length; i++)
			{
				tmpOut[tmpKeys[i]] = this._stableKeys(pObj[tmpKeys[i]]);
			}
			return tmpOut;
		}
		return pObj;
	}

	// ====================================================================
	// JSON helpers
	// ====================================================================

	_stringifySpec(pSpec)
	{
		try { return JSON.stringify(pSpec); }
		catch (pErr)
		{
			throw new Error(`StackStore: spec is not JSON-serializable: ${pErr.message}`);
		}
	}

	_safeParseSpec(pText)
	{
		if (!pText || typeof pText !== 'string') return null;
		try { return JSON.parse(pText); }
		catch (pErr) { return null; }
	}

	_stringifyInputValues(pValues)
	{
		// Drop empties so saved JSON stays small and falsey-clean.
		let tmpClean = {};
		let tmpKeys = Object.keys(pValues || {});
		for (let i = 0; i < tmpKeys.length; i++)
		{
			let tmpV = pValues[tmpKeys[i]];
			if (tmpV !== undefined && tmpV !== null && tmpV !== '')
			{
				tmpClean[tmpKeys[i]] = tmpV;
			}
		}
		try { return JSON.stringify(tmpClean); }
		catch (pErr) { return '{}'; }
	}

	_safeParseInputValues(pText)
	{
		if (!pText || typeof pText !== 'string') return {};
		try
		{
			let tmpParsed = JSON.parse(pText);
			return (tmpParsed && typeof tmpParsed === 'object' && !Array.isArray(tmpParsed))
				? tmpParsed : {};
		}
		catch (pErr) { return {}; }
	}
}

module.exports = ServiceStackStore;
