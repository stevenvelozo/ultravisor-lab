/**
 * Service-LabLifecycle
 *
 * One-shot cross-manager operations.  Currently just `teardown()` which
 * tears every lab-managed entity down in dependency order:
 *
 *   databeacons  -- depend on engines + ultravisors
 *   ultravisor   -- independent
 *   db engines   -- cascade to databases
 *   ingestion    -- history rows, no side effects
 *   events       -- audit log; kept for the boot event that comes next
 *
 * The underlying remove methods already handle container + child-process
 * cleanup; this service just chains them.
 */
'use strict';

const libFableServiceProviderBase = require('fable-serviceproviderbase');

class ServiceLabLifecycle extends libFableServiceProviderBase
{
	constructor(pFable, pOptions, pServiceHash)
	{
		super(pFable, pOptions, pServiceHash);

		this.serviceType = 'LabLifecycle';
	}

	teardown(fCallback)
	{
		let tmpStore = this.fable.LabStateStore;

		let tmpSummary =
		{
			Beacons:              { Attempted: 0, Removed: 0, Errors: [] },
			UltravisorInstances:  { Attempted: 0, Removed: 0, Errors: [] },
			DBEngines:            { Attempted: 0, Removed: 0, Errors: [] },
			IngestionJobsCleared: 0,
			EventsCleared:        0
		};

		this._removeAll('Beacon', 'IDBeacon', this.fable.LabBeaconManager, 'removeBeacon', tmpSummary.Beacons,
			() =>
			{
				this._removeAll('UltravisorInstance', 'IDUltravisorInstance', this.fable.LabUltravisorManager, 'removeInstance', tmpSummary.UltravisorInstances,
					() =>
					{
						this._removeAll('DBEngine', 'IDDBEngine', this.fable.LabDBEngineManager, 'removeEngine', tmpSummary.DBEngines,
							() =>
							{
								// Clear history tables -- keep the schema, just drop rows.
								// Route through the DAL so the lab has zero raw-SQL
								// against lab.db; teardown traffic is small (history
								// tables) so the per-row DELETE cost is fine.
								tmpSummary.IngestionJobsCleared = this._truncateTable(tmpStore, 'IngestionJob', 'IDIngestionJob');
								tmpSummary.EventsCleared        = this._truncateTable(tmpStore, 'InfrastructureEvent', 'IDInfrastructureEvent');

								tmpStore.recordEvent(
									{
										EntityType: 'System', EventType: 'lab-teardown', Severity: 'info',
										Message: `Environment torn down: ${tmpSummary.DBEngines.Removed} engines, ${tmpSummary.Beacons.Removed} beacons, ${tmpSummary.UltravisorInstances.Removed} ultravisors`,
										Detail:  tmpSummary
									});

								return fCallback(null, tmpSummary);
							});
					});
			});
	}

	_removeAll(pTable, pIDColumn, pManager, pRemoveMethod, pBucket, fCallback)
	{
		let tmpStore = this.fable.LabStateStore;
		let tmpRows = tmpStore.list(pTable);
		pBucket.Attempted = tmpRows.length;

		if (tmpRows.length === 0) { return fCallback(); }

		let tmpIdx = 0;
		let tmpNext = () =>
		{
			if (tmpIdx >= tmpRows.length) { return fCallback(); }
			let tmpRow = tmpRows[tmpIdx++];
			pManager[pRemoveMethod](tmpRow[pIDColumn],
				(pErr) =>
				{
					if (pErr) { pBucket.Errors.push({ ID: tmpRow[pIDColumn], Name: tmpRow.Name, Message: pErr.message }); }
					else      { pBucket.Removed++; }
					setImmediate(tmpNext);
				});
		};
		tmpNext();
	}

	/**
	 * Wipe every row of a history table by listing IDs and routing each
	 * through `LabStateStore.remove` (DAL-backed). Returns the count of
	 * rows actually removed. History tables are small (low hundreds at
	 * most); the per-row cost is cheaper than dropping into raw SQL.
	 */
	_truncateTable(pStore, pTable, pIDColumn)
	{
		let tmpRows = [];
		try { tmpRows = pStore.list(pTable); }
		catch (pListErr)
		{
			this.fable.log.warn(`LabLifecycle.teardown: list ${pTable} failed: ${pListErr.message}`);
			return 0;
		}
		let tmpRemoved = 0;
		for (let i = 0; i < tmpRows.length; i++)
		{
			try { tmpRemoved += pStore.remove(pTable, pIDColumn, tmpRows[i][pIDColumn]) || 0; }
			catch (pRemoveErr)
			{
				this.fable.log.warn(`LabLifecycle.teardown: remove ${pTable}#${tmpRows[i][pIDColumn]} failed: ${pRemoveErr.message}`);
			}
		}
		return tmpRemoved;
	}
}

module.exports = ServiceLabLifecycle;
