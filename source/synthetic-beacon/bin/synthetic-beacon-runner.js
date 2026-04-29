#!/usr/bin/env node
/**
 * synthetic-beacon-runner — CLI entry for the lab's synthetic worker beacon.
 *
 * Two callers spawn this script with the same argv shape:
 *   1. Service-QueueScenarioManager (child-process mode) — direct spawn,
 *      lifecycle owned by the scenario runner.
 *   2. The Docker entrypoint for the lab-synthetic-beacon image — fed by
 *      _buildSpawnSpec's expanded argTemplate.
 *
 * Usage:
 *   synthetic-beacon-runner [options]
 *
 * Options:
 *   --ultravisor URL           Ultravisor URL (default http://localhost:54321)
 *   --name NAME                Beacon name (default synthetic-beacon)
 *   --join-secret SECRET       Bootstrap secret presented at registration
 *   --capability NAME          Capability advertised (default Synthetic)
 *   --actions A,B,C            CSV of action names (default Process)
 *   --default-duration-ms N    Default sleep per action (default 2000)
 *   --max-concurrent N         Per-beacon concurrency limit (default 1)
 *   --config PATH              JSON config file (overlaid before CLI args)
 */

const libPath = require('path');
const libFS = require('fs');

const libSyntheticBeaconHarness = require('../source/SyntheticBeaconHarness.cjs');

let _Config =
	{
		UltravisorURL: 'http://localhost:54321',
		BeaconName: 'synthetic-beacon',
		JoinSecret: '',
		Capability: 'Synthetic',
		Actions: ['Process'],
		DefaultDurationMs: 2000,
		MaxConcurrent: 1
	};

function parseActions(pValue)
{
	if (Array.isArray(pValue)) { return pValue.slice(); }
	if (typeof pValue !== 'string' || pValue.length === 0) { return ['Process']; }
	let tmpParts = pValue.split(',').map((pItem) => pItem.trim()).filter((pItem) => pItem.length > 0);
	return tmpParts.length > 0 ? tmpParts : ['Process'];
}

// JSON config file (optional, applied before CLI args)
for (let i = 2; i < process.argv.length; i++)
{
	if (process.argv[i] === '--config' && process.argv[i + 1])
	{
		let tmpPath = libPath.resolve(process.argv[++i]);
		try
		{
			let tmpJSON = JSON.parse(libFS.readFileSync(tmpPath, 'utf8'));
			Object.assign(_Config, tmpJSON);
			if (tmpJSON.Actions !== undefined) { _Config.Actions = parseActions(tmpJSON.Actions); }
			console.log(`[synthetic-beacon] Loaded config from ${tmpPath}`);
		}
		catch (pError)
		{
			console.error(`[synthetic-beacon] Could not parse ${tmpPath}: ${pError.message}`);
			process.exit(1);
		}
	}
}

// CLI args (override config)
for (let i = 2; i < process.argv.length; i++)
{
	let tmpArg = process.argv[i];
	if (tmpArg === '--ultravisor' && process.argv[i + 1])              { _Config.UltravisorURL = process.argv[++i]; }
	else if (tmpArg === '--name' && process.argv[i + 1])               { _Config.BeaconName = process.argv[++i]; }
	else if (tmpArg === '--join-secret' && process.argv[i + 1])        { _Config.JoinSecret = process.argv[++i]; }
	else if (tmpArg === '--capability' && process.argv[i + 1])         { _Config.Capability = process.argv[++i]; }
	else if (tmpArg === '--actions' && process.argv[i + 1])            { _Config.Actions = parseActions(process.argv[++i]); }
	else if (tmpArg === '--default-duration-ms' && process.argv[i + 1]) { _Config.DefaultDurationMs = Number(process.argv[++i]); }
	else if (tmpArg === '--max-concurrent' && process.argv[i + 1])     { _Config.MaxConcurrent = Number(process.argv[++i]); }
	else if (tmpArg === '--help' || tmpArg === '-h')
	{
		console.log(`Usage: synthetic-beacon-runner [options]

Options:
  --ultravisor URL           Ultravisor URL (default http://localhost:54321)
  --name NAME                Beacon name (default synthetic-beacon)
  --join-secret SECRET       Bootstrap secret presented at registration
  --capability NAME          Capability advertised (default Synthetic)
  --actions A,B,C            CSV of action names (default Process)
  --default-duration-ms N    Default sleep per action (default 2000)
  --max-concurrent N         Per-beacon concurrency limit (default 1)
  --config PATH              JSON config file (overlaid before CLI args)
`);
		process.exit(0);
	}
}

if (!Number.isFinite(_Config.DefaultDurationMs) || _Config.DefaultDurationMs < 0) { _Config.DefaultDurationMs = 2000; }
if (!Number.isFinite(_Config.MaxConcurrent) || _Config.MaxConcurrent < 1) { _Config.MaxConcurrent = 1; }

let tmpHarness = new libSyntheticBeaconHarness(
	{
		UltravisorURL: _Config.UltravisorURL,
		BeaconName: _Config.BeaconName,
		JoinSecret: _Config.JoinSecret,
		Capability: _Config.Capability,
		Actions: _Config.Actions,
		DefaultDurationMs: _Config.DefaultDurationMs,
		MaxConcurrent: _Config.MaxConcurrent
	});

tmpHarness.start((pError, pBeaconID) =>
	{
		if (pError)
		{
			console.error(`[synthetic-beacon] start failed: ${pError.message}`);
			process.exit(3);
		}
		console.log(
			`[synthetic-beacon] Online as ${pBeaconID || _Config.BeaconName} on ${_Config.UltravisorURL} ` +
			`(capability=${_Config.Capability}, actions=${_Config.Actions.join(',')}, ` +
			`max-concurrent=${_Config.MaxConcurrent})`);
	});

let _Shutting = false;
let fShutdown = (pSignal) =>
	{
		if (_Shutting) { return; }
		_Shutting = true;
		console.log(`[synthetic-beacon] caught ${pSignal}, shutting down`);
		tmpHarness.stop(() => process.exit(0));
		setTimeout(() => process.exit(0), 5000).unref();
	};
process.on('SIGINT', () => fShutdown('SIGINT'));
process.on('SIGTERM', () => fShutdown('SIGTERM'));
