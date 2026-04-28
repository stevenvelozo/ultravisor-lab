/**
 * Service-StateStore
 *
 * Persists ultravisor-lab state to SQLite at data/lab.db.
 *
 * Schema covers every entity the lab supervises: dockerized DB engines,
 * databases inside them, ultravisor instances, databeacons, facto instances,
 * ingestion jobs, and a flat infrastructure event log for the UI timeline.
 *
 * Backed by the meadow DAL — schema lives in `model/MeadowModel-Lab.json`
 * and is the single source of truth. Bootstrap runs:
 *
 *   1. `Meadow.loadFromPackageObject(...)` per table → DAL handles
 *   2. The connector's `createTables` (idempotent CREATE TABLE IF NOT EXISTS)
 *   3. `meadow-migrationmanager` (introspect → diff → forward-only filter →
 *      generate ALTER → execute) for incremental ADD COLUMN
 *
 * No more drift between a hand-written `CREATE TABLE` template and a
 * separate `_applyColumnMigrations` array. Adding a column is one edit
 * to the JSON model.
 *
 * The public `list / getById / insert / update / remove / recordEvent /
 * listEvents` API stays synchronous (returns values, not callbacks) —
 * meadow's SQLite path resolves callbacks before the call returns
 * (better-sqlite3 is sync), so the wrappers capture results into a
 * local var and return them. Existing call sites need no churn.
 */
'use strict';

const libPath = require('path');
const libFs = require('fs');
const libFableServiceProviderBase = require('fable-serviceproviderbase');
const libMeadowConnectionSQLite = require('meadow-connection-sqlite');
const libMeadow = require('meadow');
const libMeadowMigrationManager = require('meadow-migrationmanager');

const MODEL_PATH = libPath.resolve(__dirname, '..', '..', 'model', 'MeadowModel-Lab.json');

// Reads cap. Lab tables are small; a 1000-row default is comfortably
// above any real-world count and avoids paging in the generic helpers.
const DEFAULT_READS_CAP = 1000;

class ServiceStateStore extends libFableServiceProviderBase
{
	constructor(pFable, pOptions, pServiceHash)
	{
		super(pFable, pOptions, pServiceHash);

		this.serviceType = 'LabStateStore';

		this.dataDir  = (pOptions && pOptions.DataDir)  ? pOptions.DataDir  : libPath.resolve(__dirname, '..', '..', 'data');
		this.dbPath   = libPath.join(this.dataDir, 'lab.db');

		// Direct better-sqlite3 handle — kept around for the migration
		// manager's ALTER execution path and as a debug escape hatch.
		// All CRUD goes through the meadow DAL.
		this.db = null;

		// Map<TableName, MeadowDAL>
		this._DAL = {};
		this._Model = null;
	}

	initialize(fCallback)
	{
		try
		{
			libFs.mkdirSync(this.dataDir, { recursive: true });
		}
		catch (pMkdirError)
		{
			return fCallback(pMkdirError);
		}

		if (!this.fable.settings.SQLite)
		{
			this.fable.settings.SQLite = {};
		}
		this.fable.settings.SQLite.SQLiteFilePath = this.dbPath;
		// Tell meadow which provider DALs should target.
		this.fable.settings.MeadowProvider = 'SQLite';

		this.fable.addAndInstantiateServiceTypeIfNotExists('MeadowSQLiteProvider', libMeadowConnectionSQLite);

		this.fable.MeadowSQLiteProvider.connectAsync(
			(pConnectError) =>
			{
				if (pConnectError)
				{
					this.fable.log.error(`LabStateStore: SQLite connect failed -- ${pConnectError.message}`);
					return fCallback(pConnectError);
				}

				this.db = this.fable.MeadowSQLiteProvider.db;

				try
				{
					this._loadModel();
					this._instantiateDALs();
				}
				catch (pLoadErr)
				{
					this.fable.log.error(`LabStateStore: model load failed -- ${pLoadErr.message}`);
					return fCallback(pLoadErr);
				}

				this._bootstrapSchema(
					(pSchemaErr) =>
					{
						if (pSchemaErr)
						{
							this.fable.log.error(`LabStateStore: schema bootstrap failed -- ${pSchemaErr.message}`);
							return fCallback(pSchemaErr);
						}
						this.fable.log.info(`LabStateStore: ready at [${this.dbPath}]`);
						return fCallback(null);
					});
			});
	}

	// ====================================================================
	// Model + DAL bootstrap
	// ====================================================================

	_loadModel()
	{
		let tmpRaw = libFs.readFileSync(MODEL_PATH, 'utf8');
		this._Model = JSON.parse(tmpRaw);
		if (!this._Model || !this._Model.Tables)
		{
			throw new Error(`LabStateStore: ${MODEL_PATH} missing Tables section.`);
		}
	}

	/**
	 * For each table in the model, build a meadow DAL pointed at SQLite.
	 * The DALs share the live MeadowSQLiteProvider — meadow's setProvider
	 * picks up `fable.settings.MeadowProvider` (set above) and routes
	 * doCreate/doReads/doUpdate/doDelete through better-sqlite3.
	 */
	_instantiateDALs()
	{
		let tmpTableNames = Object.keys(this._Model.Tables);
		for (let i = 0; i < tmpTableNames.length; i++)
		{
			let tmpName = tmpTableNames[i];
			let tmpEntry = this._Model.Tables[tmpName];
			let tmpMeadowSchema = tmpEntry.MeadowSchema;
			if (!tmpMeadowSchema)
			{
				throw new Error(`LabStateStore: model entry [${tmpName}] missing MeadowSchema.`);
			}
			let tmpDAL = libMeadow.new(this.fable).loadFromPackageObject(tmpMeadowSchema);
			tmpDAL.setProvider('SQLite');
			this._DAL[tmpName] = tmpDAL;
		}
		// Expose under fable.DAL — convenience for any future caller that
		// wants to drive meadow directly. Keep it scoped to lab tables;
		// other modules' DALs live on their own fable.
		if (!this.fable.DAL) { this.fable.DAL = {}; }
		Object.assign(this.fable.DAL, this._DAL);
	}

	/**
	 * Two-step: (1) idempotent createTables on every supported table,
	 * (2) meadow-migrationmanager forward-only ADD COLUMN for any
	 * descriptor changes since the table last existed.
	 */
	_bootstrapSchema(fCallback)
	{
		let tmpSchemaProvider = this.fable.MeadowSQLiteProvider.schemaProvider
			|| this.fable.MeadowSQLiteProvider._SchemaProvider;
		if (!tmpSchemaProvider || typeof tmpSchemaProvider.createTables !== 'function')
		{
			return fCallback(new Error('LabStateStore: SQLite schemaProvider not exposed by connector.'));
		}

		// Build the meadow-shape schema (TableName/Columns) the connector
		// expects from each table descriptor.
		let tmpMeadowSchema = { Tables: this._collectMeadowTables() };

		tmpSchemaProvider.createTables(tmpMeadowSchema,
			(pCreateErr) =>
			{
				if (pCreateErr) { return fCallback(pCreateErr); }
				tmpSchemaProvider.createAllIndices(tmpMeadowSchema,
					(pIdxErr) =>
					{
						if (pIdxErr) { return fCallback(pIdxErr); }
						this._runForwardMigrations(tmpSchemaProvider, tmpMeadowSchema, fCallback);
					});
			});
	}

	/**
	 * Convert the model's high-level Schema entries (AutoIdentity / Integer /
	 * Boolean / String / Text / DateTime / CreateDate / UpdateDate /
	 * ForeignKey) to the lower-level meadow connector vocabulary the
	 * SQLite schemaProvider expects (ID / Numeric / Boolean / String /
	 * Text / DateTime / ForeignKey).
	 */
	_collectMeadowTables()
	{
		const TYPE_TO_DATATYPE =
		{
			AutoIdentity: 'ID',
			AutoGUID:     'GUID',
			ForeignKey:   'ForeignKey',
			Integer:      'Numeric',
			Float:        'Decimal',
			Decimal:      'Decimal',
			Boolean:      'Boolean',
			Deleted:      'Boolean',
			CreateDate:   'DateTime',
			UpdateDate:   'DateTime',
			DeleteDate:   'DateTime',
			DateTime:     'DateTime',
			String:       'String',
			Text:         'Text',
			JSON:         'Text'
		};
		let tmpTables = [];
		let tmpNames = Object.keys(this._Model.Tables);
		for (let i = 0; i < tmpNames.length; i++)
		{
			let tmpEntry = this._Model.Tables[tmpNames[i]];
			let tmpSchema = tmpEntry.MeadowSchema && tmpEntry.MeadowSchema.Schema;
			if (!Array.isArray(tmpSchema)) { continue; }
			let tmpColumns = tmpSchema.map((pC) =>
			{
				let tmpDT = TYPE_TO_DATATYPE[pC.Type] || 'Text';
				let tmpCol = { Column: pC.Column, DataType: tmpDT };
				if (pC.Size && pC.Size !== 'Default' && pC.Size !== 'int')
				{
					tmpCol.Size = pC.Size;
				}
				if (pC.Indexed) { tmpCol.Indexed = pC.Indexed; }
				if (pC.IndexName) { tmpCol.IndexName = pC.IndexName; }
				return tmpCol;
			});
			tmpTables.push({ TableName: tmpEntry.TableName, Columns: tmpColumns });
		}
		return tmpTables;
	}

	/**
	 * Lazy-init meadow-migrationmanager and run introspect → diff →
	 * forward-only filter → generate → execute. Mirror of the path
	 * retold-databeacon's DataBeacon-SchemaManager uses (Session 4 work),
	 * scoped to the lab's tables only.
	 */
	_runForwardMigrations(pSchemaProvider, pMeadowSchema, fCallback)
	{
		if (!this._MM)
		{
			this._MM = new libMeadowMigrationManager(
				{
					Product: 'LabStateStore',
					LogStreams: (this.fable.settings && this.fable.settings.LogStreams) || [{ streamtype: 'console', level: 'warn' }]
				});
			this._SchemaIntrospector = this._MM.instantiateServiceProvider('SchemaIntrospector');
			this._SchemaDiff         = this._MM.instantiateServiceProvider('SchemaDiff');
			this._MigrationGenerator = this._MM.instantiateServiceProvider('MigrationGenerator');
		}

		this._SchemaIntrospector.introspectDatabase(pSchemaProvider, (pIntErr, pIntrospected) =>
		{
			if (pIntErr) { return fCallback(pIntErr); }
			let tmpIntrospected = pIntrospected || { Tables: [] };

			// Restrict the introspected snapshot to the tables we own —
			// otherwise unrelated tables in lab.db would surface as
			// drops we'd skip but still log noise about.
			let tmpOwn = new Set(pMeadowSchema.Tables.map((pT) => pT.TableName));
			let tmpFilteredSource =
			{
				Tables: (tmpIntrospected.Tables || []).filter((pT) => tmpOwn.has(pT.TableName))
			};

			let tmpDiff;
			try { tmpDiff = this._SchemaDiff.diffSchemas(tmpFilteredSource, pMeadowSchema); }
			catch (pDiffErr) { return fCallback(pDiffErr); }

			// Forward-only filter — keep ColumnsAdded / IndicesAdded only,
			// drop ColumnsRemoved / ColumnsModified / IndicesRemoved / TablesRemoved.
			let tmpModified = (tmpDiff.TablesModified || []).map((pM) => (
				{
					TableName: pM.TableName,
					ColumnsAdded: pM.ColumnsAdded || [],
					ColumnsRemoved: [], ColumnsModified: [],
					IndicesAdded: pM.IndicesAdded || [],
					IndicesRemoved: [],
					ForeignKeysAdded: pM.ForeignKeysAdded || [],
					ForeignKeysRemoved: []
				})).filter((pM) => pM.ColumnsAdded.length > 0 || pM.IndicesAdded.length > 0);

			if (tmpModified.length === 0) { return fCallback(null); }

			let tmpStatements = this._MigrationGenerator.generateMigrationStatements(
				{ TablesAdded: [], TablesRemoved: [], TablesModified: tmpModified }, 'SQLite');

			for (let i = 0; i < tmpStatements.length; i++)
			{
				let tmpSql = tmpStatements[i];
				if (!tmpSql || tmpSql.trim().length === 0 || tmpSql.trim().indexOf('--') === 0) { continue; }
				try
				{
					this.db.exec(tmpSql);
					this.fable.log.info(`LabStateStore: migrated ${tmpSql.replace(/\s+/g, ' ').slice(0, 120)}`);
				}
				catch (pExecErr)
				{
					if (/duplicate column|already exists/i.test(pExecErr.message || ''))
					{
						continue;
					}
					return fCallback(pExecErr);
				}
			}
			return fCallback(null);
		});
	}

	// ====================================================================
	// Sync wrappers around the meadow DAL
	//
	// meadow-connection-sqlite is synchronous (better-sqlite3); the
	// callbacks fire before the doX function returns. We exploit that to
	// keep the legacy sync API while routing every read/write through
	// the DAL underneath.
	// ====================================================================

	/**
	 * Run a meadow doX call and capture its result + error synchronously.
	 * Throws if the callback didn't fire (which would mean the underlying
	 * driver isn't actually sync — bug worth surfacing immediately).
	 */
	_runSync(pAction)
	{
		let tmpResult = { fired: false, error: null, args: null };
		pAction((pErr, ...pRest) =>
		{
			tmpResult.fired = true;
			tmpResult.error = pErr || null;
			tmpResult.args = pRest;
		});
		if (!tmpResult.fired)
		{
			throw new Error('LabStateStore: meadow callback did not fire synchronously (driver is not better-sqlite3?).');
		}
		if (tmpResult.error) { throw tmpResult.error; }
		return tmpResult.args;
	}

	_dal(pTable)
	{
		let tmpDAL = this._DAL[pTable];
		if (!tmpDAL) { throw new Error(`Unknown table [${pTable}]`); }
		return tmpDAL;
	}

	_idColumn(pTable)
	{
		let tmpEntry = this._Model && this._Model.Tables[pTable];
		return tmpEntry && tmpEntry.MeadowSchema && tmpEntry.MeadowSchema.DefaultIdentifier;
	}

	list(pTable, pWhere)
	{
		if (!this.db) { return []; }
		let tmpDAL = this._dal(pTable);
		let tmpQuery = tmpDAL.query.clone()
			.setBegin(0)
			.setCap(DEFAULT_READS_CAP);
		// Newest first by primary key — matches the previous "ORDER BY rowid DESC" semantics.
		let tmpIDCol = this._idColumn(pTable);
		if (tmpIDCol)
		{
			tmpQuery.addSort({ Column: tmpIDCol, Direction: 'Descending' });
		}
		if (pWhere && typeof pWhere === 'object')
		{
			let tmpKeys = Object.keys(pWhere);
			for (let i = 0; i < tmpKeys.length; i++)
			{
				tmpQuery.addFilter(tmpKeys[i], pWhere[tmpKeys[i]]);
			}
		}
		// doReads callback signature is (err, query, records).
		let tmpArgs = this._runSync((cb) => tmpDAL.doReads(tmpQuery, cb));
		return tmpArgs[1] || [];
	}

	getById(pTable, pIDColumn, pID)
	{
		if (!this.db) { return null; }
		let tmpDAL = this._dal(pTable);
		let tmpQuery = tmpDAL.query.clone().addFilter(pIDColumn, pID);
		let tmpArgs = this._runSync((cb) => tmpDAL.doReads(tmpQuery, cb));
		let tmpRecords = tmpArgs[1] || [];
		return tmpRecords.length > 0 ? tmpRecords[0] : null;
	}

	insert(pTable, pRecord)
	{
		if (!this.db) { throw new Error('LabStateStore not initialized'); }
		let tmpDAL = this._dal(pTable);
		// Coerce booleans to 0/1 — meadow's SQLite path passes values
		// through to better-sqlite3, which still rejects booleans.
		let tmpClean = this._coerceRecord(pRecord);
		let tmpQuery = tmpDAL.query.clone().setIDUser(0).addRecord(tmpClean);
		// doCreate callback: (err, query, queryRead, inserted).
		let tmpArgs = this._runSync((cb) => tmpDAL.doCreate(tmpQuery, cb));
		let tmpInserted = tmpArgs[2];
		let tmpIDCol = this._idColumn(pTable);
		return (tmpInserted && tmpIDCol) ? tmpInserted[tmpIDCol] : null;
	}

	update(pTable, pIDColumn, pID, pChanges)
	{
		if (!this.db) { throw new Error('LabStateStore not initialized'); }
		let tmpDAL = this._dal(pTable);
		// meadow's update needs the ID inside the record. Read-modify-
		// write style: pull existing row, merge changes, doUpdate.
		// Without the merge, meadow's UPDATE clobbers the columns we
		// didn't pass with their schema defaults.
		let tmpExisting = this.getById(pTable, pIDColumn, pID);
		if (!tmpExisting) { return 0; }
		let tmpMerged = Object.assign({}, tmpExisting, this._coerceRecord(pChanges));
		tmpMerged[pIDColumn] = pID;
		let tmpQuery = tmpDAL.query.clone().setIDUser(0).addRecord(tmpMerged);
		this._runSync((cb) => tmpDAL.doUpdate(tmpQuery, cb));
		return 1;
	}

	remove(pTable, pIDColumn, pID)
	{
		if (!this.db) { throw new Error('LabStateStore not initialized'); }
		let tmpDAL = this._dal(pTable);
		let tmpQuery = tmpDAL.query.clone().setIDUser(0).addFilter(pIDColumn, pID);
		// doDelete callback: (err, query, deletedCount). Tables without
		// a Deleted column hard-delete; ours don't, so this works.
		let tmpArgs = this._runSync((cb) => tmpDAL.doDelete(tmpQuery, cb));
		return tmpArgs[1] || 0;
	}

	/**
	 * Coerce JS values into shapes the SQLite provider can bind. Boolean
	 * → 0/1; undefined → null; objects → JSON-stringified. Same rationale
	 * as the previous raw-SQL `_bindable` helper but applied before the
	 * value enters the DAL pipeline.
	 */
	_coerceRecord(pRecord)
	{
		let tmpClean = {};
		let tmpKeys = Object.keys(pRecord || {});
		for (let i = 0; i < tmpKeys.length; i++)
		{
			let tmpV = pRecord[tmpKeys[i]];
			if (tmpV === undefined || tmpV === null) { tmpClean[tmpKeys[i]] = null; continue; }
			if (typeof tmpV === 'boolean') { tmpClean[tmpKeys[i]] = tmpV ? 1 : 0; continue; }
			if (typeof tmpV === 'number' || typeof tmpV === 'string'
				|| typeof tmpV === 'bigint' || Buffer.isBuffer(tmpV))
			{
				tmpClean[tmpKeys[i]] = tmpV;
				continue;
			}
			tmpClean[tmpKeys[i]] = JSON.stringify(tmpV);
		}
		return tmpClean;
	}

	// ====================================================================
	// Event log — same insert path, slightly different shape mapping
	// ====================================================================

	recordEvent(pEvent)
	{
		if (!this.db) { return 0; }
		let tmpRecord =
		{
			EntityType: pEvent.EntityType || 'System',
			EntityID:   pEvent.EntityID || 0,
			EntityName: pEvent.EntityName || '',
			EventType:  pEvent.EventType || 'info',
			Severity:   pEvent.Severity || 'info',
			Message:    pEvent.Message || '',
			Detail:     pEvent.Detail
				? (typeof pEvent.Detail === 'string' ? pEvent.Detail : JSON.stringify(pEvent.Detail))
				: ''
		};
		return this.insert('InfrastructureEvent', tmpRecord);
	}

	listEvents(pLimit)
	{
		if (!this.db) { return []; }
		let tmpLimit = (pLimit && pLimit > 0) ? pLimit : 200;
		let tmpDAL = this._dal('InfrastructureEvent');
		let tmpQuery = tmpDAL.query.clone()
			.setBegin(0)
			.setCap(tmpLimit)
			.addSort({ Column: 'IDInfrastructureEvent', Direction: 'Descending' });
		let tmpArgs = this._runSync((cb) => tmpDAL.doReads(tmpQuery, cb));
		return tmpArgs[1] || [];
	}

	// ====================================================================
	// Shutdown
	// ====================================================================

	close()
	{
		if (this.db)
		{
			try { this.db.close(); } catch (pErr) { /* non-fatal */ }
			this.db = null;
		}
	}
}

// Public entity-table list — generated from the model so adding a table
// to the JSON automatically surfaces in any code that iterates this map.
function _entityTablesFromModel()
{
	try
	{
		let tmpModel = JSON.parse(libFs.readFileSync(MODEL_PATH, 'utf8'));
		let tmpOut = {};
		let tmpNames = Object.keys(tmpModel.Tables || {});
		for (let i = 0; i < tmpNames.length; i++) { tmpOut[tmpNames[i]] = tmpNames[i]; }
		return tmpOut;
	}
	catch (e) { return {}; }
}

module.exports = ServiceStateStore;
module.exports.ENTITY_TABLES = _entityTablesFromModel();
