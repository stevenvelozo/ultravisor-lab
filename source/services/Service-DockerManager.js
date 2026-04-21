/**
 * Service-DockerManager
 *
 * Thin wrapper around the `docker` CLI.  Phase 2 introduces full container
 * lifecycle control (pull/run/start/stop/rm/exec) on top of the Phase 1
 * availability probe and `inspect` helper.
 *
 * Every shell-out runs with a bounded timeout; callers handle the parsed
 * result (stdout / stderr / exitCode).  We deliberately avoid the
 * `dockerode` dep -- the CLI is what developers already have installed.
 */
'use strict';

const libChildProcess = require('child_process');
const libFableServiceProviderBase = require('fable-serviceproviderbase');

const DEFAULT_TIMEOUT_MS  = 10000;
const PULL_TIMEOUT_MS     = 600000;  // 10 min -- first-time image pulls are slow
const EXEC_TIMEOUT_MS     = 30000;

class ServiceDockerManager extends libFableServiceProviderBase
{
	constructor(pFable, pOptions, pServiceHash)
	{
		super(pFable, pOptions, pServiceHash);

		this.serviceType = 'LabDockerManager';

		this.available  = false;
		this.version    = '';
		this.lastError  = '';
	}

	// ── Probe ────────────────────────────────────────────────────────────────

	probe(fCallback)
	{
		libChildProcess.execFile('docker', ['version', '--format', '{{.Server.Version}}'], { timeout: 5000 },
			(pError, pStdout, pStderr) =>
			{
				if (pError)
				{
					this.available = false;
					this.version = '';
					this.lastError = (pStderr || pError.message || '').trim();
					return fCallback(null, { Available: false, Version: '', Error: this.lastError });
				}

				this.available = true;
				this.version = (pStdout || '').trim();
				this.lastError = '';
				return fCallback(null, { Available: true, Version: this.version, Error: '' });
			});
	}

	// ── Inspect ──────────────────────────────────────────────────────────────

	inspect(pContainerID, fCallback)
	{
		if (!pContainerID) { return fCallback(null, null); }

		libChildProcess.execFile('docker', ['inspect', pContainerID], { timeout: DEFAULT_TIMEOUT_MS },
			(pError, pStdout) =>
			{
				if (pError) { return fCallback(null, null); }
				try
				{
					let tmpParsed = JSON.parse(pStdout);
					return fCallback(null, Array.isArray(tmpParsed) ? (tmpParsed[0] || null) : tmpParsed);
				}
				catch (pParseError) { return fCallback(pParseError); }
			});
	}

	statusFromInspect(pInspect)
	{
		if (!pInspect || !pInspect.State) { return 'missing'; }
		if (pInspect.State.Running === true) { return 'running'; }
		return 'stopped';
	}

	// ── Pull ─────────────────────────────────────────────────────────────────

	pull(pImage, fCallback)
	{
		libChildProcess.execFile('docker', ['pull', pImage], { timeout: PULL_TIMEOUT_MS, maxBuffer: 16 * 1024 * 1024 },
			(pError, pStdout, pStderr) =>
			{
				if (pError)
				{
					return fCallback(new Error(`docker pull ${pImage} failed: ${(pStderr || pError.message).trim()}`));
				}
				return fCallback(null, { Output: pStdout });
			});
	}

	// ── Run ──────────────────────────────────────────────────────────────────
	/**
	 * Start a new detached container.
	 *
	 * pRun =
	 * {
	 *   Name:     string,
	 *   Image:    string,
	 *   Ports:    [ { Host: N, Container: N } ],
	 *   Env:      { KEY: VALUE, ... },
	 *   ExtraArgs: [ ... ]  // optional raw docker flags
	 * }
	 *
	 * Callback yields the new container id (full sha).
	 */
	run(pRun, fCallback)
	{
		let tmpArgs = ['run', '-d', '--name', pRun.Name];

		if (Array.isArray(pRun.Ports))
		{
			for (let i = 0; i < pRun.Ports.length; i++)
			{
				let tmpPort = pRun.Ports[i];
				tmpArgs.push('-p', `${tmpPort.Host}:${tmpPort.Container}`);
			}
		}

		if (pRun.Env && typeof pRun.Env === 'object')
		{
			for (let tmpKey of Object.keys(pRun.Env))
			{
				tmpArgs.push('-e', `${tmpKey}=${pRun.Env[tmpKey]}`);
			}
		}

		if (Array.isArray(pRun.ExtraArgs))
		{
			for (let i = 0; i < pRun.ExtraArgs.length; i++)
			{
				tmpArgs.push(pRun.ExtraArgs[i]);
			}
		}

		tmpArgs.push(pRun.Image);

		if (Array.isArray(pRun.Command))
		{
			for (let i = 0; i < pRun.Command.length; i++)
			{
				tmpArgs.push(pRun.Command[i]);
			}
		}

		libChildProcess.execFile('docker', tmpArgs, { timeout: DEFAULT_TIMEOUT_MS },
			(pError, pStdout, pStderr) =>
			{
				if (pError)
				{
					return fCallback(new Error(`docker run failed: ${(pStderr || pError.message).trim()}`));
				}
				return fCallback(null, { ContainerID: (pStdout || '').trim() });
			});
	}

	// ── Exec ─────────────────────────────────────────────────────────────────

	exec(pContainerID, pArgs, pOptions, fCallback)
	{
		if (typeof pOptions === 'function')
		{
			fCallback = pOptions;
			pOptions = {};
		}
		let tmpTimeout = (pOptions && pOptions.TimeoutMs) ? pOptions.TimeoutMs : EXEC_TIMEOUT_MS;

		let tmpArgs = ['exec'];
		if (pOptions && pOptions.Env && typeof pOptions.Env === 'object')
		{
			for (let tmpKey of Object.keys(pOptions.Env))
			{
				tmpArgs.push('-e', `${tmpKey}=${pOptions.Env[tmpKey]}`);
			}
		}
		tmpArgs.push(pContainerID);
		for (let i = 0; i < pArgs.length; i++) { tmpArgs.push(pArgs[i]); }

		libChildProcess.execFile('docker', tmpArgs, { timeout: tmpTimeout, maxBuffer: 16 * 1024 * 1024 },
			(pError, pStdout, pStderr) =>
			{
				let tmpResult =
				{
					Stdout:   pStdout || '',
					Stderr:   pStderr || '',
					ExitCode: pError ? (pError.code || 1) : 0
				};
				// pError is a soft error here -- callers decide what to do with non-zero exit.
				return fCallback(null, tmpResult);
			});
	}

	// ── Lifecycle ────────────────────────────────────────────────────────────

	start(pContainerID, fCallback)
	{
		libChildProcess.execFile('docker', ['start', pContainerID], { timeout: DEFAULT_TIMEOUT_MS },
			(pError, pStdout, pStderr) =>
			{
				if (pError) { return fCallback(new Error((pStderr || pError.message).trim())); }
				return fCallback(null, { Output: (pStdout || '').trim() });
			});
	}

	stop(pContainerID, fCallback)
	{
		libChildProcess.execFile('docker', ['stop', pContainerID], { timeout: 30000 },
			(pError, pStdout, pStderr) =>
			{
				if (pError) { return fCallback(new Error((pStderr || pError.message).trim())); }
				return fCallback(null, { Output: (pStdout || '').trim() });
			});
	}

	rm(pContainerID, pForce, fCallback)
	{
		let tmpArgs = ['rm'];
		if (pForce) { tmpArgs.push('-f'); }
		tmpArgs.push(pContainerID);

		libChildProcess.execFile('docker', tmpArgs, { timeout: DEFAULT_TIMEOUT_MS },
			(pError, pStdout, pStderr) =>
			{
				if (pError) { return fCallback(new Error((pStderr || pError.message).trim())); }
				return fCallback(null, { Output: (pStdout || '').trim() });
			});
	}

	logs(pContainerID, pTailLines, fCallback)
	{
		let tmpArgs = ['logs', '--tail', String(pTailLines || 200), pContainerID];
		libChildProcess.execFile('docker', tmpArgs, { timeout: DEFAULT_TIMEOUT_MS, maxBuffer: 16 * 1024 * 1024 },
			(pError, pStdout, pStderr) =>
			{
				if (pError) { return fCallback(new Error((pStderr || pError.message).trim())); }
				return fCallback(null, { Stdout: pStdout || '', Stderr: pStderr || '' });
			});
	}
}

module.exports = ServiceDockerManager;
