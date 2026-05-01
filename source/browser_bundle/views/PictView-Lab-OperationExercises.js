/**
 * PictView-Lab-OperationExercises
 *
 * Tab for the operation-exercise harness: pick a target Ultravisor, browse
 * exercise catalog, run exercises, and inspect recent run verdicts.
 * Replaces the Beacon Exercises tab's "Live queue" board with a per-
 * operation status table that lists each tracked RunHash.
 *
 * Data flow: persisted state lives in `AppData.Lab.OperationExercises`.
 * Derived display records land in `AppData.Lab.Computed.OperationExercises`
 * during onBeforeRender.
 */
'use strict';

const libPictView = require('pict-view');

const _ViewConfiguration =
{
	ViewIdentifier:            'Lab-OperationExercises',
	DefaultRenderable:         'Lab-OperationExercises-Main',
	DefaultDestinationAddress: '#Lab-Content-Container',

	AutoRender: false,

	CSS: /*css*/`
.lab-opex { padding: 20px; display: flex; flex-direction: column; gap: 16px; }
.lab-opex-toolbar { display: flex; align-items: center; justify-content: space-between; }
.lab-opex-toolbar h2 { margin: 0; font-size: 16px; color: #0f172a; }

.lab-opex-targets
{
	background: #fff; border: 1px solid #e2e8f0; border-radius: 8px; padding: 14px 18px;
	display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 10px 20px;
	align-items: start;
}
.lab-opex-targets label
{
	display: flex; flex-direction: column; gap: 4px;
	font-size: 12px; font-weight: 600; color: #475569;
	text-transform: uppercase; letter-spacing: 0.3px;
}
.lab-opex-targets select
{
	font-family: inherit; font-size: 14px; padding: 7px 10px;
	border: 1px solid #cbd5e1; border-radius: 6px; background: #fff; color: #0f172a;
	box-sizing: border-box; height: 36px; line-height: 1.2;
}

.lab-opex-cards { display: grid; grid-template-columns: repeat(auto-fit, minmax(320px, 1fr)); gap: 16px; }
.lab-opex-card
{
	background: #fff; border: 1px solid #e2e8f0; border-radius: 8px; padding: 16px 18px;
	display: flex; flex-direction: column; gap: 10px;
}
.lab-opex-card h3 { margin: 0; font-size: 15px; color: #0f172a; }
.lab-opex-card .lab-opex-desc { font-size: 13px; color: #475569; line-height: 1.5; }
.lab-opex-card .lab-opex-meta
{
	display: flex; flex-wrap: wrap; gap: 12px;
	padding: 8px 10px; background: #f8fafc; border-radius: 6px;
	font-size: 12px; color: #475569;
}
.lab-opex-card .lab-opex-meta .k
{
	font-size: 11px; text-transform: uppercase; letter-spacing: 0.3px; color: #64748b;
}
.lab-opex-card .lab-opex-meta .v { color: #0f172a; font-weight: 500; }
.lab-opex-card-actions { display: flex; justify-content: flex-end; gap: 8px; margin-top: 4px; }

.lab-opex-empty
{
	padding: 32px 20px; text-align: center; color: #64748b;
	background: #fff; border: 1px dashed #cbd5e1; border-radius: 8px;
}

.lab-opex-active-block { background: #fff; border: 1px solid #e2e8f0; border-radius: 8px; overflow: hidden; }
.lab-opex-active-block h3
{
	margin: 0; padding: 12px 18px; background: #f8fafc;
	border-bottom: 1px solid #e2e8f0; font-size: 13px; color: #475569;
	font-weight: 600; text-transform: uppercase; letter-spacing: 0.3px;
}
.lab-opex-active-block table { width: 100%; border-collapse: collapse; font-size: 12.5px; }
.lab-opex-active-block th, .lab-opex-active-block td
{
	padding: 8px 14px; text-align: left; border-bottom: 1px solid #f1f5f9; vertical-align: top;
}
.lab-opex-active-block th { background: #fcfcfd; color: #64748b; font-weight: 600; font-size: 11px; text-transform: uppercase; letter-spacing: 0.3px; }
.lab-opex-active-block tr:last-child td { border-bottom: none; }
.lab-opex-active-empty { padding: 12px 18px; text-align: center; color: #64748b; font-size: 12px; }

.lab-opex-runs-block { background: #fff; border: 1px solid #e2e8f0; border-radius: 8px; overflow: hidden; }
.lab-opex-runs-block h3
{
	margin: 0; padding: 12px 18px; background: #f8fafc;
	border-bottom: 1px solid #e2e8f0; font-size: 13px; color: #475569;
	font-weight: 600; text-transform: uppercase; letter-spacing: 0.3px;
}
.lab-opex-runs-block table { width: 100%; border-collapse: collapse; font-size: 12.5px; }
.lab-opex-runs-block th, .lab-opex-runs-block td
{
	padding: 8px 14px; text-align: left; border-bottom: 1px solid #f1f5f9; vertical-align: top;
}
.lab-opex-runs-block th { background: #fcfcfd; color: #64748b; font-weight: 600; font-size: 11px; text-transform: uppercase; letter-spacing: 0.3px; }
.lab-opex-runs-block tr:last-child td { border-bottom: none; }
.lab-opex-runs-block .pill
{
	display: inline-block; padding: 2px 10px; border-radius: 10px; font-size: 11px;
	font-weight: 600; text-transform: uppercase; letter-spacing: 0.3px;
}
.lab-opex-runs-block .pill.complete           { background: #dcfce7; color: #166534; }
.lab-opex-runs-block .pill.failed-assertions  { background: #fef3c7; color: #92400e; }
.lab-opex-runs-block .pill.failed             { background: #fee2e2; color: #991b1b; }
.lab-opex-runs-block .pill.timed-out          { background: #fef3c7; color: #92400e; }
.lab-opex-runs-block .pill.canceled           { background: #e2e8f0; color: #475569; }
.lab-opex-runs-block .pill.running            { background: #dbeafe; color: #1e40af; }
.lab-opex-runs-block .pill.stalled            { background: #fef3c7; color: #b45309; }
.lab-opex-runs-block .lab-opex-verdicts
{
	font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 11px;
	background: #f8fafc; padding: 8px 10px; border-radius: 4px; color: #334155;
	white-space: pre-wrap; word-break: break-word; max-width: 100%; overflow: auto; max-height: 240px;
}
.lab-opex-runs-block .lab-opex-verdict-row
{
	display: flex; gap: 8px; align-items: center; padding: 2px 0;
}
.lab-opex-runs-block .lab-opex-verdict-row.pass::before { content: '\\2713'; color: #166534; font-weight: 700; }
.lab-opex-runs-block .lab-opex-verdict-row.fail::before { content: '\\2717'; color: #991b1b; font-weight: 700; }

.lab-btn { background: #1d4ed8; color: #fff; border: 1px solid #1d4ed8; border-radius: 6px; padding: 6px 14px; font-size: 13px; font-weight: 500; cursor: pointer; }
a.lab-btn { text-decoration: none; display: inline-flex; align-items: center; justify-content: center; }
.lab-btn:hover { background: #1e40af; border-color: #1e40af; }
.lab-btn.secondary { background: transparent; color: #0f172a; border-color: #cbd5e1; }
.lab-btn.secondary:hover { background: #f1f5f9; border-color: #94a3b8; }
.lab-btn.small { padding: 4px 10px; font-size: 12px; }
.lab-btn:disabled, .lab-btn.disabled { opacity: 0.5; cursor: not-allowed; pointer-events: none; }
`,

	Templates:
	[
		{
			Hash: 'Lab-OperationExercises-Main-Template',
			Template: /*html*/`
<div class="lab-opex">
	<div class="lab-opex-toolbar">
		<h2>Operation Exercises</h2>
	</div>
	<div class="lab-opex-targets">
		<label>Target Ultravisor
			<select id="Lab-OperationExercises-Targets-Ultravisor" onchange="{~P~}.PictApplication.navigateTo('/operationexercises/select-uv')">{~TS:Lab-OperationExercises-TargetOption-Template:AppData.Lab.Computed.OperationExercises.UltravisorOptions~}</select>
		</label>
	</div>
	<div id="Lab-OperationExercises-ActiveSlot"></div>
	<div id="Lab-OperationExercises-CardsSlot"></div>
	<div id="Lab-OperationExercises-RunsSlot"></div>
</div>`
		},
		{
			Hash: 'Lab-OperationExercises-TargetOption-Template',
			Template: /*html*/`<option value="{~D:Record.Value~}" {~D:Record.SelectedAttr~} {~D:Record.DisabledAttr~}>{~D:Record.Label~}</option>`
		},
		{
			Hash: 'Lab-OperationExercises-Active-Template',
			Template: /*html*/`{~TS:Lab-OperationExercises-ActiveBlock-Template:AppData.Lab.Computed.OperationExercises.ActiveSlot~}`
		},
		{
			Hash: 'Lab-OperationExercises-ActiveBlock-Template',
			Template: /*html*/`
<div class="lab-opex-active-block">
	<h3>Active operation runs</h3>
	{~TS:Lab-OperationExercises-ActiveTable-Template:Record.RowsWrap~}
	{~TS:Lab-OperationExercises-ActiveEmpty-Template:Record.EmptyWrap~}
</div>`
		},
		{
			Hash: 'Lab-OperationExercises-ActiveTable-Template',
			Template: /*html*/`
<table>
	<thead>
		<tr><th>Run hash</th><th>Operation</th><th>State</th><th>Started</th><th>Duration</th></tr>
	</thead>
	<tbody>{~TS:Lab-OperationExercises-ActiveRow-Template:Record.Rows~}</tbody>
</table>`
		},
		{
			Hash: 'Lab-OperationExercises-ActiveRow-Template',
			Template: /*html*/`<tr><td>{~D:Record.RunHash~}</td><td>{~D:Record.OperationHash~}</td><td>{~D:Record.State~}</td><td>{~D:Record.Started~}</td><td>{~D:Record.Duration~}</td></tr>`
		},
		{
			Hash: 'Lab-OperationExercises-ActiveEmpty-Template',
			Template: /*html*/`<div class="lab-opex-active-empty">No operation runs being tracked from the most recent exercise.</div>`
		},
		{
			Hash: 'Lab-OperationExercises-Cards-Template',
			Template: /*html*/`
{~TS:Lab-OperationExercises-Empty-Template:AppData.Lab.Computed.OperationExercises.EmptySlot~}
{~TS:Lab-OperationExercises-CardsContainer-Template:AppData.Lab.Computed.OperationExercises.ListSlot~}`
		},
		{
			Hash: 'Lab-OperationExercises-Empty-Template',
			Template: /*html*/`<div class="lab-opex-empty">No operation exercises found under <code>operation_exercises/</code>.</div>`
		},
		{
			Hash: 'Lab-OperationExercises-CardsContainer-Template',
			Template: /*html*/`<div class="lab-opex-cards">{~TS:Lab-OperationExercises-Card-Template:Record.Cards~}</div>`
		},
		{
			Hash: 'Lab-OperationExercises-Card-Template',
			Template: /*html*/`
<div class="lab-opex-card">
	<h3>{~D:Record.Name~}</h3>
	<div class="lab-opex-desc">{~D:Record.Description~}</div>
	<div class="lab-opex-meta">
		<span><span class="k">Operations:</span> <span class="v">{~D:Record.OperationCount~}</span></span>
		<span><span class="k">Kicks:</span> <span class="v">{~D:Record.KickCount~}</span></span>
		<span><span class="k">Fleet beacons:</span> <span class="v">{~D:Record.BeaconCount~}</span></span>
	</div>
	<div class="lab-opex-card-actions">
		<a class="lab-btn {~D:Record.Disabled~}" href="#/operationexercises/{~D:Record.Hash~}/run" title="{~D:Record.Hint~}">Run on Ultravisor &rarr;</a>
	</div>
</div>`
		},
		{
			Hash: 'Lab-OperationExercises-Runs-Template',
			Template: /*html*/`{~TS:Lab-OperationExercises-RunsBlock-Template:AppData.Lab.Computed.OperationExercises.RunsSlot~}`
		},
		{
			Hash: 'Lab-OperationExercises-RunsBlock-Template',
			Template: /*html*/`
<div class="lab-opex-runs-block">
	<h3>Recent runs</h3>
	<table>
		<thead>
			<tr>
				<th>Started</th>
				<th>Exercise</th>
				<th>Status</th>
				<th>Duration</th>
				<th>Operations</th>
				<th>Verdicts</th>
			</tr>
		</thead>
		<tbody>{~TS:Lab-OperationExercises-RunRow-Template:Record.Rows~}</tbody>
	</table>
</div>`
		},
		{
			Hash: 'Lab-OperationExercises-RunRow-Template',
			Template: /*html*/`
<tr>
	<td>{~D:Record.Started~}</td>
	<td>{~D:Record.ExerciseName~}</td>
	<td><span class="pill {~D:Record.Status~}">{~D:Record.Status~}</span></td>
	<td>{~D:Record.DurationSeconds~}s</td>
	<td>{~D:Record.Operations~}</td>
	<td>{~TS:Lab-OperationExercises-VerdictLine-Template:Record.Verdicts~}{~D:Record.ErrorMessage~}</td>
</tr>`
		},
		{
			Hash: 'Lab-OperationExercises-VerdictLine-Template',
			Template: /*html*/`<div class="lab-opex-verdict-row {~D:Record.PassClass~}">{~D:Record.Label~}</div>`
		}
	],

	Renderables:
	[
		{
			RenderableHash:            'Lab-OperationExercises-Main',
			TemplateHash:              'Lab-OperationExercises-Main-Template',
			ContentDestinationAddress: '#Lab-Content-Container'
		},
		{
			RenderableHash:            'Lab-OperationExercises-Active',
			TemplateHash:              'Lab-OperationExercises-Active-Template',
			ContentDestinationAddress: '#Lab-OperationExercises-ActiveSlot'
		},
		{
			RenderableHash:            'Lab-OperationExercises-Cards',
			TemplateHash:              'Lab-OperationExercises-Cards-Template',
			ContentDestinationAddress: '#Lab-OperationExercises-CardsSlot'
		},
		{
			RenderableHash:            'Lab-OperationExercises-Runs',
			TemplateHash:              'Lab-OperationExercises-Runs-Template',
			ContentDestinationAddress: '#Lab-OperationExercises-RunsSlot'
		}
	]
};

class LabOperationExercisesView extends libPictView
{
	constructor(pFable, pOptions, pServiceHash)
	{
		super(pFable, pOptions, pServiceHash);
	}

	onBeforeRender(pRenderable)
	{
		if (!this.pict.AppData.Lab.OperationExercises) { this.pict.AppData.Lab.OperationExercises = {}; }
		if (!this.pict.AppData.Lab.Computed) { this.pict.AppData.Lab.Computed = {}; }
		let tmpState = this.pict.AppData.Lab.OperationExercises;
		if (!tmpState.Targets)   { tmpState.Targets = { IDUltravisorInstance: 0 }; }
		if (!tmpState.Exercises) { tmpState.Exercises = []; }
		if (!tmpState.Runs)      { tmpState.Runs = []; }

		let tmpExercises = tmpState.Exercises;
		let tmpRuns = tmpState.Runs;

		this.pict.AppData.Lab.Computed.OperationExercises =
			{
				UltravisorOptions: this._buildUltravisorOptions(tmpState),
				ActiveSlot:        [this._buildActiveRecord(tmpRuns)],
				EmptySlot:         tmpExercises.length === 0 ? [{}] : [],
				ListSlot:          tmpExercises.length === 0 ? [] : [{ Cards: this._buildCards(tmpState) }],
				RunsSlot:          tmpRuns.length === 0 ? [] : [{ Rows: this._buildRunRows(tmpRuns) }]
			};
		return super.onBeforeRender(pRenderable);
	}

	onAfterRender(pRenderable, pAddress, pRecord, pContent)
	{
		let tmpHash = pRenderable && pRenderable.RenderableHash;
		if (tmpHash === 'Lab-OperationExercises-Main' || !tmpHash)
		{
			this.render('Lab-OperationExercises-Active');
			this.render('Lab-OperationExercises-Cards');
			this.render('Lab-OperationExercises-Runs');
		}
		this.pict.CSSMap.injectCSS();
		return super.onAfterRender(pRenderable, pAddress, pRecord, pContent);
	}

	// ── Computed builders ──────────────────────────────────────────────────

	_buildUltravisorOptions(pState)
	{
		let tmpInstances = (this.pict.AppData.Lab.Ultravisor && this.pict.AppData.Lab.Ultravisor.Instances) || [];
		let tmpHead = [{ Value: 0, Label: '-- choose an Ultravisor --', SelectedAttr: '', DisabledAttr: '' }];
		let tmpTargetID = (pState.Targets && pState.Targets.IDUltravisorInstance) || 0;
		return tmpHead.concat(tmpInstances.map((pUv) =>
			{
				let tmpRunning = pUv.Status === 'running';
				let tmpSecureTag = pUv.Secure ? 'Secure' : 'Promiscuous';
				let tmpTag = tmpRunning ? `port ${pUv.Port} · ${tmpSecureTag}` : (pUv.Status || 'stopped');
				return {
					Value:        pUv.IDUltravisorInstance,
					Label:        this._escape(pUv.Name) + ' (' + tmpTag + ')',
					SelectedAttr: (tmpRunning && String(tmpTargetID) === String(pUv.IDUltravisorInstance)) ? 'selected' : '',
					DisabledAttr: tmpRunning ? '' : 'disabled'
				};
			}));
	}

	_buildActiveRecord(pRuns)
	{
		// Pull the most recent run's Timing.PerRun rows (if any) so the
		// operator can see per-RunHash status from the last exercise.
		let tmpRows = [];
		if (Array.isArray(pRuns) && pRuns.length > 0)
		{
			let tmpLatest = pRuns[0];
			let tmpTiming = null;
			try { tmpTiming = tmpLatest.TimingJSON ? JSON.parse(tmpLatest.TimingJSON) : null; }
			catch (pErr) { tmpTiming = null; }
			if (tmpTiming && Array.isArray(tmpTiming.PerRun))
			{
				tmpRows = tmpTiming.PerRun.map((pR) =>
					{
						let tmpStarted = pR.KickedAt ? new Date(pR.KickedAt).toLocaleTimeString() : '--';
						let tmpDur = (pR.DurationMs && pR.DurationMs > 0)
							? (Math.round(pR.DurationMs / 100) / 10) + 's'
							: '--';
						return {
							RunHash:       this._escape((pR.RunHash || '').slice(0, 12)),
							OperationHash: this._escape(pR.OperationHash || ''),
							State:         this._escape(pR.State || ''),
							Started:       tmpStarted,
							Duration:      tmpDur
						};
					});
			}
		}
		return {
			RowsWrap:  tmpRows.length === 0 ? [] : [{ Rows: tmpRows }],
			EmptyWrap: tmpRows.length === 0 ? [{}] : []
		};
	}

	_buildCards(pState)
	{
		let tmpExercises = pState.Exercises || [];
		let tmpTargetID = (pState.Targets && pState.Targets.IDUltravisorInstance) || 0;
		let tmpInstances = (this.pict.AppData.Lab.Ultravisor && this.pict.AppData.Lab.Ultravisor.Instances) || [];
		let tmpTargetUV = tmpInstances.find((pUv) => String(pUv.IDUltravisorInstance) === String(tmpTargetID));
		let tmpAttachedAuth = this._hasAuthBeacon(tmpTargetID);
		let tmpEnabled = false;
		let tmpHint = '';
		if (!tmpTargetID)
		{
			tmpHint = 'Pick a target Ultravisor above first.';
		}
		else if (!tmpTargetUV)
		{
			tmpHint = 'Selected Ultravisor not found in catalog.';
		}
		else if (tmpTargetUV.Status !== 'running')
		{
			tmpHint = `Ultravisor '${tmpTargetUV.Name}' is ${tmpTargetUV.Status}; start it first.`;
		}
		else if (tmpTargetUV.Secure)
		{
			if (!tmpAttachedAuth)
			{
				tmpHint = `Ultravisor '${tmpTargetUV.Name}' is in Secure mode but has no auth-beacon attached; attach an ultravisor-auth-beacon so the harness can bootstrap and log in.`;
			}
			else
			{
				tmpEnabled = true;
				tmpHint = 'Secure mode + auth-beacon attached: harness bootstraps an admin, logs in, then provisions the suite fleet and registers + kicks the exercise operations.';
			}
		}
		else
		{
			if (tmpAttachedAuth)
			{
				tmpHint = `Ultravisor '${tmpTargetUV.Name}' is promiscuous but has an auth-beacon attached; the auth-beacon blocks the UV's anonymous-fallback path.`;
			}
			else
			{
				tmpEnabled = true;
				tmpHint = 'Promiscuous mode (no auth-beacon): UV synthesizes an anonymous session for the harness; operations register and execute without a login.';
			}
		}
		return tmpExercises.map((pEx) => (
			{
				Hash:           pEx.Hash,
				Name:           this._escape(pEx.Name),
				Description:    this._escape(pEx.Description),
				OperationCount: pEx.OperationCount,
				KickCount:      pEx.KickCount,
				BeaconCount:    pEx.BeaconCount,
				Disabled:       tmpEnabled ? '' : 'disabled',
				Hint:           tmpHint
			}));
	}

	_hasAuthBeacon(pUvID)
	{
		if (!pUvID) { return false; }
		let tmpBeacons = (this.pict.AppData.Lab.Beacons && this.pict.AppData.Lab.Beacons.Beacons) || [];
		for (let i = 0; i < tmpBeacons.length; i++)
		{
			let tmpBeacon = tmpBeacons[i];
			if (tmpBeacon.BeaconType !== 'ultravisor-auth-beacon') { continue; }
			if (String(tmpBeacon.IDUltravisorInstance) !== String(pUvID)) { continue; }
			if (tmpBeacon.Status !== 'running') { continue; }
			return true;
		}
		return false;
	}

	_buildRunRows(pRuns)
	{
		return pRuns.slice(0, 10).map((pRun) =>
			{
				let tmpVerdicts = [];
				if (pRun.VerdictsJSON)
				{
					try
					{
						let tmpParsed = JSON.parse(pRun.VerdictsJSON);
						let tmpList = (tmpParsed && Array.isArray(tmpParsed.Verdicts)) ? tmpParsed.Verdicts : [];
						tmpVerdicts = tmpList.map((pV) =>
							{
								let tmpDetail = '';
								if (pV.Spec !== undefined && pV.Observed !== undefined)
								{
									tmpDetail = ` (spec=${pV.Spec}, observed=${pV.Observed})`;
								}
								return {
									PassClass: pV.Pass ? 'pass' : 'fail',
									Label:     this._escape(pV.Assertion + tmpDetail)
								};
							});
					}
					catch (pErr) { /* leave empty */ }
				}
				let tmpDuration = pRun.DurationMs ? Math.round((pRun.DurationMs / 100)) / 10 : 0;
				let tmpOps = `${pRun.TotalCompleted || 0}/${pRun.TotalKicked || 0}`
					+ (pRun.TotalFailed ? ` (×${pRun.TotalFailed} failed)` : '');
				return {
					Started:         pRun.StartedAt ? new Date(pRun.StartedAt).toLocaleTimeString() : '--',
					ExerciseName:    this._escape(pRun.ExerciseName || ''),
					Status:          pRun.Status || 'unknown',
					DurationSeconds: tmpDuration,
					Operations:      tmpOps,
					Verdicts:        tmpVerdicts,
					ErrorMessage:    pRun.ErrorMessage ? '<div class="lab-opex-verdicts">' + this._escape(pRun.ErrorMessage) + '</div>' : ''
				};
			});
	}

	_escape(pStr)
	{
		return String(pStr == null ? '' : pStr)
			.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
	}
}

module.exports = LabOperationExercisesView;
module.exports.default_configuration = _ViewConfiguration;
