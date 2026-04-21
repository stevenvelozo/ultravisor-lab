/**
 * Lab-Api-Ultravisor
 *
 * REST surface for supervised Ultravisor instances (each bundled with a
 * meadow-integration sidecar).  See Lab-Api-SeedDatasets for the
 * dataset-oriented operations that run ON an Ultravisor.
 */
'use strict';

const ULTRAVISOR_DEFAULT_START_PORT = 54321;

module.exports = function registerUltravisorRoutes(pCore)
{
	let tmpOrator      = pCore.Orator;
	let tmpUvMgr       = pCore.UltravisorManager;
	let tmpSupervisor  = pCore.Supervisor;
	let tmpAllocator   = pCore.PortAllocator;

	// Next-free-port suggestion for a new Ultravisor.  Registered before
	// `/:id` so the literal segment isn't swallowed by the dynamic route.
	tmpOrator.serviceServer.doGet('/api/lab/ultravisor-instances/next-port',
		(pReq, pRes, pNext) =>
		{
			let tmpStart = ULTRAVISOR_DEFAULT_START_PORT;
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

	tmpOrator.serviceServer.doGet('/api/lab/ultravisor-instances/:id',
		(pReq, pRes, pNext) =>
		{
			let tmpID = parseInt(pReq.params.id, 10);
			let tmpInstance = tmpUvMgr.getInstance(tmpID);
			if (!tmpInstance)
			{
				pRes.send(404, { Error: 'Ultravisor not found.' });
				return pNext();
			}
			pRes.send({ Instance: tmpInstance });
			return pNext();
		});

	tmpOrator.serviceServer.doGet('/api/lab/ultravisor-instances/:id/operations',
		(pReq, pRes, pNext) =>
		{
			let tmpID = parseInt(pReq.params.id, 10);
			tmpUvMgr.listOperations(tmpID,
				(pErr, pResult) =>
				{
					if (pErr) { pRes.send(400, { Error: pErr.message }); return pNext(); }
					pRes.send(pResult);
					return pNext();
				});
		});

	tmpOrator.serviceServer.doPost('/api/lab/ultravisor-instances',
		(pReq, pRes, pNext) =>
		{
			tmpUvMgr.createInstance(pReq.body || {},
				(pErr, pResult) =>
				{
					if (pErr) { pRes.send(400, { Error: pErr.message }); return pNext(); }
					pRes.send(202, pResult);
					return pNext();
				});
		});

	tmpOrator.serviceServer.doPost('/api/lab/ultravisor-instances/:id/start',
		(pReq, pRes, pNext) =>
		{
			tmpUvMgr.startInstance(parseInt(pReq.params.id, 10),
				(pErr, pResult) =>
				{
					if (pErr) { pRes.send(400, { Error: pErr.message }); return pNext(); }
					pRes.send(pResult);
					return pNext();
				});
		});

	tmpOrator.serviceServer.doPost('/api/lab/ultravisor-instances/:id/stop',
		(pReq, pRes, pNext) =>
		{
			tmpUvMgr.stopInstance(parseInt(pReq.params.id, 10),
				(pErr, pResult) =>
				{
					if (pErr) { pRes.send(400, { Error: pErr.message }); return pNext(); }
					pRes.send(pResult);
					return pNext();
				});
		});

	tmpOrator.serviceServer.doDel('/api/lab/ultravisor-instances/:id',
		(pReq, pRes, pNext) =>
		{
			tmpUvMgr.removeInstance(parseInt(pReq.params.id, 10),
				(pErr, pResult) =>
				{
					if (pErr) { pRes.send(400, { Error: pErr.message }); return pNext(); }
					pRes.send(pResult);
					return pNext();
				});
		});

	tmpOrator.serviceServer.doGet('/api/lab/ultravisor-instances/:id/logs',
		(pReq, pRes, pNext) =>
		{
			let tmpID = parseInt(pReq.params.id, 10);
			let tmpLines = 200;
			if (pReq.query && pReq.query.lines)
			{
				let tmpParsed = parseInt(pReq.query.lines, 10);
				if (Number.isFinite(tmpParsed) && tmpParsed > 0) { tmpLines = Math.min(tmpParsed, 2000); }
			}
			pRes.send({ Lines: tmpSupervisor.tailLog('UltravisorInstance', tmpID, tmpLines) });
			return pNext();
		});

	// Fetch a run manifest (status + outputs) for a RunHash on a given Ultravisor.
	tmpOrator.serviceServer.doGet('/api/lab/ultravisor-instances/:id/runs/:run',
		(pReq, pRes, pNext) =>
		{
			tmpUvMgr.getRunManifest(parseInt(pReq.params.id, 10), pReq.params.run,
				(pErr, pResult) =>
				{
					if (pErr) { pRes.send(400, { Error: pErr.message }); return pNext(); }
					pRes.send(pResult);
					return pNext();
				});
		});
};
