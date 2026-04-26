/**
 * Lab-Api-AuthProxy
 *
 * Browser-facing proxy for orator-authentication + user-management
 * routes on a target Ultravisor instance.
 *
 * Why a proxy lives in lab and not browser → ultravisor directly:
 * ===============================================================
 * Hitting ultravisor's port from the browser would either need CORS
 * configured on every supervised ultravisor (fragile, leaks ports
 * into the browser) or a tunneled fetch via lab. Tunneling through
 * lab keeps cookies same-origin and lets the operator switch which
 * ultravisor they're administering by changing one config value.
 *
 * Mounted routes:
 *   GET    /api/lab/auth/CheckSession
 *   POST   /api/lab/auth/Authenticate
 *   POST   /api/lab/auth/Deauthenticate
 *   GET    /api/lab/auth/Users[?search=…]
 *   POST   /api/lab/auth/Users
 *   GET    /api/lab/auth/User/:UserID
 *   PUT    /api/lab/auth/User/:UserID
 *   DELETE /api/lab/auth/User/:UserID
 *   POST   /api/lab/auth/User/:UserID/SetPassword
 *   POST   /api/lab/auth/Me/ChangePassword
 *
 * Each one forwards to `<targetURL>/1.0/<rest>`. Cookies, Authorization,
 * and Set-Cookie all flow through. The target URL comes from
 * `pCore.AuthTargetURL` (set at lab boot from --auth-target arg or
 * config) and can be retargeted at runtime by mutating that field
 * on the core object — no restart required.
 */

'use strict';

const libHttp = require('http');
const libHttps = require('https');
const libURL = require('url');

const FORWARD_HEADERS = ['cookie', 'authorization', 'x-api-key'];
// Routes the proxy will accept. A strict allow-list rather than a
// wildcard keeps the proxy from accidentally exposing the entire
// /1.0/ surface of the target ultravisor (which includes data-API
// routes the lab user shouldn't be reaching through this hop).
const ALLOWED_ROUTES =
[
	{ method: 'GET',    pattern: 'CheckSession' },
	{ method: 'POST',   pattern: 'Authenticate' },
	{ method: 'POST',   pattern: 'Deauthenticate' },
	{ method: 'GET',    pattern: 'Users' },
	{ method: 'POST',   pattern: 'Users' },
	{ method: 'GET',    pattern: 'User/:UserID' },
	{ method: 'PUT',    pattern: 'User/:UserID' },
	{ method: 'DEL',    pattern: 'User/:UserID' },
	{ method: 'POST',   pattern: 'User/:UserID/SetPassword' },
	{ method: 'POST',   pattern: 'Me/ChangePassword' }
];

function _proxyHandler(pCore)
{
	return function (pReq, pRes, pNext)
	{
		let tmpTarget = pCore.AuthTargetURL || '';
		if (!tmpTarget)
		{
			pRes.send(503, { Error: 'Lab auth proxy: no AuthTargetURL configured (pass --auth-target).' });
			return pNext();
		}
		// Strip the lab-side prefix and rebuild the upstream path.
		// Restify already parsed any :params; reuse pReq.url which has
		// the full querystring intact.
		let tmpURL = pReq.url || '';
		let tmpStripPrefix = '/api/lab/auth/';
		let tmpRestStart = tmpURL.indexOf(tmpStripPrefix);
		if (tmpRestStart < 0)
		{
			pRes.send(404, { Error: 'Lab auth proxy: malformed path' });
			return pNext();
		}
		let tmpRest = tmpURL.slice(tmpRestStart + tmpStripPrefix.length);
		let tmpUpstreamPath = '/1.0/' + tmpRest;

		let tmpParsed = libURL.parse(tmpTarget);
		let tmpClient = (tmpParsed.protocol === 'https:') ? libHttps : libHttp;
		let tmpHeaders = {};
		for (let i = 0; i < FORWARD_HEADERS.length; i++)
		{
			let tmpKey = FORWARD_HEADERS[i];
			if (pReq.headers[tmpKey])
			{
				tmpHeaders[tmpKey.charAt(0).toUpperCase() + tmpKey.slice(1)] = pReq.headers[tmpKey];
			}
		}

		// Reconstruct the body — restify's bodyParser parsed JSON for us.
		let tmpBodyBuffer = null;
		if (pReq.body && (pReq.method === 'POST' || pReq.method === 'PUT'))
		{
			tmpBodyBuffer = Buffer.from(JSON.stringify(pReq.body), 'utf8');
			tmpHeaders['Content-Type'] = 'application/json';
			tmpHeaders['Content-Length'] = tmpBodyBuffer.length;
		}

		let tmpReqOpts =
		{
			hostname: tmpParsed.hostname,
			port: tmpParsed.port || (tmpParsed.protocol === 'https:' ? 443 : 80),
			path: tmpUpstreamPath,
			method: pReq.method,
			headers: tmpHeaders
		};

		let tmpUpstream = tmpClient.request(tmpReqOpts, (pUpRes) =>
		{
			// Forward Set-Cookie back so login flows persist on lab's domain.
			let tmpSet = pUpRes.headers['set-cookie'];
			if (tmpSet)
			{
				try { pRes.header('Set-Cookie', tmpSet); }
				catch (pErr) { /* best-effort */ }
			}
			let tmpData = '';
			pUpRes.on('data', (pChunk) => { tmpData += pChunk; });
			pUpRes.on('end', () =>
			{
				let tmpParsedBody = null;
				try { tmpParsedBody = tmpData.length ? JSON.parse(tmpData) : {}; }
				catch (pErr) { tmpParsedBody = { Error: 'Non-JSON response from auth target', Raw: tmpData.slice(0, 200) }; }
				pRes.send(pUpRes.statusCode || 502, tmpParsedBody);
				return pNext();
			});
		});
		tmpUpstream.on('error', (pErr) =>
		{
			pRes.send(502, { Error: 'Lab auth proxy: upstream unreachable', Reason: pErr.message });
			return pNext();
		});
		if (tmpBodyBuffer) { tmpUpstream.write(tmpBodyBuffer); }
		tmpUpstream.end();
	};
}

function registerRoutes(pCore)
{
	let tmpServer = pCore.Orator.serviceServer;
	let tmpHandler = _proxyHandler(pCore);

	// Map our allow-list to restify verbs. Restify uses doGet/doPost/
	// doPut/doDelete on the typed wrapper, but the underlying
	// serviceServer accepts get/post/put/del directly — we use the
	// latter so the proxy lib needs no Restify-specific imports.
	for (let i = 0; i < ALLOWED_ROUTES.length; i++)
	{
		let tmpRoute = ALLOWED_ROUTES[i];
		let tmpPath = '/api/lab/auth/' + tmpRoute.pattern;
		switch (tmpRoute.method)
		{
			case 'GET':  tmpServer.doGet(tmpPath, tmpHandler); break;
			case 'POST': tmpServer.doPost(tmpPath, tmpHandler); break;
			case 'PUT':  tmpServer.doPut(tmpPath, tmpHandler); break;
			case 'DEL':  tmpServer.doDelete(tmpPath, tmpHandler); break;
			default: break;
		}
	}
}

module.exports = registerRoutes;
