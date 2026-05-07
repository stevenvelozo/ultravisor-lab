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
const libFS = require('fs');
const libChildProcess = require('child_process');

const libLabServerSetup = require('./source/web_server/Lab-Server-Setup.js');

// ─────────────────────────────────────────────
//  Monorepo root auto-detection
// ─────────────────────────────────────────────
//
// Bundled presets reference the user's retold checkout via
// `${env.RETOLD_MONOREPO_ROOT}` so the same preset works regardless of
// where the user puts their code (we used to hard-code `${HOME}/Code/retold`
// and break anyone who checks out elsewhere). If the env var isn't already
// set, we try to derive it:
//   1. If lab.js itself is running from inside a retold checkout
//      (Retold-Modules-Manifest.json sits four levels up), use that root.
//   2. Otherwise fall back to `${HOME}/Code/retold` so we don't regress
//      anyone whose layout matched the old default.
// An explicit env var always wins.
function _autodetectRetoldRoot()
{
	let tmpCandidate = libPath.resolve(__dirname, '..', '..', '..');
	try
	{
		if (libFS.existsSync(libPath.join(tmpCandidate, 'Retold-Modules-Manifest.json')))
		{
			return tmpCandidate;
		}
	}
	catch (pError) { /* fall through */ }
	return null;
}
if (!process.env.RETOLD_MONOREPO_ROOT)
{
	process.env.RETOLD_MONOREPO_ROOT = _autodetectRetoldRoot()
		|| libPath.join(process.env.HOME || process.env.USERPROFILE || '.', 'Code', 'retold');
}

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
//  Crash logging
// ─────────────────────────────────────────────
//
// Without these, any unhandled async throw (reconciler tick, docker
// inspect callback, event-write, init runner, etc.) silently exits the
// node process with nothing printed and nothing persisted. The user
// then sees the symptom -- UI stuck on "Launching...", lab unreachable
// -- with no signal as to what went wrong. Capture the stack trace to
// data/crash-<timestamp>.log so the next reproduction is debuggable.
//
// We exit (rather than swallow) because Node's contract on
// uncaughtException is "the process is in an undefined state". Limping
// on after that risks corrupted DB writes or zombie state that's
// strictly worse than a visible crash with a logfile next to it.
function _logFatal(pKind, pErr)
{
	let tmpStamp = new Date().toISOString().replace(/[:.]/g, '-');
	let tmpDir   = libPath.resolve(__dirname, 'data');
	let tmpFile  = libPath.join(tmpDir, `crash-${tmpStamp}.log`);
	let tmpStack = (pErr && pErr.stack) ? pErr.stack : String(pErr);
	let tmpBody  = `[lab crash]\nKind: ${pKind}\nWhen: ${new Date().toISOString()}\nPID:  ${process.pid}\nNode: ${process.version}\n\n${tmpStack}\n`;
	try { libFS.mkdirSync(tmpDir, { recursive: true }); } catch (pIgn) { /* ignore */ }
	try { libFS.writeFileSync(tmpFile, tmpBody); } catch (pIgn) { /* ignore */ }
	try { process.stderr.write(`\n${tmpBody}\n[lab] crash log: ${tmpFile}\n`); } catch (pIgn) { /* ignore */ }
}
process.on('uncaughtException',  (pErr) => { _logFatal('uncaughtException',  pErr); process.exit(70); });
process.on('unhandledRejection', (pErr) => { _logFatal('unhandledRejection', pErr); process.exit(70); });

// ─────────────────────────────────────────────
//  Library exports
// ─────────────────────────────────────────────
//
// Downstream code that wants to embed the lab (e.g. retold-data-mapper, or
// any other app extending ultravisor-lab) does
// `require('ultravisor-lab').setupLabServer({...})`. Re-exporting
// setupLabServer from here means consumers don't need to reach into the
// package's internal source tree to get a stable handle.
module.exports = { setupLabServer: libLabServerSetup };

// ─────────────────────────────────────────────
//  CLI entry — gated on `require.main === module`
// ─────────────────────────────────────────────
//
// The CLI side effects below MUST be gated. When this file is `require()`d
// rather than executed directly (e.g. as the package main from a downstream
// app), running them spawns a phantom lab on the default port + data dir
// in the consumer's process. Until this gate landed, that phantom call
// silently overrode --data-dir passed to setupLabServer because the
// side-effect call connected SQLite at the default path before the
// consumer's call could.
if (require.main === module)
{
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
}
