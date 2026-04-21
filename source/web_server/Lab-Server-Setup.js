/**
 * Lab-Server-Setup
 *
 * Composes the ultravisor-lab web transport: Fable -> Orator (restify) ->
 * lab services -> REST routes -> static Pict bundle.  Mirrors the shape of
 * retold-manager's Manager-Server-Setup but trimmed for the lab's needs.
 *
 * Call signature:
 *   serverSetup({ Port, Host, DataDir, DistPath }, fCallback);
 *     fCallback(pError, pServerInfo)
 *     pServerInfo = { Fable, Orator, Core, Port, Host, DistPath }
 *
 * Binds explicitly to the supplied host so the server is not reachable
 * from the local network unless the user opts in via `--host`.
 */
'use strict';

const libPath = require('path');
const libFs = require('fs');

const libFable = require('fable');
const libOrator = require('orator');
const libOratorServiceServerRestify = require('orator-serviceserver-restify');

const libServiceStateStore         = require('../services/Service-StateStore.js');
const libServiceDockerManager      = require('../services/Service-DockerManager.js');
const libServiceProcessSupervisor  = require('../services/Service-ProcessSupervisor.js');
const libServiceReconcileLoop      = require('../services/Service-ReconcileLoop.js');
const libServicePortAllocator      = require('../services/Service-PortAllocator.js');
const libServiceDBEngineManager    = require('../services/Service-DBEngineManager.js');
const libServiceUltravisorManager  = require('../services/Service-UltravisorManager.js');
const libServiceBeaconTypeRegistry = require('../services/Service-BeaconTypeRegistry.js');
const libServiceBeaconManager      = require('../services/Service-BeaconManager.js');
const libServiceSeedDatasetManager = require('../services/Service-SeedDatasetManager.js');
const libServiceLabLifecycle       = require('../services/Service-LabLifecycle.js');

const libRoutesSystem       = require('./routes/Lab-Api-System.js');
const libRoutesEntities     = require('./routes/Lab-Api-Entities.js');
const libRoutesEvents       = require('./routes/Lab-Api-Events.js');
const libRoutesDBEngines    = require('./routes/Lab-Api-DBEngines.js');
const libRoutesUltravisor   = require('./routes/Lab-Api-Ultravisor.js');
const libRoutesBeacons      = require('./routes/Lab-Api-Beacons.js');
const libRoutesSeedDatasets = require('./routes/Lab-Api-SeedDatasets.js');

function setupLabServer(pOptions, fCallback)
{
	let tmpPort      = pOptions.Port || 44443;
	let tmpHost      = pOptions.Host || '127.0.0.1';
	let tmpDataDir   = pOptions.DataDir;
	let tmpDistPath  = pOptions.DistPath;
	let tmpPackage   = require('../../package.json');

	// ─────────────────────────────────────────────
	//  Fable
	// ─────────────────────────────────────────────

	let tmpFable = new libFable(
		{
			Product:        'Ultravisor-Lab',
			ProductVersion: tmpPackage.version,
			APIServerPort:  tmpPort,
			LogStreams:
			[
				{
					loggertype: 'console',
					streamtype: 'console',
					level:      'info'
				}
			]
		});

	// ─────────────────────────────────────────────
	//  Orator (restify)
	// ─────────────────────────────────────────────

	tmpFable.serviceManager.addServiceType('OratorServiceServer', libOratorServiceServerRestify);
	tmpFable.serviceManager.instantiateServiceProvider('OratorServiceServer');
	tmpFable.serviceManager.addServiceType('Orator', libOrator);
	let tmpOrator = tmpFable.serviceManager.instantiateServiceProvider('Orator');

	// ─────────────────────────────────────────────
	//  Lab services
	// ─────────────────────────────────────────────

	tmpFable.addAndInstantiateServiceType('LabStateStore',         libServiceStateStore,        { DataDir: tmpDataDir });
	tmpFable.addAndInstantiateServiceType('LabDockerManager',      libServiceDockerManager);
	tmpFable.addAndInstantiateServiceType('LabProcessSupervisor',  libServiceProcessSupervisor, { DataDir: tmpDataDir });
	tmpFable.addAndInstantiateServiceType('LabReconcileLoop',      libServiceReconcileLoop);
	tmpFable.addAndInstantiateServiceType('LabPortAllocator',      libServicePortAllocator);
	tmpFable.addAndInstantiateServiceType('LabDBEngineManager',    libServiceDBEngineManager);
	tmpFable.addAndInstantiateServiceType('LabUltravisorManager',  libServiceUltravisorManager);
	tmpFable.addAndInstantiateServiceType('LabBeaconTypeRegistry', libServiceBeaconTypeRegistry);
	tmpFable.addAndInstantiateServiceType('LabBeaconManager',      libServiceBeaconManager);
	tmpFable.addAndInstantiateServiceType('LabSeedDatasetManager', libServiceSeedDatasetManager);
	tmpFable.addAndInstantiateServiceType('LabLifecycle',          libServiceLabLifecycle);

	tmpFable.LabStateStore.initialize(
		(pStateErr) =>
		{
			if (pStateErr) { return fCallback(pStateErr); }

			tmpFable.LabProcessSupervisor.initialize(
				(pSuperErr) =>
				{
					if (pSuperErr) { return fCallback(pSuperErr); }

					// Record a boot event so the UI timeline has something to show.
					tmpFable.LabStateStore.recordEvent(
						{
							EntityType:  'System',
							EventType:   'lab-started',
							Severity:    'info',
							Message:     `Ultravisor-Lab v${tmpPackage.version} started on port ${tmpPort}`
						});

					// ─────────────────────────────────────────────
					//  Assemble the Core bag each route module consumes
					// ─────────────────────────────────────────────

					let tmpCore =
					{
						Fable:              tmpFable,
						Orator:             tmpOrator,
						StateStore:         tmpFable.LabStateStore,
						DockerManager:      tmpFable.LabDockerManager,
						Supervisor:         tmpFable.LabProcessSupervisor,
						Reconciler:         tmpFable.LabReconcileLoop,
						PortAllocator:      tmpFable.LabPortAllocator,
						EngineManager:      tmpFable.LabDBEngineManager,
						UltravisorManager:  tmpFable.LabUltravisorManager,
						BeaconTypeRegistry: tmpFable.LabBeaconTypeRegistry,
						BeaconManager:      tmpFable.LabBeaconManager,
						SeedDatasetManager: tmpFable.LabSeedDatasetManager,
						Lifecycle:          tmpFable.LabLifecycle,
						Package:            tmpPackage
					};

					// ─────────────────────────────────────────────
					//  Bring Orator up and wire routes
					// ─────────────────────────────────────────────

					tmpOrator.initialize(
						(pInitErr) =>
						{
							if (pInitErr) { return fCallback(pInitErr); }

							tmpOrator.serviceServer.server.use(tmpOrator.serviceServer.bodyParser());
							tmpOrator.serviceServer.server.use(
								(pReq, pRes, pNext) =>
								{
									pRes.setHeader('X-Ultravisor-Lab', tmpPackage.version);
									return pNext();
								});

							libRoutesSystem(tmpCore);
							libRoutesEntities(tmpCore);
							libRoutesEvents(tmpCore);
							libRoutesDBEngines(tmpCore);
							libRoutesUltravisor(tmpCore);
							libRoutesBeacons(tmpCore);
							libRoutesSeedDatasets(tmpCore);

							// Static bundle.  During dev we serve the `web/` source tree
							// directly.  The browser bundle only exists after `npm run
							// build-bundle`; we serve whichever directory is present.
							let tmpWebRoot = libPath.resolve(__dirname, '..', '..', 'web');
							let tmpDistRoot = tmpDistPath || libPath.join(tmpWebRoot, 'dist');

							// Try dist first (built bundle wins) then fall back to source.
							if (libFs.existsSync(tmpDistRoot))
							{
								tmpOrator.addStaticRoute(`${tmpDistRoot}/js/`,  null, '/js/*',  '/js/');
								tmpOrator.addStaticRoute(`${tmpDistRoot}/css/`, null, '/css/*', '/css/');
								tmpOrator.addStaticRoute(`${tmpDistRoot}/`, 'index.html');
							}
							else
							{
								// Serve html + css from source; warn that bundle is missing.
								tmpFable.log.warn('Browser bundle not built yet. Run: npm run build-bundle');
								tmpOrator.addStaticRoute(`${tmpWebRoot}/css/`, null, '/css/*', '/css/');
								tmpOrator.addStaticRoute(`${tmpWebRoot}/html/`, 'index.html');
							}

							// ─────────────────────────────────────────────
							//  Listen -- bypass orator.startService() so we can
							//  pass an explicit host to restify.
							// ─────────────────────────────────────────────

							tmpOrator.serviceServer.server.listen(tmpPort, tmpHost,
								(pListenErr) =>
								{
									if (pListenErr) { return fCallback(pListenErr); }

									tmpOrator.serviceServer.Active = true;
									tmpOrator.serviceServer.Port = tmpPort;

									// Snapshot rows that claimed Status==='running' before the
									// lab shut down.  The reconcile pass is about to stomp
									// their status back to 'stopped' (dead PIDs, missing
									// containers), but we use this snapshot to relaunch
									// everything that was up so the user's last-known lab
									// state survives a lab restart.
									let tmpWasRunning = _snapshotWasRunning(tmpFable.LabStateStore);

									// Prime the reconcile loop with a boot-time pass so the UI has fresh state on first render.
									tmpFable.LabReconcileLoop.runOnce(
										() =>
										{
											tmpFable.LabReconcileLoop.start();

											// Auto-restart everything that was running before
											// the last shutdown.  DB engines first (beacons
											// depend on them), then Ultravisors, then beacons.
											_autoStartWasRunning(tmpFable, tmpWasRunning,
												() =>
												{
													return fCallback(null,
														{
															Fable:    tmpFable,
															Orator:   tmpOrator,
															Core:     tmpCore,
															Port:     tmpPort,
															Host:     tmpHost,
															DistPath: tmpDistRoot
														});
												});
										});
								});
						});
				});
		});
}

// ──────────────────────────────────────────────────────────────────────────
//  Boot-time auto-restart helpers
// ──────────────────────────────────────────────────────────────────────────

/**
 * Read all supervised entities whose persisted Status is 'running'.  The
 * reconciler clobbers these to 'stopped' on the very next pass when the
 * processes are no longer alive, so we have to capture the snapshot BEFORE
 * reconcileLoop.runOnce() runs.
 */
function _snapshotWasRunning(pStore)
{
	return {
		DBEngines:   pStore.list('DBEngine').filter((pR) => pR.Status === 'running'),
		Ultravisors: pStore.list('UltravisorInstance').filter((pR) => pR.Status === 'running'),
		Beacons:     pStore.list('Beacon').filter((pR) => pR.Status === 'running')
	};
}

/**
 * Sequentially relaunch everything the user had running before the last
 * shutdown.  Order matters: a databeacon wired to a MySQL engine needs that
 * engine up before it tries to reconnect, and a beacon that registers with
 * an Ultravisor needs the Ultravisor's API reachable first.  Errors are
 * logged but never block -- the user can still retry from the UI.
 */
function _autoStartWasRunning(pFable, pWasRunning, fCallback)
{
	let tmpLog = pFable.log;

	_startSerially(pWasRunning.DBEngines, 'IDDBEngine',
		(pRow, fNext) =>
		{
			tmpLog.info(`[AutoStart] starting DB engine "${pRow.Name}" (#${pRow.IDDBEngine})`);
			pFable.LabDBEngineManager.startEngine(pRow.IDDBEngine,
				(pErr) =>
				{
					if (pErr) { tmpLog.warn(`[AutoStart] DB engine "${pRow.Name}" failed: ${pErr.message}`); }
					return fNext();
				});
		},
		() =>
		{
			_startSerially(pWasRunning.Ultravisors, 'IDUltravisorInstance',
				(pRow, fNext) =>
				{
					tmpLog.info(`[AutoStart] starting Ultravisor "${pRow.Name}" (#${pRow.IDUltravisorInstance})`);
					pFable.LabUltravisorManager.startInstance(pRow.IDUltravisorInstance,
						(pErr) =>
						{
							if (pErr) { tmpLog.warn(`[AutoStart] Ultravisor "${pRow.Name}" failed: ${pErr.message}`); }
							return fNext();
						});
				},
				() =>
				{
					_startSerially(pWasRunning.Beacons, 'IDBeacon',
						(pRow, fNext) =>
						{
							tmpLog.info(`[AutoStart] starting beacon "${pRow.Name}" (#${pRow.IDBeacon})`);
							pFable.LabBeaconManager.startBeacon(pRow.IDBeacon,
								(pErr) =>
								{
									if (pErr) { tmpLog.warn(`[AutoStart] beacon "${pRow.Name}" failed: ${pErr.message}`); }
									return fNext();
								});
						},
						() => fCallback());
				});
		});
}

function _startSerially(pRows, pIDColumn, fPerRow, fDone)
{
	let tmpIdx = 0;
	let tmpNext = () =>
	{
		if (tmpIdx >= pRows.length) { return fDone(); }
		let tmpRow = pRows[tmpIdx++];
		fPerRow(tmpRow, tmpNext);
	};
	tmpNext();
}

module.exports = setupLabServer;
