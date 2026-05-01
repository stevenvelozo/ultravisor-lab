/**
 * Lab-Api-OperationExercises
 *
 * REST surface for the operation-exercise harness: catalog of exercises,
 * run-trigger flow, run history, the per-run event timeline, and cancel.
 *
 * Mirrors Lab-Api-BeaconExercises.js shape.  Exercise files live under
 * operation_exercises/<name>/exercise.json and reference operation graphs
 * in operation_library/<hash>/operation.json.
 */
'use strict';

module.exports = function registerOperationExerciseRoutes(pCore)
{
	let tmpOrator = pCore.Orator;
	let tmpManager = pCore.OperationExerciseManager;

	tmpOrator.serviceServer.doGet('/api/lab/operation-exercises',
		(pReq, pRes, pNext) =>
		{
			pRes.send({ Exercises: tmpManager.list() });
			return pNext();
		});

	tmpOrator.serviceServer.doGet('/api/lab/operation-exercises/:hash',
		(pReq, pRes, pNext) =>
		{
			let tmpExercise = tmpManager.get(pReq.params.hash);
			if (!tmpExercise)
			{
				pRes.send(404, { Error: 'Exercise not found.' });
				return pNext();
			}
			pRes.send(tmpExercise);
			return pNext();
		});

	tmpOrator.serviceServer.doPost('/api/lab/operation-exercises/:hash/run',
		(pReq, pRes, pNext) =>
		{
			let tmpBody = pReq.body || {};
			tmpManager.run(pReq.params.hash,
				{ IDUltravisorInstance: tmpBody.IDUltravisorInstance },
				(pErr, pResult) =>
				{
					if (pErr) { pRes.send(400, { Error: pErr.message }); return pNext(); }
					pRes.send(202, pResult);
					return pNext();
				});
		});

	tmpOrator.serviceServer.doGet('/api/lab/operation-exercise-runs',
		(pReq, pRes, pNext) =>
		{
			pRes.send({ Runs: tmpManager.listRuns() });
			return pNext();
		});

	tmpOrator.serviceServer.doGet('/api/lab/operation-exercise-runs/:id',
		(pReq, pRes, pNext) =>
		{
			let tmpRun = tmpManager.getRun(pReq.params.id);
			if (!tmpRun) { pRes.send(404, { Error: 'Run not found.' }); return pNext(); }
			let tmpVerdicts = null;
			let tmpTiming = null;
			try { tmpVerdicts = tmpRun.VerdictsJSON ? JSON.parse(tmpRun.VerdictsJSON) : null; } catch (pErr) { /* leave null */ }
			try { tmpTiming   = tmpRun.TimingJSON   ? JSON.parse(tmpRun.TimingJSON)   : null; } catch (pErr) { /* leave null */ }
			pRes.send(Object.assign({}, tmpRun, { Verdicts: tmpVerdicts, Timing: tmpTiming }));
			return pNext();
		});

	tmpOrator.serviceServer.doGet('/api/lab/operation-exercise-runs/:id/events',
		(pReq, pRes, pNext) =>
		{
			let tmpEvents = tmpManager.listRunEvents(pReq.params.id,
				{ offset: pReq.query && pReq.query.offset, limit: pReq.query && pReq.query.limit });
			pRes.send({ Events: tmpEvents });
			return pNext();
		});

	tmpOrator.serviceServer.doPost('/api/lab/operation-exercise-runs/:id/cancel',
		(pReq, pRes, pNext) =>
		{
			tmpManager.cancelRun(pReq.params.id, (pErr, pResult) =>
				{
					if (pErr) { pRes.send(400, { Error: pErr.message }); return pNext(); }
					pRes.send(202, pResult);
					return pNext();
				});
		});
};
