/**
 * Engine-MySQL
 *
 * Adapter for dockerized MySQL 8.x containers.  All engine adapters share
 * the same shape; see Engine-Registry.js for the contract.
 */
'use strict';

const libCrypto = require('crypto');

const ENGINE_TYPE     = 'mysql';
const DEFAULT_IMAGE   = 'mysql:8.4';
const DEFAULT_PORT    = 3306;
const DEFAULT_USER    = 'root';

module.exports =
{
	EngineType:                ENGINE_TYPE,
	DisplayName:               'MySQL',
	DefaultImage:              DEFAULT_IMAGE,
	DefaultPort:               DEFAULT_PORT,
	SuggestedHostPort:         33306,
	DefaultUsername:           DEFAULT_USER,
	DatabaseNoun:              'database',
	SupportsMultipleDatabases: true,

	defaultPassword()
	{
		return 'Lab' + libCrypto.randomBytes(6).toString('hex') + '!';
	},

	validatePassword(pPassword)
	{
		if (!pPassword || pPassword.length < 4) { return 'MySQL password must be at least 4 characters.'; }
		return null;
	},

	buildEnv(pOptions)
	{
		return { MYSQL_ROOT_PASSWORD: pOptions.RootPassword };
	},

	buildExtraRunArgs(pOptions)
	{
		return [];
	},

	/**
	 * `docker exec` argv for a liveness ping.  A non-zero exit code means
	 * the container is still starting.
	 */
	healthCheckArgs(pOptions)
	{
		return ['mysqladmin', 'ping', '-h', '127.0.0.1', '-u', DEFAULT_USER, `-p${pOptions.RootPassword}`];
	},

	createDatabaseArgs(pOptions, pDatabaseName)
	{
		return [
			'mysql',
			'-h', '127.0.0.1',
			'-u', DEFAULT_USER,
			`-p${pOptions.RootPassword}`,
			'-e', `CREATE DATABASE IF NOT EXISTS \`${pDatabaseName}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;`
		];
	},

	dropDatabaseArgs(pOptions, pDatabaseName)
	{
		return [
			'mysql',
			'-h', '127.0.0.1',
			'-u', DEFAULT_USER,
			`-p${pOptions.RootPassword}`,
			'-e', `DROP DATABASE IF EXISTS \`${pDatabaseName}\`;`
		];
	},

	listDatabasesArgs(pOptions)
	{
		return [
			'mysql',
			'-h', '127.0.0.1',
			'-u', DEFAULT_USER,
			`-p${pOptions.RootPassword}`,
			'-Nse', 'SHOW DATABASES'
		];
	},

	parseDatabaseList(pStdout)
	{
		let tmpSystem = new Set(['information_schema', 'mysql', 'performance_schema', 'sys']);
		return pStdout.split('\n').map((pLine) => pLine.trim()).filter((pName) => pName.length > 0 && !tmpSystem.has(pName));
	},

	connectionString(pEngine)
	{
		return `mysql://${pEngine.RootUsername}:${pEngine.RootPassword}@127.0.0.1:${pEngine.Port}`;
	}
};
