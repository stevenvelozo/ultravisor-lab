/**
 * Service-SeedDatasetManager
 *
 * Catalog + runtime loader for the lab's packaged seed datasets.
 *
 * On boot, scans `seed_datasets/<name>/manifest.json` to build an in-memory
 * catalog.  When an Ultravisor instance is created the lab automatically
 * writes each dataset's `operation.json` (with path placeholders substituted)
 * into the Ultravisor's operation-library directory so the operations are
 * visible + runnable in the Ultravisor web UI, and callable via the Lab's
 * "Run seed dataset" flow.
 *
 * Triggering a seed run:
 *   runSeed({ DatasetHash, IDUltravisorInstance, IDDatabeacon }, fCallback)
 *     - Looks up target beacon URL via the Databeacon row
 *     - Registers the operation with the chosen Ultravisor (re-registering
 *       is idempotent since updateOperation upserts by Hash)
 *     - POSTs Operation/:hash/Execute/Async on the Ultravisor
 *     - Records an IngestionJob row tracking parsed/inserted counts
 */
'use strict';

const libPath = require('path');
const libFs = require('fs');
const libHttp = require('http');
const libFableServiceProviderBase = require('fable-serviceproviderbase');

const SEED_DATASETS_ROOT = libPath.resolve(__dirname, '..', '..', 'seed_datasets');

class ServiceSeedDatasetManager extends libFableServiceProviderBase
{
	constructor(pFable, pOptions, pServiceHash)
	{
		super(pFable, pOptions, pServiceHash);

		this.serviceType = 'LabSeedDatasetManager';

		this.catalog = this._buildCatalog();
	}

	// ── Catalog ─────────────────────────────────────────────────────────────

	_buildCatalog()
	{
		let tmpCatalog = [];
		let tmpEntries = [];
		try
		{
			tmpEntries = libFs.readdirSync(SEED_DATASETS_ROOT);
		}
		catch (pErr)
		{
			this.fable.log.warn(`SeedDatasetManager: cannot read ${SEED_DATASETS_ROOT} (${pErr.message})`);
			return [];
		}

		for (let i = 0; i < tmpEntries.length; i++)
		{
			let tmpEntry = tmpEntries[i];
			if (tmpEntry.startsWith('_') || tmpEntry.startsWith('.')) { continue; }
			let tmpDir = libPath.join(SEED_DATASETS_ROOT, tmpEntry);
			let tmpManifestPath = libPath.join(tmpDir, 'manifest.json');
			let tmpOperationPath = libPath.join(tmpDir, 'operation.json');
			if (!libFs.existsSync(tmpManifestPath) || !libFs.existsSync(tmpOperationPath)) { continue; }

			try
			{
				let tmpManifest = JSON.parse(libFs.readFileSync(tmpManifestPath, 'utf8'));
				let tmpOperation = JSON.parse(libFs.readFileSync(tmpOperationPath, 'utf8'));
				tmpCatalog.push(
					{
						FolderName:    tmpEntry,
						DatasetDir:    tmpDir,
						Manifest:      tmpManifest,
						OperationJSON: tmpOperation
					});
			}
			catch (pParseErr)
			{
				this.fable.log.warn(`SeedDatasetManager: invalid JSON in ${tmpEntry}: ${pParseErr.message}`);
			}
		}
		return tmpCatalog;
	}

	list()
	{
		return this.catalog.map((pEntry) =>
			{
				return {
					FolderName:    pEntry.FolderName,
					Hash:          pEntry.Manifest.Hash,
					Name:          pEntry.Manifest.Name,
					Description:   pEntry.Manifest.Description,
					OperationHash: pEntry.Manifest.OperationHash,
					Correlation:   pEntry.Manifest.Correlation || '',
					Entities:      pEntry.Manifest.Entities || [],
					TotalRows:     (pEntry.Manifest.Entities || []).reduce((pSum, pE) => pSum + (pE.RowCount || 0), 0)
				};
			});
	}

	get(pHash)
	{
		return this.catalog.find((pEntry) => pEntry.Manifest.Hash === pHash) || null;
	}

	// ── Operation provisioning ──────────────────────────────────────────────
	/**
	 * Write all seed operations into a specific Ultravisor's operation-library
	 * directory, after substituting {LAB_SEED_PATH} with the absolute path of
	 * the dataset fixture directory.  BeaconURL stays as a runtime-supplied
	 * placeholder -- it's filled in when the operation is triggered.
	 */
	provisionOperationsForUltravisor(pInstanceID)
	{
		let tmpUvMgr = this.fable.LabUltravisorManager;
		let tmpInstance = tmpUvMgr.getInstance(pInstanceID);
		if (!tmpInstance) { return { Loaded: 0, Error: 'Ultravisor not found.' }; }

		let tmpLoaded = 0;
		for (let i = 0; i < this.catalog.length; i++)
		{
			let tmpEntry = this.catalog[i];
			let tmpOp = this._substitutePaths(tmpEntry.OperationJSON, tmpEntry.DatasetDir);
			tmpUvMgr.writeOperationFile(pInstanceID, tmpOp.Hash, tmpOp);
			tmpLoaded++;
		}
		return { Loaded: tmpLoaded };
	}

	_substitutePaths(pOperation, pDatasetDir)
	{
		let tmpText = JSON.stringify(pOperation);
		tmpText = tmpText.split('{LAB_SEED_PATH}').join(pDatasetDir);
		return JSON.parse(tmpText);
	}

	// ── Quick-seed: auto-provision DB + beacon on an engine, then run ──────

	/**
	 * One-click seed: given a running Ultravisor + DB engine, idempotently
	 * provision a database and databeacon named after the dataset and then
	 * invoke the normal runSeed flow.  Names are deterministic so repeat
	 * clicks reuse the existing rows instead of piling up.
	 *
	 * pRequest = { DatasetHash, IDUltravisorInstance, IDDBEngine }
	 */
	runSeedIntoEngine(pRequest, fCallback)
	{
		let tmpEngineMgr = this.fable.LabDBEngineManager;

		let tmpEntry = this.get(pRequest.DatasetHash);
		if (!tmpEntry) { return fCallback(new Error(`Unknown seed dataset: ${pRequest.DatasetHash}`)); }

		let tmpInstance = this.fable.LabUltravisorManager.getInstance(parseInt(pRequest.IDUltravisorInstance, 10));
		if (!tmpInstance) { return fCallback(new Error('Ultravisor not found.')); }
		if (tmpInstance.Status !== 'running') { return fCallback(new Error('Ultravisor is not running.')); }

		let tmpEngine = tmpEngineMgr.getEngine(parseInt(pRequest.IDDBEngine, 10));
		if (!tmpEngine) { return fCallback(new Error('DB engine not found.')); }
		if (tmpEngine.Status !== 'running') { return fCallback(new Error('DB engine is not running.')); }

		// Deterministic names.  Database identifiers have a strict charset
		// (see DBEngineManager.createDatabase); beacons are freer.
		let tmpSlug = this._slugify(tmpEntry.FolderName);
		let tmpDbName     = `seed_${tmpSlug.replace(/-/g, '_')}`;
		let tmpBeaconName = `seed-${tmpSlug}`;

		// The seed operation dispatches two beacon capabilities that only
		// a meadow-integration beacon advertises -- ParseFile and
		// LabWriter.BulkInsertViaBeacon.  Provision one on the target UV
		// if none is already registered.
		this._ensureMIBeacon(tmpInstance,
			(pMiErr) =>
			{
				if (pMiErr) { return fCallback(pMiErr); }

				this._ensureDatabase(tmpEngine, tmpDbName,
					(pDbErr, pDatabase) =>
					{
						if (pDbErr) { return fCallback(pDbErr); }

						this._ensureBeacon(tmpEngine, pDatabase, tmpInstance, tmpBeaconName,
							(pBeaconErr, pBeacon) =>
							{
								if (pBeaconErr) { return fCallback(pBeaconErr); }

								// Beacon may have just been spawned; poll until the
								// state store sees it as 'running' before kicking off
								// the seed (matches the normal flow's expectations).
								this._waitForBeaconRunning(pBeacon.IDBeacon, 0,
									(pReadyErr) =>
									{
										if (pReadyErr) { return fCallback(pReadyErr); }

										this.runSeed(
											{
												DatasetHash:           pRequest.DatasetHash,
												IDUltravisorInstance:  tmpInstance.IDUltravisorInstance,
												IDBeacon:              pBeacon.IDBeacon
											},
											fCallback);
									});
							});
					});
			});
	}

	/**
	 * Ensure a meadow-integration beacon is present (and running) on
	 * pInstance.  Reuses any existing row of type `meadow-integration`
	 * registered with the UV; otherwise creates one on a free port via
	 * BeaconManager and waits for readiness.  Idempotent.
	 */
	_ensureMIBeacon(pInstance, fCallback)
	{
		let tmpStore = this.fable.LabStateStore;
		let tmpBeaconMgr = this.fable.LabBeaconManager;

		// Look for an existing meadow-integration beacon on this UV.
		let tmpExisting = tmpStore.list('Beacon', { BeaconType: 'meadow-integration' })
			.find((pB) => pB.IDUltravisorInstance === pInstance.IDUltravisorInstance);

		if (tmpExisting)
		{
			if (tmpExisting.Status === 'running') { return fCallback(null, tmpExisting); }
			// Exists but not running; wait for it to come back up.
			return this._waitForBeaconRunning(tmpExisting.IDBeacon, 0,
				(pErr) => fCallback(pErr, tmpExisting));
		}

		this.fable.LabPortAllocator.findFreePort(54400,
			(pPortErr, pPort) =>
			{
				if (pPortErr) { return fCallback(pPortErr); }

				tmpBeaconMgr.createBeacon(
					{
						Name:                 `mi-${pInstance.Name}`,
						BeaconType:           'meadow-integration',
						Port:                 pPort,
						IDUltravisorInstance: pInstance.IDUltravisorInstance,
						Config:               {}
					},
					(pCreateErr, pResult) =>
					{
						if (pCreateErr) { return fCallback(pCreateErr); }
						this._waitForBeaconRunning(pResult.IDBeacon, 0,
							(pReadyErr) =>
							{
								if (pReadyErr) { return fCallback(pReadyErr); }
								return fCallback(null, tmpStore.getById('Beacon', 'IDBeacon', pResult.IDBeacon));
							});
					});
			});
	}

	_slugify(pInput)
	{
		return String(pInput || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
	}

	_ensureDatabase(pEngine, pDbName, fCallback)
	{
		let tmpStore = this.fable.LabStateStore;
		// Look for an existing Database row with this name on this engine.
		let tmpRows = tmpStore.list('Database', { IDDBEngine: pEngine.IDDBEngine });
		for (let i = 0; i < tmpRows.length; i++)
		{
			if (tmpRows[i].Name === pDbName) { return fCallback(null, tmpRows[i]); }
		}
		this.fable.LabDBEngineManager.createDatabase(pEngine.IDDBEngine, pDbName,
			(pErr, pResult) =>
			{
				if (pErr) { return fCallback(pErr); }
				let tmpDb = tmpStore.getById('Database', 'IDDatabase', pResult.IDDatabase);
				return fCallback(null, tmpDb);
			});
	}

	_ensureBeacon(pEngine, pDatabase, pInstance, pBeaconName, fCallback)
	{
		let tmpStore = this.fable.LabStateStore;
		// Reuse an existing Beacon row targeting this engine+database with
		// the same name to make repeat clicks idempotent.  Type is fixed to
		// `retold-databeacon` since that's the beacon shape the seed flow
		// writes rows into.
		let tmpRows = tmpStore.list('Beacon', { BeaconType: 'retold-databeacon' });
		for (let i = 0; i < tmpRows.length; i++)
		{
			let tmpRow = tmpRows[i];
			if (tmpRow.Name !== pBeaconName) { continue; }
			let tmpCfg = {};
			try { tmpCfg = JSON.parse(tmpRow.ConfigJSON || '{}'); } catch (pEx) { /* ignore */ }
			if (tmpCfg.IDDBEngine === pEngine.IDDBEngine && tmpCfg.IDDatabase === pDatabase.IDDatabase)
			{
				return fCallback(null, tmpRow);
			}
		}

		this.fable.LabPortAllocator.findFreePort(8500,
			(pPortErr, pPort) =>
			{
				if (pPortErr) { return fCallback(pPortErr); }

				this.fable.LabBeaconManager.createBeacon(
					{
						Name:                 pBeaconName,
						BeaconType:           'retold-databeacon',
						Port:                 pPort,
						IDUltravisorInstance: pInstance.IDUltravisorInstance,
						Config:
						{
							IDDBEngine: pEngine.IDDBEngine,
							IDDatabase: pDatabase.IDDatabase
						}
					},
					(pCreateErr, pResult) =>
					{
						if (pCreateErr) { return fCallback(pCreateErr); }
						let tmpBeacon = tmpStore.getById('Beacon', 'IDBeacon', pResult.IDBeacon);
						return fCallback(null, tmpBeacon);
					});
			});
	}

	_waitForBeaconRunning(pBeaconID, pAttempt, fCallback)
	{
		let tmpStore = this.fable.LabStateStore;
		let tmpBeacon = tmpStore.getById('Beacon', 'IDBeacon', pBeaconID);
		if (!tmpBeacon) { return fCallback(new Error('Beacon vanished while waiting for readiness.')); }
		if (tmpBeacon.Status === 'running') { return fCallback(null); }
		if (tmpBeacon.Status === 'failed')  { return fCallback(new Error(`Beacon failed: ${tmpBeacon.StatusDetail || 'unknown'}`)); }
		if (pAttempt >= 60)                 { return fCallback(new Error('Beacon did not reach running state within 60 seconds.')); }
		setTimeout(() => this._waitForBeaconRunning(pBeaconID, pAttempt + 1, fCallback), 1000);
	}

	// ── Run a seed ─────────────────────────────────────────────────────────

	runSeed(pRequest, fCallback)
	{
		let tmpStore  = this.fable.LabStateStore;
		let tmpUvMgr  = this.fable.LabUltravisorManager;

		let tmpHash = pRequest.DatasetHash;
		let tmpInstanceID = parseInt(pRequest.IDUltravisorInstance, 10);
		let tmpBeaconID   = parseInt(pRequest.IDBeacon, 10);

		let tmpEntry = this.get(tmpHash);
		if (!tmpEntry) { return fCallback(new Error(`Unknown seed dataset: ${tmpHash}`)); }

		let tmpInstance = tmpUvMgr.getInstance(tmpInstanceID);
		if (!tmpInstance) { return fCallback(new Error('Ultravisor not found.')); }
		if (tmpInstance.Status !== 'running') { return fCallback(new Error('Ultravisor is not running.')); }

		let tmpBeacon = tmpStore.getById('Beacon', 'IDBeacon', tmpBeaconID);
		if (!tmpBeacon) { return fCallback(new Error('Beacon not found.')); }
		if (tmpBeacon.Status !== 'running') { return fCallback(new Error('Beacon is not running.')); }
		if (tmpBeacon.BeaconType !== 'retold-databeacon')
		{
			return fCallback(new Error(`Beacon '${tmpBeacon.Name}' is a ${tmpBeacon.BeaconType}, not a retold-databeacon; seed flow can only target retold-databeacon beacons.`));
		}

		let tmpCfg = {};
		try { tmpCfg = JSON.parse(tmpBeacon.ConfigJSON || '{}'); } catch (pEx) { /* ignore */ }
		let tmpEngine = tmpCfg.IDDBEngine ? this.fable.LabDBEngineManager.getEngine(tmpCfg.IDDBEngine) : null;
		let tmpDatabase = tmpCfg.IDDatabase ? tmpStore.getById('Database', 'IDDatabase', tmpCfg.IDDatabase) : null;
		if (!tmpEngine || !tmpDatabase)
		{
			return fCallback(new Error(`Beacon '${tmpBeacon.Name}' has no attached engine/database; seed flow needs both.`));
		}

		// The databeacon's dynamic endpoints live at /1.0/<route-hash>/<Entity>,
		// where route-hash is the connection name with non-URL-safe chars
		// (notably underscores) replaced by hyphens.
		let tmpRawName = `lab-${tmpEngine.EngineType}-${tmpDatabase.Name}`;
		let tmpRouteHash = tmpRawName.toLowerCase().replace(/[^a-z0-9-]+/g, '-');
		let tmpBeaconURL = `http://127.0.0.1:${tmpBeacon.Port}/1.0/${tmpRouteHash}`;
		let tmpOperation = this._substitutePaths(tmpEntry.OperationJSON, tmpEntry.DatasetDir);
		tmpOperation = JSON.parse(JSON.stringify(tmpOperation).split('{TARGET_BEACON_URL}').join(tmpBeaconURL));

		let tmpJobID = tmpStore.insert('IngestionJob',
			{
				IDFactoInstance: 0,
				DatasetName:     tmpEntry.Manifest.Name,
				Status:          'submitting',
				StartedAt:       new Date().toISOString()
			});

		tmpStore.recordEvent(
			{
				EntityType: 'IngestionJob', EntityID: tmpJobID, EntityName: tmpEntry.Manifest.Name,
				EventType: 'seed-submitted', Severity: 'info',
				Message: `Submitting seed '${tmpEntry.Manifest.Name}' to ultravisor '${tmpInstance.Name}' -> beacon '${tmpBeacon.Name}'`
			});

		// Pre-flight: materialize target schema + enable beacon endpoints.
		// Writing records to /1.0/<Entity> requires (a) the table to exist in
		// the real database, and (b) the beacon's dynamic endpoint manager to
		// have it enabled.  Both steps are idempotent.
		this._prepareTargetSchema(tmpEntry, tmpBeacon, tmpEngine, tmpDatabase, tmpJobID,
			(pPrepErr) =>
			{
				if (pPrepErr)
				{
					tmpStore.update('IngestionJob', 'IDIngestionJob', tmpJobID,
						{ Status: 'failed', ErrorMessage: `prepare: ${pPrepErr.message}`, CompletedAt: new Date().toISOString() });
					return fCallback(pPrepErr);
				}
				this._submitOperation(tmpUvMgr, tmpInstanceID, tmpOperation, tmpJobID, fCallback);
			});
	}

	_submitOperation(pUvMgr, pInstanceID, pOperation, pJobID, fCallback)
	{
		let tmpStore = this.fable.LabStateStore;

		pUvMgr.registerOperation(pInstanceID, pOperation,
			(pRegErr) =>
			{
				if (pRegErr)
				{
					tmpStore.update('IngestionJob', 'IDIngestionJob', pJobID,
						{ Status: 'failed', ErrorMessage: `register: ${pRegErr.message}`, CompletedAt: new Date().toISOString() });
					return fCallback(pRegErr);
				}

				pUvMgr.triggerOperation(pInstanceID, pOperation.Hash, {},
					(pTriggerErr, pResult) =>
					{
						if (pTriggerErr)
						{
							tmpStore.update('IngestionJob', 'IDIngestionJob', pJobID,
								{ Status: 'failed', ErrorMessage: `trigger: ${pTriggerErr.message}`, CompletedAt: new Date().toISOString() });
							return fCallback(pTriggerErr);
						}

						let tmpRunHash = pResult && (pResult.RunHash || pResult.Hash || pResult.runHash);
						tmpStore.update('IngestionJob', 'IDIngestionJob', pJobID,
							{ Status: 'running', ErrorMessage: tmpRunHash ? `RunHash=${tmpRunHash}` : '' });

						this._pollRun(pInstanceID, tmpRunHash, pJobID, 0);

						return fCallback(null,
							{
								IDIngestionJob: pJobID,
								RunHash:        tmpRunHash || null,
								OperationHash:  pOperation.Hash,
								Status:         'running'
							});
					});
			});
	}

	// ── Schema materialization + endpoint enabling ──────────────────────────

	_prepareTargetSchema(pEntry, pBeacon, pEngine, pDatabase, pJobID, fCallback)
	{
		let tmpStore = this.fable.LabStateStore;

		let tmpSqls = [];
		let tmpEntities = pEntry.Manifest.Entities || [];
		for (let i = 0; i < tmpEntities.length; i++)
		{
			let tmpEnt = tmpEntities[i];
			let tmpSql = this._emitMySqlCreateTable(tmpEnt.Name, tmpEnt.Schema);
			if (tmpSql) { tmpSqls.push(tmpSql); }
		}
		if (tmpSqls.length === 0) { return fCallback(null); }

		// Run all CREATE TABLEs in one mysql exec call.
		this.fable.LabDockerManager.exec(pEngine.ContainerID,
			[
				'mysql',
				'-h', '127.0.0.1',
				'-u', pEngine.RootUsername,
				`-p${pEngine.RootPassword}`,
				pDatabase.Name,
				'-e', tmpSqls.join('\n')
			],
			{ TimeoutMs: 30000 },
			(pExecErr, pExecResult) =>
			{
				if (pExecErr) { return fCallback(pExecErr); }
				if (pExecResult.ExitCode !== 0)
				{
					return fCallback(new Error((pExecResult.Stderr || pExecResult.Stdout).trim().slice(0, 240)));
				}

				tmpStore.recordEvent(
					{
						EntityType: 'IngestionJob', EntityID: pJobID,
						EventType: 'seed-schema-applied', Severity: 'info',
						Message: `Applied ${tmpSqls.length} table definition(s) to ${pEngine.Name}/${pDatabase.Name}`
					});

				// Wire the databeacon's live connection to the engine DB, then
				// ask it to re-introspect + enable endpoints for our entities.
				// Without the connection the dynamic /1.0/<hash>/<Entity>
				// routes aren't registered, and BulkInsertViaBeacon's POSTs
				// get 404s (InsertedCount stays at 0).
				this._ensureBeaconConnection(pBeacon, pEngine, pDatabase,
					(pConnErr) =>
					{
						if (pConnErr)
						{
							// Non-fatal: operation may still submit.  Record
							// the warning so users can see why rows didn't
							// land when the counts come back empty.
							tmpStore.recordEvent(
								{
									EntityType: 'IngestionJob', EntityID: pJobID,
									EventType: 'seed-connection-warning', Severity: 'warning',
									Message: `Beacon connection wiring failed: ${pConnErr.message}`
								});
						}
						this._introspectAndEnable(pBeacon, tmpEntities, fCallback);
					});
			});
	}

	// Mapping from lab engine-type slugs to the retold-databeacon `Type`
	// column the /beacon/connection endpoint expects.
	static get _ENGINE_TYPE_TO_BEACON_TYPE()
	{
		return {
			mysql:    'MySQL',
			mssql:    'MSSQL',
			postgres: 'PostgreSQL',
			mongodb:  'MongoDB'
		};
	}

	/**
	 * Make sure the databeacon has a live BeaconConnection pointing at
	 * pEngine/pDatabase.  Creates one + connects it if not already present.
	 * Idempotent: a repeat call with the same name is a no-op.
	 */
	_ensureBeaconConnection(pBeacon, pEngine, pDatabase, fCallback)
	{
		let tmpName = `lab-${pEngine.EngineType}-${pDatabase.Name}`;

		this._beaconGet(pBeacon.Port, '/beacon/connections',
			(pListErr, pListBody) =>
			{
				if (pListErr) { return fCallback(pListErr); }

				let tmpExistingID = 0;
				try
				{
					let tmpParsed = JSON.parse(pListBody);
					let tmpConns = tmpParsed.Connections || [];
					let tmpMatch = tmpConns.find((pC) => pC.Name === tmpName);
					if (tmpMatch) { tmpExistingID = tmpMatch.IDBeaconConnection; }
				}
				catch (pEx) { /* ignore, fall through to create */ }

				if (tmpExistingID)
				{
					// Already present; connect it just in case the beacon was
					// restarted and the runtime pool is cold.
					return this._beaconPost(pBeacon.Port,
						`/beacon/connection/${tmpExistingID}/connect`,
						'{}',
						() => fCallback(null, tmpExistingID));
				}

				let tmpBeaconType = ServiceSeedDatasetManager._ENGINE_TYPE_TO_BEACON_TYPE[pEngine.EngineType];
				if (!tmpBeaconType)
				{
					return fCallback(new Error(`Engine type '${pEngine.EngineType}' is not supported by retold-databeacon's connection bridge.`));
				}

				let tmpBody = JSON.stringify(
					{
						Name:   tmpName,
						Type:   tmpBeaconType,
						Config:
						{
							Server:   '127.0.0.1',
							Port:     pEngine.Port,
							User:     pEngine.RootUsername,
							Password: pEngine.RootPassword,
							Database: pDatabase.Name
						},
						AutoConnect: true,
						Description: 'Auto-created by ultravisor-lab quick-seed'
					});

				this._beaconPost(pBeacon.Port, '/beacon/connection', tmpBody,
					(pCreateErr, pCreateBody) =>
					{
						if (pCreateErr) { return fCallback(pCreateErr); }

						let tmpNewID = 0;
						try
						{
							let tmpParsed = JSON.parse(pCreateBody);
							if (tmpParsed.Success && tmpParsed.Connection)
							{
								tmpNewID = tmpParsed.Connection.IDBeaconConnection;
							}
							else if (tmpParsed.Error)
							{
								return fCallback(new Error(tmpParsed.Error));
							}
						}
						catch (pEx) { return fCallback(pEx); }

						if (!tmpNewID) { return fCallback(new Error('Beacon connection create returned no ID.')); }

						// Establish the live runtime pool so dynamic endpoints
						// have something to execute against.
						this._beaconPost(pBeacon.Port,
							`/beacon/connection/${tmpNewID}/connect`,
							'{}',
							() => fCallback(null, tmpNewID));
					});
			});
	}

	_emitMySqlCreateTable(pTableName, pSchema)
	{
		if (!pSchema || !Array.isArray(pSchema.Columns) || pSchema.Columns.length === 0) { return null; }

		let tmpCols = pSchema.Columns.map((pCol) => this._emitMySqlColumn(pCol)).filter(Boolean);
		if (tmpCols.length === 0) { return null; }

		return `CREATE TABLE IF NOT EXISTS \`${pTableName}\` (\n  ${tmpCols.join(',\n  ')}\n) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;`;
	}

	_emitMySqlColumn(pCol)
	{
		let tmpName = `\`${pCol.Name}\``;
		switch (pCol.Type)
		{
			case 'AutoIdentity': return `${tmpName} INT NOT NULL AUTO_INCREMENT PRIMARY KEY`;
			case 'Integer':      return `${tmpName} INT NULL`;
			case 'String':       return `${tmpName} VARCHAR(${pCol.Size || 255}) NULL`;
			case 'Decimal':      return `${tmpName} DECIMAL(${pCol.Precision || 10},${pCol.Scale || 2}) NULL`;
			case 'Boolean':      return `${tmpName} TINYINT(1) NULL`;
			case 'DateTime':     return `${tmpName} DATETIME NULL`;
			default:             return `${tmpName} VARCHAR(255) NULL`;
		}
	}

	_introspectAndEnable(pBeacon, pEntities, fCallback)
	{
		// List existing connections, pick ours (by name match), then enable
		// endpoints for the entities we care about.
		this._beaconGet(pBeacon.Port, '/beacon/connections', (pListErr, pBody) =>
			{
				if (pListErr) { return fCallback(null); }  // non-fatal; operation may still work

				let tmpConnID = 0;
				try
				{
					let tmpParsed = JSON.parse(pBody);
					let tmpConns = tmpParsed.Connections || [];
					if (tmpConns.length > 0) { tmpConnID = tmpConns[0].IDBeaconConnection; }
				}
				catch (pEx) { /* ignore */ }

				if (!tmpConnID) { return fCallback(null); }

				// Re-introspect so the new tables are visible to the beacon.
				this._beaconPost(pBeacon.Port, `/beacon/connection/${tmpConnID}/introspect`, '{}', () =>
					{
						let tmpIdx = 0;
						let tmpEnableNext = () =>
						{
							if (tmpIdx >= pEntities.length) { return fCallback(null); }
							let tmpEntity = pEntities[tmpIdx++];
							this._beaconPost(pBeacon.Port,
								`/beacon/endpoint/${tmpConnID}/${tmpEntity.Name}/enable`,
								'{}',
								() => setImmediate(tmpEnableNext));
						};
						tmpEnableNext();
					});
			});
	}

	_beaconPost(pPort, pPath, pBody, fCallback)
	{
		let tmpReq = libHttp.request(
			{
				host: '127.0.0.1',
				port: pPort,
				path: pPath,
				method: 'POST',
				headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(pBody) },
				timeout: 15000
			},
			(pRes) =>
			{
				let tmpChunks = [];
				pRes.on('data', (c) => tmpChunks.push(c));
				pRes.on('end', () => fCallback(null, Buffer.concat(tmpChunks).toString('utf8')));
			});
		tmpReq.on('error', (pErr) => fCallback(pErr));
		tmpReq.on('timeout', () => { tmpReq.destroy(); fCallback(new Error('timeout')); });
		tmpReq.write(pBody);
		tmpReq.end();
	}

	_beaconGet(pPort, pPath, fCallback)
	{
		let tmpReq = libHttp.get({ host: '127.0.0.1', port: pPort, path: pPath, timeout: 10000 },
			(pRes) =>
			{
				let tmpChunks = [];
				pRes.on('data', (c) => tmpChunks.push(c));
				pRes.on('end', () => fCallback(null, Buffer.concat(tmpChunks).toString('utf8')));
			});
		tmpReq.on('error', (pErr) => fCallback(pErr));
		tmpReq.on('timeout', () => { tmpReq.destroy(); fCallback(new Error('timeout')); });
	}

	_pollRun(pInstanceID, pRunHash, pJobID, pAttempt)
	{
		if (!pRunHash) { return; }
		let tmpStore = this.fable.LabStateStore;
		let tmpUvMgr = this.fable.LabUltravisorManager;

		if (pAttempt > 60)  // ~3 minutes with 3-second interval
		{
			tmpStore.update('IngestionJob', 'IDIngestionJob', pJobID,
				{ Status: 'timed-out', CompletedAt: new Date().toISOString() });
			return;
		}

		tmpUvMgr.getRunManifest(pInstanceID, pRunHash,
			(pErr, pManifest) =>
			{
				if (pErr || !pManifest)
				{
					setTimeout(() => this._pollRun(pInstanceID, pRunHash, pJobID, pAttempt + 1), 3000);
					return;
				}

				let tmpStatus = (pManifest.Status || '').toLowerCase();
				if (tmpStatus === 'complete' || tmpStatus === 'error' || tmpStatus === 'failed')
				{
					let tmpCounts = this._extractCounts(pManifest);
					tmpStore.update('IngestionJob', 'IDIngestionJob', pJobID,
						{
							Status:        tmpStatus === 'complete' ? 'complete' : 'failed',
							ParsedCount:   tmpCounts.Parsed,
							LoadedCount:   tmpCounts.Inserted,
							VerifiedCount: tmpCounts.Inserted,
							ErrorMessage:  tmpCounts.Error || '',
							CompletedAt:   new Date().toISOString()
						});
					tmpStore.recordEvent(
						{
							EntityType: 'IngestionJob', EntityID: pJobID,
							EventType:  tmpStatus === 'complete' ? 'seed-complete' : 'seed-failed',
							Severity:   tmpStatus === 'complete' ? 'info' : 'error',
							Message:    tmpStatus === 'complete'
								? `Seed '${pJobID}' complete: parsed=${tmpCounts.Parsed}, inserted=${tmpCounts.Inserted}`
								: `Seed '${pJobID}' failed: ${tmpCounts.Error}`,
							Detail:     tmpCounts
						});
					return;
				}

				setTimeout(() => this._pollRun(pInstanceID, pRunHash, pJobID, pAttempt + 1), 3000);
			});
	}

	_extractCounts(pManifest)
	{
		let tmpParsed = 0;
		let tmpInserted = 0;
		let tmpError = '';
		let tmpOutputs = pManifest.TaskOutputs || {};
		for (let tmpKey of Object.keys(tmpOutputs))
		{
			let tmpOut = tmpOutputs[tmpKey];
			if (!tmpOut) { continue; }
			if (typeof tmpOut.Count === 'number' && tmpKey.indexOf('parse-') === 0) { tmpParsed += tmpOut.Count; }
			if (typeof tmpOut.InsertedCount === 'number') { tmpInserted += tmpOut.InsertedCount; }
			if (tmpOut.Error) { tmpError = tmpOut.Error; }
		}
		if (Array.isArray(pManifest.Errors) && pManifest.Errors.length > 0)
		{
			tmpError = tmpError || (pManifest.Errors[0].Message || JSON.stringify(pManifest.Errors[0]));
		}
		return { Parsed: tmpParsed, Inserted: tmpInserted, Error: tmpError };
	}

	listJobs()
	{
		return this.fable.LabStateStore.list('IngestionJob');
	}
}

module.exports = ServiceSeedDatasetManager;
