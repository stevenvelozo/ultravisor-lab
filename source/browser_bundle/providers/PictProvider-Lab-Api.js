/**
 * PictProvider-Lab-Api
 *
 * Thin fetch wrapper for the ultravisor-lab REST surface.  Views use this
 * through `pict.providers.LabApi` so they never have to remember paths or
 * error-handling rituals.
 */
'use strict';

const libFableServiceProviderBase = require('fable-serviceproviderbase');

const _DefaultProviderConfiguration =
{
	ProviderIdentifier: 'LabApi'
};

function _request(pMethod, pPath, pBody, fCallback)
{
	let tmpOptions =
	{
		method: pMethod,
		headers: { 'Accept': 'application/json' }
	};
	if (pBody)
	{
		tmpOptions.headers['Content-Type'] = 'application/json';
		tmpOptions.body = JSON.stringify(pBody);
	}

	fetch(pPath, tmpOptions)
		.then(function (pRes)
			{
				if (!pRes.ok)
				{
					return pRes.text().then(function (pText)
						{
							let tmpMsg;
							try { tmpMsg = JSON.parse(pText); } catch (e) { tmpMsg = { Error: pText }; }
							return fCallback(new Error(tmpMsg.Error || ('HTTP ' + pRes.status)));
						});
				}
				return pRes.json().then(function (pJson) { return fCallback(null, pJson); });
			})
		.catch(function (pErr) { return fCallback(pErr); });
}

class LabApiProvider extends libFableServiceProviderBase
{
	constructor(pFable, pOptions, pServiceHash)
	{
		super(pFable, pOptions, pServiceHash);
		this.serviceType = 'LabApi';
	}

	getStatus(fCallback)
	{
		return _request('GET', '/api/lab/status', null, fCallback);
	}

	getEvents(pLimit, fCallback)
	{
		let tmpPath = '/api/lab/events';
		if (pLimit && pLimit > 0) { tmpPath += '?limit=' + pLimit; }
		return _request('GET', tmpPath, null, fCallback);
	}

	reconcileNow(fCallback)
	{
		return _request('POST', '/api/lab/reconcile', {}, fCallback);
	}

	teardown(fCallback)
	{
		return _request('POST', '/api/lab/teardown', {}, fCallback);
	}

	listEntities(pEntityRoute, fCallback)
	{
		return _request('GET', '/api/lab/' + pEntityRoute, null, fCallback);
	}

	// ── DB Engines ───────────────────────────────────────────────────────────

	getEngineTypes(fCallback)
	{
		return _request('GET', '/api/lab/db-engine-types', null, fCallback);
	}

	getNextEnginePort(pEngineType, fCallback)
	{
		return _request('GET', '/api/lab/db-engine-types/' + encodeURIComponent(pEngineType) + '/next-port', null, fCallback);
	}

	listEngines(fCallback)
	{
		return _request('GET', '/api/lab/db-engines', null, fCallback);
	}

	getEngine(pID, fCallback)
	{
		return _request('GET', '/api/lab/db-engines/' + pID, null, fCallback);
	}

	createEngine(pRequest, fCallback)
	{
		return _request('POST', '/api/lab/db-engines', pRequest, fCallback);
	}

	startEngine(pID, fCallback)
	{
		return _request('POST', '/api/lab/db-engines/' + pID + '/start', {}, fCallback);
	}

	stopEngine(pID, fCallback)
	{
		return _request('POST', '/api/lab/db-engines/' + pID + '/stop', {}, fCallback);
	}

	removeEngine(pID, fCallback)
	{
		return _request('DELETE', '/api/lab/db-engines/' + pID, null, fCallback);
	}

	createDatabase(pEngineID, pName, fCallback)
	{
		return _request('POST', '/api/lab/db-engines/' + pEngineID + '/databases', { Name: pName }, fCallback);
	}

	dropDatabase(pEngineID, pDatabaseID, fCallback)
	{
		return _request('DELETE', '/api/lab/db-engines/' + pEngineID + '/databases/' + pDatabaseID, null, fCallback);
	}

	// ── Ultravisor instances ────────────────────────────────────────────────

	listUltravisorInstances(fCallback) { return _request('GET', '/api/lab/ultravisor-instances', null, fCallback); }
	createUltravisor(pBody, fCallback) { return _request('POST', '/api/lab/ultravisor-instances', pBody, fCallback); }
	startUltravisor(pID, fCallback) { return _request('POST', '/api/lab/ultravisor-instances/' + pID + '/start', {}, fCallback); }
	stopUltravisor(pID, fCallback)  { return _request('POST', '/api/lab/ultravisor-instances/' + pID + '/stop',  {}, fCallback); }
	removeUltravisor(pID, fCallback) { return _request('DELETE', '/api/lab/ultravisor-instances/' + pID, null, fCallback); }
	getNextUltravisorPort(fCallback) { return _request('GET', '/api/lab/ultravisor-instances/next-port', null, fCallback); }

	// ── Beacons (unified; any registered BeaconType) ────────────────────────

	getBeaconTypes(fCallback) { return _request('GET', '/api/lab/beacon-types', null, fCallback); }
	listBeacons(fCallback) { return _request('GET', '/api/lab/beacons', null, fCallback); }
	createBeacon(pBody, fCallback) { return _request('POST', '/api/lab/beacons', pBody, fCallback); }
	startBeacon(pID, fCallback) { return _request('POST', '/api/lab/beacons/' + pID + '/start', {}, fCallback); }
	stopBeacon(pID, fCallback)  { return _request('POST', '/api/lab/beacons/' + pID + '/stop',  {}, fCallback); }
	removeBeacon(pID, fCallback) { return _request('DELETE', '/api/lab/beacons/' + pID, null, fCallback); }
	rebuildBeaconImage(pID, fCallback) { return _request('POST', '/api/lab/beacons/' + pID + '/rebuild', {}, fCallback); }
	switchBeaconBuildSource(pID, pBuildSource, fCallback) { return _request('POST', '/api/lab/beacons/' + pID + '/build-source', { BuildSource: pBuildSource }, fCallback); }
	getBeaconLogs(pID, pLines, fCallback)
	{
		let tmpCallback = fCallback;
		let tmpLines = pLines;
		if (typeof pLines === 'function') { tmpCallback = pLines; tmpLines = null; }
		let tmpPath = '/api/lab/beacons/' + pID + '/logs';
		if (tmpLines) { tmpPath += '?lines=' + encodeURIComponent(tmpLines); }
		return _request('GET', tmpPath, null, tmpCallback);
	}
	getEngineLogs(pID, pLines, fCallback)
	{
		let tmpCallback = fCallback;
		let tmpLines = pLines;
		if (typeof pLines === 'function') { tmpCallback = pLines; tmpLines = null; }
		let tmpPath = '/api/lab/db-engines/' + pID + '/logs';
		if (tmpLines) { tmpPath += '?lines=' + encodeURIComponent(tmpLines); }
		return _request('GET', tmpPath, null, tmpCallback);
	}
	getNextBeaconPort(pStart, fCallback)
	{
		// Two call shapes for convenience: `getNextBeaconPort(cb)` or
		// `getNextBeaconPort(startPort, cb)`.
		let tmpCallback = fCallback;
		let tmpStart = pStart;
		if (typeof pStart === 'function') { tmpCallback = pStart; tmpStart = null; }
		let tmpPath = '/api/lab/beacons/next-port';
		if (tmpStart) { tmpPath += '?start=' + encodeURIComponent(tmpStart); }
		return _request('GET', tmpPath, null, tmpCallback);
	}

	// ── Seed datasets ───────────────────────────────────────────────────────

	getSeedDatasets(fCallback) { return _request('GET', '/api/lab/seed-datasets', null, fCallback); }
	runSeedDataset(pHash, pBody, fCallback)
	{
		return _request('POST', '/api/lab/seed-datasets/' + pHash + '/run', pBody, fCallback);
	}
	seedDatasetToEngine(pHash, pBody, fCallback)
	{
		return _request('POST', '/api/lab/seed-datasets/' + pHash + '/seed-to-engine', pBody, fCallback);
	}

	listIngestionJobs(fCallback) { return _request('GET', '/api/lab/ingestion-jobs', null, fCallback); }
}

module.exports = LabApiProvider;
module.exports.default_configuration = _DefaultProviderConfiguration;
