/**
 * Service-UltravisorManager
 *
 * Supervises one container per UltravisorInstance row.  Each container runs
 * the published `ultravisor` npm module's CLI (`ultravisor start -c
 * /app/data/.ultravisor.json`) -- no lab-specific startup script is baked
 * into the image.  The lab's responsibilities are:
 *
 *   1. Build the image on demand (`docker/ultravisor.Dockerfile`).
 *   2. Render an `.ultravisor.json` config file into the instance's data
 *      dir, using container-relative paths.
 *   3. Provision seed operation JSONs into `operations/` (the Ultravisor's
 *      UltravisorOperationLibraryPath).
 *   4. `docker run` the container on the shared `ultravisor-lab` network
 *      with the instance dir bind-mounted to /app/data.
 *   5. Poll / for readiness and POST each operation file to /Operation so
 *      the HypervisorState picks them up without a restart.
 *
 * Per-instance disk layout (unchanged on the host side):
 *   data/ultravisors/<id>/
 *     .ultravisor.json             -- rendered config (container paths)
 *     operations/                  -- seed operation JSONs
 *     ultravisor_datastore/        -- Ultravisor's file store
 *     ultravisor_staging/          -- run artifacts
 *
 * Legacy host-process fallback is kept for rows with Runtime='process'
 * in case someone runs this against a state store that hasn't been
 * migrated yet; the boot migration in Lab-Server-Setup.js should flip
 * every existing UV row to 'container' on first boot.
 */
'use strict';

const libPath = require('path');
const libFs = require('fs');
const libHttp = require('http');
const libCrypto = require('crypto');
const libFableServiceProviderBase = require('fable-serviceproviderbase');

const HEALTH_POLL_MAX_ATTEMPTS = 120;  // 120 * 1s = 2 min (container cold boot allows slack)
const HEALTH_POLL_INTERVAL_MS  = 1000;

const LAB_NETWORK_NAME = 'ultravisor-lab';
const UV_INTERNAL_PORT = 54321;

class ServiceUltravisorManager extends libFableServiceProviderBase
{
	constructor(pFable, pOptions, pServiceHash)
	{
		super(pFable, pOptions, pServiceHash);

		this.serviceType = 'LabUltravisorManager';
	}

	listInstances()
	{
		return this.fable.LabStateStore.list('UltravisorInstance');
	}

	getInstance(pID)
	{
		return this.fable.LabStateStore.getById('UltravisorInstance', 'IDUltravisorInstance', pID);
	}

	_instanceDir(pID)
	{
		return libPath.join(this.fable.LabStateStore.dataDir, 'ultravisors', String(pID));
	}

	operationLibraryDir(pID)
	{
		return libPath.join(this._instanceDir(pID), 'operations');
	}

	containerName(pID)
	{
		return `lab-ultravisor-${pID}`;
	}

	imageTag()
	{
		let tmpVersion = this.fable.LabBeaconTypeRegistry
			? this.fable.LabBeaconTypeRegistry.lookupPackageVersion('ultravisor')
			: 'latest';
		return `ultravisor-lab/ultravisor:${tmpVersion}`;
	}

	// ── Create ───────────────────────────────────────────────────────────────
	/**
	 * pRequest = { Name, Port, Secure?: boolean }
	 *
	 * `Secure: true` flips the spawned ultravisor into non-promiscuous mode
	 * and mints a per-instance BootstrapAuthSecret. The secret is persisted
	 * on the UltravisorInstance row so the auth-beacon spawn flow (Layer B)
	 * and the first-user provisioning flow (Layer C) can read it. It is
	 * NEVER returned through public API responses — the row is read-only
	 * for UI consumers via getInstance(), which scrubs the secret before
	 * sending. Once the admin user has been provisioned through the auth
	 * beacon (Layer C), the secret rotates and the lab no longer needs it.
	 */
	createInstance(pRequest, fCallback)
	{
		let tmpStore = this.fable.LabStateStore;

		let tmpName = (pRequest.Name || '').trim();
		if (!tmpName) { return fCallback(new Error('Name is required.')); }

		let tmpPort = parseInt(pRequest.Port, 10);
		if (!Number.isFinite(tmpPort) || tmpPort < 1 || tmpPort > 65535)
		{
			return fCallback(new Error('Port must be a number between 1 and 65535.'));
		}

		let tmpSecure = !!pRequest.Secure;
		// 32 bytes = 256 bits of entropy — overkill for a local lab
		// secret, but the cost is zero and the ceiling is high if someone
		// later exposes the lab's port to a network. Hex-encoded so the
		// secret is safe in JSON config + curl one-liners.
		let tmpBootstrapSecret = tmpSecure
			? libCrypto.randomBytes(32).toString('hex')
			: '';

		let tmpID = tmpStore.insert('UltravisorInstance',
			{
				Name:         tmpName,
				Port:         tmpPort,
				Runtime:      'container',
				Status:       'provisioning',
				StatusDetail: 'Preparing image...',
				ConfigPath:   '',
				Secure:       tmpSecure,
				BootstrapAuthSecret: tmpBootstrapSecret,
				Bootstrapped: false
			});

		tmpStore.recordEvent(
			{
				EntityType: 'UltravisorInstance', EntityID: tmpID, EntityName: tmpName,
				EventType: 'ultravisor-create-started', Severity: 'info',
				Message: `Creating Ultravisor '${tmpName}' on port ${tmpPort}`
			});

		try
		{
			libFs.mkdirSync(this._instanceDir(tmpID), { recursive: true });
			libFs.mkdirSync(this.operationLibraryDir(tmpID), { recursive: true });
		}
		catch (pErr)
		{
			this._markFailed(tmpID, tmpName, pErr.message);
			return fCallback(pErr);
		}

		// Render the .ultravisor.json the published CLI expects.  All paths
		// are the inside-container view (/app/data/...) because the lab
		// bind-mounts the host instance dir to /app/data at docker run time.
		let tmpConfigPath;
		try
		{
			tmpConfigPath = this._renderConfig(tmpID, tmpPort,
				tmpSecure ? { BootstrapAuthSecret: tmpBootstrapSecret } : null);
		}
		catch (pRenderErr)
		{
			this._markFailed(tmpID, tmpName, pRenderErr.message);
			return fCallback(pRenderErr);
		}

		tmpStore.update('UltravisorInstance', 'IDUltravisorInstance', tmpID,
			{ ConfigPath: tmpConfigPath, StatusDetail: 'Installing seed dataset operations...' });

		// Pre-populate the operation library with all seed datasets.  The
		// published CLI doesn't auto-load these on startup (it exposes a
		// library-browse endpoint instead), so after the container is
		// healthy we also POST each operation to /Operation below.  Keeping
		// the files on disk means the library endpoint + `docker cp`-style
		// inspection still work.
		if (this.fable.LabSeedDatasetManager && typeof this.fable.LabSeedDatasetManager.provisionOperationsForUltravisor === 'function')
		{
			try { this.fable.LabSeedDatasetManager.provisionOperationsForUltravisor(tmpID); }
			catch (pProvErr) { this.fable.log.warn(`UltravisorManager: seed provisioning warning: ${pProvErr.message}`); }
		}

		tmpStore.update('UltravisorInstance', 'IDUltravisorInstance', tmpID,
			{ StatusDetail: 'Building image...' });

		this._ensureContainer(tmpID, tmpName, tmpPort,
			(pRunErr, pResult) =>
			{
				if (pRunErr) { this._markFailed(tmpID, tmpName, pRunErr.message); return fCallback(pRunErr); }

				tmpStore.update('UltravisorInstance', 'IDUltravisorInstance', tmpID,
					{
						ContainerID:   pResult.ContainerID,
						ContainerName: pResult.ContainerName,
						ImageTag:      pResult.ImageTag,
						ImageVersion:  pResult.ImageVersion,
						StatusDetail:  'Waiting for Ultravisor API...'
					});

				this._waitForHttp(tmpPort, 0, (pReady) =>
					{
						if (!pReady)
						{
							this._markFailed(tmpID, tmpName, 'Ultravisor API did not come up');
							return;
						}
						this._loadOperationsFromLibrary(tmpID, () =>
							{
								tmpStore.update('UltravisorInstance', 'IDUltravisorInstance', tmpID,
									{ Status: 'running', StatusDetail: '' });
								tmpStore.recordEvent(
									{
										EntityType: 'UltravisorInstance', EntityID: tmpID, EntityName: tmpName,
										EventType: 'ultravisor-ready', Severity: 'info',
										Message: `Ultravisor '${tmpName}' ready on port ${tmpPort} (container ${pResult.ContainerName})`
									});
							});
					});

				return fCallback(null, { IDUltravisorInstance: tmpID, Runtime: 'container', Status: 'provisioning' });
			});
	}

	// ── Render .ultravisor.json with container-relative paths ───────────────

	/**
	 * Write `.ultravisor.json` into the instance's data dir.  The file is
	 * rewritten on every create + every start so stanza changes flow into
	 * existing instances without a recreate cycle.
	 *
	 * `pSecureOpts`, when present, layers non-promiscuous-mode keys on top
	 * of the base config:
	 *
	 *   { BootstrapAuthSecret: '<hex>' }
	 *     → adds UltravisorNonPromiscuous: true
	 *     → adds UltravisorBootstrapAuthSecret: '<hex>'
	 *
	 * Pass null for the legacy promiscuous-mode behavior; existing
	 * instances rendered without secure-mode keys keep working unchanged.
	 */
	_renderConfig(pID, pPort, pSecureOpts)
	{
		let tmpConfig =
		{
			UltravisorAPIServerPort:            UV_INTERNAL_PORT,
			UltravisorFileStorePath:            '/app/data/ultravisor_datastore',
			UltravisorStagingRoot:              '/app/data/ultravisor_staging',
			UltravisorTickIntervalMilliseconds: 60000,
			UltravisorCommandTimeoutMilliseconds: 300000,
			UltravisorCommandMaxBufferBytes:    10485760,
			UltravisorWebInterfacePath:         '/app/node_modules/ultravisor/webinterface/dist',
			UltravisorOperationLibraryPath:     '/app/data/operations',
			UltravisorBeaconHeartbeatTimeoutMs: 60000,
			UltravisorBeaconWorkItemTimeoutMs:  300000,
			UltravisorBeaconAffinityTTLMs:      3600000,
			UltravisorBeaconPollIntervalMs:     5000,
			UltravisorBeaconJournalCompactThreshold: 500
		};
		if (pSecureOpts && pSecureOpts.BootstrapAuthSecret)
		{
			tmpConfig.UltravisorNonPromiscuous = true;
			tmpConfig.UltravisorBootstrapAuthSecret = pSecureOpts.BootstrapAuthSecret;
		}
		let tmpConfigPath = libPath.join(this._instanceDir(pID), '.ultravisor.json');
		libFs.writeFileSync(tmpConfigPath, JSON.stringify(tmpConfig, null, 2));
		return tmpConfigPath;
	}

	/**
	 * Read-only accessor that returns an UltravisorInstance row with
	 * any sensitive fields scrubbed. Used by the API layer when a row
	 * is sent to the browser.
	 *
	 * Public API consumers should call this; internal callers (the
	 * auth-beacon spawn, the first-user bootstrap) call getInstance()
	 * directly because they need the raw secret.
	 */
	getInstancePublic(pID)
	{
		let tmpInst = this.getInstance(pID);
		if (!tmpInst) return null;
		// Shallow clone + scrub. Don't mutate the underlying state-store
		// row — this is a defensive copy returned to the wire.
		let tmpOut = Object.assign({}, tmpInst);
		delete tmpOut.BootstrapAuthSecret;
		return tmpOut;
	}

	listInstancesPublic()
	{
		return this.listInstances().map((pInst) =>
		{
			let tmpOut = Object.assign({}, pInst);
			delete tmpOut.BootstrapAuthSecret;
			return tmpOut;
		});
	}

	// ── Container management ────────────────────────────────────────────────

	/**
	 * Build the image (if absent), ensure the network, and `docker run` the
	 * container.  Called by both createInstance and startInstance (the
	 * latter when no ContainerID is on the row, e.g. after the user
	 * manually `docker rm`'d it).
	 */
	_ensureContainer(pID, pName, pPort, fCallback)
	{
		let tmpDocker = this.fable.LabDockerManager;
		let tmpImageTag = this.imageTag();
		let tmpVersion = tmpImageTag.split(':').pop();
		let tmpDockerfilePath = libPath.resolve(__dirname, '..', '..', 'docker', 'ultravisor.Dockerfile');
		let tmpContextDir = libPath.dirname(tmpDockerfilePath);

		tmpDocker.ensureNetwork(LAB_NETWORK_NAME,
			(pNetErr) =>
			{
				if (pNetErr) { return fCallback(pNetErr); }

				tmpDocker.ensureImage(
					{
						ImageTag:       tmpImageTag,
						DockerfilePath: tmpDockerfilePath,
						ContextDir:     tmpContextDir,
						BuildArgs:      { VERSION: tmpVersion }
					},
					(pImgErr, pImgResult) =>
					{
						if (pImgErr) { return fCallback(pImgErr); }

						let tmpContainerName = this.containerName(pID);
						tmpDocker.run(
							{
								Name:      tmpContainerName,
								Hostname:  tmpContainerName,
								Network:   LAB_NETWORK_NAME,
								Image:     tmpImageTag,
								Ports:     [{ Host: pPort, Container: UV_INTERNAL_PORT }],
								Volumes:
								[
									{ Source: this._instanceDir(pID), Target: '/app/data' }
								]
							},
							(pRunErr, pRunResult) =>
							{
								if (pRunErr) { return fCallback(pRunErr); }
								return fCallback(null,
									{
										ContainerID:   pRunResult.ContainerID,
										ContainerName: tmpContainerName,
										ImageTag:      tmpImageTag,
										ImageVersion:  tmpVersion,
										ImageBuilt:    pImgResult.Built === true
									});
							});
					});
			});
	}

	/**
	 * Walk the provisioned operation library dir and POST each file to the
	 * Ultravisor's /Operation endpoint.  Published `ultravisor start`
	 * doesn't auto-load the library at boot, so this is how seed operations
	 * become available for triggering.  Idempotent: /Operation upserts.
	 */
	_loadOperationsFromLibrary(pID, fCallback)
	{
		let tmpDir = this.operationLibraryDir(pID);
		let tmpFiles = [];
		try { tmpFiles = libFs.readdirSync(tmpDir).filter((pF) => pF.endsWith('.json')); }
		catch (pErr) { return fCallback(); }
		if (tmpFiles.length === 0) { return fCallback(); }

		let tmpIdx = 0;
		let tmpNext = () =>
		{
			if (tmpIdx >= tmpFiles.length) { return fCallback(); }
			let tmpFile = tmpFiles[tmpIdx++];
			let tmpPath = libPath.join(tmpDir, tmpFile);
			let tmpOperation;
			try { tmpOperation = JSON.parse(libFs.readFileSync(tmpPath, 'utf8')); }
			catch (pParseErr)
			{
				this.fable.log.warn(`UltravisorManager: invalid JSON in ${tmpFile}: ${pParseErr.message}`);
				return setImmediate(tmpNext);
			}
			this.registerOperation(pID, tmpOperation,
				(pErr) =>
				{
					if (pErr) { this.fable.log.warn(`UltravisorManager: register ${tmpFile} failed: ${pErr.message}`); }
					setImmediate(tmpNext);
				});
		};
		tmpNext();
	}

	_waitForHttp(pPort, pAttempt, fCallback)
	{
		if (pAttempt >= HEALTH_POLL_MAX_ATTEMPTS) { return fCallback(false); }

		// Ultravisor exposes GET / which returns the web UI; a simple TCP check is enough.
		let tmpReq = libHttp.get({ host: '127.0.0.1', port: pPort, path: '/', timeout: 2000 },
			(pRes) =>
			{
				pRes.resume();
				return fCallback(true);
			});
		tmpReq.on('error', () => setTimeout(() => this._waitForHttp(pPort, pAttempt + 1, fCallback), HEALTH_POLL_INTERVAL_MS));
		tmpReq.on('timeout', () =>
			{
				tmpReq.destroy();
				setTimeout(() => this._waitForHttp(pPort, pAttempt + 1, fCallback), HEALTH_POLL_INTERVAL_MS);
			});
	}

	_markFailed(pID, pName, pMessage)
	{
		this.fable.LabStateStore.update('UltravisorInstance', 'IDUltravisorInstance', pID,
			{ Status: 'failed', StatusDetail: pMessage });
		this.fable.LabStateStore.recordEvent(
			{
				EntityType: 'UltravisorInstance', EntityID: pID, EntityName: pName,
				EventType: 'ultravisor-failed', Severity: 'error', Message: pMessage
			});
	}

	// ── Start / Stop / Remove ───────────────────────────────────────────────

	startInstance(pID, fCallback)
	{
		let tmpInstance = this.getInstance(pID);
		if (!tmpInstance) { return fCallback(new Error('Ultravisor not found.')); }

		if (tmpInstance.Runtime === 'container')
		{
			// Re-render the config in case stanza settings changed.  Cheap;
			// idempotent; keeps the on-disk file fresh for inspection too.
			// Carry the Secure-mode keys forward when set on the row so a
			// stop/start cycle doesn't accidentally downgrade an instance
			// from non-promiscuous to promiscuous mode.
			let tmpSecureOpts = tmpInstance.Secure && tmpInstance.BootstrapAuthSecret
				? { BootstrapAuthSecret: tmpInstance.BootstrapAuthSecret }
				: null;
			try { this._renderConfig(pID, tmpInstance.Port, tmpSecureOpts); }
			catch (pRenderErr) { return fCallback(pRenderErr); }

			this.fable.LabStateStore.update('UltravisorInstance', 'IDUltravisorInstance', pID,
				{ Status: 'starting', StatusDetail: 'Starting container...' });

			let fReady = () =>
			{
				this._waitForHttp(tmpInstance.Port, 0, (pR) =>
					{
						if (!pR) { this._markFailed(pID, tmpInstance.Name, 'Ultravisor API did not come up'); return; }
						this._loadOperationsFromLibrary(pID, () =>
							{
								this.fable.LabStateStore.update('UltravisorInstance', 'IDUltravisorInstance', pID,
									{ Status: 'running', StatusDetail: '' });
							});
					});
			};

			let fEnsureFresh = () =>
			{
				this._ensureContainer(pID, tmpInstance.Name, tmpInstance.Port,
					(pErr, pResult) =>
					{
						if (pErr) { this._markFailed(pID, tmpInstance.Name, pErr.message); return fCallback(pErr); }
						this.fable.LabStateStore.update('UltravisorInstance', 'IDUltravisorInstance', pID,
							{
								ContainerID:   pResult.ContainerID,
								ContainerName: pResult.ContainerName,
								ImageTag:      pResult.ImageTag,
								ImageVersion:  pResult.ImageVersion,
								StatusDetail:  'Waiting for Ultravisor API...'
							});
						fReady();
						return fCallback(null, { Status: 'starting' });
					});
			};

			if (tmpInstance.ContainerID)
			{
				return this.fable.LabDockerManager.start(tmpInstance.ContainerID,
					(pErr) =>
					{
						if (pErr)
						{
							// "No such container" means the container was
							// removed out-of-band (lab restart with `docker
							// rm` in between, manual cleanup, etc.). Fall
							// through to ensureContainer which builds a fresh
							// image + container — the row's stored
							// ContainerID gets refreshed in the resulting
							// state-store update. Any other failure (e.g.
							// port already in use) still bubbles up.
							let tmpMsg = (pErr.message || '').toLowerCase();
							if (tmpMsg.indexOf('no such container') >= 0)
							{
								this.log.info(`startInstance: stored container for UV ${pID} is gone; recreating from image.`);
								return fEnsureFresh();
							}
							this._markFailed(pID, tmpInstance.Name, pErr.message);
							return fCallback(pErr);
						}
						fReady();
						return fCallback(null, { Status: 'starting' });
					});
			}

			return fEnsureFresh();
		}

		// Host-process fallback kept for pre-migration rows.  Should never
		// fire after the boot migration in Lab-Server-Setup flips them all.
		return fCallback(new Error('Host-process Ultravisor instances are no longer supported; remove and recreate.'));
	}

	stopInstance(pID, fCallback)
	{
		let tmpInstance = this.getInstance(pID);
		if (!tmpInstance) { return fCallback(new Error('Ultravisor not found.')); }

		this.fable.LabStateStore.update('UltravisorInstance', 'IDUltravisorInstance', pID,
			{ Status: 'stopping', StatusDetail: '' });

		if (tmpInstance.Runtime === 'container' && tmpInstance.ContainerID)
		{
			return this.fable.LabDockerManager.stop(tmpInstance.ContainerID,
				(pErr) =>
				{
					if (pErr)
					{
						this.fable.LabStateStore.recordEvent(
							{
								EntityType: 'UltravisorInstance', EntityID: pID, EntityName: tmpInstance.Name,
								EventType: 'stop-failed', Severity: 'warning', Message: pErr.message
							});
						return fCallback(pErr);
					}
					this.fable.LabStateStore.update('UltravisorInstance', 'IDUltravisorInstance', pID,
						{ Status: 'stopped', StatusDetail: '' });
					return fCallback(null, { Stopped: true });
				});
		}

		// Host-process cleanup kept for parity with migration.
		this.fable.LabProcessSupervisor.stop('UltravisorInstance', pID,
			(pErr) =>
			{
				if (pErr)
				{
					this.fable.LabStateStore.recordEvent(
						{
							EntityType: 'UltravisorInstance', EntityID: pID, EntityName: tmpInstance.Name,
							EventType: 'stop-failed', Severity: 'warning', Message: pErr.message
						});
					return fCallback(pErr);
				}
				this.fable.LabStateStore.update('UltravisorInstance', 'IDUltravisorInstance', pID,
					{ Status: 'stopped', PID: 0, StatusDetail: '' });
				return fCallback(null, { Stopped: true });
			});
	}

	removeInstance(pID, fCallback)
	{
		let tmpInstance = this.getInstance(pID);
		if (!tmpInstance) { return fCallback(new Error('Ultravisor not found.')); }

		// Cascade: beacons reference the UV they register with, so remove
		// them first before tearing the UV down.  A beacon pointing at a
		// dead UV can't re-register and its process can't send work items.
		let tmpBeaconMgr = this.fable.LabBeaconManager;
		let tmpCascade = (fDone) =>
			{
				if (!tmpBeaconMgr || typeof tmpBeaconMgr.removeBeaconsForUltravisor !== 'function') { return fDone(); }
				tmpBeaconMgr.removeBeaconsForUltravisor(pID, () => fDone());
			};

		let fFinalize = () =>
		{
			this.fable.LabStateStore.remove('UltravisorInstance', 'IDUltravisorInstance', pID);
			try { this._rimraf(this._instanceDir(pID)); } catch (pErr) { /* ignore */ }
			this.fable.LabStateStore.recordEvent(
				{
					EntityType: 'UltravisorInstance', EntityID: pID, EntityName: tmpInstance.Name,
					EventType: 'ultravisor-removed', Severity: 'info',
					Message: `Ultravisor '${tmpInstance.Name}' removed`
				});
			return fCallback(null, { Removed: true });
		};

		tmpCascade(() =>
			{
				if (tmpInstance.Runtime === 'container' && tmpInstance.ContainerID)
				{
					return this.fable.LabDockerManager.rm(tmpInstance.ContainerID, true, () => fFinalize());
				}
				this.fable.LabProcessSupervisor.stop('UltravisorInstance', pID, () => fFinalize());
			});
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

	// ── Operation library (used by SeedDatasetManager) ──────────────────────

	writeOperationFile(pInstanceID, pOperationHash, pOperationJSON)
	{
		libFs.mkdirSync(this.operationLibraryDir(pInstanceID), { recursive: true });
		let tmpPath = libPath.join(this.operationLibraryDir(pInstanceID), `${pOperationHash}.json`);
		libFs.writeFileSync(tmpPath, JSON.stringify(pOperationJSON, null, 2));
		return tmpPath;
	}

	// POST the operation JSON directly to Ultravisor at runtime.  The stack
	// also scans the library dir on boot, but POSTing lets the lab add
	// operations without a restart.
	registerOperation(pInstanceID, pOperationJSON, fCallback)
	{
		let tmpInstance = this.getInstance(pInstanceID);
		if (!tmpInstance) { return fCallback(new Error('Ultravisor not found.')); }
		if (tmpInstance.Status !== 'running') { return fCallback(new Error('Ultravisor is not running.')); }

		let tmpBody = JSON.stringify(pOperationJSON);
		let tmpReq = libHttp.request(
			{
				host: '127.0.0.1',
				port: tmpInstance.Port,
				path: '/Operation',
				method: 'POST',
				headers:
				{
					'Content-Type': 'application/json',
					'Content-Length': Buffer.byteLength(tmpBody)
				},
				timeout: 10000
			},
			(pRes) =>
			{
				let tmpChunks = [];
				pRes.on('data', (pChunk) => tmpChunks.push(pChunk));
				pRes.on('end', () =>
					{
						let tmpText = Buffer.concat(tmpChunks).toString('utf8');
						if (pRes.statusCode >= 400)
						{
							return fCallback(new Error(`HTTP ${pRes.statusCode}: ${tmpText.slice(0, 200)}`));
						}
						try { return fCallback(null, JSON.parse(tmpText)); }
						catch (pParseErr) { return fCallback(null, { Body: tmpText }); }
					});
			});
		tmpReq.on('error', (pErr) => fCallback(pErr));
		tmpReq.on('timeout', () => { tmpReq.destroy(); fCallback(new Error('HTTP timeout')); });
		tmpReq.write(tmpBody);
		tmpReq.end();
	}

	// Trigger an operation on a specific Ultravisor and return the RunHash.
	triggerOperation(pInstanceID, pOperationHash, pRecordData, fCallback)
	{
		let tmpInstance = this.getInstance(pInstanceID);
		if (!tmpInstance) { return fCallback(new Error('Ultravisor not found.')); }
		if (tmpInstance.Status !== 'running') { return fCallback(new Error('Ultravisor is not running.')); }

		let tmpBody = JSON.stringify(pRecordData || {});
		let tmpReq = libHttp.request(
			{
				host: '127.0.0.1',
				port: tmpInstance.Port,
				path: `/Operation/${pOperationHash}/Execute/Async`,
				method: 'POST',
				headers:
				{
					'Content-Type': 'application/json',
					'Content-Length': Buffer.byteLength(tmpBody)
				},
				timeout: 10000
			},
			(pRes) =>
			{
				let tmpChunks = [];
				pRes.on('data', (pChunk) => tmpChunks.push(pChunk));
				pRes.on('end', () =>
					{
						let tmpText = Buffer.concat(tmpChunks).toString('utf8');
						if (pRes.statusCode >= 400)
						{
							return fCallback(new Error(`HTTP ${pRes.statusCode}: ${tmpText.slice(0, 400)}`));
						}
						try { return fCallback(null, JSON.parse(tmpText)); }
						catch (pParseErr) { return fCallback(null, { Body: tmpText }); }
					});
			});
		tmpReq.on('error', (pErr) => fCallback(pErr));
		tmpReq.on('timeout', () => { tmpReq.destroy(); fCallback(new Error('HTTP timeout')); });
		tmpReq.write(tmpBody);
		tmpReq.end();
	}

	// Fetch the manifest for a run (status + outputs).
	getRunManifest(pInstanceID, pRunHash, fCallback)
	{
		let tmpInstance = this.getInstance(pInstanceID);
		if (!tmpInstance) { return fCallback(new Error('Ultravisor not found.')); }

		let tmpReq = libHttp.get(
			{
				host: '127.0.0.1',
				port: tmpInstance.Port,
				path: `/Manifest/${pRunHash}`,
				timeout: 10000
			},
			(pRes) =>
			{
				let tmpChunks = [];
				pRes.on('data', (pChunk) => tmpChunks.push(pChunk));
				pRes.on('end', () =>
					{
						let tmpText = Buffer.concat(tmpChunks).toString('utf8');
						if (pRes.statusCode >= 400)
						{
							return fCallback(new Error(`HTTP ${pRes.statusCode}: ${tmpText.slice(0, 400)}`));
						}
						try { return fCallback(null, JSON.parse(tmpText)); }
						catch (pParseErr) { return fCallback(null, { Body: tmpText }); }
					});
			});
		tmpReq.on('error', (pErr) => fCallback(pErr));
		tmpReq.on('timeout', () => { tmpReq.destroy(); fCallback(new Error('HTTP timeout')); });
	}

	listOperations(pInstanceID, fCallback)
	{
		let tmpInstance = this.getInstance(pInstanceID);
		if (!tmpInstance) { return fCallback(new Error('Ultravisor not found.')); }

		let tmpReq = libHttp.get(
			{
				host: '127.0.0.1',
				port: tmpInstance.Port,
				path: '/Operation',
				timeout: 5000
			},
			(pRes) =>
			{
				let tmpChunks = [];
				pRes.on('data', (pChunk) => tmpChunks.push(pChunk));
				pRes.on('end', () =>
					{
						let tmpText = Buffer.concat(tmpChunks).toString('utf8');
						if (pRes.statusCode >= 400)
						{
							return fCallback(new Error(`HTTP ${pRes.statusCode}: ${tmpText.slice(0, 400)}`));
						}
						try { return fCallback(null, JSON.parse(tmpText)); }
						catch (pParseErr) { return fCallback(null, { Body: tmpText }); }
					});
			});
		tmpReq.on('error', (pErr) => fCallback(pErr));
		tmpReq.on('timeout', () => { tmpReq.destroy(); fCallback(new Error('HTTP timeout')); });
	}

	// ── Persistence assignment (Session 3) ──────────────────────────────────

	/**
	 * Inflate the Persistence object the lab UI uses for the status
	 * pill. Combines the lab's row-level assignment (IDPersistenceBeacon
	 * + IDPersistenceConnection) with the live Queue/Manifest state
	 * pulled from the running UV's GET /Ultravisor/Persistence/Status.
	 *
	 * On any UV-side error (not running, unreachable, parse error) the
	 * State degrades to 'waiting-for-beacon' with LastError set so the
	 * pill still renders meaningfully.
	 */
	getInstancePersistence(pInstanceID, fCallback)
	{
		let tmpInstance = this.getInstance(pInstanceID);
		if (!tmpInstance) { return fCallback(new Error('Ultravisor not found.')); }

		let tmpStore = this.fable.LabStateStore;
		let tmpBeaconRecord = (tmpInstance.IDPersistenceBeacon && tmpInstance.IDPersistenceBeacon > 0)
			? tmpStore.getById('Beacon', 'IDBeacon', tmpInstance.IDPersistenceBeacon)
			: null;

		let tmpBaseObject =
		{
			IDPersistenceBeacon: tmpInstance.IDPersistenceBeacon || 0,
			IDPersistenceConnection: tmpInstance.IDPersistenceConnection || 0,
			BeaconRecord: tmpBeaconRecord,
			ConnectionRecord: null,
			Queue: null,
			Manifest: null,
			State: 'unassigned',
			LastError: null,
			BootstrappedAt: null
		};

		// Not running → can't ask the UV; surface the lab-side intent.
		if (tmpInstance.Status !== 'running')
		{
			if (tmpBaseObject.IDPersistenceBeacon > 0)
			{
				tmpBaseObject.State = 'waiting-for-beacon';
				tmpBaseObject.LastError = 'Ultravisor is not running';
			}
			return fCallback(null, tmpBaseObject);
		}

		// Talk to the UV's runtime endpoint.
		let tmpReq = libHttp.get(
			{
				host: '127.0.0.1',
				port: tmpInstance.Port,
				path: '/Ultravisor/Persistence/Status',
				timeout: 2000
			},
			(pRes) =>
			{
				let tmpChunks = [];
				pRes.on('data', (pChunk) => tmpChunks.push(pChunk));
				pRes.on('end', () =>
				{
					let tmpText = Buffer.concat(tmpChunks).toString('utf8');
					if (pRes.statusCode >= 400)
					{
						tmpBaseObject.State = 'waiting-for-beacon';
						tmpBaseObject.LastError = `UV /Ultravisor/Persistence/Status returned ${pRes.statusCode}`;
						return fCallback(null, tmpBaseObject);
					}
					let tmpBody;
					try { tmpBody = JSON.parse(tmpText); }
					catch (pParseErr)
					{
						tmpBaseObject.State = 'waiting-for-beacon';
						tmpBaseObject.LastError = 'UV returned non-JSON status';
						return fCallback(null, tmpBaseObject);
					}
					tmpBaseObject.Queue = tmpBody.Queue || null;
					tmpBaseObject.Manifest = tmpBody.Manifest || null;
					// Aggregate the two states. Both bridges share an
					// assignment, so they're normally in lockstep — but
					// during the bootstrap window one might lead the other.
					// Worst-of-both-states (with explicit precedence) keeps
					// the pill honest.
					tmpBaseObject.State = aggregatePersistenceState(tmpBody.Queue, tmpBody.Manifest);
					tmpBaseObject.LastError = (tmpBody.Queue && tmpBody.Queue.LastError) || (tmpBody.Manifest && tmpBody.Manifest.LastError) || null;
					tmpBaseObject.BootstrappedAt = (tmpBody.Queue && tmpBody.Queue.BootstrappedAt) || null;
					return fCallback(null, tmpBaseObject);
				});
			});
		tmpReq.on('error', (pErr) =>
		{
			tmpBaseObject.State = 'waiting-for-beacon';
			tmpBaseObject.LastError = `UV unreachable: ${pErr.message}`;
			return fCallback(null, tmpBaseObject);
		});
		tmpReq.on('timeout', () =>
		{
			tmpReq.destroy();
			tmpBaseObject.State = 'waiting-for-beacon';
			tmpBaseObject.LastError = 'UV did not respond within 2s';
			return fCallback(null, tmpBaseObject);
		});
	}

	/**
	 * Apply (or clear) the persistence-beacon assignment for a UV.
	 * Updates the lab row, then forwards the assignment to the running
	 * UV's /Ultravisor/Persistence/Assign so the bridges fire their
	 * bootstrap state machine. Pass `pIDBeacon = 0` (or null) to clear.
	 */
	setInstancePersistence(pInstanceID, pIDBeacon, pIDBeaconConnection, fCallback)
	{
		let tmpInstance = this.getInstance(pInstanceID);
		if (!tmpInstance) { return fCallback(new Error('Ultravisor not found.')); }
		if (tmpInstance.Status !== 'running')
		{
			return fCallback(new Error('Ultravisor is not running.'));
		}

		let tmpStore = this.fable.LabStateStore;
		let tmpIDBeacon = parseInt(pIDBeacon, 10) || 0;
		let tmpIDConn = parseInt(pIDBeaconConnection, 10) || 0;

		let tmpBeaconRecord = null;
		if (tmpIDBeacon > 0)
		{
			tmpBeaconRecord = tmpStore.getById('Beacon', 'IDBeacon', tmpIDBeacon);
			if (!tmpBeaconRecord)
			{
				return fCallback(new Error(`Beacon ${tmpIDBeacon} not found.`));
			}
		}

		// 1. Update the lab row.
		tmpStore.update('UltravisorInstance', 'IDUltravisorInstance', pInstanceID,
			{ IDPersistenceBeacon: tmpIDBeacon, IDPersistenceConnection: tmpIDConn });

		// 2. Forward to the UV. The mesh BeaconID is the lab beacon
		//    row's Name (matches addAuthBeacon's convention — see the
		//    Session 3 plan's BeaconID-resolution decision).
		let tmpAssignBody =
		{
			BeaconID: tmpBeaconRecord ? tmpBeaconRecord.Name : null,
			IDBeaconConnection: tmpIDConn
		};
		let tmpPayload = JSON.stringify(tmpAssignBody);
		let tmpReq = libHttp.request(
			{
				host: '127.0.0.1',
				port: tmpInstance.Port,
				path: '/Ultravisor/Persistence/Assign',
				method: 'POST',
				headers:
				{
					'Content-Type': 'application/json',
					'Content-Length': Buffer.byteLength(tmpPayload)
				},
				timeout: 5000
			},
			(pRes) =>
			{
				let tmpChunks = [];
				pRes.on('data', (pChunk) => tmpChunks.push(pChunk));
				pRes.on('end', () =>
				{
					let tmpText = Buffer.concat(tmpChunks).toString('utf8');
					if (pRes.statusCode >= 400)
					{
						return fCallback(new Error(`UV /Ultravisor/Persistence/Assign: HTTP ${pRes.statusCode}: ${tmpText.slice(0, 400)}`));
					}
					tmpStore.recordEvent(
					{
						EntityType: 'UltravisorInstance',
						EntityID: pInstanceID,
						EntityName: tmpInstance.Name,
						EventType: tmpIDBeacon > 0 ? 'persistence-assigned' : 'persistence-cleared',
						Severity: 'info',
						Message: tmpIDBeacon > 0
							? `Persistence routed to beacon ${tmpBeaconRecord.Name} (connection ${tmpIDConn}).`
							: 'Persistence assignment cleared; bridge fell back to local.'
					});
					// Fetch the now-current Persistence object so the
					// caller can return it to the UI.
					return this.getInstancePersistence(pInstanceID, fCallback);
				});
			});
		tmpReq.on('error', (pErr) => fCallback(new Error(`Ultravisor not reachable: ${pErr.message}`)));
		tmpReq.on('timeout', () => { tmpReq.destroy(); fCallback(new Error('HTTP timeout')); });
		tmpReq.write(tmpPayload);
		tmpReq.end();
	}

	/**
	 * Live-fetch the connections list inside a running databeacon.
	 * Used by GET /api/lab/beacons/:id/connections to populate the
	 * second step of the persistence-beacon picker.
	 */
	listBeaconConnections(pBeaconID, fCallback)
	{
		let tmpStore = this.fable.LabStateStore;
		let tmpBeaconRow = tmpStore.getById('Beacon', 'IDBeacon', pBeaconID);
		if (!tmpBeaconRow) { return fCallback(new Error('Beacon not found.')); }
		if (tmpBeaconRow.Status !== 'running')
		{
			return fCallback(new Error('Beacon is not running.'));
		}

		let tmpReq = libHttp.get(
			{
				host: '127.0.0.1',
				port: tmpBeaconRow.Port,
				path: '/beacon/connections',
				timeout: 5000
			},
			(pRes) =>
			{
				let tmpChunks = [];
				pRes.on('data', (pChunk) => tmpChunks.push(pChunk));
				pRes.on('end', () =>
				{
					let tmpText = Buffer.concat(tmpChunks).toString('utf8');
					if (pRes.statusCode >= 400)
					{
						return fCallback(new Error(`HTTP ${pRes.statusCode}: ${tmpText.slice(0, 200)}`));
					}
					try { return fCallback(null, JSON.parse(tmpText)); }
					catch (pParseErr) { return fCallback(new Error('Non-JSON response from databeacon')); }
				});
			});
		tmpReq.on('error', (pErr) => fCallback(new Error(`Beacon not reachable: ${pErr.message}`)));
		tmpReq.on('timeout', () => { tmpReq.destroy(); fCallback(new Error('HTTP timeout')); });
	}
}

// Worst-of-both-states aggregator for the lab's status pill. Order of
// precedence keeps the pill in the most informative state when the two
// bridges briefly disagree during bootstrap.
function aggregatePersistenceState(pQueue, pManifest)
{
	let tmpStates = [pQueue && pQueue.State, pManifest && pManifest.State].filter((s) => !!s);
	if (tmpStates.length === 0) return 'unassigned';
	if (tmpStates.indexOf('error') >= 0) return 'error';
	if (tmpStates.indexOf('waiting-for-beacon') >= 0) return 'waiting-for-beacon';
	if (tmpStates.indexOf('bootstrapping') >= 0) return 'bootstrapping';
	if (tmpStates.every((s) => s === 'bootstrapped')) return 'bootstrapped';
	if (tmpStates.every((s) => s === 'unassigned')) return 'unassigned';
	return tmpStates[0];
}

module.exports = ServiceUltravisorManager;
