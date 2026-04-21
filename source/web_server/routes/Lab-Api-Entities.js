/**
 * Lab-Api-Entities
 *
 * Generic list endpoints for every managed entity table.  Phase 1 only
 * needs read access -- Phase 2+ will layer POST/PUT/DELETE handlers for
 * the actual CRUD operations (create engine, start beacon, etc.).
 */
'use strict';

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
			tmpOrator.serviceServer.doGet(pSpec.Route,
				(pReq, pRes, pNext) =>
				{
					pRes.send({ Records: tmpStore.list(pSpec.Table) });
					return pNext();
				});
		})(tmpRoute);
	}
};
