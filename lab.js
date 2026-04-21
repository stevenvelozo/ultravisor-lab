#!/usr/bin/env node
/**
 * Ultravisor Lab -- entry point
 *
 *   node lab.js                    -> start the web UI on 127.0.0.1:44443
 *   node lab.js --port 5555
 *   node lab.js --host 0.0.0.0
 *   node lab.js --no-open
 *
 * The web server is the only mode in Phase 1.  A TUI mode may land later,
 * at which point we'll dispatch on `--web` the same way retold-manager does.
 */
'use strict';

const libPath = require('path');
const libChildProcess = require('child_process');

const libLabServerSetup = require('./source/web_server/Lab-Server-Setup.js');

// ─────────────────────────────────────────────
//  argv
// ─────────────────────────────────────────────

function parseArgs(pArgv)
{
	let tmpArgs =
	{
		Port: 44443,
		Host: '127.0.0.1',
		Open: true
	};

	for (let i = 0; i < pArgv.length; i++)
	{
		let tmpArg = pArgv[i];
		if (tmpArg === '--web')     { continue; }
		if (tmpArg === '--port')    { tmpArgs.Port = parseInt(pArgv[++i], 10); continue; }
		if (tmpArg.startsWith('--port=')) { tmpArgs.Port = parseInt(tmpArg.slice(7), 10); continue; }
		if (tmpArg === '--host')    { tmpArgs.Host = pArgv[++i]; continue; }
		if (tmpArg.startsWith('--host=')) { tmpArgs.Host = tmpArg.slice(7); continue; }
		if (tmpArg === '--no-open') { tmpArgs.Open = false; continue; }
		if (tmpArg === '--open')    { tmpArgs.Open = true; continue; }
		if (tmpArg === '--help' || tmpArg === '-h')
		{
			printHelp();
			process.exit(0);
		}
	}

	if (!Number.isFinite(tmpArgs.Port) || tmpArgs.Port < 1 || tmpArgs.Port > 65535)
	{
		console.error('Invalid --port value.');
		process.exit(2);
	}

	return tmpArgs;
}

function printHelp()
{
	console.log('Ultravisor Lab -- web UI for orchestrating retold test infrastructure.');
	console.log('');
	console.log('Usage: node lab.js [options]');
	console.log('');
	console.log('  --port <N>     Bind to port N (default: 44443).');
	console.log('  --host <ADDR>  Bind to interface ADDR (default: 127.0.0.1).');
	console.log('  --no-open      Do not auto-open the browser.');
	console.log('  --open         Auto-open the browser (default).');
	console.log('  --help, -h     Print this help.');
}

// ─────────────────────────────────────────────
//  Browser auto-open
// ─────────────────────────────────────────────

function openBrowser(pUrl)
{
	let tmpCommand;
	switch (process.platform)
	{
		case 'darwin': tmpCommand = `open "${pUrl}"`; break;
		case 'win32':  tmpCommand = `start "" "${pUrl}"`; break;
		default:       tmpCommand = `xdg-open "${pUrl}"`; break;
	}
	libChildProcess.exec(tmpCommand,
		(pError) =>
		{
			if (pError) { console.error('Could not auto-open browser:', pError.message); }
		});
}

// ─────────────────────────────────────────────
//  Graceful shutdown
// ─────────────────────────────────────────────

let _ShuttingDown = false;
let _ServerInfo = null;

function _gracefulShutdown()
{
	if (_ShuttingDown) { return; }
	_ShuttingDown = true;

	process.stdout.write('\n[lab] Shutting down...\n');

	if (_ServerInfo && _ServerInfo.Core && _ServerInfo.Core.Reconciler)
	{
		try { _ServerInfo.Core.Reconciler.stop(); } catch (pErr) { /* ignore */ }
	}
	if (_ServerInfo && _ServerInfo.Core && _ServerInfo.Core.StateStore)
	{
		try { _ServerInfo.Core.StateStore.close(); } catch (pErr) { /* ignore */ }
	}

	// Orator / restify does not have a graceful-close helper that always
	// behaves; give everything a moment and exit.
	setTimeout(() => { process.exit(0); }, 300);
}

process.on('SIGINT',  _gracefulShutdown);
process.on('SIGTERM', _gracefulShutdown);

// ─────────────────────────────────────────────
//  Main
// ─────────────────────────────────────────────

const _args = parseArgs(process.argv.slice(2));

libLabServerSetup(
	{
		Port:     _args.Port,
		Host:     _args.Host,
		DataDir:  libPath.resolve(__dirname, 'data')
	},
	(pError, pServerInfo) =>
	{
		if (pError)
		{
			console.error('Ultravisor-Lab failed to start:', pError.message || pError);
			process.exit(1);
		}

		_ServerInfo = pServerInfo;

		let tmpUrl = `http://${pServerInfo.Host}:${pServerInfo.Port}/`;
		console.log('');
		console.log('  Ultravisor Lab');
		console.log('  ' + tmpUrl);
		console.log('  data dir: ' + libPath.resolve(__dirname, 'data'));
		console.log('  Ctrl-C to stop.');
		console.log('');

		if (_args.Open)
		{
			openBrowser(tmpUrl);
		}
	});
