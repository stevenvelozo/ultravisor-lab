/**
 * Service-BeaconManager
 *
 * Generic lifecycle manager for every row in the Beacon table.  Dispatches
 * to one of two spawn strategies based on the type descriptor from
 * Service-BeaconTypeRegistry:
 *
 *   standalone-service   -- run the module's own bin, pointed at the
 *                           user's saved ConfigJSON (written to disk so
 *                           the module can consume it in its native form).
 *   capability-provider  -- run the lab's lab-beacon-host.js, which loads
 *                           the module's CapabilityProvider class and
 *                           registers it with the target Ultravisor.
 *
 * Data layout:
 *   data/beacons/<id>/
 *     config.json                 -- ConfigJSON persisted to disk (fed to
 *                                    the module via argTemplate)
 *     logs/ (via ProcessSupervisor)
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

		let tmpID = tmpStore.insert('Beacon',
			{
				Name:                 tmpName,
				BeaconType:           tmpType.BeaconType,
				Port:                 tmpPort,
				IDUltravisorInstance: tmpUvID,
				ConfigJSON:           JSON.stringify(tmpConfig),
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
			{ ConfigPath: tmpConfigPath, StatusDetail: 'Spawning beacon...' });

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

		return fCallback(null, { IDBeacon: tmpID, PID: tmpPid, Status: 'provisioning' });
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
		let tmpTokens =
		{
			Port:          pPort,
			BeaconName:    pName,
			BeaconDir:     this._beaconDir(pID),
			UltravisorURL: pInstance ? `http://127.0.0.1:${pInstance.Port}` : '',
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
			if (!pType.ProviderPath) { throw new Error(`Type '${pType.BeaconType}' has no provider path.`); }
			if (!pInstance) { throw new Error(`capability-provider mode requires a target Ultravisor.`); }

			let tmpHost = libPath.resolve(__dirname, '..', '..', 'bin', 'lab-beacon-host.js');
			let tmpArgs =
			[
				tmpHost,
				'--port',            String(pPort),
				'--beacon-name',     pName,
				'--ultravisor-url',  `http://127.0.0.1:${pInstance.Port}`,
				'--provider',        `${pType.BeaconType}:${pType.ProviderPath}`,
				'--config',          pConfigPath
			];
			return { Command: process.execPath, Args: tmpArgs };
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

		this.fable.LabProcessSupervisor.stop('Beacon', pID, () =>
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
			});
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
