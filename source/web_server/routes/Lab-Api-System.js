/**
 * Lab-Api-System
 *
 * System-level endpoints: health, reconciled status snapshot, docker probe.
 * Views query these to render the Overview dashboard.
 */
'use strict';

module.exports = function registerSystemRoutes(pCore)
{
	let tmpOrator     = pCore.Orator;
	let tmpFable      = pCore.Fable;
	let tmpStore      = pCore.StateStore;
	let tmpDocker     = pCore.DockerManager;
	let tmpReconc     = pCore.Reconciler;
	let tmpLifecycle  = pCore.Lifecycle;
	let tmpPackage    = pCore.Package;

	// Quick ping.  Scripts use this for readiness probing.
	tmpOrator.serviceServer.doGet('/api/lab/health',
		(pReq, pRes, pNext) =>
		{
			pRes.send(
				{
					Product:    'Ultravisor-Lab',
					Version:    tmpPackage.version,
					ServerTime: new Date().toISOString()
				});
			return pNext();
		});

	// Full dashboard snapshot: docker availability, reconcile report, and a
	// count of each tracked entity type.
	tmpOrator.serviceServer.doGet('/api/lab/status',
		(pReq, pRes, pNext) =>
		{
			tmpDocker.probe(
				(pProbeErr, pProbe) =>
				{
					let tmpCounts =
					{
						DBEngine:            tmpStore.list('DBEngine').length,
						Database:            tmpStore.list('Database').length,
						UltravisorInstance:  tmpStore.list('UltravisorInstance').length,
						Beacon:              tmpStore.list('Beacon').length,
						FactoInstance:       tmpStore.list('FactoInstance').length,
						IngestionJob:        tmpStore.list('IngestionJob').length
					};

					pRes.send(
						{
							Product:        'Ultravisor-Lab',
							Version:        tmpPackage.version,
							ServerTime:     new Date().toISOString(),
							Docker:         pProbe || { Available: false, Version: '', Error: '' },
							Counts:         tmpCounts,
							LastReconcile:  tmpReconc.lastRunResult
						});
					return pNext();
				});
		});

	// On-demand reconcile -- useful for the UI's "refresh now" button.
	tmpOrator.serviceServer.doPost('/api/lab/reconcile',
		(pReq, pRes, pNext) =>
		{
			tmpReconc.runOnce(
				(pErr, pReport) =>
				{
					if (pErr)
					{
						tmpFable.log.error(`Reconcile failed -- ${pErr.message}`);
						pRes.send(500, { Error: pErr.message });
						return pNext();
					}
					pRes.send(pReport);
					return pNext();
				});
		});

	// Nuke all lab-managed entities: docker containers, supervised processes,
	// DB rows.  Boot event is recorded afterwards so the event log isn't empty.
	tmpOrator.serviceServer.doPost('/api/lab/teardown',
		(pReq, pRes, pNext) =>
		{
			tmpLifecycle.teardown(
				(pErr, pSummary) =>
				{
					if (pErr)
					{
						tmpFable.log.error(`Teardown failed -- ${pErr.message}`);
						pRes.send(500, { Error: pErr.message });
						return pNext();
					}
					pRes.send(pSummary);
					return pNext();
				});
		});
};
