/**
 * Engine-MongoDB
 *
 * Adapter for dockerized MongoDB 7.x containers.
 *
 * MongoDB quirks handled here:
 *   - Databases are lazily created on first write; we force creation by
 *     inserting a tiny `_lab_init` doc into a sentinel collection.
 *   - `admin` is the authentication DB for the root user.  All mongosh
 *     invocations pass --authenticationDatabase admin.
 *   - Health check uses `db.runCommand({ ping: 1 })` which succeeds before
 *     any user collections exist.
 */
'use strict';

const libCrypto = require('crypto');

const ENGINE_TYPE    = 'mongodb';
const DEFAULT_IMAGE  = 'mongo:7';
const DEFAULT_PORT   = 27017;
const DEFAULT_USER   = 'admin';

function _authArgs(pOptions)
{
	return ['-u', DEFAULT_USER, '-p', pOptions.RootPassword, '--authenticationDatabase', 'admin', '--quiet'];
}

module.exports =
{
	EngineType:                ENGINE_TYPE,
	DisplayName:               'MongoDB',
	DefaultImage:              DEFAULT_IMAGE,
	DefaultPort:               DEFAULT_PORT,
	SuggestedHostPort:         37017,
	DefaultUsername:           DEFAULT_USER,
	DatabaseNoun:              'database',
	SupportsMultipleDatabases: true,

	defaultPassword()
	{
		return 'lab' + libCrypto.randomBytes(6).toString('hex');
	},

	validatePassword(pPassword)
	{
		if (!pPassword || pPassword.length < 4) { return 'MongoDB password must be at least 4 characters.'; }
		return null;
	},

	buildEnv(pOptions)
	{
		return {
			MONGO_INITDB_ROOT_USERNAME: DEFAULT_USER,
			MONGO_INITDB_ROOT_PASSWORD: pOptions.RootPassword
		};
	},

	buildExtraRunArgs(pOptions)
	{
		return [];
	},

	healthCheckArgs(pOptions)
	{
		let tmpArgs = ['mongosh'].concat(_authArgs(pOptions));
		tmpArgs.push('--eval', 'db.runCommand({ ping: 1 })');
		return tmpArgs;
	},

	createDatabaseArgs(pOptions, pDatabaseName)
	{
		// Use(<name>) + an insert forces Mongo to materialize the database.
		// The collection name avoids a leading underscore -- mongosh treats
		// `db._foo` as a JS private-property access and the insert fails.
		let tmpScript = `db = db.getSiblingDB('${pDatabaseName}'); db.getCollection('lab_init').insertOne({ createdAt: new Date() });`;
		let tmpArgs = ['mongosh'].concat(_authArgs(pOptions));
		tmpArgs.push('--eval', tmpScript);
		return tmpArgs;
	},

	dropDatabaseArgs(pOptions, pDatabaseName)
	{
		let tmpScript = `db.getSiblingDB('${pDatabaseName}').dropDatabase();`;
		let tmpArgs = ['mongosh'].concat(_authArgs(pOptions));
		tmpArgs.push('--eval', tmpScript);
		return tmpArgs;
	},

	listDatabasesArgs(pOptions)
	{
		let tmpScript = 'db.adminCommand({ listDatabases: 1 }).databases.forEach(function (d) { print(d.name); });';
		let tmpArgs = ['mongosh'].concat(_authArgs(pOptions));
		tmpArgs.push('--eval', tmpScript);
		return tmpArgs;
	},

	parseDatabaseList(pStdout)
	{
		let tmpSystem = new Set(['admin', 'config', 'local']);
		return pStdout
			.split('\n')
			.map((pLine) => pLine.trim())
			.filter((pName) => pName.length > 0 && !tmpSystem.has(pName));
	},

	connectionString(pEngine)
	{
		return `mongodb://${pEngine.RootUsername}:${pEngine.RootPassword}@127.0.0.1:${pEngine.Port}/?authSource=admin`;
	}
};
