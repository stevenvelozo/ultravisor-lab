/**
 * Service-OperationStore
 *
 * Read-only library of init / orchestration operation graphs available to
 * Service-StackInitializer. Mirrors the "additional dirs" pattern the
 * StackStore already uses for presets — bundled operations live under
 * source/operations/, downstream apps inject more via AdditionalOperationDirs
 * in setupLabServer.
 *
 * Operation files are JSON graphs in the same shape ultravisor's
 * /Operation endpoint accepts (Hash, Name, Description, Graph: { Nodes, Edges? },
 * plus optional Tier/Author/Version metadata).  When an init step pushes
 * an operation into a running ultravisor, StackInitializer reads the file
 * via getByHash() then POSTs it.
 *
 * Public API:
 *   listOperations()                 → [{ Hash, Name, Description, ... }]
 *   getByHash(pHash)                 → full operation spec or null
 *   registerOperationDirectory(pDir) → add a dir at runtime; invalidates cache
 */

'use strict';

const libPath = require('path');
const libFs = require('fs');
const libFableServiceProviderBase = require('fable-serviceproviderbase');

// The lab does not currently ship any bundled operations of its own
// (downstream apps own their init flows). Keeping the constant here so the
// scan logic mirrors StackStore's bundled-vs-additional pattern even
// when the bundled list is empty.
const BUNDLED_OPERATIONS_DIR = libPath.resolve(__dirname, '..', 'operations');

class ServiceOperationStore extends libFableServiceProviderBase
{
	constructor(pFable, pOptions, pServiceHash)
	{
		super(pFable, pOptions, pServiceHash);
		this.serviceType = 'LabOperationStore';

		this._AdditionalOperationDirs = [];
		let tmpDirsFromOptions = (pOptions && pOptions.AdditionalOperationDirs);
		let tmpDirsFromSettings = (this.fable.settings && this.fable.settings.LabAdditionalOperationDirs);
		let tmpDirs = Array.isArray(tmpDirsFromOptions) ? tmpDirsFromOptions
			: Array.isArray(tmpDirsFromSettings) ? tmpDirsFromSettings : [];
		for (let i = 0; i < tmpDirs.length; i++)
		{
			if (typeof tmpDirs[i] === 'string' && tmpDirs[i].length > 0)
			{
				this._AdditionalOperationDirs.push(libPath.resolve(tmpDirs[i]));
			}
		}

		this._Operations = null;
	}

	registerOperationDirectory(pDir)
	{
		if (typeof pDir !== 'string' || pDir.length === 0) return;
		let tmpAbs = libPath.resolve(pDir);
		if (this._AdditionalOperationDirs.indexOf(tmpAbs) === -1)
		{
			this._AdditionalOperationDirs.push(tmpAbs);
		}
		this._Operations = null;
	}

	listOperations()
	{
		if (this._Operations) return this._Operations;
		this._Operations = [];
		this._scanOperationDirectory(BUNDLED_OPERATIONS_DIR, 'bundled');
		for (let i = 0; i < this._AdditionalOperationDirs.length; i++)
		{
			this._scanOperationDirectory(this._AdditionalOperationDirs[i], 'extension');
		}
		return this._Operations;
	}

	getByHash(pHash)
	{
		let tmpAll = this.listOperations();
		for (let i = 0; i < tmpAll.length; i++)
		{
			if (tmpAll[i].Hash === pHash) return tmpAll[i];
		}
		return null;
	}

	_scanOperationDirectory(pDir, pSourceLabel)
	{
		try
		{
			if (!libFs.existsSync(pDir)) { return; }
			let tmpFiles = libFs.readdirSync(pDir).filter((pF) => pF.endsWith('.json')).sort();
			for (let i = 0; i < tmpFiles.length; i++)
			{
				let tmpPath = libPath.join(pDir, tmpFiles[i]);
				try
				{
					let tmpSpec = JSON.parse(libFs.readFileSync(tmpPath, 'utf8'));
					if (!tmpSpec.Hash)
					{
						this.fable.log.warn(`OperationStore: operation ${tmpFiles[i]} (${pSourceLabel}) missing Hash; skipping.`);
						continue;
					}
					let tmpExistingIndex = this._Operations.findIndex((pP) => pP.Hash === tmpSpec.Hash);
					if (tmpExistingIndex >= 0)
					{
						this.fable.log.warn(`OperationStore: operation Hash [${tmpSpec.Hash}] from ${pSourceLabel} (${tmpPath}) is overriding an earlier registration.`);
						this._Operations[tmpExistingIndex] = tmpSpec;
					}
					else
					{
						this._Operations.push(tmpSpec);
					}
				}
				catch (pErr)
				{
					this.fable.log.warn(`OperationStore: operation ${tmpFiles[i]} (${pSourceLabel}) failed to parse: ${pErr.message}`);
				}
			}
		}
		catch (pErr)
		{
			this.fable.log.warn(`OperationStore: scan of ${pDir} (${pSourceLabel}) failed: ${pErr.message}`);
		}
	}
}

module.exports = ServiceOperationStore;
