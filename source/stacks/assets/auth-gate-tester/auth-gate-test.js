'use strict';

/**
 * auth-gate-test — one-shot assertion runner for the ultravisor-lab
 * "auth-gate-test" stack.
 *
 * Exercises every layer of Ultravisor's secured-mode authentication gate
 * end-to-end, against a live secured (UltravisorNonPromiscuous=true)
 * Ultravisor with an ultravisor-auth-beacon attached:
 *
 *   1. /status reports AuthMode=authenticated (the secured flag is honoured).
 *   2. A management read (GET /Beacon) is 401 with no session.
 *   3. A WebSocket Subscribe is rejected (execution.auth_required + close 1008)
 *      with no session.
 *   4. POST /1.0/Authenticate (admin creds) yields a session cookie.
 *   5. The same management read is 200 with that cookie.
 *   6. A WebSocket Subscribe is accepted with that cookie.
 *
 * Steps 1-3 prove the gate is armed by the flag (they pass before the
 * auth-beacon even matters); steps 4-6 prove a real credential opens both the
 * HTTP and WS surfaces. Exits 0 iff every check passes.
 *
 * Config via env (all have stack-provided defaults):
 *   UV_URL          base URL of the Ultravisor      (http://ultravisor:54321)
 *   UV_WS_URL       WebSocket URL                    (derived from UV_URL)
 *   UV_USER/UV_PASS admin credentials                (admin / admin)
 *   UV_RETRIES      poll attempts for boot + login   (40, 2s apart)
 */

const libHttp = require('http');
const WebSocket = require('ws');

const UV_URL = process.env.UV_URL || 'http://ultravisor:54321';
const WS_URL = process.env.UV_WS_URL || (UV_URL.replace(/^http/, 'ws') + '/');
const USER = process.env.UV_USER || 'admin';
const PASS = process.env.UV_PASS || 'admin';
const RETRIES = parseInt(process.env.UV_RETRIES || '40', 10);
const RETRY_DELAY_MS = 2000;

let gPassed = 0;
let gFailed = 0;

function check(pLabel, pOk, pDetail)
{
	if (pOk)
	{
		gPassed++;
		console.log('  ✓ PASS  ' + pLabel);
	}
	else
	{
		gFailed++;
		console.log('  ✗ FAIL  ' + pLabel + (pDetail ? '  — ' + pDetail : ''));
	}
}

function sleep(pMs)
{
	return new Promise(function (resolve) { setTimeout(resolve, pMs); });
}

function request(pMethod, pPath, pOptions)
{
	pOptions = pOptions || {};
	return new Promise(function (resolve, reject)
	{
		let tmpURL = new URL(UV_URL + pPath);
		let tmpBody = pOptions.body ? JSON.stringify(pOptions.body) : null;
		let tmpHeaders = Object.assign({}, pOptions.headers || {});
		if (tmpBody)
		{
			tmpHeaders['Content-Type'] = 'application/json';
			tmpHeaders['Content-Length'] = Buffer.byteLength(tmpBody);
		}
		let tmpReq = libHttp.request(
			{
				method: pMethod,
				hostname: tmpURL.hostname,
				port: tmpURL.port,
				path: tmpURL.pathname + tmpURL.search,
				headers: tmpHeaders
			},
			function (pResponse)
			{
				let tmpData = '';
				pResponse.on('data', function (pChunk) { tmpData += pChunk; });
				pResponse.on('end', function ()
				{
					resolve({ status: pResponse.statusCode, headers: pResponse.headers, body: tmpData });
				});
			});
		tmpReq.on('error', reject);
		if (tmpBody) { tmpReq.write(tmpBody); }
		tmpReq.end();
	});
}

// Open a WS, send a Subscribe frame, and report what came back.
// Resolves { frames: [...], closeCode, timedOut }.
function wsSubscribe(pCookie)
{
	return new Promise(function (resolve)
	{
		let tmpOptions = pCookie ? { headers: { Cookie: pCookie } } : {};
		let tmpWS = new WebSocket(WS_URL, tmpOptions);
		let tmpFrames = [];
		let tmpDone = false;
		function finish(pExtra)
		{
			if (tmpDone) { return; }
			tmpDone = true;
			try { tmpWS.terminate(); } catch (pErr) { /* ignore */ }
			resolve(Object.assign({ frames: tmpFrames }, pExtra || {}));
		}
		tmpWS.on('open', function () { tmpWS.send(JSON.stringify({ Action: 'Subscribe', RunHash: 'auth-gate-probe' })); });
		tmpWS.on('message', function (pMsg) { try { tmpFrames.push(JSON.parse(pMsg.toString())); } catch (pErr) { /* ignore */ } });
		tmpWS.on('close', function (pCode) { finish({ closeCode: pCode }); });
		tmpWS.on('error', function () { finish({ error: true }); });
		// A successful (authorized) subscribe stays open with no events for our
		// fake run hash — treat a quiet socket as "accepted".
		setTimeout(function () { finish({ timedOut: true }); }, 4000);
	});
}

async function main()
{
	console.log('[auth-gate-test] target=' + UV_URL + ' ws=' + WS_URL + ' user=' + USER);
	console.log('');

	// --- Wait for the Ultravisor to answer at all. ---
	let tmpUp = false;
	for (let i = 0; i < RETRIES; i++)
	{
		try { let r = await request('GET', '/status'); if (r.status === 200) { tmpUp = true; break; } }
		catch (pErr) { /* not up yet */ }
		await sleep(RETRY_DELAY_MS);
	}
	check('Ultravisor /status is reachable', tmpUp);
	if (!tmpUp) { return finishRun(); }

	// --- 1. /status reports secured (flag-driven authenticated mode). ---
	let tmpStatus = await request('GET', '/status');
	let tmpStatusBody = {};
	try { tmpStatusBody = JSON.parse(tmpStatus.body); } catch (pErr) { /* leave {} */ }
	check('/status reports AuthMode=authenticated (secured by the flag)',
		tmpStatusBody.AuthMode === 'authenticated', 'got AuthMode=' + tmpStatusBody.AuthMode);

	// --- 2. Management read is 401 without a session. ---
	let tmpNoAuth = await request('GET', '/Beacon');
	check('GET /Beacon → 401 without a session', tmpNoAuth.status === 401, 'got HTTP ' + tmpNoAuth.status);

	// --- 3. WS Subscribe rejected without a session. ---
	let tmpWsNoAuth = await wsSubscribe(null);
	let tmpWsRejected = (tmpWsNoAuth.closeCode === 1008)
		|| tmpWsNoAuth.frames.some(function (f) { return f && f.EventType === 'execution.auth_required'; });
	check('WS Subscribe rejected without a session (auth_required + close 1008)',
		tmpWsRejected, JSON.stringify({ closeCode: tmpWsNoAuth.closeCode, frames: tmpWsNoAuth.frames }));

	// --- 4. Login — retry until the auth-beacon is connected to validate it. ---
	let tmpCookie = null;
	for (let i = 0; i < RETRIES; i++)
	{
		let r = await request('POST', '/1.0/Authenticate', { body: { UserName: USER, Password: PASS } });
		let tmpSetCookie = r.headers['set-cookie'];
		if (r.status === 200 && tmpSetCookie && tmpSetCookie.length)
		{
			tmpCookie = tmpSetCookie[0].split(';')[0];
			break;
		}
		await sleep(RETRY_DELAY_MS);
	}
	check('POST /1.0/Authenticate yields a session cookie', !!tmpCookie);
	if (!tmpCookie) { return finishRun(); }

	// --- 5. Management read is 200 with the session cookie. ---
	let tmpAuthed = await request('GET', '/Beacon', { headers: { Cookie: tmpCookie } });
	check('GET /Beacon → 200 with a valid session', tmpAuthed.status === 200, 'got HTTP ' + tmpAuthed.status);

	// --- 6. WS Subscribe accepted with the session cookie. ---
	let tmpWsAuth = await wsSubscribe(tmpCookie);
	let tmpWsAccepted = (tmpWsAuth.closeCode !== 1008)
		&& !tmpWsAuth.frames.some(function (f) { return f && f.EventType === 'execution.auth_required'; });
	check('WS Subscribe accepted with a valid session',
		tmpWsAccepted, JSON.stringify({ closeCode: tmpWsAuth.closeCode, frames: tmpWsAuth.frames }));

	return finishRun();
}

function finishRun()
{
	console.log('');
	console.log('[auth-gate-test] ' + gPassed + ' passed, ' + gFailed + ' failed');
	console.log('[auth-gate-test] ' + (gFailed === 0 ? 'ALL CHECKS PASSED ✓' : 'FAILURES DETECTED ✗'));
	process.exit(gFailed === 0 ? 0 : 1);
}

main().catch(function (pErr)
{
	console.error('[auth-gate-test] fatal error:', pErr && pErr.message ? pErr.message : pErr);
	process.exit(1);
});
