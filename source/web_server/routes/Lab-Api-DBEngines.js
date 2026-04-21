/**
 * Lab-Api-DBEngines
 *
 * Engine + database CRUD endpoints consumed by PictView-Lab-DBEngines.
 *
 * Routes:
 *   GET    /api/lab/db-engine-types                  -- engine registry metadata
 *   GET    /api/lab/db-engines/:id                   -- engine + databases
 *   POST   /api/lab/db-engines                       -- create (async health polling)
 *   POST   /api/lab/db-engines/:id/start
 *   POST   /api/lab/db-engines/:id/stop
 *   DELETE /api/lab/db-engines/:id
 *   GET    /api/lab/db-engines/:id/connection-info
 *   POST   /api/lab/db-engines/:id/databases         -- create database inside engine
 *   DELETE /api/lab/db-engines/:id/databases/:dbid
 *
 * Note: the Phase-1 generic list endpoint at `/api/lab/db-engines` (from
 * Lab-Api-Entities.js) still handles the list case.
 */
'use strict';

module.exports = function registerDBEngineRoutes(pCore)
{
	let tmpOrator    = pCore.Orator;
	let tmpEngineMgr = pCore.EngineManager;

	// Engine registry (for the "Add Engine" form)
	tmpOrator.serviceServer.doGet('/api/lab/db-engine-types',
		(pReq, pRes, pNext) =>
		{
			pRes.send({ EngineTypes: tmpEngineMgr.listEngineTypes() });
			return pNext();
		});

	// Next-free-host-port suggestion: walks upward from the adapter's
	// SuggestedHostPort, skipping ports owned by other lab entities or held
	// by the OS.  The UI hits this each time the form opens or the engine
	// type changes so the prefilled port never collides.
	tmpOrator.serviceServer.doGet('/api/lab/db-engine-types/:engineType/next-port',
		(pReq, pRes, pNext) =>
		{
			tmpEngineMgr.suggestHostPort(pReq.params.engineType,
				(pErr, pPort) =>
				{
					if (pErr) { pRes.send(400, { Error: pErr.message }); return pNext(); }
					pRes.send({ Port: pPort });
					return pNext();
				});
		});

	// Single engine + child databases + connection info
	tmpOrator.serviceServer.doGet('/api/lab/db-engines/:id',
		(pReq, pRes, pNext) =>
		{
			let tmpID = parseInt(pReq.params.id, 10);
			let tmpEngine = tmpEngineMgr.getEngine(tmpID);
			if (!tmpEngine)
			{
				pRes.send(404, { Error: 'Engine not found.' });
				return pNext();
			}
			pRes.send(
				{
					Engine:           tmpEngine,
					Databases:        tmpEngineMgr.listDatabasesForEngine(tmpID),
					ConnectionInfo:   tmpEngineMgr.connectionInfo(tmpID)
				});
			return pNext();
		});

	tmpOrator.serviceServer.doGet('/api/lab/db-engines/:id/connection-info',
		(pReq, pRes, pNext) =>
		{
			let tmpID = parseInt(pReq.params.id, 10);
			let tmpInfo = tmpEngineMgr.connectionInfo(tmpID);
			if (!tmpInfo)
			{
				pRes.send(404, { Error: 'Engine not found.' });
				return pNext();
			}
			pRes.send(tmpInfo);
			return pNext();
		});

	// Create engine -- async health polling; returns immediately in `provisioning`.
	tmpOrator.serviceServer.doPost('/api/lab/db-engines',
		(pReq, pRes, pNext) =>
		{
			let tmpBody = pReq.body || {};
			tmpEngineMgr.createEngine(tmpBody,
				(pErr, pResult) =>
				{
					if (pErr)
					{
						pRes.send(400, { Error: pErr.message });
						return pNext();
					}
					pRes.send(202, pResult);
					return pNext();
				});
		});

	tmpOrator.serviceServer.doPost('/api/lab/db-engines/:id/start',
		(pReq, pRes, pNext) =>
		{
			let tmpID = parseInt(pReq.params.id, 10);
			tmpEngineMgr.startEngine(tmpID,
				(pErr, pResult) =>
				{
					if (pErr)
					{
						pRes.send(400, { Error: pErr.message });
						return pNext();
					}
					pRes.send(pResult);
					return pNext();
				});
		});

	tmpOrator.serviceServer.doPost('/api/lab/db-engines/:id/stop',
		(pReq, pRes, pNext) =>
		{
			let tmpID = parseInt(pReq.params.id, 10);
			tmpEngineMgr.stopEngine(tmpID,
				(pErr, pResult) =>
				{
					if (pErr)
					{
						pRes.send(400, { Error: pErr.message });
						return pNext();
					}
					pRes.send(pResult);
					return pNext();
				});
		});

	tmpOrator.serviceServer.doDel('/api/lab/db-engines/:id',
		(pReq, pRes, pNext) =>
		{
			let tmpID = parseInt(pReq.params.id, 10);
			tmpEngineMgr.removeEngine(tmpID,
				(pErr, pResult) =>
				{
					if (pErr)
					{
						pRes.send(400, { Error: pErr.message });
						return pNext();
					}
					pRes.send(pResult);
					return pNext();
				});
		});

	// Databases inside an engine
	tmpOrator.serviceServer.doPost('/api/lab/db-engines/:id/databases',
		(pReq, pRes, pNext) =>
		{
			let tmpID = parseInt(pReq.params.id, 10);
			let tmpBody = pReq.body || {};
			tmpEngineMgr.createDatabase(tmpID, tmpBody.Name,
				(pErr, pResult) =>
				{
					if (pErr)
					{
						pRes.send(400, { Error: pErr.message });
						return pNext();
					}
					pRes.send(201, pResult);
					return pNext();
				});
		});

	tmpOrator.serviceServer.doDel('/api/lab/db-engines/:id/databases/:dbid',
		(pReq, pRes, pNext) =>
		{
			let tmpID   = parseInt(pReq.params.id, 10);
			let tmpDbID = parseInt(pReq.params.dbid, 10);
			tmpEngineMgr.dropDatabase(tmpID, tmpDbID,
				(pErr, pResult) =>
				{
					if (pErr)
					{
						pRes.send(400, { Error: pErr.message });
						return pNext();
					}
					pRes.send(pResult);
					return pNext();
				});
		});
};
