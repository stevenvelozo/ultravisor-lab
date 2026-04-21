/**
 * Lab-Api-SeedDatasets
 *
 * REST surface for the seed-dataset catalog and run-trigger flow.
 */
'use strict';

module.exports = function registerSeedDatasetRoutes(pCore)
{
	let tmpOrator = pCore.Orator;
	let tmpSeedMgr = pCore.SeedDatasetManager;

	tmpOrator.serviceServer.doGet('/api/lab/seed-datasets',
		(pReq, pRes, pNext) =>
		{
			pRes.send({ Datasets: tmpSeedMgr.list() });
			return pNext();
		});

	tmpOrator.serviceServer.doGet('/api/lab/seed-datasets/:hash',
		(pReq, pRes, pNext) =>
		{
			let tmpEntry = tmpSeedMgr.get(pReq.params.hash);
			if (!tmpEntry)
			{
				pRes.send(404, { Error: 'Seed dataset not found.' });
				return pNext();
			}
			pRes.send(
				{
					FolderName:    tmpEntry.FolderName,
					Manifest:      tmpEntry.Manifest,
					OperationJSON: tmpEntry.OperationJSON
				});
			return pNext();
		});

	tmpOrator.serviceServer.doPost('/api/lab/seed-datasets/:hash/run',
		(pReq, pRes, pNext) =>
		{
			let tmpBody = pReq.body || {};
			tmpSeedMgr.runSeed(
				{
					DatasetHash:           pReq.params.hash,
					IDUltravisorInstance:  tmpBody.IDUltravisorInstance,
					IDBeacon:              tmpBody.IDBeacon
				},
				(pErr, pResult) =>
				{
					if (pErr) { pRes.send(400, { Error: pErr.message }); return pNext(); }
					pRes.send(202, pResult);
					return pNext();
				});
		});

	// One-click seed: auto-provision db + beacon on a DB engine, then seed.
	// Returns whenever the seed has been submitted (beacon may still be
	// warming up when the call returns; the ingestion job tracks progress).
	tmpOrator.serviceServer.doPost('/api/lab/seed-datasets/:hash/seed-to-engine',
		(pReq, pRes, pNext) =>
		{
			let tmpBody = pReq.body || {};
			tmpSeedMgr.runSeedIntoEngine(
				{
					DatasetHash:          pReq.params.hash,
					IDUltravisorInstance: tmpBody.IDUltravisorInstance,
					IDDBEngine:           tmpBody.IDDBEngine
				},
				(pErr, pResult) =>
				{
					if (pErr) { pRes.send(400, { Error: pErr.message }); return pNext(); }
					pRes.send(202, pResult);
					return pNext();
				});
		});

	// /api/lab/ingestion-jobs is registered by Lab-Api-Entities generically.
};
