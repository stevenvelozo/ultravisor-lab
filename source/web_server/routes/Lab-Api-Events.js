/**
 * Lab-Api-Events
 *
 * Infrastructure event log endpoints powering the timeline view.
 */
'use strict';

module.exports = function registerEventRoutes(pCore)
{
	let tmpOrator = pCore.Orator;
	let tmpStore  = pCore.StateStore;

	tmpOrator.serviceServer.doGet('/api/lab/events',
		(pReq, pRes, pNext) =>
		{
			let tmpLimit = 200;
			if (pReq.query && pReq.query.limit)
			{
				let tmpParsed = parseInt(pReq.query.limit, 10);
				if (Number.isFinite(tmpParsed) && tmpParsed > 0 && tmpParsed <= 1000)
				{
					tmpLimit = tmpParsed;
				}
			}
			pRes.send({ Events: tmpStore.listEvents(tmpLimit) });
			return pNext();
		});

	tmpOrator.serviceServer.doPost('/api/lab/events',
		(pReq, pRes, pNext) =>
		{
			let tmpBody = pReq.body || {};
			if (!tmpBody.EventType)
			{
				pRes.send(400, { Error: 'EventType is required' });
				return pNext();
			}
			let tmpID = tmpStore.recordEvent(tmpBody);
			pRes.send({ IDInfrastructureEvent: tmpID });
			return pNext();
		});
};
