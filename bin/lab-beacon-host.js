#!/usr/bin/env node
/**
 * lab-beacon-host
 *
 * Generic host process for beacon types running in `capability-provider`
 * mode.  Boots an Orator, loads one or more ultravisor-beacon
 * CapabilityProvider classes from specified module paths, wraps them in a
 * beacon registered with the supplied Ultravisor, and stays running.
 *
 * Service-BeaconManager spawns this with arguments assembled from the
 * type descriptor and the user-saved config blob.
 *
 * CLI:
 *   node lab-beacon-host.js
 *     --port <N>                   Local HTTP port (required)
 *     --beacon-name <name>         Beacon name used when registering (default: host)
 *     --ultravisor-url <URL>       Ultravisor API base URL (required)
 *     --provider <label:abspath>   Capability provider class file path.
 *                                  May repeat to load multiple providers.
 *     --config <path-to-json>      Optional: JSON object passed to each
 *                                  provider constructor as ProviderConfig.
 */
'use strict';

const libPath = require('path');
const libFs = require('fs');

const libPict = require('pict');
const libOrator = require('orator');
const libOratorRestify = require('orator-serviceserver-restify');
const libUltravisorBeacon = require('ultravisor-beacon');

// ──────────────────────────────────────────────────────────────────────────
//  argv
// ──────────────────────────────────────────────────────────────────────────

function parseArgs(pArgv)
{
	let tmpArgs =
	{
		Port:          0,
		BeaconName:    'host',
		UltravisorURL: '',
		Providers:     [],
		ConfigPath:    ''
	};
	for (let i = 0; i < pArgv.length; i++)
	{
		let tmpArg = pArgv[i];
		if (tmpArg === '--port')            { tmpArgs.Port          = parseInt(pArgv[++i], 10); continue; }
		if (tmpArg === '--beacon-name')     { tmpArgs.BeaconName    = pArgv[++i]; continue; }
		if (tmpArg === '--ultravisor-url')  { tmpArgs.UltravisorURL = pArgv[++i]; continue; }
		if (tmpArg === '--provider')        { tmpArgs.Providers.push(pArgv[++i]); continue; }
		if (tmpArg === '--config')          { tmpArgs.ConfigPath    = pArgv[++i]; continue; }
	}
	return tmpArgs;
}

const _args = parseArgs(process.argv.slice(2));

if (!_args.Port || _args.Port < 1 || _args.Port > 65535)
{
	console.error('[lab-beacon-host] --port is required and must be between 1 and 65535.');
	process.exit(2);
}
if (!_args.UltravisorURL)
{
	console.error('[lab-beacon-host] --ultravisor-url is required.');
	process.exit(2);
}
if (_args.Providers.length === 0)
{
	console.error('[lab-beacon-host] at least one --provider <label:path> is required.');
	process.exit(2);
}

// Load the saved config blob (user-supplied via the per-type form).  Passed
// unchanged to each provider constructor; providers pull only the keys they
// care about.
let _providerConfig = {};
if (_args.ConfigPath)
{
	try { _providerConfig = JSON.parse(libFs.readFileSync(_args.ConfigPath, 'utf8')); }
	catch (pErr)
	{
		console.warn(`[lab-beacon-host] Could not read config ${_args.ConfigPath}: ${pErr.message}`);
	}
}

// ──────────────────────────────────────────────────────────────────────────
//  Resolve providers
// ──────────────────────────────────────────────────────────────────────────

// Provider loading is deferred until after the pict instance is built so
// we can hand it to providers that want to register meadow-style services
// through the native serviceManager wiring.
let _providers = null;

function loadProvider(pSpec, pPict)
{
	// "label:path" -- label is used only for logging; path is require()d.
	let tmpIdx = pSpec.indexOf(':');
	let tmpLabel = tmpIdx > 0 ? pSpec.slice(0, tmpIdx) : 'provider';
	let tmpPath  = tmpIdx > 0 ? pSpec.slice(tmpIdx + 1) : pSpec;

	let tmpModule;
	try { tmpModule = require(tmpPath); }
	catch (pErr)
	{
		console.error(`[lab-beacon-host] Could not require provider ${tmpLabel} from ${tmpPath}: ${pErr.message}`);
		process.exit(1);
	}

	// Providers are typically the default export OR the module itself if
	// it's a class.  Accept either shape.
	let tmpCtor = typeof tmpModule === 'function' ? tmpModule : tmpModule.default;
	if (typeof tmpCtor !== 'function')
	{
		console.error(`[lab-beacon-host] Provider ${tmpLabel} at ${tmpPath} did not export a constructor.`);
		process.exit(1);
	}

	try
	{
		// Pass the host pict as the second arg so providers that need it
		// (meadow-integration) can use serviceManager.  Providers that
		// don't care (orator-conversion) simply ignore it.
		let tmpInstance = new tmpCtor(_providerConfig, pPict);
		console.log(`[lab-beacon-host] Loaded provider '${tmpLabel}' (${tmpInstance.Name || 'unnamed'} / ${tmpInstance.Capability || 'unknown'})`);
		return tmpInstance;
	}
	catch (pErr)
	{
		console.error(`[lab-beacon-host] Provider ${tmpLabel} constructor threw: ${pErr.message}`);
		process.exit(1);
	}
}

// ──────────────────────────────────────────────────────────────────────────
//  Orator
// ──────────────────────────────────────────────────────────────────────────

let _pict = new libPict(
	{
		Product:       'Lab-Beacon-Host',
		LogNoisiness:  1,
		APIServerPort: _args.Port
	});

// Providers are loaded after the pict exists so provider constructors that
// need to register services (e.g. meadow-integration via serviceManager)
// have a real host to attach to.
_providers = _args.Providers.map((pSpec) => loadProvider(pSpec, _pict));

_pict.serviceManager.addServiceType('OratorServiceServer', libOratorRestify);
_pict.serviceManager.addServiceType('Orator', libOrator);
_pict.serviceManager.instantiateServiceProvider('OratorServiceServer');
let _orator = _pict.serviceManager.instantiateServiceProvider('Orator');

_orator.initialize(
	(pInitErr) =>
	{
		if (pInitErr)
		{
			console.error('[lab-beacon-host] orator init failed:', pInitErr.message);
			process.exit(1);
		}

		_pict.OratorServiceServer.server.use(_pict.OratorServiceServer.bodyParser());

		_orator.startWebServer(
			(pStartErr) =>
			{
				if (pStartErr)
				{
					console.error('[lab-beacon-host] start failed:', pStartErr.message);
					process.exit(1);
				}
				console.log(`[lab-beacon-host] listening on port ${_args.Port}`);
				registerBeacon();
			});
	});

// ──────────────────────────────────────────────────────────────────────────
//  Beacon registration
// ──────────────────────────────────────────────────────────────────────────

function registerBeacon()
{
	_pict.serviceManager.addServiceType('UltravisorBeacon', libUltravisorBeacon);
	let tmpBeacon = _pict.serviceManager.instantiateServiceProvider('UltravisorBeacon',
		{
			ServerURL:      _args.UltravisorURL,
			Name:           _args.BeaconName,
			MaxConcurrent:  5
		});

	// Each provider exposes either a `.register(beacon)` convenience or the
	// lower-level .Name / .Capability / .actions surface registerCapability
	// expects.  Accept both so provider classes don't have to implement a
	// lab-specific helper.
	for (let i = 0; i < _providers.length; i++)
	{
		let tmpProvider = _providers[i];
		if (typeof tmpProvider.register === 'function')
		{
			tmpProvider.register(tmpBeacon);
			continue;
		}
		if (tmpProvider.Capability && tmpProvider.actions)
		{
			tmpBeacon.registerCapability(
				{
					Capability: tmpProvider.Capability,
					Name:       tmpProvider.Name || tmpProvider.Capability,
					actions:    tmpProvider.actions
				});
			continue;
		}
		console.warn(`[lab-beacon-host] Provider at index ${i} has no register() and no Capability/actions pair; skipping.`);
	}

	tmpBeacon.enable(
		(pErr, pInfo) =>
		{
			if (pErr)
			{
				console.warn(`[lab-beacon-host] beacon registration warning: ${pErr.message}`);
				return;
			}
			console.log(`[lab-beacon-host] beacon registered as '${_args.BeaconName}' with ${_args.UltravisorURL}`);
		});
}

// ──────────────────────────────────────────────────────────────────────────
//  Graceful shutdown
// ──────────────────────────────────────────────────────────────────────────

function shutdown()
{
	console.log('[lab-beacon-host] Shutting down...');
	setTimeout(() => process.exit(0), 500);
}
process.on('SIGINT',  shutdown);
process.on('SIGTERM', shutdown);
