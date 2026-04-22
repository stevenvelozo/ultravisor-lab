/**
 * Lab-Api-Beacons
 *
 * REST surface for the unified Beacon table.  Any beacon type registered
 * via Service-BeaconTypeRegistry (retoldBeacon stanzas in package.json)
 * is createable through these routes; spawn + config handling is
 * dispatched inside Service-BeaconManager based on the type descriptor.
 *
 * Routes:
 *   GET    /api/lab/beacon-types              -- registered types + their forms
 *   GET    /api/lab/beacons/next-port         -- next free host port for a new beacon
 *   GET    /api/lab/beacons/:id               -- single beacon + paired UV
 *   POST   /api/lab/beacons                   -- create
 *   POST   /api/lab/beacons/:id/start
 *   POST   /api/lab/beacons/:id/stop
 *   DELETE /api/lab/beacons/:id
 *   GET    /api/lab/beacons/:id/logs          -- tail supervised log file
 *
 * The list endpoint /api/lab/beacons is registered by Lab-Api-Entities.
 */
'use strict';

const BEACON_DEFAULT_START_PORT = 8500;

module.exports = function registerBeaconRoutes(pCore)
{
	let tmpOrator      = pCore.Orator;
	let tmpMgr         = pCore.BeaconManager;
	let tmpRegistry    = pCore.BeaconTypeRegistry;
	let tmpUvMgr       = pCore.UltravisorManager;
	let tmpAllocator   = pCore.PortAllocator;
	let tmpSupervisor  = pCore.Supervisor;
	let tmpContainer   = pCore.BeaconContainerManager;

	tmpOrator.serviceServer.doGet('/api/lab/beacon-types',
		(pReq, pRes, pNext) =>
		{
			let tmpList = tmpRegistry.list().map((pEntry) => tmpRegistry.publicDescriptor(pEntry));
			pRes.send({ BeaconTypes: tmpList });
			return pNext();
		});

	// next-port registered before `/:id` so the literal segment isn't caught
	// by the dynamic param route.
	tmpOrator.serviceServer.doGet('/api/lab/beacons/next-port',
		(pReq, pRes, pNext) =>
		{
			let tmpStart = BEACON_DEFAULT_START_PORT;
			if (pReq.query && pReq.query.start)
			{
				let tmpParsed = parseInt(pReq.query.start, 10);
				if (Number.isFinite(tmpParsed) && tmpParsed > 0) { tmpStart = tmpParsed; }
			}
			tmpAllocator.findFreePort(tmpStart,
				(pErr, pPort) =>
				{
					if (pErr) { pRes.send(400, { Error: pErr.message }); return pNext(); }
					pRes.send({ Port: pPort });
					return pNext();
				});
		});

	tmpOrator.serviceServer.doGet('/api/lab/beacons/:id',
		(pReq, pRes, pNext) =>
		{
			let tmpID = parseInt(pReq.params.id, 10);
			let tmpBeacon = tmpMgr.getBeacon(tmpID);
			if (!tmpBeacon) { pRes.send(404, { Error: 'Beacon not found.' }); return pNext(); }
			let tmpInstance = tmpBeacon.IDUltravisorInstance ? tmpUvMgr.getInstance(tmpBeacon.IDUltravisorInstance) : null;
			pRes.send({ Beacon: tmpBeacon, Ultravisor: tmpInstance });
			return pNext();
		});

	tmpOrator.serviceServer.doPost('/api/lab/beacons',
		(pReq, pRes, pNext) =>
		{
			tmpMgr.createBeacon(pReq.body || {},
				(pErr, pResult) =>
				{
					if (pErr) { pRes.send(400, { Error: pErr.message }); return pNext(); }
					pRes.send(202, pResult);
					return pNext();
				});
		});

	tmpOrator.serviceServer.doPost('/api/lab/beacons/:id/start',
		(pReq, pRes, pNext) =>
		{
			tmpMgr.startBeacon(parseInt(pReq.params.id, 10),
				(pErr, pResult) =>
				{
					if (pErr) { pRes.send(400, { Error: pErr.message }); return pNext(); }
					pRes.send(pResult);
					return pNext();
				});
		});

	tmpOrator.serviceServer.doPost('/api/lab/beacons/:id/stop',
		(pReq, pRes, pNext) =>
		{
			tmpMgr.stopBeacon(parseInt(pReq.params.id, 10),
				(pErr, pResult) =>
				{
					if (pErr) { pRes.send(400, { Error: pErr.message }); return pNext(); }
					pRes.send(pResult);
					return pNext();
				});
		});

	tmpOrator.serviceServer.doDel('/api/lab/beacons/:id',
		(pReq, pRes, pNext) =>
		{
			tmpMgr.removeBeacon(parseInt(pReq.params.id, 10),
				(pErr, pResult) =>
				{
					if (pErr) { pRes.send(400, { Error: pErr.message }); return pNext(); }
					pRes.send(pResult);
					return pNext();
				});
		});

	tmpOrator.serviceServer.doGet('/api/lab/beacons/:id/logs',
		(pReq, pRes, pNext) =>
		{
			let tmpID = parseInt(pReq.params.id, 10);
			let tmpBeacon = tmpMgr.getBeacon(tmpID);
			if (!tmpBeacon) { pRes.send(404, { Error: 'Beacon not found.' }); return pNext(); }

			let tmpLines = 500;
			if (pReq.query && pReq.query.lines)
			{
				let tmpParsed = parseInt(pReq.query.lines, 10);
				if (Number.isFinite(tmpParsed) && tmpParsed > 0) { tmpLines = Math.min(tmpParsed, 5000); }
			}

			// Container-backed beacons surface logs via `docker logs`.
			// Process-backed beacons surface via the supervisor's file tail.
			// Either way we return the same { Runtime, Lines, Source } shape
			// so the UI doesn't care which path served it.
			if (tmpBeacon.Runtime === 'container' && tmpBeacon.ContainerID)
			{
				return tmpContainer.logs(tmpBeacon.ContainerID, tmpLines,
					(pLogErr, pLogResult) =>
					{
						if (pLogErr)
						{
							pRes.send(400, { Error: pLogErr.message, Runtime: 'container', Lines: [], Source: 'docker' });
							return pNext();
						}
						// docker returns separate stdout / stderr streams; most
						// image entrypoints go to stdout, error traces to stderr.
						// Interleave them in a single flat list the UI can render.
						let tmpLinesOut = [];
						if (pLogResult.Stdout) { tmpLinesOut = tmpLinesOut.concat(pLogResult.Stdout.split('\n')); }
						if (pLogResult.Stderr) { tmpLinesOut = tmpLinesOut.concat(pLogResult.Stderr.split('\n')); }
						// Trim trailing blank line introduced by split().
						while (tmpLinesOut.length > 0 && tmpLinesOut[tmpLinesOut.length - 1] === '')
						{
							tmpLinesOut.pop();
						}
						pRes.send({ Runtime: 'container', Lines: tmpLinesOut, Source: 'docker', ContainerID: tmpBeacon.ContainerID, ContainerName: tmpBeacon.ContainerName });
						return pNext();
					});
			}

			let tmpPath = tmpSupervisor.logFilePath('Beacon', tmpID);
			pRes.send({ Runtime: 'process', Lines: tmpSupervisor.tailLog('Beacon', tmpID, tmpLines), Source: tmpPath });
			return pNext();
		});
};
