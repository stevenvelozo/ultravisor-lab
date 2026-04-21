#!/usr/bin/env node
/**
 * lab-ultravisor
 *
 * One-process child spawn that hosts a single Ultravisor API server.
 * Service-UltravisorManager invokes this per UltravisorInstance row.
 *
 * meadow-integration beacons used to run in this process; they now live
 * in their own script (`lab-meadow-integration-beacon.js`) and are tracked
 * as separate entities with independent lifecycle.
 *
 * Operation JSONs living under <library-dir> are loaded into the Ultravisor
 * at startup via UltravisorHypervisorState.updateOperation().
 *
 * CLI:
 *   node lab-ultravisor.js
 *     --port <N>               Ultravisor API port (default 54321)
 *     --library-dir <path>     Directory to scan for *.json operation files
 *     --data-dir <path>        Where Ultravisor puts its file store + staging
 */
'use strict';

const libPath = require('path');
const libFs = require('fs');

const libPict = require('pict');
const libUltravisor = require('ultravisor');
const libUltravisorAPIServer = require('ultravisor/source/web_server/Ultravisor-API-Server.cjs');

// ──────────────────────────────────────────────────────────────────────────
//  argv
// ──────────────────────────────────────────────────────────────────────────

function parseArgs(pArgv)
{
	let tmpArgs =
	{
		Port:        54321,
		LibraryDir:  libPath.resolve(process.cwd(), 'operations'),
		DataDir:     libPath.resolve(process.cwd(), 'data')
	};
	for (let i = 0; i < pArgv.length; i++)
	{
		let tmpArg = pArgv[i];
		if (tmpArg === '--port')        { tmpArgs.Port       = parseInt(pArgv[++i], 10); continue; }
		if (tmpArg === '--library-dir') { tmpArgs.LibraryDir = libPath.resolve(pArgv[++i]); continue; }
		if (tmpArg === '--data-dir')    { tmpArgs.DataDir    = libPath.resolve(pArgv[++i]); continue; }
		// Ignore legacy flags so older config.json files (with --beacon-port /
		// --beacon-name) still start cleanly after the split.
		if (tmpArg === '--beacon-port' || tmpArg === '--beacon-name') { ++i; continue; }
	}
	return tmpArgs;
}

const _args = parseArgs(process.argv.slice(2));

// ──────────────────────────────────────────────────────────────────────────
//  Ultravisor bootstrap
// ──────────────────────────────────────────────────────────────────────────

libFs.mkdirSync(_args.DataDir,       { recursive: true });
libFs.mkdirSync(_args.LibraryDir,    { recursive: true });

const _uvDataStore = libPath.join(_args.DataDir, 'ultravisor_datastore');
const _uvStaging   = libPath.join(_args.DataDir, 'ultravisor_staging');
libFs.mkdirSync(_uvDataStore, { recursive: true });
libFs.mkdirSync(_uvStaging,   { recursive: true });

let _uvPict = new libPict(
	{
		Product:      'Lab-Ultravisor',
		LogNoisiness: 1,
		APIServerPort: _args.Port
	});

// Ultravisor's HypervisorState expects `gatherProgramConfiguration()` (from
// pict-service-commandlineutility).  The lab isn't using the CLI utility,
// so supply a stub that returns the config it would have loaded from
// .ultravisor.json.
let _uvConfig =
{
	UltravisorAPIServerPort:            _args.Port,
	UltravisorFileStorePath:            _uvDataStore,
	UltravisorStagingRoot:              _uvStaging,
	UltravisorTickIntervalMilliseconds: 60000,
	UltravisorCommandTimeoutMilliseconds: 300000,
	UltravisorCommandMaxBufferBytes:    10485760,
	UltravisorWebInterfacePath:         libPath.join(libPath.dirname(require.resolve('ultravisor/package.json')), 'webinterface', 'dist'),
	UltravisorOperationLibraryPath:     _args.LibraryDir,
	UltravisorBeaconHeartbeatTimeoutMs: 60000,
	UltravisorBeaconWorkItemTimeoutMs:  300000,
	UltravisorBeaconAffinityTTLMs:      3600000,
	UltravisorBeaconPollIntervalMs:     5000,
	UltravisorBeaconJournalCompactThreshold: 500
};
_uvPict.ProgramConfiguration = _uvConfig;
_uvPict.gatherProgramConfiguration = function ()
{
	return { GatherPhases: [{ Phase: 'Lab', Path: '(lab-generated)' }], Settings: _uvConfig };
};

// Register and instantiate core Ultravisor services.
_uvPict.serviceManager.addServiceType('UltravisorTaskTypeRegistry',   libUltravisor.TaskTypeRegistry);
_uvPict.serviceManager.addServiceType('UltravisorStateManager',       libUltravisor.StateManager);
_uvPict.serviceManager.addServiceType('UltravisorExecutionEngine',    libUltravisor.ExecutionEngine);
_uvPict.serviceManager.addServiceType('UltravisorExecutionManifest',  libUltravisor.ExecutionManifest);
_uvPict.serviceManager.addServiceType('UltravisorHypervisorState',    libUltravisor.HypervisorState);
_uvPict.serviceManager.addServiceType('UltravisorHypervisor',         libUltravisor.Hypervisor);
_uvPict.serviceManager.addServiceType('UltravisorBeaconCoordinator',  libUltravisor.BeaconCoordinator);
_uvPict.serviceManager.instantiateServiceProvider('UltravisorTaskTypeRegistry');
_uvPict.serviceManager.instantiateServiceProvider('UltravisorStateManager');
_uvPict.serviceManager.instantiateServiceProvider('UltravisorExecutionEngine');
_uvPict.serviceManager.instantiateServiceProvider('UltravisorExecutionManifest');
_uvPict.serviceManager.instantiateServiceProvider('UltravisorHypervisorState');
_uvPict.serviceManager.instantiateServiceProvider('UltravisorHypervisor');
_uvPict.serviceManager.instantiateServiceProvider('UltravisorBeaconCoordinator');

// Built-in task types (meadow-connection tasks, transforms, etc.).
if (typeof _uvPict.UltravisorTaskTypeRegistry.registerBuiltInTaskTypes === 'function')
{
	_uvPict.UltravisorTaskTypeRegistry.registerBuiltInTaskTypes();
}

// Load operation JSONs from the library dir.
function loadOperationLibrary()
{
	let tmpFiles = [];
	try { tmpFiles = libFs.readdirSync(_args.LibraryDir).filter((pF) => pF.endsWith('.json')); }
	catch (pErr) { console.warn(`[lab-ultravisor] No operation library at ${_args.LibraryDir}`); return; }

	for (let i = 0; i < tmpFiles.length; i++)
	{
		let tmpPath = libPath.join(_args.LibraryDir, tmpFiles[i]);
		try
		{
			let tmpOp = JSON.parse(libFs.readFileSync(tmpPath, 'utf8'));
			_uvPict.UltravisorHypervisorState.updateOperation(tmpOp,
				(pErr) =>
				{
					if (pErr) { console.warn(`[lab-ultravisor] Failed to load ${tmpFiles[i]}: ${pErr.message}`); }
					else      { console.log(`[lab-ultravisor] Loaded operation: ${tmpOp.Hash}`); }
				});
		}
		catch (pParseErr)
		{
			console.warn(`[lab-ultravisor] Invalid JSON in ${tmpFiles[i]}: ${pParseErr.message}`);
		}
	}
}

loadOperationLibrary();

// Start the Ultravisor API server.
_uvPict.serviceManager.addServiceType('UltravisorAPIServer', libUltravisorAPIServer);
let _uvAPIServer = _uvPict.serviceManager.instantiateServiceProvider('UltravisorAPIServer');
_uvAPIServer.start(
	(pUvErr) =>
	{
		if (pUvErr)
		{
			console.error('[lab-ultravisor] Ultravisor start failed:', pUvErr.message || pUvErr);
			process.exit(1);
		}
		console.log(`[lab-ultravisor] Ultravisor API listening on port ${_args.Port}`);
	});

// ──────────────────────────────────────────────────────────────────────────
//  Graceful shutdown
// ──────────────────────────────────────────────────────────────────────────

function shutdown()
{
	console.log('[lab-ultravisor] Shutting down...');
	setTimeout(() => process.exit(0), 500);
}
process.on('SIGINT',  shutdown);
process.on('SIGTERM', shutdown);
