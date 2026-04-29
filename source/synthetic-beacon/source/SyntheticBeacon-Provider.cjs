/**
 * SyntheticBeacon-Provider — capability provider for the lab's queue-testing
 * harness. Lives inside ultravisor-lab (not a standalone module) and is only
 * intended for synthetic load: each action is a sleep with optional jitter,
 * synthetic-failure injection, and shaped Output payloads.
 *
 * Construct with { Capability, Actions: string[], DefaultDurationMs }. The
 * provider advertises one Capability whose name comes from config, and a
 * map of Actions whose names also come from config. The work item's
 * Settings drive per-call behavior:
 *
 *   DurationMs   how long the action sleeps before completing
 *   JitterMs     +/- variance applied to DurationMs (uniform, clamped >= 0)
 *   FailRate     0..1 probability of synthetic failure
 *   LogLines     number of fake log lines to emit in the Log array
 *   OutputBytes  size of a filler "Payload" string in Outputs
 *
 * The work-item-level Settings always win over the provider-level defaults.
 */

const libBeaconCapabilityProvider = require('ultravisor-beacon/source/Ultravisor-Beacon-CapabilityProvider.cjs');

const PROGRESS_INTERVAL_MS = 250;

class SyntheticBeaconCapabilityProvider extends libBeaconCapabilityProvider
{
	constructor(pProviderConfig)
	{
		super(pProviderConfig);

		let tmpConfig = pProviderConfig || {};
		let tmpCapability = tmpConfig.Capability || 'Synthetic';
		let tmpActions = Array.isArray(tmpConfig.Actions) && tmpConfig.Actions.length > 0
			? tmpConfig.Actions.slice()
			: ['Process'];

		this.Name = tmpCapability;
		this.Capability = tmpCapability;

		this._ConfiguredActions = tmpActions;
		this._DefaultDurationMs = Number.isFinite(tmpConfig.DefaultDurationMs)
			? tmpConfig.DefaultDurationMs
			: 2000;
	}

	get actions()
	{
		let tmpMap = {};
		for (let i = 0; i < this._ConfiguredActions.length; i++)
		{
			let tmpAction = this._ConfiguredActions[i];
			tmpMap[tmpAction] =
				{
					Description: `Synthetic ${this.Capability}/${tmpAction}: sleeps for the configured duration.`,
					SettingsSchema:
					[
						{ Name: 'DurationMs',  DataType: 'Number', Required: false },
						{ Name: 'JitterMs',    DataType: 'Number', Required: false },
						{ Name: 'FailRate',    DataType: 'Number', Required: false },
						{ Name: 'LogLines',    DataType: 'Number', Required: false },
						{ Name: 'OutputBytes', DataType: 'Number', Required: false }
					]
				};
		}
		return tmpMap;
	}

	getCapabilities()
	{
		return [this.Capability];
	}

	execute(pAction, pWorkItem, pContext, fCallback, fReportProgress)
	{
		if (this._ConfiguredActions.indexOf(pAction) < 0)
		{
			return fCallback(null,
				{
					Outputs: { Success: false, Reason: `Unknown action: ${pAction}` },
					Log: [`Synthetic ${this.Capability}: unknown action [${pAction}]`]
				});
		}

		let tmpSettings = (pWorkItem && pWorkItem.Settings) || {};
		let tmpBaseDuration = Number.isFinite(tmpSettings.DurationMs)
			? tmpSettings.DurationMs
			: this._DefaultDurationMs;
		let tmpJitter = Number.isFinite(tmpSettings.JitterMs) ? tmpSettings.JitterMs : 0;
		let tmpFailRate = Number.isFinite(tmpSettings.FailRate) ? tmpSettings.FailRate : 0;

		let tmpDuration = tmpBaseDuration + ((Math.random() - 0.5) * 2 * tmpJitter);
		if (tmpDuration < 0) { tmpDuration = 0; }

		let tmpStartedAt = Date.now();
		let tmpProgressTimer = null;
		let tmpCompletionTimer = null;
		let tmpFinished = false;

		let fFinish = (pError, pResult) =>
		{
			if (tmpFinished) { return; }
			tmpFinished = true;
			if (tmpProgressTimer) { clearInterval(tmpProgressTimer); tmpProgressTimer = null; }
			if (tmpCompletionTimer) { clearTimeout(tmpCompletionTimer); tmpCompletionTimer = null; }
			return fCallback(pError, pResult);
		};

		if (typeof fReportProgress === 'function')
		{
			tmpProgressTimer = setInterval(() =>
				{
					let tmpElapsed = Date.now() - tmpStartedAt;
					let tmpPercent = tmpDuration > 0 ? Math.min(99, Math.floor((tmpElapsed / tmpDuration) * 100)) : 99;
					try
					{
						fReportProgress(
							{
								Percent: tmpPercent,
								Message: `Synthetic ${this.Capability}/${pAction} ${tmpPercent}%`
							});
					}
					catch (pErr) { /* fire-and-forget; the harness side decides what to do */ }
				}, PROGRESS_INTERVAL_MS);
			if (tmpProgressTimer.unref) { tmpProgressTimer.unref(); }
		}

		let tmpWillFail = tmpFailRate > 0 && Math.random() < tmpFailRate;
		if (tmpWillFail)
		{
			let tmpFailAt = tmpDuration * (0.3 + Math.random() * 0.4);
			tmpCompletionTimer = setTimeout(() =>
				{
					fFinish(new Error(`synthetic-failure: ${this.Capability}/${pAction}`));
				}, tmpFailAt);
			if (tmpCompletionTimer.unref) { tmpCompletionTimer.unref(); }
			return;
		}

		tmpCompletionTimer = setTimeout(() =>
			{
				let tmpFinishedAt = Date.now();
				let tmpLog = [`Synthetic ${this.Capability}/${pAction} completed in ${tmpFinishedAt - tmpStartedAt}ms`];
				let tmpLogLines = Number.isFinite(tmpSettings.LogLines) ? tmpSettings.LogLines : 0;
				for (let i = 0; i < tmpLogLines; i++)
				{
					tmpLog.push(`Synthetic log line ${i + 1}`);
				}

				let tmpOutputs =
					{
						Action:        pAction,
						Capability:    this.Capability,
						DurationMs:    Math.round(tmpDuration),
						StartedAtMs:   tmpStartedAt,
						FinishedAtMs:  tmpFinishedAt,
						ElapsedMs:     tmpFinishedAt - tmpStartedAt
					};

				let tmpOutputBytes = Number.isFinite(tmpSettings.OutputBytes) ? tmpSettings.OutputBytes : 0;
				if (tmpOutputBytes > 0)
				{
					tmpOutputs.Payload = 'x'.repeat(tmpOutputBytes);
				}

				fFinish(null, { Outputs: tmpOutputs, Log: tmpLog });
			}, tmpDuration);
		if (tmpCompletionTimer.unref) { tmpCompletionTimer.unref(); }
	}
}

module.exports = SyntheticBeaconCapabilityProvider;
