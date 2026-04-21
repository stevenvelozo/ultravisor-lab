/**
 * Service-PortAllocator
 *
 * Walks upward from a starting port looking for the next free host port,
 * skipping ports that are either (a) already owned by another lab entity
 * (per the state store) or (b) currently bound at the OS level.  Used by
 * the UI's create forms so prefilled port fields don't collide out of the
 * box.
 *
 * Public surface:
 *   collectUsedPorts()                -> Set<number>
 *   findFreePort(pStart, fCallback)   -> fCallback(pErr, pPort)
 */
'use strict';

const libNet = require('net');
const libFableServiceProviderBase = require('fable-serviceproviderbase');

const DEFAULT_MAX_SCANS = 100;

// Tables whose rows carry a host Port the lab has handed out.  Kept in one
// place so every caller agrees on what "used by lab" means.
const PORTED_ENTITY_TABLES = ['DBEngine', 'UltravisorInstance', 'Beacon', 'FactoInstance'];

class ServicePortAllocator extends libFableServiceProviderBase
{
	constructor(pFable, pOptions, pServiceHash)
	{
		super(pFable, pOptions, pServiceHash);
		this.serviceType = 'LabPortAllocator';

		this.options = this.options || {};
		this.maxScans = Number.isFinite(this.options.MaxScans) && this.options.MaxScans > 0
			? this.options.MaxScans
			: DEFAULT_MAX_SCANS;
	}

	collectUsedPorts()
	{
		let tmpStore = this.fable.LabStateStore;
		let tmpUsed = new Set();
		for (let i = 0; i < PORTED_ENTITY_TABLES.length; i++)
		{
			let tmpRows = tmpStore.list(PORTED_ENTITY_TABLES[i]);
			for (let j = 0; j < tmpRows.length; j++)
			{
				if (tmpRows[j].Port) { tmpUsed.add(tmpRows[j].Port); }
			}
		}
		return tmpUsed;
	}

	findFreePort(pStart, fCallback)
	{
		let tmpStart = parseInt(pStart, 10);
		if (!Number.isFinite(tmpStart) || tmpStart < 1 || tmpStart > 65535)
		{
			return fCallback(new Error('Start port must be between 1 and 65535.'));
		}

		let tmpUsed = this.collectUsedPorts();
		this._walk(tmpStart, tmpUsed, this.maxScans, fCallback);
	}

	_walk(pCandidate, pUsed, pRemaining, fCallback)
	{
		if (pRemaining <= 0)
		{
			return fCallback(new Error('Could not find a free host port after scanning.'));
		}
		if (pCandidate > 65535)
		{
			return fCallback(new Error('Exhausted the port range.'));
		}
		if (pUsed.has(pCandidate))
		{
			return setImmediate(() => this._walk(pCandidate + 1, pUsed, pRemaining - 1, fCallback));
		}

		// OS-level probe: briefly bind to 127.0.0.1:<candidate> and release.
		// Covers ports held by non-lab processes (other docker containers,
		// local DB installs, etc.).
		let tmpServer = libNet.createServer();
		tmpServer.once('error',
			(pErr) =>
			{
				if (pErr.code === 'EADDRINUSE' || pErr.code === 'EACCES')
				{
					return this._walk(pCandidate + 1, pUsed, pRemaining - 1, fCallback);
				}
				return fCallback(pErr);
			});
		tmpServer.once('listening',
			() =>
			{
				tmpServer.close(() => fCallback(null, pCandidate));
			});
		tmpServer.listen(pCandidate, '127.0.0.1');
	}
}

module.exports = ServicePortAllocator;
