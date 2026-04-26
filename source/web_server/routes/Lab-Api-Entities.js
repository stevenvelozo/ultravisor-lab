/**
 * Lab-Api-Entities
 *
 * Generic list endpoints for every managed entity table.  Phase 1 only
 * needs read access -- Phase 2+ will layer POST/PUT/DELETE handlers for
 * the actual CRUD operations (create engine, start beacon, etc.).
 */
'use strict';

// Per-table scrubbers strip sensitive fields before sending records to the
// browser. The state store keeps the full record on disk; this is the
// boundary where we narrow the projection for public consumers.
const SCRUBBERS =
{
	UltravisorInstance: function (pRow)
	{
		// BootstrapAuthSecret is per-instance non-promiscuous-mode admission
		// material. The lab's auth-beacon spawn flow (Layer B) and bootstrap-
		// admin flow (Layer C) read it directly from the state store; it
		// should never travel over the wire to the browser.
		if (!pRow) return pRow;
		let tmpOut = Object.assign({}, pRow);
		delete tmpOut.BootstrapAuthSecret;
		return tmpOut;
	}
};

const ENTITY_ROUTES =
[
	{ Route: '/api/lab/db-engines',           Table: 'DBEngine'           },
	{ Route: '/api/lab/databases',            Table: 'Database'           },
	{ Route: '/api/lab/ultravisor-instances', Table: 'UltravisorInstance' },
	{ Route: '/api/lab/beacons',              Table: 'Beacon'             },
	{ Route: '/api/lab/facto-instances',      Table: 'FactoInstance'      },
	{ Route: '/api/lab/ingestion-jobs',       Table: 'IngestionJob'       }
];

module.exports = function registerEntityRoutes(pCore)
{
	let tmpOrator = pCore.Orator;
	let tmpStore  = pCore.StateStore;

	for (let i = 0; i < ENTITY_ROUTES.length; i++)
	{
		let tmpRoute = ENTITY_ROUTES[i];
		// Capture into a closure so each route has its own table binding.
		(function registerOne(pSpec)
		{
			let tmpScrubber = SCRUBBERS[pSpec.Table];
			tmpOrator.serviceServer.doGet(pSpec.Route,
				(pReq, pRes, pNext) =>
				{
					let tmpRows = tmpStore.list(pSpec.Table);
					if (tmpScrubber) tmpRows = tmpRows.map(tmpScrubber);
					pRes.send({ Records: tmpRows });
					return pNext();
				});
		})(tmpRoute);
	}
};
