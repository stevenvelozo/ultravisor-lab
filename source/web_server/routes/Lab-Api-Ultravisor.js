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
			// getInstancePublic scrubs the BootstrapAuthSecret — never
			// send that down the wire. Internal callers (the auth-beacon
			// spawn flow, the bootstrap-admin flow) use getInstance()
			// directly and read the secret in-process.
			let tmpInstance = tmpUvMgr.getInstancePublic
				? tmpUvMgr.getInstancePublic(tmpID)
				: tmpUvMgr.getInstance(tmpID);
			if (!tmpInstance)
			{
				pRes.send(404, { Error: 'Ultravisor not found.' });
				return pNext();
			}
			// Inflate the Persistence object so the lab's status pill has
			// it on every list-refresh. getInstancePersistence falls back
			// to a stub object on UV-side errors so a stuck UV doesn't
			// hang the response.
			tmpUvMgr.getInstancePersistence(tmpID,
				(pErr, pPersistence) =>
				{
					if (pErr)
					{
						pRes.send({ Instance: tmpInstance });
						return pNext();
					}
					pRes.send({ Instance: tmpInstance, Persistence: pPersistence });
					return pNext();
				});
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

	// One-time admin bootstrap. Body: {Username, Password}.
	// Looks up the instance + its BootstrapAuthSecret, hits the
	// ultravisor's /Beacon/BootstrapAdmin route to mint the first admin,
	// then flips Bootstrapped=true on the instance row so the UI can
	// hide the bootstrap prompt going forward.
	tmpOrator.serviceServer.doPost('/api/lab/ultravisor-instances/:id/bootstrap-admin',
		(pReq, pRes, pNext) =>
		{
			let tmpID = parseInt(pReq.params.id, 10);
			let tmpInstance = tmpUvMgr.getInstance(tmpID);
			if (!tmpInstance)
			{
				pRes.send(404, { Error: 'Ultravisor not found.' });
				return pNext();
			}
			if (!tmpInstance.Secure || !tmpInstance.BootstrapAuthSecret)
			{
				pRes.send(409, { Error: 'Instance is not in Secure mode (no bootstrap secret).' });
				return pNext();
			}
			if (tmpInstance.Bootstrapped)
			{
				pRes.send(409, { Error: 'Bootstrap admin already provisioned for this instance.' });
				return pNext();
			}
			let tmpBody = pReq.body || {};
			let tmpSpec =
			{
				Username: tmpBody.Username || '',
				Password: tmpBody.Password || '',
				Roles:    Array.isArray(tmpBody.Roles) ? tmpBody.Roles : ['admin'],
				FullName: tmpBody.FullName || '',
				Email:    tmpBody.Email || ''
			};
			let tmpPayload = JSON.stringify({ Token: tmpInstance.BootstrapAuthSecret, UserSpec: tmpSpec });
			let libHttp = require('http');
			let tmpReq = libHttp.request(
			{
				hostname: '127.0.0.1',
				port: tmpInstance.Port,
				path: '/Beacon/BootstrapAdmin',
				method: 'POST',
				headers:
				{
					'Content-Type': 'application/json',
					'Content-Length': Buffer.byteLength(tmpPayload)
				}
			}, (pUpRes) =>
			{
				let tmpData = '';
				pUpRes.on('data', (pChunk) => { tmpData += pChunk; });
				pUpRes.on('end', () =>
				{
					let tmpParsed = null;
					try { tmpParsed = JSON.parse(tmpData); }
					catch (pParseErr) { tmpParsed = { Success: false, Reason: 'Non-JSON response', Raw: tmpData }; }
					if (pUpRes.statusCode >= 400 || !tmpParsed.Success)
					{
						pRes.send(pUpRes.statusCode || 400, tmpParsed);
						return pNext();
					}
					// Success — mark Bootstrapped on the row. We DON'T
					// rotate the BootstrapAuthSecret here because:
					//   (a) the auth beacon's MemoryAuthProvider has
					//       already burned its in-memory bootstrap-token
					//       flag (one-shot consumption gate);
					//   (b) the same secret stays valid for OTHER beacons
					//       to present at join time (validateBeaconJoin),
					//       which is independent of the bootstrap path.
					// A separate rotation flow can null it out later if
					// operators want zero-trust after bootstrap.
					pCore.StateStore.update('UltravisorInstance', 'IDUltravisorInstance', tmpID,
						{ Bootstrapped: true });
					pCore.StateStore.recordEvent(
					{
						EntityType: 'UltravisorInstance', EntityID: tmpID, EntityName: tmpInstance.Name,
						EventType: 'ultravisor-bootstrap-admin', Severity: 'info',
						Message: `Bootstrap admin '${tmpSpec.Username}' provisioned for '${tmpInstance.Name}'`
					});
					pRes.send(200, tmpParsed);
					return pNext();
				});
			});
			tmpReq.on('error', (pErr) =>
			{
				pRes.send(502, { Error: 'Ultravisor not reachable: ' + pErr.message });
				return pNext();
			});
			tmpReq.write(tmpPayload);
			tmpReq.end();
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

	// ── Persistence-beacon assignment (Session 3) ───────────────────────
	// POST body: { IDBeacon: <ref> | null, IDBeaconConnection: <num> | 0 }.
	// Updates the lab row and forwards the assignment to the running UV's
	// /Ultravisor/Persistence/Assign so the bridges fire bootstrap.
	tmpOrator.serviceServer.doPost('/api/lab/ultravisor-instances/:id/persistence-beacon',
		(pReq, pRes, pNext) =>
		{
			let tmpID = parseInt(pReq.params.id, 10);
			let tmpInstance = tmpUvMgr.getInstance(tmpID);
			if (!tmpInstance) { pRes.send(404, { Error: 'Ultravisor not found.' }); return pNext(); }
			if (tmpInstance.Status !== 'running')
			{
				pRes.send(409, { Error: 'Ultravisor is not running.' });
				return pNext();
			}
			let tmpBody = pReq.body || {};
			let tmpIDBeacon = (tmpBody.IDBeacon === null || tmpBody.IDBeacon === undefined) ? 0 : parseInt(tmpBody.IDBeacon, 10) || 0;
			let tmpIDConn = parseInt(tmpBody.IDBeaconConnection, 10) || 0;
			tmpUvMgr.setInstancePersistence(tmpID, tmpIDBeacon, tmpIDConn,
				(pErr, pPersistence) =>
				{
					if (pErr) { pRes.send(502, { Error: pErr.message }); return pNext(); }
					pRes.send({ Persistence: pPersistence });
					return pNext();
				});
		});

	// Fast-poll endpoint for the status pill. Decoupled from the
	// list-GET so the pill can refresh every ~2s while in transient
	// states without dragging the heavier list path along.
	tmpOrator.serviceServer.doGet('/api/lab/ultravisor-instances/:id/persistence-status',
		(pReq, pRes, pNext) =>
		{
			let tmpID = parseInt(pReq.params.id, 10);
			tmpUvMgr.getInstancePersistence(tmpID,
				(pErr, pPersistence) =>
				{
					if (pErr) { pRes.send(404, { Error: pErr.message }); return pNext(); }
					pRes.send({ Persistence: pPersistence });
					return pNext();
				});
		});
};
