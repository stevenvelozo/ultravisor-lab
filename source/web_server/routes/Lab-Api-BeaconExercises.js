/**
 * Lab-Api-BeaconExercises
 *
 * REST surface for the queue-testing harness: catalog of scenarios,
 * run-trigger flow, run history, and the per-run event timeline.
 */
'use strict';

const libHttp = require('http');

module.exports = function registerBeaconExerciseRoutes(pCore)
{
	let tmpOrator = pCore.Orator;
	let tmpScenarioMgr = pCore.BeaconExerciseManager;
	let tmpUVManager = pCore.UltravisorManager;

	tmpOrator.serviceServer.doGet('/api/lab/beacon-exercises',
		(pReq, pRes, pNext) =>
		{
			pRes.send({ Scenarios: tmpScenarioMgr.list() });
			return pNext();
		});

	tmpOrator.serviceServer.doGet('/api/lab/beacon-exercises/:hash',
		(pReq, pRes, pNext) =>
		{
			let tmpScenario = tmpScenarioMgr.get(pReq.params.hash);
			if (!tmpScenario)
			{
				pRes.send(404, { Error: 'Scenario not found.' });
				return pNext();
			}
			pRes.send(tmpScenario);
			return pNext();
		});

	tmpOrator.serviceServer.doPost('/api/lab/beacon-exercises/:hash/run',
		(pReq, pRes, pNext) =>
		{
			let tmpBody = pReq.body || {};
			tmpScenarioMgr.run(pReq.params.hash,
				{ IDUltravisorInstance: tmpBody.IDUltravisorInstance },
				(pErr, pResult) =>
				{
					if (pErr) { pRes.send(400, { Error: pErr.message }); return pNext(); }
					pRes.send(202, pResult);
					return pNext();
				});
		});

	tmpOrator.serviceServer.doGet('/api/lab/beacon-exercise-runs',
		(pReq, pRes, pNext) =>
		{
			pRes.send({ Runs: tmpScenarioMgr.listRuns() });
			return pNext();
		});

	tmpOrator.serviceServer.doGet('/api/lab/beacon-exercise-runs/:id',
		(pReq, pRes, pNext) =>
		{
			let tmpRun = tmpScenarioMgr.getRun(pReq.params.id);
			if (!tmpRun) { pRes.send(404, { Error: 'Run not found.' }); return pNext(); }
			// Inflate the JSON columns so consumers don't have to re-parse.
			let tmpVerdicts = null;
			let tmpTiming = null;
			try { tmpVerdicts = tmpRun.VerdictsJSON ? JSON.parse(tmpRun.VerdictsJSON) : null; } catch (pErr) { /* leave null */ }
			try { tmpTiming = tmpRun.TimingJSON ? JSON.parse(tmpRun.TimingJSON) : null; } catch (pErr) { /* leave null */ }
			pRes.send(Object.assign({}, tmpRun, { Verdicts: tmpVerdicts, Timing: tmpTiming }));
			return pNext();
		});

	tmpOrator.serviceServer.doGet('/api/lab/beacon-exercise-runs/:id/events',
		(pReq, pRes, pNext) =>
		{
			let tmpEvents = tmpScenarioMgr.listRunEvents(pReq.params.id,
				{ offset: pReq.query && pReq.query.offset, limit: pReq.query && pReq.query.limit });
			pRes.send({ Events: tmpEvents });
			return pNext();
		});

	tmpOrator.serviceServer.doPost('/api/lab/beacon-exercise-runs/:id/cancel',
		(pReq, pRes, pNext) =>
		{
			tmpScenarioMgr.cancelRun(pReq.params.id, (pErr, pResult) =>
				{
					if (pErr) { pRes.send(400, { Error: pErr.message }); return pNext(); }
					pRes.send(202, pResult);
					return pNext();
				});
		});

	// Live queue snapshot: a thin proxy to the target UV's /Beacon/Queue
	// endpoint.  The browser polls this from the Beacon Exercises view to show
	// live status counts; routing through lab avoids the cross-origin
	// hop from the lab's port (44443) to a UV's port (54321 etc).
	tmpOrator.serviceServer.doGet('/api/lab/ultravisor-instances/:id/queue-snapshot',
		(pReq, pRes, pNext) =>
		{
			let tmpID = parseInt(pReq.params.id, 10);
			let tmpInstance = tmpUVManager && tmpUVManager.getInstance ? tmpUVManager.getInstance(tmpID) : null;
			if (!tmpInstance) { pRes.send(404, { Error: 'Ultravisor not found.' }); return pNext(); }
			if (tmpInstance.Status !== 'running') { pRes.send(409, { Error: 'Ultravisor is not running.' }); return pNext(); }

			let tmpUpReq = libHttp.request(
				{
					hostname: '127.0.0.1',
					port:     tmpInstance.Port,
					path:     '/Beacon/Queue',
					method:   'GET'
				},
				(pUpRes) =>
				{
					let tmpChunks = [];
					pUpRes.on('data', (pChunk) => tmpChunks.push(pChunk));
					pUpRes.on('end', () =>
						{
							let tmpRaw = Buffer.concat(tmpChunks).toString('utf8');
							let tmpBody = null;
							try { tmpBody = JSON.parse(tmpRaw); } catch (pErr) { tmpBody = { Error: 'Non-JSON response from UV', Raw: tmpRaw.slice(0, 200) }; }
							pRes.send(pUpRes.statusCode || 200, tmpBody);
							return pNext();
						});
				});
			tmpUpReq.on('error', (pErr) =>
				{
					pRes.send(502, { Error: 'Ultravisor not reachable: ' + pErr.message });
					return pNext();
				});
			tmpUpReq.end();
		});
};
