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
					`(capability=${this._Provider.Capability}, max-concurrent=${this._MaxConcurrent})`);
				return fCallback ? fCallback(null, tmpID) : null;
			});
	}

	stop(fCallback)
	{
		if (this._Client && typeof this._Client.stop === 'function')
		{
			return this._Client.stop((pError) => fCallback ? fCallback(pError) : null);
		}
		return fCallback ? fCallback(null) : null;
	}
}

module.exports = SyntheticBeaconHarness;
