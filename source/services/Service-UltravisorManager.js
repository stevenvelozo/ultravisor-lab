/**
 * Service-UltravisorManager
 *
 * Spawns and supervises `lab-ultravisor.js` child processes.  Each
 * UltravisorInstance row corresponds to one child process running an
 * Ultravisor API server on the row's port.  Beacons (including
 * meadow-integration) are their own entity (Beacon) managed by
 * Service-BeaconManager and created separately via the Beacons page.
 *
 * The per-instance data layout on disk:
 *   data/ultravisors/<id>/
 *     config.json                  -- spawn config (port, dirs)
 *     logs/ (via ProcessSupervisor)
 *     ultravisor_datastore/        -- Ultravisor's own state
 *     ultravisor_staging/
 *     operations/                  -- operation JSONs auto-loaded at boot
 */
'use strict';

const libPath = require('path');
const libFs = require('fs');
const libHttp = require('http');
const libFableServiceProviderBase = require('fable-serviceproviderbase');

const HEALTH_POLL_MAX_ATTEMPTS = 60;  // 60 * 1s = 60s budget
const HEALTH_POLL_INTERVAL_MS  = 1000;

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

	// ── Create ───────────────────────────────────────────────────────────────
	/**
	 * pRequest = { Name, Port }
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

		let tmpID = tmpStore.insert('UltravisorInstance',
			{
				Name:         tmpName,
				Port:         tmpPort,
				Status:       'provisioning',
				StatusDetail: 'Preparing spawn...',
				ConfigPath:   ''
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

		let tmpConfig =
		{
			Port:        tmpPort,
			LibraryDir:  this.operationLibraryDir(tmpID),
			DataDir:     this._instanceDir(tmpID)
		};
		let tmpConfigPath = libPath.join(this._instanceDir(tmpID), 'config.json');
		try
		{
			libFs.writeFileSync(tmpConfigPath, JSON.stringify(tmpConfig, null, 2));
		}
		catch (pWriteErr)
		{
			this._markFailed(tmpID, tmpName, pWriteErr.message);
			return fCallback(pWriteErr);
		}

		tmpStore.update('UltravisorInstance', 'IDUltravisorInstance', tmpID,
			{ ConfigPath: tmpConfigPath, StatusDetail: 'Installing seed dataset operations...' });

		// Pre-populate the operation library with all seed datasets so the
		// Ultravisor picks them up on its startup scan.  This also leaves the
		// operation JSONs visible on disk for users who want to inspect them.
		if (this.fable.LabSeedDatasetManager && typeof this.fable.LabSeedDatasetManager.provisionOperationsForUltravisor === 'function')
		{
			try { this.fable.LabSeedDatasetManager.provisionOperationsForUltravisor(tmpID); }
			catch (pProvErr) { this.fable.log.warn(`UltravisorManager: seed provisioning warning: ${pProvErr.message}`); }
		}

		tmpStore.update('UltravisorInstance', 'IDUltravisorInstance', tmpID,
			{ StatusDetail: 'Spawning Ultravisor...' });

		let tmpBinPath = libPath.resolve(__dirname, '..', '..', 'bin', 'lab-ultravisor.js');
		let tmpPid;
		try
		{
			tmpPid = this.fable.LabProcessSupervisor.spawn('UltravisorInstance', tmpID,
				{
					Command: process.execPath,
					Args:
					[
						tmpBinPath,
						'--port',         String(tmpPort),
						'--library-dir',  this.operationLibraryDir(tmpID),
						'--data-dir',     this._instanceDir(tmpID)
					],
					Cwd: this._instanceDir(tmpID),
					Env: Object.assign({}, process.env)
				});
		}
		catch (pSpawnErr)
		{
			this._markFailed(tmpID, tmpName, pSpawnErr.message);
			return fCallback(pSpawnErr);
		}

		tmpStore.update('UltravisorInstance', 'IDUltravisorInstance', tmpID,
			{ PID: tmpPid, StatusDetail: 'Waiting for Ultravisor API...' });

		this._waitForHttp(tmpPort, 0, (pReady) =>
			{
				if (!pReady)
				{
					this._markFailed(tmpID, tmpName, 'Ultravisor API did not come up');
					return;
				}
				tmpStore.update('UltravisorInstance', 'IDUltravisorInstance', tmpID,
					{ Status: 'running', StatusDetail: '' });
				tmpStore.recordEvent(
					{
						EntityType: 'UltravisorInstance', EntityID: tmpID, EntityName: tmpName,
						EventType: 'ultravisor-ready', Severity: 'info',
						Message: `Ultravisor '${tmpName}' ready on port ${tmpPort}`
					});
			});

		return fCallback(null, { IDUltravisorInstance: tmpID, PID: tmpPid, Status: 'provisioning' });
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

		let tmpBinPath = libPath.resolve(__dirname, '..', '..', 'bin', 'lab-ultravisor.js');
		let tmpConfigPath = tmpInstance.ConfigPath;
		let tmpConfig = {};
		try { tmpConfig = JSON.parse(libFs.readFileSync(tmpConfigPath, 'utf8')); }
		catch (pErr) { return fCallback(new Error(`Could not read ultravisor config: ${pErr.message}`)); }

		let tmpPid;
		try
		{
			tmpPid = this.fable.LabProcessSupervisor.spawn('UltravisorInstance', pID,
				{
					Command: process.execPath,
					Args:
					[
						tmpBinPath,
						'--port',         String(tmpConfig.Port || tmpInstance.Port),
						'--library-dir',  tmpConfig.LibraryDir || this.operationLibraryDir(pID),
						'--data-dir',     tmpConfig.DataDir    || this._instanceDir(pID)
					],
					Cwd: this._instanceDir(pID),
					Env: Object.assign({}, process.env)
				});
		}
		catch (pSpawnErr) { return fCallback(pSpawnErr); }

		this.fable.LabStateStore.update('UltravisorInstance', 'IDUltravisorInstance', pID,
			{ PID: tmpPid, Status: 'starting', StatusDetail: 'Waiting for Ultravisor API...' });

		this._waitForHttp(tmpInstance.Port, 0, (pReady) =>
			{
				if (pReady)
				{
					this.fable.LabStateStore.update('UltravisorInstance', 'IDUltravisorInstance', pID,
						{ Status: 'running', StatusDetail: '' });
				}
				else
				{
					this._markFailed(pID, tmpInstance.Name, 'Ultravisor API did not come up');
				}
			});

		return fCallback(null, { PID: tmpPid, Status: 'starting' });
	}

	stopInstance(pID, fCallback)
	{
		let tmpInstance = this.getInstance(pID);
		if (!tmpInstance) { return fCallback(new Error('Ultravisor not found.')); }

		this.fable.LabStateStore.update('UltravisorInstance', 'IDUltravisorInstance', pID,
			{ Status: 'stopping', StatusDetail: '' });

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

		tmpCascade(() =>
			{
				this.fable.LabProcessSupervisor.stop('UltravisorInstance', pID, () =>
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
					});
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
}

module.exports = ServiceUltravisorManager;
