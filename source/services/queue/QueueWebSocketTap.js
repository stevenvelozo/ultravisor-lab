/**
 * QueueWebSocketTap — wraps a WebSocket subscription to an Ultravisor's
 * queue.* topic and hands every envelope to a callback. Used by the
 * QueueScenarioManager to capture the full event stream for one run.
 *
 * Wire shape (mirrors Ultravisor-API-Server.cjs:3030+):
 *   - Client → server:  { Action: "QueueSubscribe", LastEventGUID: ... | null }
 *   - Server → client:  { Topic, Payload, EventGUID, Seq, EmittedAt }
 *   - Control frames:   queue.replay_begin / queue.replay_complete / queue.reset
 *
 * Lifecycle:
 *   const tmpTap = new QueueWebSocketTap({ ServerURL, OnEnvelope, OnError, OnReset });
 *   tmpTap.start();    // opens WS, sends QueueSubscribe
 *   ...
 *   tmpTap.stop();     // unsubscribes (best-effort) and closes
 *
 * Reconnection: a single retry-on-close attempt is made if start() succeeded
 * once.  The retry sends the most recent EventGUID so the hub can replay
 * missed envelopes via the existing protocol.  If the hub responds with
 * queue.reset (history-too-old), OnReset fires so the runner can mark
 * assertions as "incomplete due to lost history."
 */

'use strict';

const libWebSocket = require('ws');

const RETRY_DELAY_MS = 500;

class QueueWebSocketTap
{
	constructor(pOptions)
	{
		let tmpOptions = pOptions || {};
		this._ServerURL = tmpOptions.ServerURL || '';
		this._OnEnvelope = typeof tmpOptions.OnEnvelope === 'function' ? tmpOptions.OnEnvelope : null;
		this._OnError = typeof tmpOptions.OnError === 'function' ? tmpOptions.OnError : null;
		this._OnReset = typeof tmpOptions.OnReset === 'function' ? tmpOptions.OnReset : null;
		this._Log = tmpOptions.Log || console;

		this._Socket = null;
		this._LastEventGUID = null;
		this._RetriesUsed = 0;
		this._MaxRetries = 1;
		this._Stopped = false;
	}

	get lastEventGUID()
	{
		return this._LastEventGUID;
	}

	start()
	{
		if (!this._ServerURL) { throw new Error('QueueWebSocketTap: ServerURL is required'); }
		this._open();
	}

	stop(fCallback)
	{
		this._Stopped = true;
		if (this._Socket && this._Socket.readyState === libWebSocket.OPEN)
		{
			try { this._Socket.send(JSON.stringify({ Action: 'QueueUnsubscribe' })); }
			catch (pErr) { /* best effort */ }
			try { this._Socket.close(); }
			catch (pErr) { /* best effort */ }
		}
		this._Socket = null;
		if (typeof fCallback === 'function') { return fCallback(null); }
	}

	_open()
	{
		let tmpURL = this._toWSURL(this._ServerURL);
		let tmpSocket;
		try { tmpSocket = new libWebSocket(tmpURL); }
		catch (pErr)
		{
			this._reportError(pErr);
			return;
		}
		this._Socket = tmpSocket;

		tmpSocket.on('open', () =>
			{
				try
				{
					tmpSocket.send(JSON.stringify(
						{
							Action: 'QueueSubscribe',
							LastEventGUID: this._LastEventGUID
						}));
				}
				catch (pErr) { this._reportError(pErr); }
			});

		tmpSocket.on('message', (pData) =>
			{
				let tmpText = (typeof pData === 'string')
					? pData
					: (pData && typeof pData.toString === 'function' ? pData.toString('utf8') : '');
				if (!tmpText) { return; }
				let tmpEnvelope;
				try { tmpEnvelope = JSON.parse(tmpText); }
				catch (pErr) { return; }
				if (!tmpEnvelope || typeof tmpEnvelope !== 'object') { return; }

				if (tmpEnvelope.EventGUID) { this._LastEventGUID = tmpEnvelope.EventGUID; }

				if (tmpEnvelope.Topic === 'queue.reset' && this._OnReset)
				{
					try { this._OnReset(tmpEnvelope); }
					catch (pErr) { this._reportError(pErr); }
				}

				if (this._OnEnvelope)
				{
					try { this._OnEnvelope(tmpEnvelope); }
					catch (pErr) { this._reportError(pErr); }
				}
			});

		tmpSocket.on('error', (pErr) =>
			{
				this._reportError(pErr);
			});

		tmpSocket.on('close', () =>
			{
				if (this._Stopped) { return; }
				if (this._RetriesUsed >= this._MaxRetries) { return; }
				this._RetriesUsed++;
				setTimeout(() =>
					{
						if (!this._Stopped) { this._open(); }
					}, RETRY_DELAY_MS);
			});
	}

	_toWSURL(pHttpURL)
	{
		if (!pHttpURL) { return ''; }
		if (pHttpURL.indexOf('ws://') === 0 || pHttpURL.indexOf('wss://') === 0) { return pHttpURL; }
		if (pHttpURL.indexOf('https://') === 0) { return 'wss://' + pHttpURL.slice('https://'.length); }
		if (pHttpURL.indexOf('http://') === 0) { return 'ws://' + pHttpURL.slice('http://'.length); }
		return 'ws://' + pHttpURL;
	}

	_reportError(pErr)
	{
		if (this._OnError)
		{
			try { this._OnError(pErr); }
			catch (pInnerErr) { (this._Log.error || console.error)('QueueWebSocketTap: OnError threw: ' + pInnerErr.message); }
		}
		else
		{
			(this._Log.warn || console.warn)('QueueWebSocketTap error: ' + (pErr && pErr.message ? pErr.message : String(pErr)));
		}
	}
}

module.exports = QueueWebSocketTap;
