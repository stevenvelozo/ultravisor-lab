/**
 * Service-StackPreflight (Phase 8 — Pillar 2)
 *
 * Probes a RESOLVED stack spec against the host filesystem + ports +
 * docker daemon, and produces a structured report the UI can render
 * as ✓ ready / ⚠ warnings / ✗ blockers.
 *
 * Probes:
 *   folder.exists       — fs.statSync on every Volumes[*].Host path.
 *                         info if exists-empty, warn if exists-with-files,
 *                         info if missing (will mkdir on launch),
 *                         block if path resolves to a file (not a dir).
 *   port.in-use         — `lsof -iTCP:<port>` for every Ports[*].Host.
 *                         block when in use; report PID + command.
 *   image.present       — `docker images -q <tag>` for docker-service
 *                         components. Info when missing (compose pulls
 *                         on up; not a blocker).
 *   build.context       — for docker-build-from-folder: verify the
 *                         BuildContext exists and (info) check for
 *                         a Dockerfile. Missing context = block.
 *   secret.empty        — Inputs[X].Type='secret' with empty resolved
 *                         value = block (must be filled in).
 *   reference.unresolved — passes through any Unresolved entries from
 *                         the resolver as blockers.
 *
 * Public API:
 *   run(pResolved, fCallback)
 *     pResolved — output of Service-StackResolver.resolve()
 *                 ({ Spec, Inputs, Components, Unresolved })
 *     fCallback — (err, report) where report is:
 *       { Status: "ready" | "warnings" | "blockers",
 *         Items:  [{ Path, Severity, Code, Message, Detail? }] }
 *
 * Async because docker / lsof shell out. Filesystem probes are sync
 * (fs.statSync is fine and keeps the code linear).
 */

'use strict';

const libFs = require('fs');
const libPath = require('path');
const libChildProcess = require('child_process');
const libFableServiceProviderBase = require('fable-serviceproviderbase');

const PROBE_TIMEOUT_MS = 5000;

// Patterns matched against a process's full command line to detect
// docker / colima / lima port-forwarding muxes. These hold container-
// mapped host ports, so an "in use" result for one of them is a false
// positive when the user is launching (or re-launching) a stack — the
// container is either ours or about to be replaced by `compose up`.
const DOCKER_HOLDER_PATTERNS =
[
	/docker-proxy/i,
	/com\.docker/i,
	/Docker\.app/i,
	/colima/i,
	/lima/i,
	/vpnkit/i,
	/qemu.*lima/i
];

function _looksLikeDockerHolder(pCommand)
{
	if (!pCommand) return false;
	for (let i = 0; i < DOCKER_HOLDER_PATTERNS.length; i++)
	{
		if (DOCKER_HOLDER_PATTERNS[i].test(pCommand)) return true;
	}
	return false;
}

class ServiceStackPreflight extends libFableServiceProviderBase
{
	constructor(pFable, pOptions, pServiceHash)
	{
		super(pFable, pOptions, pServiceHash);
		this.serviceType = 'LabStackPreflight';
	}

	run(pResolved, fCallback)
	{
		let tmpItems = [];
		let tmpSpec = (pResolved && pResolved.Spec) || {};
		let tmpInputs = (pResolved && pResolved.Inputs) || {};
		let tmpComponents = Array.isArray(tmpSpec.Components) ? tmpSpec.Components : [];

		// Synchronous probes first (unresolved refs, empty secrets,
		// folder existence) — they don't need to wait for shell-outs.

		// 1. Unresolved references → blockers.
		let tmpUnresolved = (pResolved && pResolved.Unresolved) || [];
		for (let i = 0; i < tmpUnresolved.length; i++)
		{
			tmpItems.push({
				Path: tmpUnresolved[i].Path,
				Severity: 'block',
				Code: 'reference.unresolved',
				Message: `Unresolved reference ${tmpUnresolved[i].Reference}`
			});
		}

		// 2. Empty secret inputs.
		let tmpInputDefs = (tmpSpec.Inputs) || {};
		let tmpInputKeys = Object.keys(tmpInputDefs);
		for (let i = 0; i < tmpInputKeys.length; i++)
		{
			let tmpKey = tmpInputKeys[i];
			let tmpDef = tmpInputDefs[tmpKey] || {};
			if (tmpDef.Type === 'secret')
			{
				let tmpVal = tmpInputs[tmpKey];
				if (!tmpVal || (typeof tmpVal === 'string' && tmpVal.trim() === ''))
				{
					tmpItems.push({
						Path: `Inputs.${tmpKey}`,
						Severity: 'block',
						Code: 'secret.empty',
						Message: `Required secret "${tmpKey}" is empty`
					});
				}
			}
		}

		// 3. Folder probes (sync) for every Volumes[*].Host across all components.
		for (let i = 0; i < tmpComponents.length; i++)
		{
			let tmpC = tmpComponents[i] || {};
			let tmpVolumes = Array.isArray(tmpC.Volumes) ? tmpC.Volumes : [];
			for (let v = 0; v < tmpVolumes.length; v++)
			{
				let tmpVol = tmpVolumes[v];
				if (!tmpVol || !tmpVol.Host) continue;
				let tmpPath = `Components[${i}].Volumes[${v}].Host`;
				this._probeFolder(tmpVol.Host, tmpPath, tmpVol.Mode || 'rw', tmpItems);
			}
			// docker-build-from-folder: the BuildContext must exist.
			if (tmpC.Type === 'docker-build-from-folder' && tmpC.BuildContext)
			{
				this._probeBuildContext(tmpC, `Components[${i}]`, tmpItems);
			}
		}

		// Async probes: ports + images run in parallel.
		let tmpAsyncJobs = [];

		// 4. Port probes.
		for (let i = 0; i < tmpComponents.length; i++)
		{
			let tmpC = tmpComponents[i] || {};
			let tmpPorts = Array.isArray(tmpC.Ports) ? tmpC.Ports : [];
			for (let p = 0; p < tmpPorts.length; p++)
			{
				let tmpPort = tmpPorts[p];
				if (!tmpPort || tmpPort.Host === undefined || tmpPort.Host === null) continue;
				let tmpPortNum = parseInt(tmpPort.Host, 10);
				if (!Number.isFinite(tmpPortNum) || tmpPortNum <= 0)
				{
					tmpItems.push({
						Path: `Components[${i}].Ports[${p}].Host`,
						Severity: 'block',
						Code: 'port.invalid',
						Message: `Host port "${tmpPort.Host}" is not a valid number`
					});
					continue;
				}
				tmpAsyncJobs.push(this._probePort(tmpPortNum, `Components[${i}].Ports[${p}].Host`, tmpItems));
			}
		}

		// 5. Image probes (only for docker-service; build-from-folder
		// gets its image at build time so there's nothing to check).
		for (let i = 0; i < tmpComponents.length; i++)
		{
			let tmpC = tmpComponents[i] || {};
			if (tmpC.Type !== 'docker-service' && tmpC.Type !== undefined) continue;
			if (tmpC.Type === undefined && !tmpC.Image) continue;
			if (!tmpC.Image) continue;
			tmpAsyncJobs.push(this._probeImage(tmpC.Image, `Components[${i}].Image`, tmpItems));
		}

		Promise.all(tmpAsyncJobs).then(function ()
		{
			let tmpStatus = 'ready';
			for (let i = 0; i < tmpItems.length; i++)
			{
				if (tmpItems[i].Severity === 'block')
				{
					tmpStatus = 'blockers';
					break;
				}
				if (tmpItems[i].Severity === 'warn')
				{
					tmpStatus = 'warnings';
				}
			}
			fCallback(null, { Status: tmpStatus, Items: tmpItems });
		}).catch(function (pErr)
		{
			fCallback(pErr);
		});
	}

	// ====================================================================
	// Synchronous probes
	// ====================================================================

	_probeFolder(pHostPath, pPath, pMode, pItems)
	{
		let tmpAbs = libPath.resolve(pHostPath);
		let tmpStat = null;
		try { tmpStat = libFs.statSync(tmpAbs); }
		catch (pErr)
		{
			if (pErr.code === 'ENOENT')
			{
				pItems.push({
					Path: pPath,
					Severity: 'info',
					Code: 'folder.missing',
					Message: `Path ${tmpAbs} does not exist; will be created on launch`,
					Detail: { AbsolutePath: tmpAbs }
				});
				return;
			}
			pItems.push({
				Path: pPath,
				Severity: 'warn',
				Code: 'folder.stat-failed',
				Message: `Could not stat ${tmpAbs}: ${pErr.message}`
			});
			return;
		}
		if (!tmpStat.isDirectory())
		{
			pItems.push({
				Path: pPath,
				Severity: 'block',
				Code: 'folder.not-a-directory',
				Message: `${tmpAbs} exists but is not a directory`
			});
			return;
		}
		// Folder exists — empty or has files?
		let tmpEntries = [];
		try { tmpEntries = libFs.readdirSync(tmpAbs); }
		catch (pErr)
		{
			pItems.push({
				Path: pPath,
				Severity: 'warn',
				Code: 'folder.readdir-failed',
				Message: `Could not list ${tmpAbs}: ${pErr.message}`
			});
			return;
		}
		if (tmpEntries.length === 0)
		{
			pItems.push({
				Path: pPath,
				Severity: 'info',
				Code: 'folder.exists-empty',
				Message: `${tmpAbs} exists and is empty (will be used as-is)`
			});
		}
		else
		{
			pItems.push({
				Path: pPath,
				Severity: 'warn',
				Code: 'folder.has-files',
				Message: `${tmpAbs} already has ${tmpEntries.length} entr${tmpEntries.length === 1 ? 'y' : 'ies'} (will reuse — wipe manually if you want a clean start)`,
				Detail: { AbsolutePath: tmpAbs, EntryCount: tmpEntries.length, Mode: pMode }
			});
		}
	}

	_probeBuildContext(pComponent, pPath, pItems)
	{
		let tmpAbs = libPath.resolve(pComponent.BuildContext);
		let tmpStat = null;
		try { tmpStat = libFs.statSync(tmpAbs); }
		catch (pErr)
		{
			pItems.push({
				Path: `${pPath}.BuildContext`,
				Severity: 'block',
				Code: 'build.context-missing',
				Message: `Build context ${tmpAbs} does not exist; can't build component "${pComponent.Hash}"`
			});
			return;
		}
		if (!tmpStat.isDirectory())
		{
			pItems.push({
				Path: `${pPath}.BuildContext`,
				Severity: 'block',
				Code: 'build.context-not-directory',
				Message: `Build context ${tmpAbs} is not a directory`
			});
			return;
		}
		// Look for a Dockerfile (or the spec-named one).
		let tmpDockerfile = pComponent.Dockerfile || 'Dockerfile';
		let tmpDockerfilePath = libPath.join(tmpAbs, tmpDockerfile);
		if (!libFs.existsSync(tmpDockerfilePath))
		{
			let tmpFallback = pComponent.DockerfileFallback;
			if (tmpFallback)
			{
				pItems.push({
					Path: `${pPath}.Dockerfile`,
					Severity: 'info',
					Code: 'build.dockerfile-fallback',
					Message: `${tmpDockerfilePath} missing; will use synthesized fallback "${tmpFallback}" on build`
				});
			}
			else
			{
				pItems.push({
					Path: `${pPath}.Dockerfile`,
					Severity: 'block',
					Code: 'build.dockerfile-missing',
					Message: `${tmpDockerfilePath} does not exist and no DockerfileFallback declared`
				});
			}
		}
		else
		{
			pItems.push({
				Path: `${pPath}.Dockerfile`,
				Severity: 'info',
				Code: 'build.dockerfile-present',
				Message: `Dockerfile found at ${tmpDockerfilePath}`
			});
		}
	}

	// ====================================================================
	// Async probes (return Promise; settle by pushing to pItems)
	// ====================================================================

	_probePort(pPort, pPath, pItems)
	{
		return new Promise(function (pResolve)
		{
			// `lsof -nP -iTCP:<port> -sTCP:LISTEN -t` prints PIDs only;
			// empty output = port free. -n + -P avoid DNS / port-name
			// lookups; -t makes parsing trivial.
			libChildProcess.execFile('lsof',
				['-nP', '-iTCP:' + pPort, '-sTCP:LISTEN', '-t'],
				{ timeout: PROBE_TIMEOUT_MS },
				function (pErr, pStdout, pStderr)
				{
					// lsof exits 1 when no matching processes — treat
					// that as "port free" rather than an error.
					let tmpStdout = (pStdout || '').trim();
					if (!tmpStdout)
					{
						pItems.push({
							Path: pPath,
							Severity: 'info',
							Code: 'port.available',
							Message: `Port ${pPort} is available`
						});
						return pResolve();
					}
					let tmpPids = tmpStdout.split('\n').filter(function (pL) { return pL.trim().length > 0; });
					// For the PID context, get the FULL command line (not
					// just `comm`) so we can detect docker / colima /
					// lima processes that mux container-mapped ports —
					// those are false positives when re-launching a
					// stack while its containers are still up.
					libChildProcess.execFile('ps',
						['-o', 'pid=,command=', '-p', tmpPids.join(',')],
						{ timeout: PROBE_TIMEOUT_MS },
						function (pPsErr, pPsOut)
						{
							let tmpDetail = {};
							let tmpPretty = tmpPids.join(', ');
							let tmpProcesses = [];
							if (!pPsErr && pPsOut)
							{
								tmpProcesses = (pPsOut || '').trim().split('\n').map(function (pL)
								{
									let tmpTrim = pL.trim();
									let tmpSpace = tmpTrim.indexOf(' ');
									if (tmpSpace < 0) { return { PID: tmpTrim, Command: '' }; }
									return { PID: tmpTrim.slice(0, tmpSpace), Command: tmpTrim.slice(tmpSpace + 1) };
								});
								tmpDetail.Processes = tmpProcesses;
								tmpPretty = tmpProcesses.map(function (pP)
								{
									// Trim long command lines for the toast/UI message.
									let tmpCmd = pP.Command.length > 80 ? pP.Command.slice(0, 80) + '…' : pP.Command;
									return `${tmpCmd} (pid ${pP.PID})`;
								}).join(', ');
							}

							// Downgrade to a warning when ALL holding
							// processes look like docker / colima / lima
							// muxes — those mean the port is held by a
							// container we either own or could replace
							// via `compose up`. Block remains for any
							// unrelated process.
							let tmpAllDocker = tmpProcesses.length > 0
								&& tmpProcesses.every(function (pP) { return _looksLikeDockerHolder(pP.Command); });
							if (tmpAllDocker)
							{
								pItems.push({
									Path: pPath,
									Severity: 'warn',
									Code: 'port.held-by-docker',
									Message: `Port ${pPort} appears to be held by a docker / colima container mux. If you're re-launching this stack, take it down first; otherwise check for a stale container.`,
									Detail: tmpDetail
								});
							}
							else
							{
								pItems.push({
									Path: pPath,
									Severity: 'block',
									Code: 'port.in-use',
									Message: `Port ${pPort} is already in use by ${tmpPretty}`,
									Detail: tmpDetail
								});
							}
							pResolve();
						});
				});
		});
	}

	_probeImage(pImageTag, pPath, pItems)
	{
		return new Promise(function (pResolve)
		{
			libChildProcess.execFile('docker',
				['images', '-q', pImageTag],
				{ timeout: PROBE_TIMEOUT_MS },
				function (pErr, pStdout)
				{
					if (pErr)
					{
						pItems.push({
							Path: pPath,
							Severity: 'warn',
							Code: 'image.probe-failed',
							Message: `Could not query docker for image "${pImageTag}": ${pErr.message}`
						});
						return pResolve();
					}
					let tmpHas = (pStdout || '').trim().length > 0;
					pItems.push({
						Path: pPath,
						Severity: 'info',
						Code: tmpHas ? 'image.present' : 'image.pull-needed',
						Message: tmpHas
							? `Image ${pImageTag} is present locally`
							: `Image ${pImageTag} not present locally; will be pulled on launch (or fail fast if the registry doesn't have it)`
					});
					pResolve();
				});
		});
	}
}

module.exports = ServiceStackPreflight;
