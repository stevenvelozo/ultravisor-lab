/**
 * Service-StateStore
 *
 * Persists ultravisor-lab state to SQLite at data/lab.db.
 *
 * Schema covers every entity the lab supervises: dockerized DB engines,
 * databases inside them, ultravisor instances, databeacons, facto instances,
 * ingestion jobs, stacks, and a flat infrastructure event log for the UI
 * timeline.
 *
 * Backed by `meadow-connection-sqlite` (the retold SQLite provider, now
 * itself sitting on node:sqlite's DatabaseSync). We use mcs for two things:
 *
 *   1. Connection lifecycle — mcs constructs the DatabaseSync handle,
 *      issues the WAL pragma, and exposes the handle as `provider.db`.
 *      If mcs ever switches drivers again (libsql, back to better-sqlite3,
 *      …), the lab follows for free.
 *
 *   2. DDL generation — `schemaProvider.generateCreateTableStatement` and
 *      `generateCreateIndexStatements` are pure string builders that own
 *      the canonical retold DataType -> DDL mapping. We call them to get
 *      the SQL, then `exec` it on the handle ourselves.
 *
 * What we deliberately do NOT use:
 *
 *   - `meadow` (the DAL). meadow's _CreateBehavior step 0 schedules a
 *     `setImmediate` between its pre-flight and the actual INSERT to keep
 *     long synchronous chains of Creates from blowing the stack. That
 *     defer is fine for normal consumers but breaks the lab's historical
 *     "insert returns the new ID on the next line" idiom and would force
 *     a callsite-wide rewrite for no actual gain (twelve small tables,
 *     low-thousand row counts).
 *
 *   - `meadow-migrationmanager`. Same story — its introspect path goes
 *     through `async.eachLimit`, which defers via setImmediate even when
 *     every iteratee is sync. We do forward-only ADD COLUMN migrations
 *     ourselves via PRAGMA table_info, which is comfortably scoped to the
 *     lab's needs.
 *
 *   - `schemaProvider.createTables` / `createAllIndices` — same eachLimit
 *     deferral problem. We call the underlying `generate…Statement`
 *     methods directly and exec the SQL ourselves.
 *
 * The public `list / getById / insert / update / remove / recordEvent /
 * listEvents` API stays synchronous and the call shapes are unchanged.
 */
'use strict';

const libPath = require('path');
const libFs = require('fs');
const libFableServiceProviderBase = require('fable-serviceproviderbase');
const libMeadowConnectionSQLite = require('meadow-connection-sqlite');

const MODEL_PATH = libPath.resolve(__dirname, '..', '..', 'model', 'MeadowModel-Lab.json');

// Reads cap. Lab tables are small; a 1000-row default is comfortably
// above any real-world count and avoids paging in the generic helpers.
const DEFAULT_READS_CAP = 1000;

// Convert the model's high-level Schema entries (AutoIdentity / Integer /
// Boolean / String / Text / DateTime / CreateDate / UpdateDate /
// ForeignKey) to the lower-level meadow connector vocabulary the SQLite
// schemaProvider expects (ID / Numeric / Boolean / String / Text /
// DateTime / ForeignKey). mcs is the canonical source for the DataType
// -> DDL mapping; we just translate the model's higher-level Types into
// mcs's vocabulary.
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

class ServiceStateStore extends libFableServiceProviderBase
{
	constructor(pFable, pOptions, pServiceHash)
	{
		super(pFable, pOptions, pServiceHash);

		this.serviceType = 'LabStateStore';

		this.dataDir = (pOptions && pOptions.DataDir)  ? pOptions.DataDir  : libPath.resolve(__dirname, '..', '..', 'data');
		this.dbPath  = libPath.join(this.dataDir, 'lab.db');

		// DatabaseSync handle, set in initialize() once mcs connects.
		this.db = null;

		this._Model = null;
		this._TableMeta = null;
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

		// Point mcs at our lab.db. The provider reads SQLiteFilePath from
		// fable.settings.SQLite on construction; setting it before
		// instantiation is how every other retold consumer wires it up.
		if (!this.fable.settings.SQLite)
		{
			this.fable.settings.SQLite = {};
		}
		this.fable.settings.SQLite.SQLiteFilePath = this.dbPath;

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
					this._buildTableMeta();
					this._bootstrapSchema();
					this.fable.log.info(`LabStateStore: ready at [${this.dbPath}]`);
					return fCallback(null);
				}
				catch (pBootErr)
				{
					this.fable.log.error(`LabStateStore: schema bootstrap failed -- ${pBootErr.message}`);
					return fCallback(pBootErr);
				}
			});
	}

	// ====================================================================
	// Model + schema bootstrap
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
	 * Pre-walk the model and stash per-table metadata every CRUD call
	 * needs. We do this once at boot rather than rewalking the Schema
	 * array on every insert — the reconcile loop drives thousands of
	 * inserts per lab session.
	 *
	 * We also pre-build the mcs-shape table descriptor here so the
	 * schemaProvider's DDL generators can be called without re-translating
	 * on every boot.
	 */
	_buildTableMeta()
	{
		this._TableMeta = {};
		let tmpNames = Object.keys(this._Model.Tables);
		for (let i = 0; i < tmpNames.length; i++)
		{
			let tmpName = tmpNames[i];
			let tmpEntry = this._Model.Tables[tmpName];
			let tmpSchema = tmpEntry.MeadowSchema && tmpEntry.MeadowSchema.Schema;
			if (!Array.isArray(tmpSchema)) { continue; }
			let tmpKnown = new Set();
			let tmpCreateDateCol = null;
			let tmpUpdateDateCol = null;
			let tmpProviderCols = [];
			for (let j = 0; j < tmpSchema.length; j++)
			{
				let tmpCol = tmpSchema[j];
				tmpKnown.add(tmpCol.Column);
				if (tmpCol.Type === 'CreateDate') { tmpCreateDateCol = tmpCol.Column; }
				if (tmpCol.Type === 'UpdateDate') { tmpUpdateDateCol = tmpCol.Column; }
				let tmpProviderCol = { Column: tmpCol.Column, DataType: TYPE_TO_DATATYPE[tmpCol.Type] || 'Text' };
				if (tmpCol.Size && tmpCol.Size !== 'Default' && tmpCol.Size !== 'int')
				{
					tmpProviderCol.Size = tmpCol.Size;
				}
				if (tmpCol.Indexed)   { tmpProviderCol.Indexed   = tmpCol.Indexed;   }
				if (tmpCol.IndexName) { tmpProviderCol.IndexName = tmpCol.IndexName; }
				tmpProviderCols.push(tmpProviderCol);
			}
			this._TableMeta[tmpName] =
			{
				TableName:     tmpEntry.TableName,
				IDColumn:      (tmpEntry.MeadowSchema && tmpEntry.MeadowSchema.DefaultIdentifier) || null,
				Schema:        tmpSchema,
				KnownColumns:  tmpKnown,
				CreateDateCol: tmpCreateDateCol,
				UpdateDateCol: tmpUpdateDateCol,
				DefaultObject: (tmpEntry.MeadowSchema && tmpEntry.MeadowSchema.DefaultObject) || {},
				// mcs-shape descriptor: passed to schemaProvider for DDL generation.
				ProviderSchema: { TableName: tmpEntry.TableName, Columns: tmpProviderCols }
			};
		}
	}

	/**
	 * Walk every Tables entry in the model and ensure the corresponding
	 * SQLite table + columns + indices are present. All three steps are
	 * idempotent (IF NOT EXISTS / introspect-then-ADD), so re-runs on an
	 * existing lab.db are no-ops.
	 *
	 * We deliberately don't call mcs's `schemaProvider.createTables` /
	 * `createAllIndices` — those wrap each step in `async.eachLimit`,
	 * which defers via setImmediate even with all-sync iteratees. Instead
	 * we ask the schemaProvider to *generate* the DDL (pure sync string
	 * builders) and exec it on the handle ourselves.
	 */
	_bootstrapSchema()
	{
		let tmpSchemaProvider = this.fable.MeadowSQLiteProvider.schemaProvider
			|| this.fable.MeadowSQLiteProvider._SchemaProvider;
		if (!tmpSchemaProvider
			|| typeof tmpSchemaProvider.generateCreateTableStatement !== 'function'
			|| typeof tmpSchemaProvider.generateCreateIndexStatements !== 'function')
		{
			throw new Error('LabStateStore: mcs schemaProvider missing the DDL generators we need.');
		}

		let tmpNames = Object.keys(this._TableMeta);
		for (let i = 0; i < tmpNames.length; i++)
		{
			let tmpMeta = this._TableMeta[tmpNames[i]];
			this._ensureTable(tmpSchemaProvider, tmpMeta);
			this._ensureColumns(tmpSchemaProvider, tmpMeta);
			this._ensureIndices(tmpSchemaProvider, tmpMeta);
		}
	}

	/**
	 * Have mcs generate the CREATE TABLE statement, then exec it. mcs
	 * already emits `CREATE TABLE IF NOT EXISTS`, so this is idempotent
	 * on a repeat boot.
	 */
	_ensureTable(pSchemaProvider, pMeta)
	{
		let tmpStatement = pSchemaProvider.generateCreateTableStatement(pMeta.ProviderSchema);
		this.db.exec(tmpStatement);
	}

	/**
	 * Forward-only ADD COLUMN migration. PRAGMA table_info surfaces the
	 * columns already on disk; anything in the model that's missing gets
	 * ALTERed in. We deliberately do NOT drop, rename, or retype — every
	 * schema evolution has to be expressed as an ADD so older lab.db files
	 * survive a column rename without losing data.
	 *
	 * mcs doesn't ship a "generate ALTER ADD COLUMN" helper, so we build
	 * a single-column meadow-shape table descriptor and feed it through
	 * `generateCreateTableStatement`, then snip the column line out of the
	 * resulting `CREATE TABLE … ( <col> <ddl> )`. This keeps the DDL type
	 * mapping in one place (mcs) instead of duplicating it here.
	 *
	 * SQLite's ALTER TABLE ADD COLUMN cannot create a PRIMARY KEY, so
	 * AutoIdentity columns are skipped (they would only ever fire on a
	 * brand-new table, already covered by _ensureTable above).
	 */
	_ensureColumns(pSchemaProvider, pMeta)
	{
		let tmpRows = this.db.prepare(`PRAGMA table_info(${pMeta.TableName})`).all();
		let tmpExisting = new Set();
		for (let i = 0; i < tmpRows.length; i++)
		{
			tmpExisting.add(tmpRows[i].name);
		}
		let tmpProviderCols = pMeta.ProviderSchema.Columns;
		for (let i = 0; i < tmpProviderCols.length; i++)
		{
			let tmpProviderCol = tmpProviderCols[i];
			if (tmpProviderCol.DataType === 'ID') { continue; }
			if (tmpExisting.has(tmpProviderCol.Column)) { continue; }
			let tmpFragment = this._columnDDL(pSchemaProvider, tmpProviderCol);
			if (!tmpFragment)
			{
				throw new Error(`LabStateStore: could not derive DDL for ${pMeta.TableName}.${tmpProviderCol.Column} (${tmpProviderCol.DataType})`);
			}
			try
			{
				this.db.exec(`ALTER TABLE ${pMeta.TableName} ADD COLUMN ${tmpFragment}`);
				this.fable.log.info(`LabStateStore: migrated ${pMeta.TableName}.${tmpProviderCol.Column} (${tmpProviderCol.DataType})`);
			}
			catch (pExecErr)
			{
				// Tolerate the race where the column was added between
				// PRAGMA and ALTER (only happens if a second process is
				// attached to the same lab.db, which is developer-bench).
				if (!/duplicate column|already exists/i.test(pExecErr.message || ''))
				{
					throw pExecErr;
				}
			}
		}
	}

	/**
	 * Derive the `<colname> <ddl>` fragment for a single column by feeding
	 * mcs a one-column table descriptor and reading the generated CREATE
	 * TABLE statement back. We strip the surrounding boilerplate and
	 * return just the column line — exactly what ALTER TABLE ADD COLUMN
	 * needs after the column name. Keeps mcs as the single source of
	 * truth for the DataType -> DDL mapping.
	 */
	_columnDDL(pSchemaProvider, pProviderCol)
	{
		let tmpStatement = pSchemaProvider.generateCreateTableStatement(
			{ TableName: '__alter_probe__', Columns: [pProviderCol] });
		// mcs emits a multi-line CREATE TABLE statement with one column;
		// pull the single non-comment, non-paren line. Format example:
		//   --   [ __alter_probe__ ]
		//   CREATE TABLE IF NOT EXISTS __alter_probe__
		//       (
		//           <Column> <DDL>
		//       );
		let tmpLines = tmpStatement.split('\n');
		for (let i = 0; i < tmpLines.length; i++)
		{
			let tmpLine = tmpLines[i].trim();
			if (!tmpLine || tmpLine.startsWith('--') || tmpLine.startsWith('CREATE') || tmpLine === '(' || tmpLine === ');')
			{
				continue;
			}
			return tmpLine.replace(/,$/, '');
		}
		return null;
	}

	/**
	 * Ask mcs to generate the per-column index statements, then exec each
	 * one as CREATE [UNIQUE] INDEX IF NOT EXISTS. mcs's
	 * `generateCreateIndexStatements` emits `CREATE [UNIQUE] INDEX` (no IF
	 * NOT EXISTS — that's added at exec time by mcs's `createIndex` wrapper,
	 * which we're bypassing). We inject the IF NOT EXISTS ourselves.
	 */
	_ensureIndices(pSchemaProvider, pMeta)
	{
		let tmpStatements = pSchemaProvider.generateCreateIndexStatements(pMeta.ProviderSchema);
		for (let i = 0; i < tmpStatements.length; i++)
		{
			let tmpSql = tmpStatements[i].Statement
				.replace('CREATE UNIQUE INDEX ', 'CREATE UNIQUE INDEX IF NOT EXISTS ')
				.replace('CREATE INDEX ', 'CREATE INDEX IF NOT EXISTS ');
			this.db.exec(tmpSql);
		}
	}

	_meta(pTable)
	{
		let tmpMeta = this._TableMeta && this._TableMeta[pTable];
		if (!tmpMeta) { throw new Error(`Unknown table [${pTable}]`); }
		return tmpMeta;
	}

	// ====================================================================
	// CRUD — synchronous wrappers over the mcs DatabaseSync handle.
	//
	// node:sqlite (DatabaseSync) is fully synchronous: `db.prepare(...).run`
	// blocks until the statement completes, and the lab's reconcile loop
	// relies on that — every supervisor service calls insert/update and
	// reads the result on the next line. Anything async here would force
	// a callsite-wide rewrite for no actual gain (the lab is single-tenant
	// and lab.db tops out at low-thousands of rows).
	// ====================================================================

	list(pTable, pWhere)
	{
		if (!this.db) { return []; }
		let tmpMeta = this._meta(pTable);
		let tmpParams = [];
		let tmpSql = `SELECT * FROM ${tmpMeta.TableName}`;
		if (pWhere && typeof pWhere === 'object')
		{
			let tmpKeys = Object.keys(pWhere);
			if (tmpKeys.length > 0)
			{
				let tmpClauses = [];
				for (let i = 0; i < tmpKeys.length; i++)
				{
					if (!tmpMeta.KnownColumns.has(tmpKeys[i]))
					{
						throw new Error(`LabStateStore.list: unknown column [${tmpKeys[i]}] on [${pTable}]`);
					}
					tmpClauses.push(`${tmpKeys[i]} = ?`);
					tmpParams.push(this._bindable(pWhere[tmpKeys[i]]));
				}
				tmpSql += ' WHERE ' + tmpClauses.join(' AND ');
			}
		}
		// Newest first by primary key — matches the previous "ORDER BY rowid DESC" semantics.
		if (tmpMeta.IDColumn)
		{
			tmpSql += ` ORDER BY ${tmpMeta.IDColumn} DESC`;
		}
		tmpSql += ` LIMIT ${DEFAULT_READS_CAP}`;
		return this.db.prepare(tmpSql).all(...tmpParams);
	}

	getById(pTable, pIDColumn, pID)
	{
		if (!this.db) { return null; }
		let tmpMeta = this._meta(pTable);
		if (!tmpMeta.KnownColumns.has(pIDColumn))
		{
			throw new Error(`LabStateStore.getById: unknown column [${pIDColumn}] on [${pTable}]`);
		}
		let tmpRow = this.db.prepare(`SELECT * FROM ${tmpMeta.TableName} WHERE ${pIDColumn} = ?`).get(this._bindable(pID));
		return tmpRow || null;
	}

	insert(pTable, pRecord)
	{
		if (!this.db) { throw new Error('LabStateStore not initialized'); }
		let tmpMeta = this._meta(pTable);

		// Merge schema defaults UNDER the caller's record so columns the
		// caller didn't pass land at their declared default (e.g. Status
		// defaults to 'pending', not ''). Caller-supplied values win.
		let tmpMerged = Object.assign({}, tmpMeta.DefaultObject, pRecord || {});
		let tmpClean = this._coerceRecord(tmpMerged);

		// Auto-populate CreateDate / UpdateDate when the model declares the
		// column and neither the caller nor the schema default set one.
		// Mirrors meadow's CreateDate / UpdateDate behavior so existing
		// callsites need no churn.
		let tmpNow = new Date().toISOString();
		if (tmpMeta.CreateDateCol && tmpClean[tmpMeta.CreateDateCol] == null) { tmpClean[tmpMeta.CreateDateCol] = tmpNow; }
		if (tmpMeta.UpdateDateCol && tmpClean[tmpMeta.UpdateDateCol] == null) { tmpClean[tmpMeta.UpdateDateCol] = tmpNow; }

		// Restrict to columns the model knows; skip the AutoIdentity column
		// so SQLite assigns the next ID.
		let tmpCols = [];
		let tmpValues = [];
		for (let i = 0; i < tmpMeta.Schema.length; i++)
		{
			let tmpCol = tmpMeta.Schema[i];
			if (tmpCol.Type === 'AutoIdentity') { continue; }
			if (!Object.prototype.hasOwnProperty.call(tmpClean, tmpCol.Column)) { continue; }
			tmpCols.push(tmpCol.Column);
			tmpValues.push(tmpClean[tmpCol.Column]);
		}
		if (tmpCols.length === 0)
		{
			throw new Error(`LabStateStore.insert: no recognizable columns supplied for [${pTable}]`);
		}
		let tmpPlaceholders = tmpCols.map(() => '?').join(', ');
		let tmpSql = `INSERT INTO ${tmpMeta.TableName} (${tmpCols.join(', ')}) VALUES (${tmpPlaceholders})`;
		let tmpResult = this.db.prepare(tmpSql).run(...tmpValues);
		return tmpMeta.IDColumn ? Number(tmpResult.lastInsertRowid) : null;
	}

	update(pTable, pIDColumn, pID, pChanges)
	{
		if (!this.db) { throw new Error('LabStateStore not initialized'); }
		let tmpMeta = this._meta(pTable);
		if (!tmpMeta.KnownColumns.has(pIDColumn))
		{
			throw new Error(`LabStateStore.update: unknown ID column [${pIDColumn}] on [${pTable}]`);
		}
		let tmpClean = this._coerceRecord(pChanges || {});

		// Auto-bump UpdateDate when the model declares one — matches meadow's
		// UpdateDate behavior. CreateDate stays untouched on update.
		if (tmpMeta.UpdateDateCol && tmpClean[tmpMeta.UpdateDateCol] == null)
		{
			tmpClean[tmpMeta.UpdateDateCol] = new Date().toISOString();
		}

		let tmpAssigns = [];
		let tmpValues = [];
		for (let i = 0; i < tmpMeta.Schema.length; i++)
		{
			let tmpCol = tmpMeta.Schema[i];
			if (tmpCol.Column === pIDColumn) { continue; }
			if (tmpCol.Type === 'AutoIdentity') { continue; }
			if (!Object.prototype.hasOwnProperty.call(tmpClean, tmpCol.Column)) { continue; }
			tmpAssigns.push(`${tmpCol.Column} = ?`);
			tmpValues.push(tmpClean[tmpCol.Column]);
		}
		if (tmpAssigns.length === 0) { return 0; }
		tmpValues.push(this._bindable(pID));
		let tmpResult = this.db.prepare(
			`UPDATE ${tmpMeta.TableName} SET ${tmpAssigns.join(', ')} WHERE ${pIDColumn} = ?`).run(...tmpValues);
		return tmpResult.changes || 0;
	}

	remove(pTable, pIDColumn, pID)
	{
		if (!this.db) { throw new Error('LabStateStore not initialized'); }
		let tmpMeta = this._meta(pTable);
		if (!tmpMeta.KnownColumns.has(pIDColumn))
		{
			throw new Error(`LabStateStore.remove: unknown ID column [${pIDColumn}] on [${pTable}]`);
		}
		let tmpResult = this.db.prepare(
			`DELETE FROM ${tmpMeta.TableName} WHERE ${pIDColumn} = ?`).run(this._bindable(pID));
		return tmpResult.changes || 0;
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
		return this.db.prepare(
			'SELECT * FROM InfrastructureEvent ORDER BY IDInfrastructureEvent DESC LIMIT ?').all(tmpLimit);
	}

	// ====================================================================
	// Value coercion — kept compatible with the meadow-backed predecessor
	// ====================================================================

	/**
	 * Coerce a single JS value into a SQLite-bindable form. node:sqlite
	 * accepts numbers, strings, BigInts, Buffers, and null — not booleans,
	 * not plain objects. Booleans go to 0/1; objects (including arrays)
	 * are JSON-stringified, matching what callers got out of meadow.
	 */
	_bindable(pValue)
	{
		if (pValue === undefined || pValue === null) { return null; }
		if (typeof pValue === 'boolean') { return pValue ? 1 : 0; }
		if (typeof pValue === 'number' || typeof pValue === 'string'
			|| typeof pValue === 'bigint' || Buffer.isBuffer(pValue))
		{
			return pValue;
		}
		return JSON.stringify(pValue);
	}

	_coerceRecord(pRecord)
	{
		let tmpClean = {};
		let tmpKeys = Object.keys(pRecord || {});
		for (let i = 0; i < tmpKeys.length; i++)
		{
			tmpClean[tmpKeys[i]] = this._bindable(pRecord[tmpKeys[i]]);
		}
		return tmpClean;
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
