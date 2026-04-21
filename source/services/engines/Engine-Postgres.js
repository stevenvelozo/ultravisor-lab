/**
 * Engine-Postgres
 *
 * Adapter for dockerized PostgreSQL 16 containers.
 */
'use strict';

const libCrypto = require('crypto');

const ENGINE_TYPE     = 'postgres';
const DEFAULT_IMAGE   = 'postgres:16';
const DEFAULT_PORT    = 5432;
const DEFAULT_USER    = 'postgres';

module.exports =
{
	EngineType:                ENGINE_TYPE,
	DisplayName:               'PostgreSQL',
	DefaultImage:              DEFAULT_IMAGE,
	DefaultPort:               DEFAULT_PORT,
	SuggestedHostPort:         35432,
	DefaultUsername:           DEFAULT_USER,
	DatabaseNoun:              'database',
	SupportsMultipleDatabases: true,

	defaultPassword()
	{
		return 'lab' + libCrypto.randomBytes(6).toString('hex');
	},

	validatePassword(pPassword)
	{
		if (!pPassword || pPassword.length < 4) { return 'Postgres password must be at least 4 characters.'; }
		return null;
	},

	buildEnv(pOptions)
	{
		return { POSTGRES_PASSWORD: pOptions.RootPassword };
	},

	buildExtraRunArgs(pOptions)
	{
		return [];
	},

	healthCheckArgs(pOptions)
	{
		return ['pg_isready', '-h', '127.0.0.1', '-U', DEFAULT_USER];
	},

	createDatabaseArgs(pOptions, pDatabaseName)
	{
		return [
			'psql',
			'-h', '127.0.0.1',
			'-U', DEFAULT_USER,
			'-d', 'postgres',
			'-v', 'ON_ERROR_STOP=1',
			'-c', `CREATE DATABASE "${pDatabaseName}"`
		];
	},

	dropDatabaseArgs(pOptions, pDatabaseName)
	{
		return [
			'psql',
			'-h', '127.0.0.1',
			'-U', DEFAULT_USER,
			'-d', 'postgres',
			'-v', 'ON_ERROR_STOP=1',
			'-c', `DROP DATABASE IF EXISTS "${pDatabaseName}"`
		];
	},

	listDatabasesArgs(pOptions)
	{
		return [
			'psql',
			'-h', '127.0.0.1',
			'-U', DEFAULT_USER,
			'-d', 'postgres',
			'-At',
			'-c', `SELECT datname FROM pg_database WHERE datistemplate = false`
		];
	},

	parseDatabaseList(pStdout)
	{
		let tmpSystem = new Set(['postgres']);
		return pStdout.split('\n').map((pLine) => pLine.trim()).filter((pName) => pName.length > 0 && !tmpSystem.has(pName));
	},

	connectionString(pEngine)
	{
		return `postgres://${pEngine.RootUsername}:${pEngine.RootPassword}@127.0.0.1:${pEngine.Port}/postgres`;
	},

	/**
	 * PG refuses password auth unless PGPASSWORD is in the environment; we
	 * inject it into every exec via dockerExecEnv (DockerManager adds it
	 * as `-e NAME=VALUE` in the exec command).
	 */
	dockerExecEnv(pOptions)
	{
		return { PGPASSWORD: pOptions.RootPassword };
	}
};
