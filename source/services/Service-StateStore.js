/**
 * Service-StateStore
 *
 * Persists ultravisor-lab state to SQLite at data/lab.db.
 *
 * Schema covers every entity the lab supervises: dockerized DB engines,
 * databases inside them, ultravisor instances, databeacons, facto instances,
 * ingestion jobs, and a flat infrastructure event log for the UI timeline.
 *
 * Everything is plain SQL executed through the meadow-connection-sqlite
 * better-sqlite3 handle -- no Stricture/meadow-endpoints layer.  Lab state
 * is internal; it isn't exposed through REST automatically.  The web server
 * exposes a thin, opinionated API on top of the services.
 */
'use strict';

const libPath = require('path');
const libFs = require('fs');
const libFableServiceProviderBase = require('fable-serviceproviderbase');
const libMeadowConnectionSQLite = require('meadow-connection-sqlite');

const LAB_SCHEMA_SQL = /*sql*/`
CREATE TABLE IF NOT EXISTS DBEngine
(
	IDDBEngine       INTEGER PRIMARY KEY AUTOINCREMENT,
	Name             TEXT    NOT NULL,
	EngineType       TEXT    NOT NULL,
	Port             INTEGER NOT NULL,
	InternalPort     INTEGER DEFAULT 0,
	ContainerID      TEXT    DEFAULT '',
	ContainerName    TEXT    DEFAULT '',
	ImageTag         TEXT    DEFAULT '',
	RootUsername     TEXT    DEFAULT '',
	RootPassword     TEXT    DEFAULT '',
	Status           TEXT    DEFAULT 'pending',
	StatusDetail     TEXT    DEFAULT '',
	CreatedAt        TEXT    DEFAULT (datetime('now')),
	UpdatedAt        TEXT    DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS Database
(
	IDDatabase       INTEGER PRIMARY KEY AUTOINCREMENT,
	IDDBEngine       INTEGER NOT NULL,
	Name             TEXT    NOT NULL,
	CreatedAt        TEXT    DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS UltravisorInstance
(
	IDUltravisorInstance INTEGER PRIMARY KEY AUTOINCREMENT,
	Name                 TEXT    NOT NULL,
	Port                 INTEGER NOT NULL,
	PID                  INTEGER DEFAULT 0,
	ContainerID          TEXT    DEFAULT '',
	ContainerName        TEXT    DEFAULT '',
	ImageTag             TEXT    DEFAULT '',
	ImageVersion         TEXT    DEFAULT '',
	Runtime              TEXT    DEFAULT 'process',
	ConfigPath           TEXT    DEFAULT '',
	Status               TEXT    DEFAULT 'pending',
	StatusDetail         TEXT    DEFAULT '',
	CreatedAt            TEXT    DEFAULT (datetime('now')),
	UpdatedAt            TEXT    DEFAULT (datetime('now'))
);

-- Unified beacon registry: any supervised process that registers (or could
-- register) as an ultravisor-beacon.  BeaconType is a free-form string that
-- matches an entry in Service-BeaconTypeRegistry; ConfigJSON holds whatever
-- shape the type's pict-section-form produced.
CREATE TABLE IF NOT EXISTS Beacon
(
	IDBeacon             INTEGER PRIMARY KEY AUTOINCREMENT,
	Name                 TEXT    NOT NULL,
	BeaconType           TEXT    NOT NULL,
	Port                 INTEGER NOT NULL,
	PID                  INTEGER DEFAULT 0,
	ContainerID          TEXT    DEFAULT '',
	ContainerName        TEXT    DEFAULT '',
	ImageTag             TEXT    DEFAULT '',
	ImageVersion         TEXT    DEFAULT '',
	Runtime              TEXT    DEFAULT 'process',  -- 'process' | 'container'
	IDUltravisorInstance INTEGER DEFAULT 0,
	ConfigPath           TEXT    DEFAULT '',
	ConfigJSON           TEXT    DEFAULT '{}',
	Status               TEXT    DEFAULT 'pending',
	StatusDetail         TEXT    DEFAULT '',
	CreatedAt            TEXT    DEFAULT (datetime('now')),
	UpdatedAt            TEXT    DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS FactoInstance
(
	IDFactoInstance  INTEGER PRIMARY KEY AUTOINCREMENT,
	Name             TEXT    NOT NULL,
	Port             INTEGER NOT NULL,
	PID              INTEGER DEFAULT 0,
	IDDatabase       INTEGER DEFAULT 0,
	Status           TEXT    DEFAULT 'pending',
	StatusDetail     TEXT    DEFAULT '',
	CreatedAt        TEXT    DEFAULT (datetime('now')),
	UpdatedAt        TEXT    DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS IngestionJob
(
	IDIngestionJob   INTEGER PRIMARY KEY AUTOINCREMENT,
	IDFactoInstance  INTEGER NOT NULL,
	DatasetName      TEXT    NOT NULL,
	Status           TEXT    DEFAULT 'pending',
	ParsedCount      INTEGER DEFAULT 0,
	LoadedCount      INTEGER DEFAULT 0,
	VerifiedCount    INTEGER DEFAULT 0,
	ErrorMessage     TEXT    DEFAULT '',
	StartedAt        TEXT    DEFAULT '',
	CompletedAt      TEXT    DEFAULT ''
);

CREATE TABLE IF NOT EXISTS InfrastructureEvent
(
	IDInfrastructureEvent INTEGER PRIMARY KEY AUTOINCREMENT,
	EntityType            TEXT    NOT NULL,
	EntityID              INTEGER DEFAULT 0,
	EntityName            TEXT    DEFAULT '',
	EventType             TEXT    NOT NULL,
	Severity              TEXT    DEFAULT 'info',
	Message               TEXT    DEFAULT '',
	Detail                TEXT    DEFAULT '',
	Timestamp             TEXT    DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS IX_InfrastructureEvent_Timestamp
	ON InfrastructureEvent (Timestamp);
CREATE INDEX IF NOT EXISTS IX_InfrastructureEvent_Entity
	ON InfrastructureEvent (EntityType, EntityID);
CREATE INDEX IF NOT EXISTS IX_Database_Engine
	ON Database (IDDBEngine);
CREATE INDEX IF NOT EXISTS IX_Beacon_Type
	ON Beacon (BeaconType);
CREATE INDEX IF NOT EXISTS IX_Beacon_Ultravisor
	ON Beacon (IDUltravisorInstance);
CREATE INDEX IF NOT EXISTS IX_IngestionJob_Facto
	ON IngestionJob (IDFactoInstance);
`;

// Tables the UI queries generically.  Keep in sync with LAB_SCHEMA_SQL.
const ENTITY_TABLES =
{
	DBEngine:            'DBEngine',
	Database:            'Database',
	UltravisorInstance:  'UltravisorInstance',
	Beacon:              'Beacon',
	FactoInstance:       'FactoInstance',
	IngestionJob:        'IngestionJob'
};

class ServiceStateStore extends libFableServiceProviderBase
{
	constructor(pFable, pOptions, pServiceHash)
	{
		super(pFable, pOptions, pServiceHash);

		this.serviceType = 'LabStateStore';

		this.dataDir  = (pOptions && pOptions.DataDir)  ? pOptions.DataDir  : libPath.resolve(__dirname, '..', '..', 'data');
		this.dbPath   = libPath.join(this.dataDir, 'lab.db');

		this.db = null;
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

		this.fable.addAndInstantiateServiceTypeIfNotExists('MeadowSQLiteProvider', libMeadowConnectionSQLite);

		this.fable.MeadowSQLiteProvider.connectAsync(
			(pConnectError) =>
			{
				if (pConnectError)
				{
					this.fable.log.error(`LabStateStore: SQLite connect failed -- ${pConnectError.message}`);
					return fCallback(pConnectError);
				}

				try
				{
					this.fable.MeadowSQLiteProvider.db.exec(LAB_SCHEMA_SQL);
					this.db = this.fable.MeadowSQLiteProvider.db;
					this._applyColumnMigrations();
					this.fable.log.info(`LabStateStore: ready at [${this.dbPath}]`);
					return fCallback(null);
				}
				catch (pSchemaError)
				{
					this.fable.log.error(`LabStateStore: schema setup failed -- ${pSchemaError.message}`);
					return fCallback(pSchemaError);
				}
			});
	}

	/**
	 * SQLite doesn't support `ALTER TABLE ... ADD COLUMN IF NOT EXISTS`, so
	 * for each newly-added column we probe `PRAGMA table_info(<table>)` and
	 * issue an `ALTER TABLE ADD COLUMN` only when the column is missing.
	 * This keeps existing dev databases alive without a wipe-and-recreate.
	 *
	 * Columns added in each schema iteration:
	 *   - 2026-04 Beacon    -- ContainerID, ContainerName, ImageTag, ImageVersion, Runtime
	 *   - 2026-04 DBEngine  -- InternalPort
	 */
	_applyColumnMigrations()
	{
		let tmpMigrations =
		[
			{ Table: 'Beacon',             Column: 'ContainerID',   Def: `TEXT DEFAULT ''` },
			{ Table: 'Beacon',             Column: 'ContainerName', Def: `TEXT DEFAULT ''` },
			{ Table: 'Beacon',             Column: 'ImageTag',      Def: `TEXT DEFAULT ''` },
			{ Table: 'Beacon',             Column: 'ImageVersion',  Def: `TEXT DEFAULT ''` },
			{ Table: 'Beacon',             Column: 'Runtime',       Def: `TEXT DEFAULT 'process'` },
			// BuildSource: 'npm' (default -- pull from registry at image build
			// time) or 'source' (pack the sibling monorepo checkout into a
			// tarball and install from that).  Source mode lets developers
			// debug the image-resident code against an unpublished version.
			{ Table: 'Beacon',             Column: 'BuildSource',   Def: `TEXT DEFAULT 'npm'` },
			{ Table: 'DBEngine',           Column: 'InternalPort',  Def: `INTEGER DEFAULT 0` },
			{ Table: 'UltravisorInstance', Column: 'ContainerID',   Def: `TEXT DEFAULT ''` },
			{ Table: 'UltravisorInstance', Column: 'ContainerName', Def: `TEXT DEFAULT ''` },
			{ Table: 'UltravisorInstance', Column: 'ImageTag',      Def: `TEXT DEFAULT ''` },
			{ Table: 'UltravisorInstance', Column: 'ImageVersion',  Def: `TEXT DEFAULT ''` },
			{ Table: 'UltravisorInstance', Column: 'Runtime',       Def: `TEXT DEFAULT 'process'` }
		];

		for (let i = 0; i < tmpMigrations.length; i++)
		{
			let tmpM = tmpMigrations[i];
			let tmpInfo = this.db.prepare(`PRAGMA table_info(${tmpM.Table})`).all();
			let tmpHas = tmpInfo.some((pR) => pR.name === tmpM.Column);
			if (!tmpHas)
			{
				this.db.exec(`ALTER TABLE ${tmpM.Table} ADD COLUMN ${tmpM.Column} ${tmpM.Def}`);
				this.fable.log.info(`LabStateStore: migrated ${tmpM.Table}.${tmpM.Column}`);
			}
		}
	}

	// ── Generic helpers ──────────────────────────────────────────────────────

	list(pTable, pWhere)
	{
		if (!this.db) { return []; }
		if (!ENTITY_TABLES[pTable]) { throw new Error(`Unknown table [${pTable}]`); }

		let tmpSql = `SELECT * FROM ${pTable}`;
		let tmpParams = [];
		if (pWhere && typeof pWhere === 'object')
		{
			let tmpClauses = [];
			for (let tmpKey of Object.keys(pWhere))
			{
				tmpClauses.push(`${tmpKey} = ?`);
				tmpParams.push(pWhere[tmpKey]);
			}
			if (tmpClauses.length > 0)
			{
				tmpSql += ' WHERE ' + tmpClauses.join(' AND ');
			}
		}
		tmpSql += ` ORDER BY rowid DESC`;

		return this.db.prepare(tmpSql).all(...tmpParams);
	}

	getById(pTable, pIDColumn, pID)
	{
		if (!this.db) { return null; }
		if (!ENTITY_TABLES[pTable]) { throw new Error(`Unknown table [${pTable}]`); }
		return this.db.prepare(`SELECT * FROM ${pTable} WHERE ${pIDColumn} = ?`).get(pID) || null;
	}

	insert(pTable, pRecord)
	{
		if (!this.db) { throw new Error('LabStateStore not initialized'); }
		if (!ENTITY_TABLES[pTable]) { throw new Error(`Unknown table [${pTable}]`); }

		let tmpKeys = Object.keys(pRecord);
		let tmpPlaceholders = tmpKeys.map(() => '?').join(', ');
		let tmpValues = tmpKeys.map((pKey) => pRecord[pKey]);
		let tmpSql = `INSERT INTO ${pTable} (${tmpKeys.join(', ')}) VALUES (${tmpPlaceholders})`;
		let tmpResult = this.db.prepare(tmpSql).run(...tmpValues);
		return tmpResult.lastInsertRowid;
	}

	update(pTable, pIDColumn, pID, pChanges)
	{
		if (!this.db) { throw new Error('LabStateStore not initialized'); }
		if (!ENTITY_TABLES[pTable]) { throw new Error(`Unknown table [${pTable}]`); }

		let tmpKeys = Object.keys(pChanges);
		if (tmpKeys.length === 0) { return 0; }
		let tmpSet = tmpKeys.map((pKey) => `${pKey} = ?`).join(', ');
		let tmpValues = tmpKeys.map((pKey) => pChanges[pKey]);
		tmpValues.push(pID);
		let tmpSql = `UPDATE ${pTable} SET ${tmpSet}, UpdatedAt = datetime('now') WHERE ${pIDColumn} = ?`;
		// Some tables lack UpdatedAt -- guard against it.
		if (!this._hasUpdatedAt(pTable))
		{
			tmpSql = `UPDATE ${pTable} SET ${tmpSet} WHERE ${pIDColumn} = ?`;
		}
		let tmpResult = this.db.prepare(tmpSql).run(...tmpValues);
		return tmpResult.changes;
	}

	remove(pTable, pIDColumn, pID)
	{
		if (!this.db) { throw new Error('LabStateStore not initialized'); }
		if (!ENTITY_TABLES[pTable]) { throw new Error(`Unknown table [${pTable}]`); }
		let tmpResult = this.db.prepare(`DELETE FROM ${pTable} WHERE ${pIDColumn} = ?`).run(pID);
		return tmpResult.changes;
	}

	_hasUpdatedAt(pTable)
	{
		return (pTable === 'DBEngine' || pTable === 'UltravisorInstance' || pTable === 'Beacon' || pTable === 'FactoInstance');
	}

	// ── Event log ────────────────────────────────────────────────────────────

	recordEvent(pEvent)
	{
		if (!this.db) { return 0; }

		let tmpRecord =
		{
			EntityType:  pEvent.EntityType || 'System',
			EntityID:    pEvent.EntityID || 0,
			EntityName:  pEvent.EntityName || '',
			EventType:   pEvent.EventType || 'info',
			Severity:    pEvent.Severity || 'info',
			Message:     pEvent.Message || '',
			Detail:      pEvent.Detail ? (typeof pEvent.Detail === 'string' ? pEvent.Detail : JSON.stringify(pEvent.Detail)) : ''
		};

		let tmpSql = `INSERT INTO InfrastructureEvent (EntityType, EntityID, EntityName, EventType, Severity, Message, Detail)
			VALUES (@EntityType, @EntityID, @EntityName, @EventType, @Severity, @Message, @Detail)`;
		let tmpResult = this.db.prepare(tmpSql).run(tmpRecord);
		return tmpResult.lastInsertRowid;
	}

	listEvents(pLimit)
	{
		if (!this.db) { return []; }
		let tmpLimit = (pLimit && pLimit > 0) ? pLimit : 200;
		return this.db.prepare(`SELECT * FROM InfrastructureEvent ORDER BY IDInfrastructureEvent DESC LIMIT ?`).all(tmpLimit);
	}

	// ── Shutdown ─────────────────────────────────────────────────────────────

	close()
	{
		if (this.db)
		{
			try { this.db.close(); } catch (pErr) { /* non-fatal */ }
			this.db = null;
		}
	}
}

module.exports = ServiceStateStore;
module.exports.ENTITY_TABLES = ENTITY_TABLES;
