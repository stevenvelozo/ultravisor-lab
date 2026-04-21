/**
 * Engine-Registry
 *
 * Collection of DB engine adapters keyed by EngineType.  Each adapter
 * exposes the same shape so Service-DBEngineManager can stay engine-
 * agnostic:
 *
 *   EngineType                string  (stable key: 'mysql', 'mssql', ...)
 *   DisplayName               string  (shown in the UI)
 *   DefaultImage              string  (docker image + tag)
 *   DefaultPort               number  (engine's native port inside the container)
 *   DefaultUsername           string
 *   DatabaseNoun              string  ('database', 'core', 'graph', ...)
 *   SupportsMultipleDatabases boolean (UI hides create form when false)
 *   defaultPassword()         string
 *   validatePassword(pw)      string | null
 *   buildEnv(opts)            { KEY: VALUE, ... }
 *   buildExtraRunArgs(opts)   [ ... ]
 *   healthCheckArgs(opts)     [ ... ]     -- docker exec argv; exit 0 == ready
 *   createDatabaseArgs(opts, dbname) [ ... ]
 *   dropDatabaseArgs(opts, dbname)   [ ... ]
 *   listDatabasesArgs(opts)          [ ... ]
 *   parseDatabaseList(stdout)        [ ... ]
 *   connectionString(engineRow)      string
 *   dockerExecEnv(opts)              { KEY: VALUE }  -- optional, extra env for exec calls
 *
 * Engines omitted from the registry on purpose:
 *   - SQLite / RocksDB -- embedded libraries, no server process to provision.
 *     Lab can still point beacons at SQLite files in a later phase without
 *     needing a DB-engine container.
 */
'use strict';

const libMySQL    = require('./Engine-MySQL.js');
const libMSSQL    = require('./Engine-MSSQL.js');
const libPostgres = require('./Engine-Postgres.js');
const libMongoDB  = require('./Engine-MongoDB.js');
const libSolr     = require('./Engine-Solr.js');
const libDGraph   = require('./Engine-DGraph.js');

const REGISTRY =
{
	[libMySQL.EngineType]:    libMySQL,
	[libMSSQL.EngineType]:    libMSSQL,
	[libPostgres.EngineType]: libPostgres,
	[libMongoDB.EngineType]:  libMongoDB,
	[libSolr.EngineType]:     libSolr,
	[libDGraph.EngineType]:   libDGraph
};

module.exports =
{
	get(pEngineType)
	{
		return REGISTRY[pEngineType] || null;
	},

	list()
	{
		return Object.keys(REGISTRY).map((pKey) =>
			{
				let tmpAdapter = REGISTRY[pKey];
				return {
					EngineType:                tmpAdapter.EngineType,
					DisplayName:               tmpAdapter.DisplayName,
					DefaultImage:              tmpAdapter.DefaultImage,
					DefaultPort:               tmpAdapter.DefaultPort,
					SuggestedHostPort:         tmpAdapter.SuggestedHostPort || tmpAdapter.DefaultPort,
					DefaultUsername:           tmpAdapter.DefaultUsername,
					DatabaseNoun:              tmpAdapter.DatabaseNoun || 'database',
					SupportsMultipleDatabases: tmpAdapter.SupportsMultipleDatabases !== false
				};
			});
	}
};
