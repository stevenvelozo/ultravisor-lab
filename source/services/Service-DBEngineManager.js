/**
 * Service-DBEngineManager
 *
 * Business logic for dockerized DB engines (MySQL, MSSQL, Postgres).
 * Delegates raw `docker` calls to Service-DockerManager and engine-specific
 * commands (create database, health ping, ...) to per-engine adapters in
 * `./engines/`.
 *
 * Engine lifecycle:
 *   create   -> insert DBEngine row (status=provisioning), pull image,
 *               run container, record ContainerID, wait for health,
 *               flip Status to `running` (or `failed`).
 *   start    -> `docker start`, poll for healthy.
 *   stop     -> `docker stop`, mark row Status=stopped.
 *   remove   -> `docker rm -f` (if container exists), delete row + child
 *               databases.
 *
 * Database lifecycle:
 *   create   -> `docker exec` the adapter's createDatabaseArgs, insert
 *               Database row on success.
 *   drop     -> `docker exec` the adapter's dropDatabaseArgs, delete row.
 */
'use strict';

const libFableServiceProviderBase = require('fable-serviceproviderbase');

const libEngineRegistry = require('./engines/Engine-Registry.js');

const HEALTH_POLL_MAX_ATTEMPTS = 60;  // 60 * 2s = up to 120s wait
const HEALTH_POLL_INTERVAL_MS  = 2000;

class ServiceDBEngineManager extends libFableServiceProviderBase
{
	constructor(pFable, pOptions, pServiceHash)
	{
		super(pFable, pOptions, pServiceHash);

		this.serviceType = 'LabDBEngineManager';
	}

	// ── Read helpers (used by routes) ────────────────────────────────────────

	listEngineTypes()
	{
		return libEngineRegistry.list();
	}

	listEngines()
	{
		return this.fable.LabStateStore.list('DBEngine');
	}

	getEngine(pID)
	{
		return this.fable.LabStateStore.getById('DBEngine', 'IDDBEngine', pID);
	}

	listDatabasesForEngine(pEngineID)
	{
		return this.fable.LabStateStore.list('Database', { IDDBEngine: pEngineID });
	}

	// ── Create engine (full async flow) ──────────────────────────────────────

	createEngine(pRequest, fCallback)
	{
		let tmpStore    = this.fable.LabStateStore;
		let tmpDocker   = this.fable.LabDockerManager;

		let tmpAdapter = libEngineRegistry.get(pRequest.EngineType);
		if (!tmpAdapter)
		{
			return fCallback(new Error(`Unknown engine type: ${pRequest.EngineType}`));
		}

		let tmpName = (pRequest.Name || '').trim();
		if (!tmpName) { return fCallback(new Error('Name is required.')); }

		let tmpPort = parseInt(pRequest.Port, 10);
		if (!Number.isFinite(tmpPort) || tmpPort < 1 || tmpPort > 65535)
		{
			return fCallback(new Error('Port must be a number between 1 and 65535.'));
		}

		let tmpRootPassword = pRequest.RootPassword && pRequest.RootPassword.length > 0
			? pRequest.RootPassword
			: tmpAdapter.defaultPassword();

		let tmpValidationErr = tmpAdapter.validatePassword(tmpRootPassword);
		if (tmpValidationErr) { return fCallback(new Error(tmpValidationErr)); }

		let tmpContainerName = this._sanitizeContainerName(`lab-${tmpAdapter.EngineType}-${tmpName}`);
		let tmpImage = pRequest.ImageTag || tmpAdapter.DefaultImage;

		// Insert the row in `provisioning` state so the UI sees a pending entry.
		let tmpEngineID = tmpStore.insert('DBEngine',
			{
				Name:           tmpName,
				EngineType:     tmpAdapter.EngineType,
				Port:           tmpPort,
				InternalPort:   tmpAdapter.DefaultPort,
				ContainerName:  tmpContainerName,
				ImageTag:       tmpImage,
				RootUsername:   tmpAdapter.DefaultUsername,
				RootPassword:   tmpRootPassword,
				Status:         'provisioning',
				StatusDetail:   'Pulling image...'
			});

		tmpStore.recordEvent(
			{
				EntityType: 'DBEngine', EntityID: tmpEngineID, EntityName: tmpName,
				EventType: 'engine-create-started', Severity: 'info',
				Message: `Creating ${tmpAdapter.DisplayName} engine '${tmpName}' on port ${tmpPort}`
			});

		// Step 1: pull image (may be a no-op if already present) and ensure
		// the shared lab docker network exists so beacons running on it can
		// reach this engine by container DNS.
		tmpDocker.ensureNetwork('ultravisor-lab',
			(pNetErr) =>
			{
				if (pNetErr)
				{
					this._markEngineFailed(tmpEngineID, tmpName, 'network-failed', pNetErr.message);
					return fCallback(pNetErr);
				}

				tmpDocker.pull(tmpImage,
					(pPullErr) =>
					{
						if (pPullErr)
						{
							this._markEngineFailed(tmpEngineID, tmpName, 'pull-failed', pPullErr.message);
							return fCallback(pPullErr);
						}

						tmpStore.update('DBEngine', 'IDDBEngine', tmpEngineID, { StatusDetail: 'Starting container...' });

						// Step 2: run container on the shared network with
						// the stable hostname other containers resolve against.
						let tmpEnv = tmpAdapter.buildEnv({ RootPassword: tmpRootPassword });
						let tmpExtra = tmpAdapter.buildExtraRunArgs({ RootPassword: tmpRootPassword });

						tmpDocker.run(
							{
								Name:      tmpContainerName,
								Hostname:  tmpContainerName,
								Network:   'ultravisor-lab',
								Image:     tmpImage,
								Ports:     [{ Host: tmpPort, Container: tmpAdapter.DefaultPort }],
								Env:       tmpEnv,
								ExtraArgs: tmpExtra
							},
							(pRunErr, pRunResult) =>
							{
								if (pRunErr)
								{
									this._markEngineFailed(tmpEngineID, tmpName, 'run-failed', pRunErr.message);
									return fCallback(pRunErr);
								}

								tmpStore.update('DBEngine', 'IDDBEngine', tmpEngineID,
									{
										ContainerID:  pRunResult.ContainerID,
										StatusDetail: 'Waiting for engine to accept connections...'
									});

								// Step 3: poll for health in the background.  The API
								// response is sent right away so the UI can render the
								// new engine card in `provisioning` state.
								this._pollHealthy(tmpEngineID, tmpName, tmpAdapter,
									{ ContainerID: pRunResult.ContainerID, RootPassword: tmpRootPassword },
									() => {});

								return fCallback(null,
									{
										IDDBEngine:   tmpEngineID,
										ContainerID:  pRunResult.ContainerID,
										Status:       'provisioning'
									});
							});
					});
			});
	}

	_pollHealthy(pEngineID, pEngineName, pAdapter, pOptions, fCallback)
	{
		let tmpStore  = this.fable.LabStateStore;
		let tmpDocker = this.fable.LabDockerManager;
		let tmpAttempt = 0;

		let tmpEnv = typeof pAdapter.dockerExecEnv === 'function'
			? pAdapter.dockerExecEnv({ RootPassword: pOptions.RootPassword })
			: null;

		let tmpTry = () =>
		{
			tmpAttempt++;
			tmpDocker.exec(pOptions.ContainerID, pAdapter.healthCheckArgs({ RootPassword: pOptions.RootPassword }),
				{ TimeoutMs: 7000, Env: tmpEnv },
				(pErr, pResult) =>
				{
					if (!pErr && pResult.ExitCode === 0)
					{
						tmpStore.update('DBEngine', 'IDDBEngine', pEngineID,
							{ Status: 'running', StatusDetail: '' });
						tmpStore.recordEvent(
							{
								EntityType: 'DBEngine', EntityID: pEngineID, EntityName: pEngineName,
								EventType: 'engine-ready', Severity: 'info',
								Message: `Engine '${pEngineName}' is ready (took ~${tmpAttempt * HEALTH_POLL_INTERVAL_MS / 1000}s)`
							});
						return fCallback(null, true);
					}

					if (tmpAttempt >= HEALTH_POLL_MAX_ATTEMPTS)
					{
						this._markEngineFailed(pEngineID, pEngineName, 'health-timeout',
							`Engine did not become healthy within ${HEALTH_POLL_MAX_ATTEMPTS * HEALTH_POLL_INTERVAL_MS / 1000}s`);
						return fCallback(null, false);
					}

					setTimeout(tmpTry, HEALTH_POLL_INTERVAL_MS);
				});
		};

		tmpTry();
	}

	_markEngineFailed(pEngineID, pEngineName, pEventType, pDetail)
	{
		let tmpStore = this.fable.LabStateStore;
		tmpStore.update('DBEngine', 'IDDBEngine', pEngineID,
			{ Status: 'failed', StatusDetail: pDetail || '' });
		tmpStore.recordEvent(
			{
				EntityType: 'DBEngine', EntityID: pEngineID, EntityName: pEngineName,
				EventType: pEventType || 'engine-failed', Severity: 'error',
				Message: `Engine '${pEngineName}' failed: ${pDetail || 'unknown error'}`,
				Detail: { Reason: pDetail }
			});
	}

	_sanitizeContainerName(pName)
	{
		return String(pName).toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '');
	}

	// ── Start / Stop / Remove ───────────────────────────────────────────────

	startEngine(pID, fCallback)
	{
		let tmpStore  = this.fable.LabStateStore;
		let tmpDocker = this.fable.LabDockerManager;

		let tmpEngine = this.getEngine(pID);
		if (!tmpEngine) { return fCallback(new Error('Engine not found.')); }
		if (!tmpEngine.ContainerID) { return fCallback(new Error('Engine has no container to start.')); }

		let tmpAdapter = libEngineRegistry.get(tmpEngine.EngineType);
		if (!tmpAdapter) { return fCallback(new Error(`Unknown engine type: ${tmpEngine.EngineType}`)); }

		tmpStore.update('DBEngine', 'IDDBEngine', pID, { Status: 'starting', StatusDetail: '' });

		tmpDocker.start(tmpEngine.ContainerID,
			(pErr) =>
			{
				if (pErr)
				{
					this._markEngineFailed(pID, tmpEngine.Name, 'start-failed', pErr.message);
					return fCallback(pErr);
				}
				this._pollHealthy(pID, tmpEngine.Name, tmpAdapter,
					{ ContainerID: tmpEngine.ContainerID, RootPassword: tmpEngine.RootPassword },
					() => {});
				return fCallback(null, { Status: 'starting' });
			});
	}

	stopEngine(pID, fCallback)
	{
		let tmpStore  = this.fable.LabStateStore;
		let tmpDocker = this.fable.LabDockerManager;

		let tmpEngine = this.getEngine(pID);
		if (!tmpEngine) { return fCallback(new Error('Engine not found.')); }
		if (!tmpEngine.ContainerID) { return fCallback(new Error('Engine has no container to stop.')); }

		tmpStore.update('DBEngine', 'IDDBEngine', pID, { Status: 'stopping', StatusDetail: '' });

		tmpDocker.stop(tmpEngine.ContainerID,
			(pErr) =>
			{
				if (pErr)
				{
					tmpStore.recordEvent(
						{
							EntityType: 'DBEngine', EntityID: pID, EntityName: tmpEngine.Name,
							EventType: 'stop-failed', Severity: 'warning', Message: pErr.message
						});
					return fCallback(pErr);
				}

				tmpStore.update('DBEngine', 'IDDBEngine', pID, { Status: 'stopped', StatusDetail: '' });
				tmpStore.recordEvent(
					{
						EntityType: 'DBEngine', EntityID: pID, EntityName: tmpEngine.Name,
						EventType: 'engine-stopped', Severity: 'info', Message: `Engine '${tmpEngine.Name}' stopped`
					});
				return fCallback(null, { Status: 'stopped' });
			});
	}

	removeEngine(pID, fCallback)
	{
		let tmpStore  = this.fable.LabStateStore;
		let tmpDocker = this.fable.LabDockerManager;

		let tmpEngine = this.getEngine(pID);
		if (!tmpEngine) { return fCallback(new Error('Engine not found.')); }

		let finishRemoval = () =>
		{
			// Cascade-delete databases first (no FK constraint enforced in schema).
			let tmpDatabases = this.listDatabasesForEngine(pID);
			for (let i = 0; i < tmpDatabases.length; i++)
			{
				tmpStore.remove('Database', 'IDDatabase', tmpDatabases[i].IDDatabase);
			}

			tmpStore.remove('DBEngine', 'IDDBEngine', pID);
			tmpStore.recordEvent(
				{
					EntityType: 'DBEngine', EntityID: pID, EntityName: tmpEngine.Name,
					EventType: 'engine-removed', Severity: 'info',
					Message: `Engine '${tmpEngine.Name}' removed (${tmpDatabases.length} associated databases dropped from state)`
				});
			return fCallback(null, { Removed: true });
		};

		if (tmpEngine.ContainerID)
		{
			tmpDocker.rm(tmpEngine.ContainerID, true,
				(pErr) =>
				{
					if (pErr)
					{
						// Log but continue -- the container may already be gone.
						tmpStore.recordEvent(
							{
								EntityType: 'DBEngine', EntityID: pID, EntityName: tmpEngine.Name,
								EventType: 'rm-warning', Severity: 'warning',
								Message: `docker rm warning: ${pErr.message}`
							});
					}
					finishRemoval();
				});
		}
		else
		{
			finishRemoval();
		}
	}

	// ── Databases ────────────────────────────────────────────────────────────

	createDatabase(pEngineID, pDatabaseName, fCallback)
	{
		let tmpStore  = this.fable.LabStateStore;
		let tmpDocker = this.fable.LabDockerManager;

		let tmpEngine = this.getEngine(pEngineID);
		if (!tmpEngine) { return fCallback(new Error('Engine not found.')); }
		if (tmpEngine.Status !== 'running') { return fCallback(new Error(`Engine is ${tmpEngine.Status}, can only create databases on running engines.`)); }

		let tmpAdapter = libEngineRegistry.get(tmpEngine.EngineType);
		if (!tmpAdapter) { return fCallback(new Error(`Unknown engine type: ${tmpEngine.EngineType}`)); }

		let tmpDbName = (pDatabaseName || '').trim();
		if (!tmpDbName) { return fCallback(new Error('Database name is required.')); }
		if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(tmpDbName))
		{
			return fCallback(new Error('Database name must start with a letter or underscore and contain only letters, digits, and underscores.'));
		}

		let tmpEnv = typeof tmpAdapter.dockerExecEnv === 'function'
			? tmpAdapter.dockerExecEnv({ RootPassword: tmpEngine.RootPassword })
			: null;

		tmpDocker.exec(tmpEngine.ContainerID, tmpAdapter.createDatabaseArgs({ RootPassword: tmpEngine.RootPassword }, tmpDbName),
			{ Env: tmpEnv, TimeoutMs: 30000 },
			(pErr, pResult) =>
			{
				if (pErr || pResult.ExitCode !== 0)
				{
					let tmpMessage = pErr ? pErr.message : (pResult.Stderr || pResult.Stdout || 'unknown error').trim();
					tmpStore.recordEvent(
						{
							EntityType: 'DBEngine', EntityID: pEngineID, EntityName: tmpEngine.Name,
							EventType: 'database-create-failed', Severity: 'error',
							Message: `Failed to create database '${tmpDbName}': ${tmpMessage}`
						});
					return fCallback(new Error(tmpMessage));
				}

				let tmpDatabaseID = tmpStore.insert('Database',
					{
						IDDBEngine: pEngineID,
						Name:       tmpDbName
					});
				tmpStore.recordEvent(
					{
						EntityType: 'Database', EntityID: tmpDatabaseID, EntityName: tmpDbName,
						EventType: 'database-created', Severity: 'info',
						Message: `Database '${tmpDbName}' created in engine '${tmpEngine.Name}'`
					});
				return fCallback(null, { IDDatabase: tmpDatabaseID, Name: tmpDbName });
			});
	}

	dropDatabase(pEngineID, pDatabaseID, fCallback)
	{
		let tmpStore  = this.fable.LabStateStore;
		let tmpDocker = this.fable.LabDockerManager;

		let tmpEngine = this.getEngine(pEngineID);
		if (!tmpEngine) { return fCallback(new Error('Engine not found.')); }

		let tmpDatabase = tmpStore.getById('Database', 'IDDatabase', pDatabaseID);
		if (!tmpDatabase) { return fCallback(new Error('Database not found.')); }

		let tmpAdapter = libEngineRegistry.get(tmpEngine.EngineType);
		if (!tmpAdapter) { return fCallback(new Error(`Unknown engine type: ${tmpEngine.EngineType}`)); }

		let finishDrop = (pContainerWarning) =>
		{
			tmpStore.remove('Database', 'IDDatabase', pDatabaseID);
			tmpStore.recordEvent(
				{
					EntityType: 'Database', EntityID: pDatabaseID, EntityName: tmpDatabase.Name,
					EventType: 'database-dropped', Severity: 'info',
					Message: `Database '${tmpDatabase.Name}' dropped from engine '${tmpEngine.Name}'`
						+ (pContainerWarning ? ` (warning: ${pContainerWarning})` : '')
				});
			return fCallback(null, { Removed: true });
		};

		// If the engine container is up, drop the actual database too.  If it's
		// not running we just unlink from state (the real database will sit in
		// the container until the user brings it back up, which is acceptable).
		if (tmpEngine.Status === 'running' && tmpEngine.ContainerID)
		{
			let tmpEnv = typeof tmpAdapter.dockerExecEnv === 'function'
				? tmpAdapter.dockerExecEnv({ RootPassword: tmpEngine.RootPassword })
				: null;

			tmpDocker.exec(tmpEngine.ContainerID, tmpAdapter.dropDatabaseArgs({ RootPassword: tmpEngine.RootPassword }, tmpDatabase.Name),
				{ Env: tmpEnv, TimeoutMs: 30000 },
				(pErr, pResult) =>
				{
					if (pErr || pResult.ExitCode !== 0)
					{
						let tmpMessage = pErr ? pErr.message : (pResult.Stderr || pResult.Stdout || 'unknown error').trim();
						return finishDrop(tmpMessage);
					}
					finishDrop(null);
				});
		}
		else
		{
			finishDrop('engine not running; database removed from state only');
		}
	}

	// ── Port suggestion ──────────────────────────────────────────────────────
	/**
	 * Find the next free host port for a given engine type.  Starts at the
	 * adapter's SuggestedHostPort and delegates to the shared PortAllocator,
	 * which skips ports already owned by other lab entities and OS-probes
	 * for local conflicts.  Used by the UI's "Add DB Engine" form.
	 */
	suggestHostPort(pEngineType, fCallback)
	{
		let tmpAdapter = libEngineRegistry.get(pEngineType);
		if (!tmpAdapter)
		{
			return fCallback(new Error(`Unknown engine type: ${pEngineType}`));
		}

		let tmpStart = tmpAdapter.SuggestedHostPort || tmpAdapter.DefaultPort;
		return this.fable.LabPortAllocator.findFreePort(tmpStart, fCallback);
	}

	connectionInfo(pEngineID)
	{
		let tmpEngine = this.getEngine(pEngineID);
		if (!tmpEngine) { return null; }
		let tmpAdapter = libEngineRegistry.get(tmpEngine.EngineType);
		if (!tmpAdapter) { return null; }
		return {
			EngineType:        tmpEngine.EngineType,
			Host:              '127.0.0.1',
			Port:              tmpEngine.Port,
			RootUsername:      tmpEngine.RootUsername,
			RootPassword:      tmpEngine.RootPassword,
			ConnectionString:  tmpAdapter.connectionString(tmpEngine)
		};
	}
}

module.exports = ServiceDBEngineManager;
