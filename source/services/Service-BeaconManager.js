/**
 * Service-BeaconManager
 *
 * Generic lifecycle manager for every row in the Beacon table.  Forks
 * on the row's Runtime column:
 *
 *   container  -- LabBeaconContainerManager builds the beacon image
 *                 (standalone-service or capability-provider flavor)
 *                 and runs it on the shared `ultravisor-lab` network.
 *   process    -- legacy host-process path for standalone-service
 *                 beacons whose npm package doesn't ship a docker block.
 *                 Capability-provider beacons are container-only.
 *
 * Per-beacon data layout (host side):
 *   data/beacons/<id>/
 *     config.json                 -- rendered from the type's ConfigTemplate
 *                                    (bind-mounted to /app/data in container
 *                                    mode)
 *     logs/ (via ProcessSupervisor) -- process mode only
 */
'use strict';

const libPath = require('path');
const libFs = require('fs');
const libHttp = require('http');
const libFableServiceProviderBase = require('fable-serviceproviderbase');

const HEALTH_POLL_MAX_ATTEMPTS = 60;  // 60 * 1s = 60s budget
const HEALTH_POLL_INTERVAL_MS  = 1000;

class ServiceBeaconManager extends libFableServiceProviderBase
{
	constructor(pFable, pOptions, pServiceHash)
	{
		super(pFable, pOptions, pServiceHash);
		this.serviceType = 'LabBeaconManager';
	}

	listBeacons()
	{
		return this.fable.LabStateStore.list('Beacon');
	}

	getBeacon(pID)
	{
		return this.fable.LabStateStore.getById('Beacon', 'IDBeacon', pID);
	}

	listBeaconsForUltravisor(pUltravisorID)
	{
		return this.fable.LabStateStore.list('Beacon', { IDUltravisorInstance: pUltravisorID });
	}

	_beaconDir(pID)
	{
		return libPath.join(this.fable.LabStateStore.dataDir, 'beacons', String(pID));
	}

	// ── Create ───────────────────────────────────────────────────────────────
	/**
	 * pRequest = {
	 *   Name:                 string (required)
	 *   BeaconType:           string (required, must match a registered type)
	 *   Port:                 number (required)
	 *   IDUltravisorInstance: number (required if type.RequiresUltravisor)
	 *   Config:               object (per-type config blob; may be empty)
	 * }
	 */
	createBeacon(pRequest, fCallback)
	{
		let tmpStore = this.fable.LabStateStore;
		let tmpRegistry = this.fable.LabBeaconTypeRegistry;

		let tmpName = (pRequest.Name || '').trim();
		if (!tmpName) { return fCallback(new Error('Name is required.')); }

		let tmpType = tmpRegistry.get(pRequest.BeaconType);
		if (!tmpType) { return fCallback(new Error(`Unknown beacon type: ${pRequest.BeaconType}`)); }

		let tmpPort = parseInt(pRequest.Port, 10);
		if (!Number.isFinite(tmpPort) || tmpPort < 1 || tmpPort > 65535)
		{
			return fCallback(new Error('Port must be a number between 1 and 65535.'));
		}

		let tmpUvID = parseInt(pRequest.IDUltravisorInstance, 10) || 0;
		let tmpInstance = tmpUvID ? this.fable.LabUltravisorManager.getInstance(tmpUvID) : null;
		if (tmpType.RequiresUltravisor && !tmpInstance)
		{
			return fCallback(new Error(`Beacon type '${tmpType.BeaconType}' requires a target Ultravisor.`));
		}

		let tmpConfig = pRequest.Config && typeof pRequest.Config === 'object' ? pRequest.Config : {};

		// Runtime is driven by the type descriptor: if it carries a docker
		// block we route through the container manager, else fall back to
		// the existing host-process path.  The choice is frozen on the
		// Beacon row so start/stop/remove always route consistently even
		// if the stanza is later edited.
		let tmpRuntime = tmpType.Docker ? 'container' : 'process';

		let tmpID = tmpStore.insert('Beacon',
			{
				Name:                 tmpName,
				BeaconType:           tmpType.BeaconType,
				Port:                 tmpPort,
				IDUltravisorInstance: tmpUvID,
				ConfigJSON:           JSON.stringify(tmpConfig),
				Runtime:              tmpRuntime,
				Status:               'provisioning',
				StatusDetail:         'Preparing spawn...'
			});

		tmpStore.recordEvent(
			{
				EntityType: 'Beacon', EntityID: tmpID, EntityName: tmpName,
				EventType: 'beacon-create-started', Severity: 'info',
				Message: `Creating ${tmpType.DisplayName} beacon '${tmpName}' on port ${tmpPort}`
			});

		try { libFs.mkdirSync(this._beaconDir(tmpID), { recursive: true }); }
		catch (pErr)
		{
			this._markFailed(tmpID, tmpName, pErr.message);
			return fCallback(pErr);
		}

		// Render on-disk config.json by walking the type's configTemplate (if
		// any), substituting lab-injected tokens, then overlaying the user's
		// form output.  Module authors declare the template in their
		// retoldBeacon stanza; lab fills in Port / BeaconName / BeaconDir /
		// UltravisorURL without needing any per-type server code.
		let tmpConfigPath = libPath.join(this._beaconDir(tmpID), 'config.json');
		let tmpRenderedConfig = this._renderConfig(tmpType, tmpConfig, tmpID, tmpName, tmpPort, tmpInstance);
		try { libFs.writeFileSync(tmpConfigPath, JSON.stringify(tmpRenderedConfig, null, 2)); }
		catch (pErr)
		{
			this._markFailed(tmpID, tmpName, pErr.message);
			return fCallback(pErr);
		}
		tmpStore.update('Beacon', 'IDBeacon', tmpID,
			{ ConfigPath: tmpConfigPath, StatusDetail: (tmpRuntime === 'container' ? 'Building container...' : 'Spawning beacon...') });

		if (tmpRuntime === 'container')
		{
			// Include ConfigJSON so the container manager's _resolveConfigMounts
			// can read per-beacon bind sources (e.g. HostContentPath) from the
			// saved config.  Otherwise the stub row is missing the field and
			// config-driven mounts silently fall back to anonymous volumes.
			let tmpBeaconRow =
				{
					IDBeacon:             tmpID,
					Name:                 tmpName,
					Port:                 tmpPort,
					IDUltravisorInstance: tmpUvID,
					ConfigJSON:           JSON.stringify(tmpConfig)
				};

			let fProgress = this._buildContainerProgressEmitter(
				{ IDBeacon: tmpID, Name: tmpName, TypeDisplayName: tmpType.DisplayName });

			this.fable.LabBeaconContainerManager.create(tmpType, tmpBeaconRow,
				(pContainerErr, pContainerResult) =>
				{
					if (pContainerErr)
					{
						this._markFailed(tmpID, tmpName, pContainerErr.message);
						return;
					}
					tmpStore.update('Beacon', 'IDBeacon', tmpID,
						{
							ContainerID:   pContainerResult.ContainerID,
							ContainerName: pContainerResult.ContainerName,
							ImageTag:      pContainerResult.ImageTag,
							ImageVersion:  pContainerResult.ImageVersion,
							StatusDetail:  'Waiting for HTTP readiness...'
						});

					this._waitForHttp(tmpPort, tmpType.HealthCheck && tmpType.HealthCheck.Path, 0,
						(pReady) =>
						{
							if (!pReady)
							{
								this._markFailed(tmpID, tmpName, 'beacon container did not come up');
								return;
							}
							tmpStore.update('Beacon', 'IDBeacon', tmpID,
								{ Status: 'running', StatusDetail: '' });
							tmpStore.recordEvent(
								{
									EntityType: 'Beacon', EntityID: tmpID, EntityName: tmpName,
									EventType: 'beacon-ready', Severity: 'info',
									Message: `${tmpType.DisplayName} beacon '${tmpName}' ready on port ${tmpPort} (container ${pContainerResult.ContainerName})`
								});
						});
				},
				fProgress);

			return fCallback(null, { IDBeacon: tmpID, Runtime: 'container', Status: 'provisioning' });
		}

		// Host-process path ( existing behavior; unchanged ).
		let tmpSpawn;
		try
		{
			tmpSpawn = this._buildSpawnSpec(tmpType, tmpID, tmpName, tmpPort, tmpInstance, tmpConfigPath);
		}
		catch (pErr)
		{
			this._markFailed(tmpID, tmpName, pErr.message);
			return fCallback(pErr);
		}

		let tmpPid;
		try
		{
			tmpPid = this.fable.LabProcessSupervisor.spawn('Beacon', tmpID,
				{
					Command: tmpSpawn.Command,
					Args:    tmpSpawn.Args,
					Cwd:     this._beaconDir(tmpID),
					Env:     Object.assign({}, process.env)
				});
		}
		catch (pSpawnErr)
		{
			this._markFailed(tmpID, tmpName, pSpawnErr.message);
			return fCallback(pSpawnErr);
		}

		tmpStore.update('Beacon', 'IDBeacon', tmpID,
			{ PID: tmpPid, StatusDetail: 'Waiting for HTTP readiness...' });

		this._waitForHttp(tmpPort, tmpType.HealthCheck && tmpType.HealthCheck.Path, 0,
			(pReady) =>
			{
				if (!pReady)
				{
					this._markFailed(tmpID, tmpName, 'beacon did not come up');
					return;
				}
				tmpStore.update('Beacon', 'IDBeacon', tmpID,
					{ Status: 'running', StatusDetail: '' });
				tmpStore.recordEvent(
					{
						EntityType: 'Beacon', EntityID: tmpID, EntityName: tmpName,
						EventType: 'beacon-ready', Severity: 'info',
						Message: `${tmpType.DisplayName} beacon '${tmpName}' ready on port ${tmpPort}`
					});
			});

		return fCallback(null, { IDBeacon: tmpID, PID: tmpPid, Runtime: 'process', Status: 'provisioning' });
	}

	// ── Config rendering ────────────────────────────────────────────────────
	/**
	 * Walk the type's ConfigTemplate (if any), substitute `{{Token}}`
	 * placeholders with lab-computed values, then deep-merge the user's
	 * form output on top.  Tokens supported: Port, BeaconName, BeaconDir,
	 * UltravisorURL, IDBeacon.
	 */
	_renderConfig(pType, pUserConfig, pID, pName, pPort, pInstance)
	{
		// For container-mode beacons the process inside the container sees
		// two lab-written paths differently than host-mode beacons:
		//   - Port: the internal port it listens on (stanza's ExposedPort).
		//           The host→container port mapping is separate.
		//   - BeaconDir: the container-visible path of its data dir (the
		//           DataMountPath in the stanza, where the lab bind-mounts
		//           data/beacons/<id>/).  Writing the host path here means
		//           the container writes to an unmounted path and loses
		//           state on restart.
		//   - UltravisorURL: the container reaches the host-process
		//           Ultravisor via host.docker.internal instead of 127.0.0.1.
		let tmpIsContainer = !!(pType.Docker);

		let tmpInternalPort = pPort;
		if (tmpIsContainer && pType.Docker.ExposedPort)
		{
			tmpInternalPort = pType.Docker.ExposedPort;
		}

		let tmpBeaconDir = tmpIsContainer
			? (pType.Docker.DataMountPath || '/app/data')
			: this._beaconDir(pID);

		let tmpUltravisorURL = '';
		if (pInstance)
		{
			if (tmpIsContainer)
			{
				// Container-to-UV: docker DNS on shared network when the UV
				// is also a container; host.docker.internal otherwise.
				if (pInstance.Runtime === 'container' && pInstance.ContainerName)
				{
					tmpUltravisorURL = `http://${pInstance.ContainerName}:54321`;
				}
				else
				{
					tmpUltravisorURL = `http://host.docker.internal:${pInstance.Port}`;
				}
			}
			else
			{
				tmpUltravisorURL = `http://127.0.0.1:${pInstance.Port}`;
			}
		}

		let tmpTokens =
		{
			Port:          tmpInternalPort,
			BeaconName:    pName,
			BeaconDir:     tmpBeaconDir,
			UltravisorURL: tmpUltravisorURL,
			IDBeacon:      pID
		};
		let tmpTemplate = pType.ConfigTemplate ? this._substituteTokens(pType.ConfigTemplate, tmpTokens) : {};
		return this._deepMerge(tmpTemplate, pUserConfig || {});
	}

	_substituteTokens(pValue, pTokens)
	{
		if (pValue == null) { return pValue; }
		if (typeof pValue === 'string')
		{
			return pValue.replace(/\{\{(\w+)\}\}/g, (pMatch, pKey) =>
				{
					return Object.prototype.hasOwnProperty.call(pTokens, pKey) ? String(pTokens[pKey]) : pMatch;
				});
		}
		if (Array.isArray(pValue))
		{
			return pValue.map((pItem) => this._substituteTokens(pItem, pTokens));
		}
		if (typeof pValue === 'object')
		{
			let tmpOut = {};
			for (let tmpKey of Object.keys(pValue)) { tmpOut[tmpKey] = this._substituteTokens(pValue[tmpKey], pTokens); }
			return tmpOut;
		}
		return pValue;
	}

	_deepMerge(pBase, pOverlay)
	{
		if (!pBase || typeof pBase !== 'object' || Array.isArray(pBase)) { return pOverlay; }
		if (!pOverlay || typeof pOverlay !== 'object' || Array.isArray(pOverlay)) { return pOverlay !== undefined ? pOverlay : pBase; }
		let tmpOut = Object.assign({}, pBase);
		for (let tmpKey of Object.keys(pOverlay))
		{
			let tmpBaseVal = tmpOut[tmpKey];
			let tmpOverVal = pOverlay[tmpKey];
			tmpOut[tmpKey] = (tmpBaseVal && typeof tmpBaseVal === 'object' && !Array.isArray(tmpBaseVal)
				&& tmpOverVal && typeof tmpOverVal === 'object' && !Array.isArray(tmpOverVal))
				? this._deepMerge(tmpBaseVal, tmpOverVal)
				: tmpOverVal;
		}
		return tmpOut;
	}

	// ── Spawn spec assembly ─────────────────────────────────────────────────

	_buildSpawnSpec(pType, pID, pName, pPort, pInstance, pConfigPath)
	{
		if (pType.Mode === 'standalone-service')
		{
			if (!pType.BinPath) { throw new Error(`Type '${pType.BeaconType}' has no bin path.`); }
			let tmpTemplate = pType.ArgTemplate || [];
			let tmpCtx = { Port: pPort, BeaconName: pName, ConfigPath: pConfigPath, UltravisorURL: pInstance ? `http://127.0.0.1:${pInstance.Port}` : '' };
			return {
				Command: process.execPath,
				Args: [pType.BinPath].concat(this._expandArgTemplate(tmpTemplate, tmpCtx))
			};
		}

		if (pType.Mode === 'capability-provider')
		{
			// Host-process capability-provider beacons are no longer
			// supported -- they live exclusively as containers via
			// LabBeaconContainerManager.  Boot migration flips legacy rows
			// to Runtime='container' before anything tries this path, so
			// reaching here means something slipped the migration.
			throw new Error(`Capability-provider type '${pType.BeaconType}' must run as a container; no host-process fallback.`);
		}

		throw new Error(`Unknown beacon mode: ${pType.Mode}`);
	}

	_expandArgTemplate(pTemplate, pCtx)
	{
		let tmpOut = [];
		for (let i = 0; i < pTemplate.length; i++)
		{
			let tmpItem = pTemplate[i];
			if (typeof tmpItem === 'string') { tmpOut.push(tmpItem); continue; }
			if (tmpItem && typeof tmpItem === 'object')
			{
				if (tmpItem.flag) { tmpOut.push(tmpItem.flag); }
				if (tmpItem.fromLabPath && pCtx[tmpItem.fromLabPath] !== undefined)
				{
					tmpOut.push(String(pCtx[tmpItem.fromLabPath]));
				}
				else if (tmpItem.literal !== undefined)
				{
					tmpOut.push(String(tmpItem.literal));
				}
			}
		}
		return tmpOut;
	}

	// ── Readiness polling ───────────────────────────────────────────────────

	_waitForHttp(pPort, pPath, pAttempt, fCallback)
	{
		if (pAttempt >= HEALTH_POLL_MAX_ATTEMPTS) { return fCallback(false); }

		let tmpPath = pPath || '/';
		let tmpReq = libHttp.get({ host: '127.0.0.1', port: pPort, path: tmpPath, timeout: 2000 },
			(pRes) =>
			{
				pRes.resume();
				return fCallback(true);
			});
		tmpReq.on('error', () => setTimeout(() => this._waitForHttp(pPort, pPath, pAttempt + 1, fCallback), HEALTH_POLL_INTERVAL_MS));
		tmpReq.on('timeout', () =>
			{
				tmpReq.destroy();
				setTimeout(() => this._waitForHttp(pPort, pPath, pAttempt + 1, fCallback), HEALTH_POLL_INTERVAL_MS);
			});
	}

	/**
	 * Build a progress callback the container manager uses to surface
	 * image-build + container-start phases into the Beacon row's
	 * StatusDetail and the Events timeline.  Keeps the user informed
	 * during long docker builds (the first image build of a given
	 * version can take multiple minutes).
	 */
	_buildContainerProgressEmitter(pCtx)
	{
		let tmpStore = this.fable.LabStateStore;

		return (pPhase, pData) =>
		{
			let tmpStatusDetail = '';
			let tmpEventType    = '';
			let tmpSeverity     = 'info';
			let tmpMessage      = '';
			let tmpData         = pData || {};
			let tmpElapsedS     = tmpData.ElapsedMs ? Math.round(tmpData.ElapsedMs / 1000) : 0;

			switch (pPhase)
			{
				case 'build-started':
					tmpStatusDetail = `Building image ${tmpData.ImageTag} (first build may take a few minutes)...`;
					tmpEventType    = 'beacon-image-build-started';
					tmpMessage      = `Building container image ${tmpData.ImageTag} for '${pCtx.Name}'...`;
					break;
				case 'build-progress':
					tmpStatusDetail = `Building image... ${tmpElapsedS}s elapsed`;
					tmpEventType    = 'beacon-image-build-progress';
					tmpMessage      = `Still building ${tmpData.ImageTag} for '${pCtx.Name}'... ${tmpElapsedS}s elapsed`;
					break;
				case 'build-completed':
					tmpStatusDetail = `Image ready (${tmpElapsedS}s)`;
					tmpEventType    = 'beacon-image-built';
					tmpMessage      = `Built container image ${tmpData.ImageTag} for '${pCtx.Name}' in ${tmpElapsedS}s`;
					break;
				case 'build-failed':
					tmpSeverity     = 'error';
					tmpEventType    = 'beacon-image-build-failed';
					tmpMessage      = `Image build failed for '${pCtx.Name}' after ${tmpElapsedS}s: ${tmpData.Error || 'unknown error'}`;
					break;
				case 'container-creating':
					tmpStatusDetail = 'Starting container...';
					tmpEventType    = 'beacon-container-creating';
					tmpMessage      = `Starting container ${tmpData.ContainerName} for '${pCtx.Name}'...`;
					break;
				case 'container-started':
					tmpStatusDetail = 'Container running; waiting for HTTP readiness...';
					tmpEventType    = 'beacon-container-started';
					tmpMessage      = `Container ${tmpData.ContainerName} running for '${pCtx.Name}'.`;
					break;
				default:
					return;
			}

			if (tmpStatusDetail)
			{
				tmpStore.update('Beacon', 'IDBeacon', pCtx.IDBeacon, { StatusDetail: tmpStatusDetail });
			}
			if (tmpEventType)
			{
				tmpStore.recordEvent(
					{
						EntityType: 'Beacon',
						EntityID:   pCtx.IDBeacon,
						EntityName: pCtx.Name,
						EventType:  tmpEventType,
						Severity:   tmpSeverity,
						Message:    tmpMessage
					});
			}
		};
	}

	_markFailed(pID, pName, pMessage)
	{
		this.fable.LabStateStore.update('Beacon', 'IDBeacon', pID,
			{ Status: 'failed', StatusDetail: pMessage });
		this.fable.LabStateStore.recordEvent(
			{
				EntityType: 'Beacon', EntityID: pID, EntityName: pName,
				EventType: 'beacon-failed', Severity: 'error', Message: pMessage
			});
	}

	// ── Start / Stop / Remove ───────────────────────────────────────────────

	startBeacon(pID, fCallback)
	{
		let tmpBeacon = this.getBeacon(pID);
		if (!tmpBeacon) { return fCallback(new Error('Beacon not found.')); }

		let tmpType = this.fable.LabBeaconTypeRegistry.get(tmpBeacon.BeaconType);
		if (!tmpType) { return fCallback(new Error(`Beacon type '${tmpBeacon.BeaconType}' is not registered; cannot start.`)); }

		let tmpInstance = tmpBeacon.IDUltravisorInstance ? this.fable.LabUltravisorManager.getInstance(tmpBeacon.IDUltravisorInstance) : null;
		if (tmpType.RequiresUltravisor && !tmpInstance)
		{
			return fCallback(new Error('Paired Ultravisor no longer exists.'));
		}

		if (tmpBeacon.Runtime === 'container')
		{
			// If we already have a container id, just `docker start` it.
			// Otherwise (e.g. first boot after a container was removed out
			// from under us) re-create the container from the type descriptor.
			let fReady = () =>
			{
				this._waitForHttp(tmpBeacon.Port, tmpType.HealthCheck && tmpType.HealthCheck.Path, 0,
					(pR) =>
					{
						if (pR)
						{
							this.fable.LabStateStore.update('Beacon', 'IDBeacon', pID,
								{ Status: 'running', StatusDetail: '' });
						}
						else
						{
							this._markFailed(pID, tmpBeacon.Name, 'beacon container did not come up');
						}
					});
			};

			this.fable.LabStateStore.update('Beacon', 'IDBeacon', pID,
				{ Status: 'starting', StatusDetail: 'Starting container...' });

			if (tmpBeacon.ContainerID)
			{
				return this.fable.LabBeaconContainerManager.start(tmpBeacon.ContainerID,
					(pErr) =>
					{
						if (pErr)
						{
							this._markFailed(pID, tmpBeacon.Name, pErr.message);
							return fCallback(pErr);
						}
						fReady();
						return fCallback(null, { Status: 'starting' });
					});
			}

			// Re-render config.json before (re-)creating the container.
			// Stanza tweaks (port mappings, mount paths, etc.) only reach
			// the running process through the rendered file, so any config
			// older than the current type descriptor gets refreshed here.
			try
			{
				let tmpConfig = {};
				try { tmpConfig = JSON.parse(tmpBeacon.ConfigJSON || '{}'); } catch (pCEx) { /* ignore */ }
				let tmpRendered = this._renderConfig(tmpType, tmpConfig, pID, tmpBeacon.Name, tmpBeacon.Port, tmpInstance);
				let tmpCfgPath = tmpBeacon.ConfigPath || libPath.join(this._beaconDir(pID), 'config.json');
				libFs.mkdirSync(this._beaconDir(pID), { recursive: true });
				libFs.writeFileSync(tmpCfgPath, JSON.stringify(tmpRendered, null, 2));
				if (tmpBeacon.ConfigPath !== tmpCfgPath)
				{
					this.fable.LabStateStore.update('Beacon', 'IDBeacon', pID, { ConfigPath: tmpCfgPath });
				}
			}
			catch (pRenderErr)
			{
				this._markFailed(pID, tmpBeacon.Name, `config render failed: ${pRenderErr.message}`);
				return fCallback(pRenderErr);
			}

			let fProgress = this._buildContainerProgressEmitter(
				{ IDBeacon: pID, Name: tmpBeacon.Name, TypeDisplayName: tmpType.DisplayName });

			return this.fable.LabBeaconContainerManager.create(tmpType, tmpBeacon,
				(pErr, pResult) =>
				{
					if (pErr) { this._markFailed(pID, tmpBeacon.Name, pErr.message); return fCallback(pErr); }
					this.fable.LabStateStore.update('Beacon', 'IDBeacon', pID,
						{
							ContainerID:   pResult.ContainerID,
							ContainerName: pResult.ContainerName,
							ImageTag:      pResult.ImageTag,
							ImageVersion:  pResult.ImageVersion,
							StatusDetail:  'Waiting for HTTP readiness...'
						});
					fReady();
					return fCallback(null, { Status: 'starting' });
				},
				fProgress);
		}

		// Host-process path ( existing behavior; unchanged ).
		let tmpSpawn;
		try
		{
			tmpSpawn = this._buildSpawnSpec(tmpType, pID, tmpBeacon.Name, tmpBeacon.Port, tmpInstance, tmpBeacon.ConfigPath);
		}
		catch (pErr) { return fCallback(pErr); }

		let tmpPid;
		try
		{
			tmpPid = this.fable.LabProcessSupervisor.spawn('Beacon', pID,
				{
					Command: tmpSpawn.Command,
					Args:    tmpSpawn.Args,
					Cwd:     this._beaconDir(pID),
					Env:     Object.assign({}, process.env)
				});
		}
		catch (pSpawnErr) { return fCallback(pSpawnErr); }

		this.fable.LabStateStore.update('Beacon', 'IDBeacon', pID,
			{ PID: tmpPid, Status: 'starting', StatusDetail: 'Waiting for HTTP readiness...' });

		this._waitForHttp(tmpBeacon.Port, tmpType.HealthCheck && tmpType.HealthCheck.Path, 0,
			(pReady) =>
			{
				if (pReady)
				{
					this.fable.LabStateStore.update('Beacon', 'IDBeacon', pID,
						{ Status: 'running', StatusDetail: '' });
				}
				else
				{
					this._markFailed(pID, tmpBeacon.Name, 'beacon did not come up');
				}
			});

		return fCallback(null, { PID: tmpPid, Status: 'starting' });
	}

	stopBeacon(pID, fCallback)
	{
		let tmpBeacon = this.getBeacon(pID);
		if (!tmpBeacon) { return fCallback(new Error('Beacon not found.')); }

		this.fable.LabStateStore.update('Beacon', 'IDBeacon', pID,
			{ Status: 'stopping', StatusDetail: '' });

		if (tmpBeacon.Runtime === 'container' && tmpBeacon.ContainerID)
		{
			return this.fable.LabBeaconContainerManager.stop(tmpBeacon.ContainerID,
				(pErr) =>
				{
					if (pErr)
					{
						this.fable.LabStateStore.recordEvent(
							{
								EntityType: 'Beacon', EntityID: pID, EntityName: tmpBeacon.Name,
								EventType: 'stop-failed', Severity: 'warning', Message: pErr.message
							});
						return fCallback(pErr);
					}
					this.fable.LabStateStore.update('Beacon', 'IDBeacon', pID,
						{ Status: 'stopped', StatusDetail: '' });
					return fCallback(null, { Stopped: true });
				});
		}

		this.fable.LabProcessSupervisor.stop('Beacon', pID,
			(pErr) =>
			{
				if (pErr)
				{
					this.fable.LabStateStore.recordEvent(
						{
							EntityType: 'Beacon', EntityID: pID, EntityName: tmpBeacon.Name,
							EventType: 'stop-failed', Severity: 'warning', Message: pErr.message
						});
					return fCallback(pErr);
				}
				this.fable.LabStateStore.update('Beacon', 'IDBeacon', pID,
					{ Status: 'stopped', PID: 0, StatusDetail: '' });
				return fCallback(null, { Stopped: true });
			});
	}

	removeBeacon(pID, fCallback)
	{
		let tmpBeacon = this.getBeacon(pID);
		if (!tmpBeacon) { return fCallback(new Error('Beacon not found.')); }

		let fFinalize = () =>
		{
			this.fable.LabStateStore.remove('Beacon', 'IDBeacon', pID);
			try { this._rimraf(this._beaconDir(pID)); } catch (pErr) { /* ignore */ }
			this.fable.LabStateStore.recordEvent(
				{
					EntityType: 'Beacon', EntityID: pID, EntityName: tmpBeacon.Name,
					EventType: 'beacon-removed', Severity: 'info',
					Message: `Beacon '${tmpBeacon.Name}' removed`
				});
			return fCallback(null, { Removed: true });
		};

		if (tmpBeacon.Runtime === 'container' && tmpBeacon.ContainerID)
		{
			return this.fable.LabBeaconContainerManager.remove(tmpBeacon.ContainerID, () => fFinalize());
		}

		this.fable.LabProcessSupervisor.stop('Beacon', pID, () => fFinalize());
	}

	// Cascade hook called when an Ultravisor is removed.  Beacons registered
	// with that UV can't function without it, so they go too.
	removeBeaconsForUltravisor(pUltravisorID, fCallback)
	{
		let tmpRows = this.listBeaconsForUltravisor(pUltravisorID);
		if (tmpRows.length === 0) { return fCallback(null, { Removed: 0 }); }

		let tmpRemoved = 0;
		let tmpIdx = 0;
		let tmpNext = () =>
		{
			if (tmpIdx >= tmpRows.length) { return fCallback(null, { Removed: tmpRemoved }); }
			let tmpRow = tmpRows[tmpIdx++];
			this.removeBeacon(tmpRow.IDBeacon,
				(pErr) =>
				{
					if (!pErr) { tmpRemoved++; }
					setImmediate(tmpNext);
				});
		};
		tmpNext();
	}

	_rimraf(pDirPath)
	{
		if (!libFs.existsSync(pDirPath)) { return; }
		let tmpStat = libFs.statSync(pDirPath);
		if (tmpStat.isFile() || tmpStat.isSymbolicLink()) { libFs.unlinkSync(pDirPath); return; }
		for (let tmpEntry of libFs.readdirSync(pDirPath))
		{
			this._rimraf(libPath.join(pDirPath, tmpEntry));
		}
		libFs.rmdirSync(pDirPath);
	}
}

module.exports = ServiceBeaconManager;
