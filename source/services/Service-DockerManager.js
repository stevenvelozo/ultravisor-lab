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
const BUILD_TIMEOUT_MS    = 900000;  // 15 min -- fresh `npm install` + base layer pull combined
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

	// ── Images ───────────────────────────────────────────────────────────────

	/**
	 * Check whether a local image tag exists in the docker daemon.
	 * Returns the image id string if present, '' if not.  Does not talk to
	 * any registry -- `docker images -q` is a purely local lookup.
	 */
	imageExists(pImageTag, fCallback)
	{
		libChildProcess.execFile('docker', ['images', '-q', pImageTag], { timeout: DEFAULT_TIMEOUT_MS },
			(pError, pStdout) =>
			{
				if (pError) { return fCallback(null, ''); }
				return fCallback(null, (pStdout || '').trim());
			});
	}

	/**
	 * Build an image from a Dockerfile if it isn't already present locally.
	 *
	 * pBuild =
	 * {
	 *   ImageTag:       string   -- e.g. 'ultravisor-lab/retold-databeacon:0.0.8'
	 *   DockerfilePath: string   -- absolute path to the .Dockerfile
	 *   ContextDir:     string   -- absolute path used as the docker build context
	 *                                (any directory -- our Dockerfiles don't COPY
	 *                                anything from the context, so an empty dir is
	 *                                safest and avoids sending irrelevant files)
	 *   BuildArgs:      { KEY: VALUE, ... }   -- passed as --build-arg flags
	 * }
	 *
	 * Callback gets { ImageTag, Built: true|false } so callers can log
	 * the first-build cost when it happens.
	 */
	ensureImage(pBuild, fCallback, fProgress)
	{
		if (!pBuild || !pBuild.ImageTag || !pBuild.DockerfilePath || !pBuild.ContextDir)
		{
			return fCallback(new Error('ensureImage requires ImageTag, DockerfilePath, and ContextDir.'));
		}

		// fProgress is an optional (pPhase, pData) callback the caller uses
		// to surface build lifecycle to the UI.  Phases:
		//   'build-started'   { ImageTag }
		//   'build-progress'  { ImageTag, ElapsedMs }   -- ticks every HEARTBEAT_MS
		//   'build-completed' { ImageTag, ElapsedMs }
		//   'build-failed'    { ImageTag, ElapsedMs, Error }
		let fEmit = (typeof fProgress === 'function') ? fProgress : () => {};

		this.imageExists(pBuild.ImageTag,
			(pExistsErr, pImageID) =>
			{
				if (pImageID)
				{
					return fCallback(null, { ImageTag: pBuild.ImageTag, Built: false, ImageID: pImageID });
				}

				let tmpArgs = ['build', '-t', pBuild.ImageTag, '-f', pBuild.DockerfilePath];

				if (pBuild.BuildArgs && typeof pBuild.BuildArgs === 'object')
				{
					for (let tmpKey of Object.keys(pBuild.BuildArgs))
					{
						tmpArgs.push('--build-arg', `${tmpKey}=${pBuild.BuildArgs[tmpKey]}`);
					}
				}

				tmpArgs.push(pBuild.ContextDir);

				this.fable.log.info(`[DockerManager] Building image ${pBuild.ImageTag}... (first build may take several minutes)`);

				let tmpStartedAt = Date.now();
				fEmit('build-started', { ImageTag: pBuild.ImageTag });

				// Periodic heartbeat so the UI's Events timeline shows the
				// build is still making progress.  Ticks every 10 seconds
				// until the execFile callback cancels it.
				const HEARTBEAT_MS = 10000;
				let tmpHeartbeat = setInterval(
					() => fEmit('build-progress', { ImageTag: pBuild.ImageTag, ElapsedMs: Date.now() - tmpStartedAt }),
					HEARTBEAT_MS);

				libChildProcess.execFile('docker', tmpArgs,
					{ timeout: BUILD_TIMEOUT_MS, maxBuffer: 64 * 1024 * 1024 },
					(pError, pStdout, pStderr) =>
					{
						clearInterval(tmpHeartbeat);
						let tmpElapsedMs = Date.now() - tmpStartedAt;

						if (pError)
						{
							let tmpMsg = (pStderr || pError.message).trim().slice(0, 500);
							fEmit('build-failed', { ImageTag: pBuild.ImageTag, ElapsedMs: tmpElapsedMs, Error: tmpMsg });
							return fCallback(new Error(`docker build ${pBuild.ImageTag} failed: ${tmpMsg}`));
						}

						this.fable.log.info(`[DockerManager] Built image ${pBuild.ImageTag} in ${Math.round(tmpElapsedMs / 1000)}s.`);
						fEmit('build-completed', { ImageTag: pBuild.ImageTag, ElapsedMs: tmpElapsedMs });
						return fCallback(null, { ImageTag: pBuild.ImageTag, Built: true, ElapsedMs: tmpElapsedMs });
					});
			});
	}

	// ── Networks ─────────────────────────────────────────────────────────────

	/**
	 * Ensure a user-defined bridge network exists.  Idempotent; repeated
	 * calls are no-ops after the first one.  Beacons, DB engines, and
	 * (eventually) Ultravisors all attach to the same network so they
	 * resolve each other by container name via docker's embedded DNS.
	 */
	ensureNetwork(pNetworkName, fCallback)
	{
		if (!pNetworkName) { return fCallback(new Error('ensureNetwork requires a network name.')); }

		libChildProcess.execFile('docker', ['network', 'inspect', pNetworkName],
			{ timeout: DEFAULT_TIMEOUT_MS },
			(pError) =>
			{
				if (!pError)
				{
					return fCallback(null, { NetworkName: pNetworkName, Created: false });
				}

				libChildProcess.execFile('docker', ['network', 'create', pNetworkName],
					{ timeout: DEFAULT_TIMEOUT_MS },
					(pCreateError, pStdout, pStderr) =>
					{
						if (pCreateError)
						{
							return fCallback(new Error(`docker network create ${pNetworkName} failed: ${(pStderr || pCreateError.message).trim()}`));
						}
						this.fable.log.info(`[DockerManager] Created docker network '${pNetworkName}'.`);
						return fCallback(null, { NetworkName: pNetworkName, Created: true });
					});
			});
	}

	/**
	 * Attach an existing container to a docker network.  Idempotent: the
	 * docker CLI errors with `endpoint ... already exists` when the
	 * container is already a member, and we swallow that specific error.
	 */
	connectToNetwork(pNetworkName, pContainerID, fCallback)
	{
		libChildProcess.execFile('docker', ['network', 'connect', pNetworkName, pContainerID],
			{ timeout: DEFAULT_TIMEOUT_MS },
			(pError, pStdout, pStderr) =>
			{
				if (!pError)
				{
					return fCallback(null, { Attached: true });
				}
				let tmpMsg = (pStderr || pError.message || '').trim();
				if (/already exists/i.test(tmpMsg) || /is already attached/i.test(tmpMsg))
				{
					return fCallback(null, { Attached: false, AlreadyAttached: true });
				}
				return fCallback(new Error(tmpMsg));
			});
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

		if (pRun.Network)
		{
			tmpArgs.push('--network', pRun.Network);
		}

		if (pRun.Hostname)
		{
			tmpArgs.push('--hostname', pRun.Hostname);
		}

		if (Array.isArray(pRun.Ports))
		{
			for (let i = 0; i < pRun.Ports.length; i++)
			{
				let tmpPort = pRun.Ports[i];
				tmpArgs.push('-p', `${tmpPort.Host}:${tmpPort.Container}`);
			}
		}

		if (Array.isArray(pRun.Volumes))
		{
			for (let i = 0; i < pRun.Volumes.length; i++)
			{
				let tmpVol = pRun.Volumes[i];
				// { Source, Target, ReadOnly? } -- Source may be a named volume or host path
				let tmpSpec = `${tmpVol.Source}:${tmpVol.Target}`;
				if (tmpVol.ReadOnly) { tmpSpec += ':ro'; }
				tmpArgs.push('-v', tmpSpec);
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
