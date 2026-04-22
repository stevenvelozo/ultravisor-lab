/**
 * Service-ReconcileLoop
 *
 * Keeps the state-store's view of the world in sync with reality:
 *
 *   - docker containers listed in DBEngine: inspect each container_id
 *   - supervised processes listed in UltravisorInstance / Databeacon /
 *     FactoInstance: check the PID file + `kill -0`
 *
 * Runs once at boot (so the UI has fresh state on the first render) and
 * then on a 15-second interval.  Any drift -- row says running, kernel
 * disagrees -- gets recorded as an InfrastructureEvent with severity
 * `warning`.  The UI decides whether to surface an "Attention" badge; we
 * never silently cleanup entries.
 *
 * In Phase 1 the tables are empty so most passes are no-ops, but the
 * scaffolding is in place for Phases 2-5.
 */
'use strict';

const libFableServiceProviderBase = require('fable-serviceproviderbase');

const DEFAULT_INTERVAL_MS = 15000;

const SUPERVISED_ENTITIES =
[
	{ Table: 'UltravisorInstance', IDColumn: 'IDUltravisorInstance', EntityType: 'UltravisorInstance' },
	{ Table: 'Beacon',             IDColumn: 'IDBeacon',             EntityType: 'Beacon' },
	{ Table: 'FactoInstance',      IDColumn: 'IDFactoInstance',      EntityType: 'FactoInstance' }
];

class ServiceReconcileLoop extends libFableServiceProviderBase
{
	constructor(pFable, pOptions, pServiceHash)
	{
		super(pFable, pOptions, pServiceHash);

		this.serviceType = 'LabReconcileLoop';

		this.intervalMs    = (pOptions && pOptions.IntervalMs) ? pOptions.IntervalMs : DEFAULT_INTERVAL_MS;
		this._timer        = null;
		this._running      = false;
		this.lastRunAt     = null;
		this.lastRunResult = null;
	}

	start()
	{
		if (this._timer) { return; }
		this._timer = setInterval(() => this.runOnce(() => {}), this.intervalMs);
		// Don't block node from exiting just because the reconciler is ticking.
		if (this._timer.unref) { this._timer.unref(); }
	}

	stop()
	{
		if (this._timer)
		{
			clearInterval(this._timer);
			this._timer = null;
		}
	}

	/**
	 * Run a single reconciliation pass.
	 */
	runOnce(fCallback)
	{
		if (this._running)
		{
			return fCallback(null, { Skipped: true });
		}
		this._running = true;

		let tmpStore      = this.fable.LabStateStore;
		let tmpDocker     = this.fable.LabDockerManager;
		let tmpSupervisor = this.fable.LabProcessSupervisor;

		let tmpReport =
		{
			StartedAt: new Date().toISOString(),
			DockerAvailable: false,
			Containers: { Checked: 0, Running: 0, Stopped: 0, Missing: 0, Drift: 0 },
			Processes:  { Checked: 0, Alive: 0, Dead: 0, Drift: 0 }
		};

		// Step 1: probe docker.  If it's not available, we skip container checks.
		tmpDocker.probe((pProbeErr, pProbe) =>
			{
				tmpReport.DockerAvailable = !!(pProbe && pProbe.Available);

				// Step 2: reconcile docker containers in DBEngine rows.
				this._reconcileContainers(tmpStore, tmpDocker, tmpReport.Containers, tmpReport.DockerAvailable,
					() =>
					{
						// Step 3: reconcile supervised processes.
						this._reconcileProcesses(tmpStore, tmpSupervisor, tmpReport.Processes,
							() =>
							{
								tmpReport.FinishedAt = new Date().toISOString();
								this.lastRunAt = tmpReport.FinishedAt;
								this.lastRunResult = tmpReport;
								this._running = false;
								return fCallback(null, tmpReport);
							});
					});
			});
	}

	_reconcileContainers(pStore, pDocker, pCounters, pDockerAvailable, fCallback)
	{
		if (!pDockerAvailable) { return fCallback(); }

		// Container-backed rows live in DBEngine (always) + Beacon rows with
		// Runtime='container' + UltravisorInstance rows with Runtime='container'.
		// All three walk the same inspect path so they share drift detection.
		let tmpTargets = [];
		let tmpEngineRows = pStore.list('DBEngine');
		for (let i = 0; i < tmpEngineRows.length; i++)
		{
			tmpTargets.push({ Table: 'DBEngine', IDColumn: 'IDDBEngine', EntityType: 'DBEngine', Row: tmpEngineRows[i] });
		}
		let tmpBeaconRows = pStore.list('Beacon');
		for (let j = 0; j < tmpBeaconRows.length; j++)
		{
			if (tmpBeaconRows[j].Runtime === 'container')
			{
				tmpTargets.push({ Table: 'Beacon', IDColumn: 'IDBeacon', EntityType: 'Beacon', Row: tmpBeaconRows[j] });
			}
		}
		let tmpUVRows = pStore.list('UltravisorInstance');
		for (let k = 0; k < tmpUVRows.length; k++)
		{
			if (tmpUVRows[k].Runtime === 'container')
			{
				tmpTargets.push({ Table: 'UltravisorInstance', IDColumn: 'IDUltravisorInstance', EntityType: 'UltravisorInstance', Row: tmpUVRows[k] });
			}
		}

		if (tmpTargets.length === 0) { return fCallback(); }

		let tmpIdx = 0;
		let tmpNext = () =>
		{
			if (tmpIdx >= tmpTargets.length) { return fCallback(); }
			let tmpTarget = tmpTargets[tmpIdx++];
			let tmpRow = tmpTarget.Row;
			pCounters.Checked++;

			if (!tmpRow.ContainerID)
			{
				// Not yet launched; nothing to reconcile.
				return tmpNext();
			}

			pDocker.inspect(tmpRow.ContainerID,
				(pErr, pInspect) =>
				{
					let tmpObserved = pDocker.statusFromInspect(pInspect);
					if (tmpObserved === 'running') { pCounters.Running++; }
					else if (tmpObserved === 'stopped') { pCounters.Stopped++; }
					else { pCounters.Missing++; }

					if (tmpRow.Status !== tmpObserved)
					{
						pStore.update(tmpTarget.Table, tmpTarget.IDColumn, tmpRow[tmpTarget.IDColumn], { Status: tmpObserved });
						if (tmpRow.Status === 'running' && tmpObserved !== 'running')
						{
							pCounters.Drift++;
							pStore.recordEvent(
								{
									EntityType:  tmpTarget.EntityType,
									EntityID:    tmpRow[tmpTarget.IDColumn],
									EntityName:  tmpRow.Name,
									EventType:   'drift-detected',
									Severity:    'warning',
									Message:     `Container drift: state says running, docker says ${tmpObserved}`,
									Detail:      { PreviousStatus: tmpRow.Status, ObservedStatus: tmpObserved, ContainerID: tmpRow.ContainerID }
								});
						}
					}

					return tmpNext();
				});
		};
		tmpNext();
	}

	_reconcileProcesses(pStore, pSupervisor, pCounters, fCallback)
	{
		for (let i = 0; i < SUPERVISED_ENTITIES.length; i++)
		{
			let tmpEntity = SUPERVISED_ENTITIES[i];
			let tmpRows = pStore.list(tmpEntity.Table);

			for (let j = 0; j < tmpRows.length; j++)
			{
				let tmpRow = tmpRows[j];

				// Container-mode beacons/UVs are reconciled by _reconcileContainers
				// via docker inspect; PID checks don't apply to them.
				if ((tmpEntity.Table === 'Beacon' || tmpEntity.Table === 'UltravisorInstance') && tmpRow.Runtime === 'container') { continue; }

				pCounters.Checked++;

				let tmpPidFromFile = pSupervisor.readPidFile(tmpEntity.EntityType, tmpRow[tmpEntity.IDColumn]);
				let tmpPidToCheck = tmpPidFromFile || tmpRow.PID;
				let tmpAlive = pSupervisor.isAlive(tmpPidToCheck);
				let tmpObserved = tmpAlive ? 'running' : 'stopped';

				if (tmpAlive) { pCounters.Alive++; } else { pCounters.Dead++; }

				let tmpChanges = {};
				if (tmpRow.Status !== tmpObserved) { tmpChanges.Status = tmpObserved; }
				if (tmpPidFromFile && tmpRow.PID !== tmpPidFromFile) { tmpChanges.PID = tmpPidFromFile; }

				if (Object.keys(tmpChanges).length > 0)
				{
					pStore.update(tmpEntity.Table, tmpEntity.IDColumn, tmpRow[tmpEntity.IDColumn], tmpChanges);

					if (tmpRow.Status === 'running' && !tmpAlive)
					{
						pCounters.Drift++;
						pStore.recordEvent(
							{
								EntityType:  tmpEntity.EntityType,
								EntityID:    tmpRow[tmpEntity.IDColumn],
								EntityName:  tmpRow.Name,
								EventType:   'drift-detected',
								Severity:    'warning',
								Message:     `Process drift: state says running, no live PID on host`,
								Detail:      { PreviousPID: tmpRow.PID, PidFile: tmpPidFromFile }
							});
					}
				}
			}
		}
		return fCallback();
	}
}

module.exports = ServiceReconcileLoop;
