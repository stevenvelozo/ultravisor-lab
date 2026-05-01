/**
 * SyntheticBeaconHarness — wires a SyntheticBeacon-Provider into a
 * BeaconClient. Used in two ways:
 *   1. Child-process mode: spawned by the lab's QueueScenarioManager via
 *      bin/synthetic-beacon-runner.js, lives only for the duration of a
 *      scenario, never registered as a Beacon row.
 *   2. Docker mode: lab-local beacon type (lab-synthetic-beacon) goes
 *      through LabBeaconManager + LabBeaconContainerManager. The container
 *      entrypoint is the same bin script.
 *
 * Both paths exercise the same harness; only the lifecycle owner differs.
 */

const libHTTP = require('http');
const libBeaconClient = require('ultravisor-beacon/source/Ultravisor-Beacon-Client.cjs');
const libSyntheticProvider = require('./SyntheticBeacon-Provider.cjs');

class SyntheticBeaconHarness
{
	constructor(pOptions)
	{
		let tmpOptions = pOptions || {};

		this._UltravisorURL = tmpOptions.UltravisorURL || 'http://localhost:54321';
		this._BeaconName = tmpOptions.BeaconName || 'synthetic-beacon';
		this._JoinSecret = tmpOptions.JoinSecret || '';
		this._MaxConcurrent = Number.isFinite(tmpOptions.MaxConcurrent) ? tmpOptions.MaxConcurrent : 1;
		this._StagingPath = tmpOptions.StagingPath || process.cwd();
		this._Log = tmpOptions.Log || console;

		// Optional HTTP listener mode.  When BindPort is set, the
		// harness spins up a tiny HTTP server (any GET returns 200) and
		// advertises {Protocol, IP, Port} in BindAddresses so UV's
		// reachability prober can verify direct beacon-to-beacon
		// connectivity.  Used by the lab fleet to exercise the direct
		// transport path that would otherwise be unrepresentable when
		// every beacon is a WS-only client.
		this._BindPort = Number.isFinite(tmpOptions.BindPort) ? tmpOptions.BindPort : 0;
		this._BindIP = tmpOptions.BindIP || '127.0.0.1';
		this._BindProtocol = tmpOptions.BindProtocol || 'http';
		// AdvertiseIP is what we put in BindAddresses for other peers
		// to dial.  Distinct from BindIP because UV often runs in a
		// container while the synthetic beacons run on the host: bind
		// on 0.0.0.0 to listen everywhere, advertise host.docker.internal
		// so the container's probe can reach back.  Defaults to BindIP
		// when not set, preserving the host-only single-process case.
		this._AdvertiseIP = tmpOptions.AdvertiseIP || tmpOptions.BindIP || '127.0.0.1';
		this._HTTPServer = null;

		this._Provider = new libSyntheticProvider(
			{
				Capability: tmpOptions.Capability || 'Synthetic',
				Actions: Array.isArray(tmpOptions.Actions) ? tmpOptions.Actions : ['Process'],
				DefaultDurationMs: tmpOptions.DefaultDurationMs
			});

		this._Client = null;
	}

	start(fCallback)
	{
		let fStartClient = () =>
		{
			let tmpClientConfig =
				{
					ServerURL: this._UltravisorURL,
					Name: this._BeaconName,
					MaxConcurrent: this._MaxConcurrent,
					StagingPath: this._StagingPath,
					JoinSecret: this._JoinSecret,
					Providers: [ this._Provider ],
					HeartbeatIntervalMs: 30000,
					Tags: { Role: 'synthetic-load', Capability: this._Provider.Capability }
				};

			if (this._BindPort > 0)
			{
				tmpClientConfig.BindAddresses =
				[
					{ Protocol: this._BindProtocol, IP: this._AdvertiseIP, Port: this._BindPort }
				];
			}

			this._Client = new libBeaconClient(tmpClientConfig);
			this._Client.start((pError, pBeacon) =>
				{
					if (pError)
					{
						(this._Log.error || console.error)(
							`SyntheticBeaconHarness: start failed: ${pError.message}`);
						return fCallback ? fCallback(pError) : null;
					}
					let tmpID = (pBeacon && pBeacon.BeaconID) || (pBeacon && pBeacon.beaconID) || '';
					(this._Log.info || this._Log.log || console.log)(
						`SyntheticBeaconHarness: connected as ${tmpID || this._BeaconName} ` +
						`(capability=${this._Provider.Capability}, max-concurrent=${this._MaxConcurrent}` +
						(this._BindPort > 0
							? `, bind=${this._BindIP}:${this._BindPort}, advertise=${this._BindProtocol}://${this._AdvertiseIP}:${this._BindPort}`
							: '') +
						')');
					return fCallback ? fCallback(null, tmpID) : null;
				});
		};

		if (this._BindPort > 0)
		{
			this._startHTTPListener((pErr) =>
				{
					if (pErr)
					{
						(this._Log.error || console.error)(
							`SyntheticBeaconHarness: listener bind failed on ${this._BindIP}:${this._BindPort}: ${pErr.message}`);
						return fCallback ? fCallback(pErr) : null;
					}
					fStartClient();
				});
		}
		else
		{
			fStartClient();
		}
	}

	// Tiny GET-anything-returns-200 HTTP server.  The probe in
	// Ultravisor-Beacon-Reachability.cjs treats any HTTP response as
	// "reachable" — we don't need to honor specific paths.
	_startHTTPListener(fCallback)
	{
		this._HTTPServer = libHTTP.createServer((pReq, pRes) =>
		{
			pRes.statusCode = 200;
			pRes.setHeader('Content-Type', 'application/json');
			pRes.end(JSON.stringify({
				Beacon: this._BeaconName,
				Capability: this._Provider.Capability,
				Probe: 'ok'
			}));
		});
		this._HTTPServer.on('error', (pErr) => fCallback(pErr));
		this._HTTPServer.listen(this._BindPort, this._BindIP, () => fCallback(null));
	}

	stop(fCallback)
	{
		let fStopHTTP = (fNext) =>
		{
			if (!this._HTTPServer) { return fNext(); }
			try { this._HTTPServer.close(() => fNext()); }
			catch (pErr) { fNext(); }
		};

		if (this._Client && typeof this._Client.stop === 'function')
		{
			return this._Client.stop((pError) =>
			{
				fStopHTTP(() => fCallback ? fCallback(pError) : null);
			});
		}
		return fStopHTTP(() => fCallback ? fCallback(null) : null);
	}
}

module.exports = SyntheticBeaconHarness;
