/**
 * Engine-Solr
 *
 * Adapter for dockerized Apache Solr 9.x containers.
 *
 * Solr's data-organization unit is a "core" rather than a database; this
 * adapter surfaces cores through the same create/drop/list contract and
 * uses `DatabaseNoun: 'core'` so the UI labels them correctly.
 *
 * The default Solr image starts without auth enabled.  We still capture a
 * generated "password" in state for symmetry with the other engines, but
 * there is no credential check on the HTTP endpoints.
 */
'use strict';

const libCrypto = require('crypto');

const ENGINE_TYPE    = 'solr';
const DEFAULT_IMAGE  = 'solr:9';
const DEFAULT_PORT   = 8983;
const DEFAULT_USER   = 'solr';

module.exports =
{
	EngineType:                ENGINE_TYPE,
	DisplayName:               'Apache Solr',
	DefaultImage:              DEFAULT_IMAGE,
	DefaultPort:               DEFAULT_PORT,
	SuggestedHostPort:         38983,
	DefaultUsername:           DEFAULT_USER,
	DatabaseNoun:              'core',
	SupportsMultipleDatabases: true,

	defaultPassword()
	{
		// Solr-in-docker doesn't authenticate by default; we keep a token so
		// the state row has a non-empty password (matches the other engines).
		return 'lab-' + libCrypto.randomBytes(6).toString('hex');
	},

	validatePassword(pPassword)
	{
		return null;
	},

	buildEnv(pOptions)
	{
		return {};
	},

	buildExtraRunArgs(pOptions)
	{
		// Solr's image ENTRYPOINT requires `solr-precreate <core>` or
		// `solr-foreground` as the command.  We want an empty node so cores
		// can be created on demand; `solr-foreground` is the idiomatic way.
		return [];
	},

	healthCheckArgs(pOptions)
	{
		// Use wget (present in the solr image) to hit the admin status endpoint.
		return ['wget', '-q', '-O', '-', 'http://localhost:8983/solr/admin/info/system?wt=json'];
	},

	createDatabaseArgs(pOptions, pDatabaseName)
	{
		// `solr create -c <name>` creates a core using the default configset.
		return ['solr', 'create', '-c', pDatabaseName];
	},

	dropDatabaseArgs(pOptions, pDatabaseName)
	{
		return ['solr', 'delete', '-c', pDatabaseName];
	},

	listDatabasesArgs(pOptions)
	{
		// `solr status` prints running info; the cores are more reliably
		// fetched via the Admin API.  wget keeps output clean for parsing.
		return ['wget', '-q', '-O', '-', 'http://localhost:8983/solr/admin/cores?action=STATUS&wt=json'];
	},

	parseDatabaseList(pStdout)
	{
		try
		{
			let tmpPayload = JSON.parse(pStdout);
			if (!tmpPayload || !tmpPayload.status) { return []; }
			return Object.keys(tmpPayload.status);
		}
		catch (pErr)
		{
			return [];
		}
	},

	connectionString(pEngine)
	{
		return `http://127.0.0.1:${pEngine.Port}/solr/`;
	}
};
