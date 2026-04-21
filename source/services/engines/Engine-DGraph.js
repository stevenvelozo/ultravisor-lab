/**
 * Engine-DGraph
 *
 * Adapter for dockerized DGraph containers using the `standalone` image
 * that bundles Zero + Alpha in a single process -- convenient for dev,
 * not for production.
 *
 * DGraph's data model does not map cleanly onto "databases":
 *   - Community edition hosts a single graph per instance.
 *   - Multi-tenancy (namespaces) is an enterprise feature.
 * We therefore set `SupportsMultipleDatabases: false`, and the UI hides
 * the "+ database" form for DGraph engines.  Schema mutations happen via
 * the DQL / GraphQL HTTP API on the container's port.
 */
'use strict';

const libCrypto = require('crypto');

const ENGINE_TYPE    = 'dgraph';
const DEFAULT_IMAGE  = 'dgraph/standalone:v24.0.5';
const DEFAULT_PORT   = 8080;
const DEFAULT_USER   = 'groot';

module.exports =
{
	EngineType:                ENGINE_TYPE,
	DisplayName:               'DGraph',
	DefaultImage:              DEFAULT_IMAGE,
	DefaultPort:               DEFAULT_PORT,
	SuggestedHostPort:         38080,
	DefaultUsername:           DEFAULT_USER,
	DatabaseNoun:              'graph',
	SupportsMultipleDatabases: false,

	defaultPassword()
	{
		// DGraph community has no auth by default; we still stash a token.
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
		// Expose the gRPC port too.  The Zero port (5080) is internal-only
		// for the standalone image.  The UI only shows the HTTP port.
		return ['-p', '9080:9080'];
	},

	healthCheckArgs(pOptions)
	{
		// The DGraph Alpha exposes /health on the HTTP port.  wget is
		// present in the debian-based dgraph image via apt; curl is not.
		// Fall back to bash-wrapped /dev/tcp which is always available.
		return ['bash', '-c', 'echo > /dev/tcp/127.0.0.1/8080 && echo ok'];
	},

	// These are stubs -- gated off by SupportsMultipleDatabases=false --
	// but kept around so the adapter contract stays uniform for callers.
	createDatabaseArgs(pOptions, pDatabaseName)
	{
		return ['true'];
	},

	dropDatabaseArgs(pOptions, pDatabaseName)
	{
		return ['true'];
	},

	listDatabasesArgs(pOptions)
	{
		return ['true'];
	},

	parseDatabaseList(pStdout)
	{
		return [];
	},

	connectionString(pEngine)
	{
		return `dgraph://127.0.0.1:${pEngine.Port} (HTTP) / 127.0.0.1:9080 (gRPC)`;
	}
};
