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

		// New beacons default to npm-build source; users opt into source
		// mode per-beacon via POST /api/lab/beacons/:id/build-source.  The
		// request body may set it up-front when a pre-cached source image is
		// already sitting in docker (rare; tested via curl more than UI).
		let tmpBuildSource = (pRequest.BuildSource === 'source') ? 'source' : 'npm';

		// Admission overrides — frozen on the row at create time so a
		// stop/start cycle uses the same admission shape the operator
		// chose. Empty / false means "fall back to lab's auto-assignment"
		// (parent UV's BootstrapAuthSecret in Secure mode, no secret
		// otherwise). These exist only to support testing different
		// security configurations from the lab UI; production beacons
		// should leave them at defaults.
		let tmpJoinSecretOverride = (typeof pRequest.JoinSecretOverride === 'string')
			? pRequest.JoinSecretOverride : '';
		let tmpSkipJoinSecret = !!pRequest.SkipJoinSecret;

		let tmpID = tmpStore.insert('Beacon',
			{
				Name:                 tmpName,
				BeaconType:           tmpType.BeaconType,
				Port:                 tmpPort,
				IDUltravisorInstance: tmpUvID,
				ConfigJSON:           JSON.stringify(tmpConfig),
				Runtime:              tmpRuntime,
				BuildSource:          tmpBuildSource,
				JoinSecretOverride:   tmpJoinSecretOverride,
				SkipJoinSecret:       tmpSkipJoinSecret,
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
			// Carry the admission overrides too so the container path's
			// _standaloneServiceTokens can short-circuit the auto-assigned
			// JoinSecret when the operator explicitly opted out.
			let tmpBeaconRow =
				{
					IDBeacon:             tmpID,
					Name:                 tmpName,
					Port:                 tmpPort,
					IDUltravisorInstance: tmpUvID,
					ConfigJSON:           JSON.stringify(tmpConfig),
					BuildSource:          tmpBuildSource,
					JoinSecretOverride:   tmpJoinSecretOverride,
					SkipJoinSecret:       tmpSkipJoinSecret
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
							BuildSource:   pContainerResult.BuildSource || tmpBuildSource,
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
			// Build a stub Beacon row with just the admission-override
			// fields _buildSpawnSpec needs. (The full row hasn't been
			// reloaded from the store yet; this is the shortest-path
			// option that doesn't introduce a re-read for create.)
			let tmpStubRow =
			{
				IDBeacon: tmpID, Name: tmpName, Port: tmpPort,
				JoinSecretOverride: tmpJoinSecretOverride,
				SkipJoinSecret: tmpSkipJoinSecret
			};
			tmpSpawn = this._buildSpawnSpec(tmpType, tmpID, tmpName, tmpPort, tmpInstance, tmpConfigPath, tmpStubRow);
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

		// Beacons that don't run their own HTTP server (e.g. the auth
		// beacon — pure WS client connecting up to ultravisor) declare
		// `defaultPort: 0` in their stanza. For those, polling
		// 127.0.0.1:Port would never succeed; we wait briefly for the
		// process to stabilize and mark it ready. A more rigorous check
		// would query ultravisor's beacon list for our Name; that's
		// follow-up work.
		let tmpNeedsHTTP = tmpPort && tmpPort > 0;
		if (!tmpNeedsHTTP)
		{
			tmpStore.update('Beacon', 'IDBeacon', tmpID,
				{ StatusDetail: 'Process started; non-HTTP beacon, skipping HTTP poll...' });
			setTimeout(() =>
			{
				let tmpRow = tmpStore.getById('Beacon', 'IDBeacon', tmpID);
				if (!tmpRow || tmpRow.Status === 'failed' || tmpRow.Status === 'stopped') return;
				tmpStore.update('Beacon', 'IDBeacon', tmpID,
					{ Status: 'running', StatusDetail: '' });
				tmpStore.recordEvent(
					{
						EntityType: 'Beacon', EntityID: tmpID, EntityName: tmpName,
						EventType: 'beacon-ready', Severity: 'info',
						Message: `${tmpType.DisplayName} beacon '${tmpName}' running (no HTTP server)`
					});
			}, 3000);
		}
		else
		{
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
		}

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

	_buildSpawnSpec(pType, pID, pName, pPort, pInstance, pConfigPath, pBeaconRow)
	{
		if (pType.Mode === 'standalone-service')
		{
			if (!pType.BinPath) { throw new Error(`Type '${pType.BeaconType}' has no bin path.`); }
			let tmpTemplate = pType.ArgTemplate || [];
			// JoinSecret resolution, in order of precedence:
			//   1. SkipJoinSecret on the beacon row → '' (sends nothing,
			//      always rejected by Secure UVs — useful for testing)
			//   2. JoinSecretOverride on the beacon row → that literal
			//      (lets the operator try a wrong secret, an expired one,
			//      a known-good per-beacon credential, etc.)
			//   3. Parent UV's BootstrapAuthSecret when Secure → auto
			//   4. Empty string (promiscuous mode → field omitted on wire)
			//
			// Beacons whose argTemplate doesn't reference
			// {fromLabPath:'JoinSecret'} just ignore whatever lands here.
			let tmpJoinSecret = '';
			if (pBeaconRow && pBeaconRow.SkipJoinSecret)
			{
				tmpJoinSecret = '';
			}
			else if (pBeaconRow && pBeaconRow.JoinSecretOverride)
			{
				tmpJoinSecret = pBeaconRow.JoinSecretOverride;
			}
			else if (pInstance && pInstance.Secure && pInstance.BootstrapAuthSecret)
			{
				tmpJoinSecret = pInstance.BootstrapAuthSecret;
			}
			let tmpCtx =
			{
				Port: pPort,
				BeaconName: pName,
				ConfigPath: pConfigPath,
				UltravisorURL: pInstance ? `http://127.0.0.1:${pInstance.Port}` : '',
				JoinSecret: tmpJoinSecret
			};

			// Pass-through for argTemplate.fromLabPath: merge any per-beacon
			// ConfigJSON keys (operator-set fields from the configForm) into
			// tmpCtx so type-specific argTemplates can reference them
			// without lab core needing to know about each key.  Reserved
			// keys above always win; arrays flatten to CSV so string-shaped
			// flags work without per-bin parsing.  Parse failures are
			// non-fatal -- the spawn proceeds with defaults.
			let tmpReserved =
				{ Port: 1, BeaconName: 1, ConfigPath: 1, UltravisorURL: 1, JoinSecret: 1 };
			if (pBeaconRow && typeof pBeaconRow.ConfigJSON === 'string' && pBeaconRow.ConfigJSON.length > 0)
			{
				try
				{
					let tmpConfig = JSON.parse(pBeaconRow.ConfigJSON);
					if (tmpConfig && typeof tmpConfig === 'object')
					{
						let tmpKeys = Object.keys(tmpConfig);
						for (let i = 0; i < tmpKeys.length; i++)
						{
							let tmpKey = tmpKeys[i];
							if (tmpReserved[tmpKey]) { continue; }
							let tmpValue = tmpConfig[tmpKey];
							if (tmpValue === null || tmpValue === undefined) { continue; }
							if (Array.isArray(tmpValue)) { tmpValue = tmpValue.join(','); }
							tmpCtx[tmpKey] = tmpValue;
						}
					}
				}
				catch (pErr)
				{
					if (this.fable && this.fable.log)
					{
						this.fable.log.warn(`_buildSpawnSpec: could not parse ConfigJSON for beacon ${pName}: ${pErr.message}`);
					}
				}
			}

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

			// Build a fresh container from the type descriptor. Used either
			// when the row has no ContainerID yet, or when the stored
			// ContainerID points at a container that's been removed
			// out-of-band (manual cleanup, lab DB carried across machines,
			// etc.). Idempotent: meadow's image-existence check skips the
			// build when the tag is already cached.
			let fEnsureFresh = () =>
			{
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

				this.fable.LabBeaconContainerManager.create(tmpType, tmpBeacon,
					(pErr, pResult) =>
					{
						if (pErr) { this._markFailed(pID, tmpBeacon.Name, pErr.message); return fCallback(pErr); }
						this.fable.LabStateStore.update('Beacon', 'IDBeacon', pID,
							{
								ContainerID:   pResult.ContainerID,
								ContainerName: pResult.ContainerName,
								ImageTag:      pResult.ImageTag,
								ImageVersion:  pResult.ImageVersion,
								BuildSource:   pResult.BuildSource || tmpBeacon.BuildSource || 'npm',
								StatusDetail:  'Waiting for HTTP readiness...'
							});
						fReady();
						return fCallback(null, { Status: 'starting' });
					},
					fProgress);
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
							// "No such container" → fall through to recreate.
							// Other failures (port conflict, etc.) still bubble.
							let tmpMsg = (pErr.message || '').toLowerCase();
							if (tmpMsg.indexOf('no such container') >= 0)
							{
								this.log.info(`startBeacon: stored container for beacon ${pID} is gone; recreating from image.`);
								return fEnsureFresh();
							}
							this._markFailed(pID, tmpBeacon.Name, pErr.message);
							return fCallback(pErr);
						}
						fReady();
						return fCallback(null, { Status: 'starting' });
					});
			}

			return fEnsureFresh();
		}

		// Host-process path ( existing behavior; unchanged ).
		let tmpSpawn;
		try
		{
			// Reused start path — tmpBeacon is the full row from the
			// state store, so the admission-override fields ride
			// through directly without a stub.
			tmpSpawn = this._buildSpawnSpec(tmpType, pID, tmpBeacon.Name, tmpBeacon.Port, tmpInstance, tmpBeacon.ConfigPath, tmpBeacon);
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

	// ── Rebuild image (container-mode beacons only) ─────────────────────────
	/**
	 * "Rebuild image" flow: force a full rebuild from the current stanza.
	 *   1. Stop + remove the container.
	 *   2. Best-effort `docker rmi` the cached image tag.  If another beacon
	 *      still references it, docker refuses and we proceed with the
	 *      cached image -- the newly-created container will run on the
	 *      existing image (same-tag case).  For the common "stanza version
	 *      bumped" case, the tag will be different and a fresh build runs
	 *      unconditionally since the new tag has no cached image.
	 *   3. Clear ContainerID on the row so startBeacon re-enters the
	 *      create path (builds + runs fresh).
	 *   4. Re-invoke startBeacon to do the work.
	 *
	 * Records a `beacon-rebuild-started` InfrastructureEvent so the Events
	 * timeline shows the intent; the create path already emits its own
	 * image-build + container-started events on top of that.
	 */
	rebuildBeaconImage(pID, fCallback)
	{
		let tmpBeacon = this.getBeacon(pID);
		if (!tmpBeacon) { return fCallback(new Error('Beacon not found.')); }
		if (tmpBeacon.Runtime !== 'container')
		{
			return fCallback(new Error(`Beacon '${tmpBeacon.Name}' is not a container beacon; nothing to rebuild.`));
		}

		let tmpStore = this.fable.LabStateStore;
		let tmpDocker = this.fable.LabDockerManager;

		tmpStore.update('Beacon', 'IDBeacon', pID,
			{ Status: 'rebuilding', StatusDetail: 'Stopping container...' });
		tmpStore.recordEvent(
			{
				EntityType: 'Beacon', EntityID: pID, EntityName: tmpBeacon.Name,
				EventType: 'beacon-rebuild-started', Severity: 'info',
				Message: `Rebuilding image for '${tmpBeacon.Name}' (was ${tmpBeacon.ImageTag || 'no tag'})`
			});

		let fAfterRmi = () =>
		{
			// Clear ContainerID + ImageTag so startBeacon takes the
			// create-fresh branch.  ConfigJSON, ConfigPath, Name, Port, and
			// the UV binding all stay.
			tmpStore.update('Beacon', 'IDBeacon', pID,
				{
					ContainerID:   '',
					ImageTag:      '',
					ImageVersion:  '',
					ContainerName: '',
					StatusDetail:  'Rebuilding image...'
				});
			this.startBeacon(pID, fCallback);
		};

		let fRemoveImage = () =>
		{
			if (!tmpBeacon.ImageTag) { return fAfterRmi(); }
			tmpDocker.rmi(tmpBeacon.ImageTag,
				(pRmiErr) =>
				{
					if (pRmiErr)
					{
						// Image is still in use by other beacons or another
						// container.  Not fatal -- the cached image just
						// remains, and we recreate this beacon's container
						// against it.  User can rebuild the other beacons
						// individually to propagate the upgrade.
						tmpStore.recordEvent(
							{
								EntityType: 'Beacon', EntityID: pID, EntityName: tmpBeacon.Name,
								EventType: 'beacon-rebuild-image-cached', Severity: 'warning',
								Message: `Image '${tmpBeacon.ImageTag}' still referenced by other containers; rebuilt '${tmpBeacon.Name}'s container against cached image. Rebuild other beacons of this type to propagate.`
							});
					}
					return fAfterRmi();
				});
		};

		if (tmpBeacon.ContainerID)
		{
			tmpDocker.rm(tmpBeacon.ContainerID, true,
				(pRmErr) =>
				{
					if (pRmErr)
					{
						// Fall through regardless -- the container might
						// already be gone, and we still want to proceed.
						this.fable.log.warn(`[Rebuild] container rm for ${tmpBeacon.Name} failed: ${pRmErr.message}`);
					}
					fRemoveImage();
				});
		}
		else
		{
			fRemoveImage();
		}
	}

	// ── Switch build source (container-mode beacons only) ──────────────────
	/**
	 * Toggle a beacon between npm-built and source-built images.  Flow:
	 *   1. Validate the request + beacon state (must be container-mode; type
	 *      must support source builds when switching TO source).
	 *   2. Stop + remove the current container.  Leave the old image intact
	 *      (npm image sticks around so switching back is a cheap re-run, and
	 *      the per-beacon source tag is scoped by IDBeacon so it doesn't
	 *      conflict with sibling beacons).
	 *   3. Update BuildSource on the row.  Clear ContainerID so startBeacon
	 *      takes the create path, which re-computes the image tag from the
	 *      new BuildSource and builds/reuses the matching image.
	 *   4. Call startBeacon.
	 *
	 * Switching to source always forces a fresh `npm pack` of the sibling
	 * checkout (_prepareSourceContext wipes the staging dir each call), so
	 * repeated switch-to-source hops actually pick up in-flight edits.  The
	 * image tag for source is `<name>:source-b<IDBeacon>`; this method
	 * `docker rmi`s that tag before create so switching-to-source always
	 * yields a fresh build from current disk.  Switching-to-npm skips the
	 * rmi so the cached npm image is reused.
	 */
	switchBeaconBuildSource(pID, pBuildSource, fCallback)
	{
		let tmpBeacon = this.getBeacon(pID);
		if (!tmpBeacon) { return fCallback(new Error('Beacon not found.')); }
		if (tmpBeacon.Runtime !== 'container')
		{
			return fCallback(new Error(`Beacon '${tmpBeacon.Name}' is not a container beacon; nothing to switch.`));
		}

		let tmpTarget = (pBuildSource === 'source') ? 'source' : 'npm';
		let tmpCurrent = tmpBeacon.BuildSource || 'npm';
		if (tmpTarget === tmpCurrent)
		{
			return fCallback(null, { Status: 'nochange', BuildSource: tmpCurrent });
		}

		let tmpType = this.fable.LabBeaconTypeRegistry.get(tmpBeacon.BeaconType);
		if (!tmpType) { return fCallback(new Error(`Beacon type '${tmpBeacon.BeaconType}' not registered.`)); }
		if (tmpTarget === 'source' && !this.fable.LabBeaconContainerManager.supportsSourceBuild(tmpType))
		{
			return fCallback(new Error(`Beacon type '${tmpType.BeaconType}' doesn't support source builds (capability-provider, or no sibling monorepo checkout).`));
		}

		let tmpStore = this.fable.LabStateStore;
		let tmpDocker = this.fable.LabDockerManager;

		tmpStore.update('Beacon', 'IDBeacon', pID,
			{ Status: 'rebuilding', StatusDetail: `Switching to ${tmpTarget}-built image...` });
		tmpStore.recordEvent(
			{
				EntityType: 'Beacon', EntityID: pID, EntityName: tmpBeacon.Name,
				EventType: 'beacon-build-source-switch', Severity: 'info',
				Message: `Switching '${tmpBeacon.Name}' build source ${tmpCurrent} → ${tmpTarget}`
			});

		let fAfterRmi = () =>
		{
			tmpStore.update('Beacon', 'IDBeacon', pID,
				{
					ContainerID:   '',
					ContainerName: '',
					ImageTag:      '',
					ImageVersion:  '',
					BuildSource:   tmpTarget,
					StatusDetail:  `${tmpTarget === 'source' ? 'Packing monorepo checkout' : 'Rebuilding'}…`
				});
			this.startBeacon(pID, fCallback);
		};

		let fRemoveContainer = () =>
		{
			if (!tmpBeacon.ContainerID) { return fAfterRmi(); }
			tmpDocker.rm(tmpBeacon.ContainerID, true,
				(pRmErr) =>
				{
					if (pRmErr) { this.fable.log.warn(`[SwitchBuildSource] container rm for ${tmpBeacon.Name} failed: ${pRmErr.message}`); }
					fAfterRmi();
				});
		};

		// Pre-flight `docker rmi` only when switching TO source -- the
		// source tag is per-beacon so removing it won't affect siblings,
		// and we want the rebuild to reflect current disk state.  Switching
		// to npm reuses the cached npm image if it already exists (that's
		// the fast-switch path the user asked for).
		if (tmpTarget === 'source')
		{
			let tmpSourceTag = this.fable.LabBeaconContainerManager.imageTag(tmpType, Object.assign({}, tmpBeacon, { BuildSource: 'source' }));
			return tmpDocker.rmi(tmpSourceTag,
				(pRmiErr) =>
				{
					// rmi errors are fine here -- the tag might not exist yet.
					if (pRmiErr) { this.fable.log.debug(`[SwitchBuildSource] rmi ${tmpSourceTag}: ${pRmiErr.message}`); }
					fRemoveContainer();
				});
		}
		return fRemoveContainer();
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
