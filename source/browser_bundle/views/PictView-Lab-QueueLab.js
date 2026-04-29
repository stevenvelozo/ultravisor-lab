/**
 * PictView-Lab-QueueLab
 *
 * Tab for the queue-testing harness: pick a target Ultravisor, see live
 * queue counters (per-capability + global buckets), browse the scenario
 * catalog, run scenarios, and inspect recent run verdicts.
 *
 * Live counters come from polling the lab's queue-snapshot proxy at
 * `/api/lab/ultravisor-instances/:id/queue-snapshot` (which forwards to
 * the UV's /Beacon/Queue REST endpoint) -- not via direct browser→UV
 * WebSocket, to keep the page same-origin.
 *
 * Data flow: persisted state lives in `AppData.Lab.QueueLab`. Derived
 * display records land in `AppData.Lab.Computed.QueueLab` during
 * onBeforeRender. Templates iterate via {~TS:~}; no HTML construction
 * in JS.
 */
'use strict';

const libPictView = require('pict-view');

const _ViewConfiguration =
{
	ViewIdentifier:            'Lab-QueueLab',
	DefaultRenderable:         'Lab-QueueLab-Main',
	DefaultDestinationAddress: '#Lab-Content-Container',

	AutoRender: false,

	CSS: /*css*/`
.lab-queue { padding: 20px; display: flex; flex-direction: column; gap: 16px; }
.lab-queue-toolbar { display: flex; align-items: center; justify-content: space-between; }
.lab-queue-toolbar h2 { margin: 0; font-size: 16px; color: #0f172a; }

.lab-queue-targets
{
	background: #fff; border: 1px solid #e2e8f0; border-radius: 8px; padding: 14px 18px;
	display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 10px 20px;
	align-items: start;
}
.lab-queue-targets label
{
	display: flex; flex-direction: column; gap: 4px;
	font-size: 12px; font-weight: 600; color: #475569;
	text-transform: uppercase; letter-spacing: 0.3px;
}
.lab-queue-targets select
{
	font-family: inherit; font-size: 14px; padding: 7px 10px;
	border: 1px solid #cbd5e1; border-radius: 6px; background: #fff; color: #0f172a;
	box-sizing: border-box; height: 36px; line-height: 1.2;
}

.lab-queue-board
{
	background: #fff; border: 1px solid #e2e8f0; border-radius: 8px; overflow: hidden;
}
.lab-queue-board h3
{
	margin: 0; padding: 12px 18px; background: #f8fafc;
	border-bottom: 1px solid #e2e8f0; font-size: 13px; color: #475569;
	font-weight: 600; text-transform: uppercase; letter-spacing: 0.3px;
	display: flex; justify-content: space-between; align-items: center;
}
.lab-queue-board h3 .lab-queue-board-tag
{
	font-size: 11px; font-weight: 500; color: #64748b; text-transform: none;
	letter-spacing: normal;
}
.lab-queue-buckets
{
	display: grid; grid-template-columns: repeat(5, 1fr); gap: 0;
}
.lab-queue-bucket
{
	padding: 14px 16px; text-align: center;
	border-right: 1px solid #f1f5f9;
}
.lab-queue-bucket:last-child { border-right: none; }
.lab-queue-bucket .lab-queue-bucket-value
{
	font-size: 24px; font-weight: 600; color: #0f172a; line-height: 1.1;
}
.lab-queue-bucket .lab-queue-bucket-label
{
	font-size: 11px; color: #64748b; text-transform: uppercase; letter-spacing: 0.3px;
	margin-top: 4px;
}
.lab-queue-bucket.bucket-upcoming   .lab-queue-bucket-value { color: #92400e; }
.lab-queue-bucket.bucket-inprogress .lab-queue-bucket-value { color: #1d4ed8; }
.lab-queue-bucket.bucket-stalled    .lab-queue-bucket-value { color: #b45309; }
.lab-queue-bucket.bucket-completed  .lab-queue-bucket-value { color: #166534; }
.lab-queue-bucket.bucket-errored    .lab-queue-bucket-value { color: #991b1b; }

.lab-queue-bycap-table { width: 100%; border-collapse: collapse; font-size: 12.5px; }
.lab-queue-bycap-table th, .lab-queue-bycap-table td
{
	padding: 8px 14px; text-align: left; border-top: 1px solid #f1f5f9;
}
.lab-queue-bycap-table th { background: #fcfcfd; color: #64748b; font-weight: 600; font-size: 11px; text-transform: uppercase; letter-spacing: 0.3px; }
.lab-queue-bycap-empty { padding: 12px 18px; text-align: center; color: #64748b; font-size: 12px; }

.lab-queue-scenarios { display: grid; grid-template-columns: repeat(auto-fit, minmax(320px, 1fr)); gap: 16px; }
.lab-queue-card
{
	background: #fff; border: 1px solid #e2e8f0; border-radius: 8px; padding: 16px 18px;
	display: flex; flex-direction: column; gap: 10px;
}
.lab-queue-card h3 { margin: 0; font-size: 15px; color: #0f172a; }
.lab-queue-card .lab-queue-desc { font-size: 13px; color: #475569; line-height: 1.5; }
.lab-queue-card .lab-queue-meta
{
	display: flex; flex-wrap: wrap; gap: 12px;
	padding: 8px 10px; background: #f8fafc; border-radius: 6px;
	font-size: 12px; color: #475569;
}
.lab-queue-card .lab-queue-meta .k
{
	font-size: 11px; text-transform: uppercase; letter-spacing: 0.3px; color: #64748b;
}
.lab-queue-card .lab-queue-meta .v { color: #0f172a; font-weight: 500; }
.lab-queue-card-actions { display: flex; justify-content: flex-end; gap: 8px; margin-top: 4px; }

.lab-queue-empty
{
	padding: 32px 20px; text-align: center; color: #64748b;
	background: #fff; border: 1px dashed #cbd5e1; border-radius: 8px;
}

.lab-queue-runs-block { background: #fff; border: 1px solid #e2e8f0; border-radius: 8px; overflow: hidden; }
.lab-queue-runs-block h3
{
	margin: 0; padding: 12px 18px; background: #f8fafc;
	border-bottom: 1px solid #e2e8f0; font-size: 13px; color: #475569;
	font-weight: 600; text-transform: uppercase; letter-spacing: 0.3px;
}
.lab-queue-runs-block table { width: 100%; border-collapse: collapse; font-size: 12.5px; }
.lab-queue-runs-block th, .lab-queue-runs-block td
{
	padding: 8px 14px; text-align: left; border-bottom: 1px solid #f1f5f9; vertical-align: top;
}
.lab-queue-runs-block th { background: #fcfcfd; color: #64748b; font-weight: 600; font-size: 11px; text-transform: uppercase; letter-spacing: 0.3px; }
.lab-queue-runs-block tr:last-child td { border-bottom: none; }
.lab-queue-runs-block .pill
{
	display: inline-block; padding: 2px 10px; border-radius: 10px; font-size: 11px;
	font-weight: 600; text-transform: uppercase; letter-spacing: 0.3px;
}
.lab-queue-runs-block .pill.complete         { background: #dcfce7; color: #166534; }
.lab-queue-runs-block .pill.failed-assertions{ background: #fef3c7; color: #92400e; }
.lab-queue-runs-block .pill.failed           { background: #fee2e2; color: #991b1b; }
.lab-queue-runs-block .pill.timed-out        { background: #fef3c7; color: #92400e; }
.lab-queue-runs-block .pill.canceled         { background: #e2e8f0; color: #475569; }
.lab-queue-runs-block .pill.running          { background: #dbeafe; color: #1e40af; }
.lab-queue-runs-block .lab-queue-verdicts
{
	font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 11px;
	background: #f8fafc; padding: 8px 10px; border-radius: 4px; color: #334155;
	white-space: pre-wrap; word-break: break-word; max-width: 100%; overflow: auto; max-height: 240px;
}
.lab-queue-runs-block .lab-queue-verdict-row
{
	display: flex; gap: 8px; align-items: center; padding: 2px 0;
}
.lab-queue-runs-block .lab-queue-verdict-row.pass::before { content: '✓'; color: #166534; font-weight: 700; }
.lab-queue-runs-block .lab-queue-verdict-row.fail::before { content: '✗'; color: #991b1b; font-weight: 700; }

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
			Hash: 'Lab-QueueLab-Main-Template',
			Template: /*html*/`
<div class="lab-queue">
	<div class="lab-queue-toolbar">
		<h2>Queue Lab</h2>
	</div>
	<div class="lab-queue-targets">
		<label>Target Ultravisor
			<select id="Lab-QueueLab-Targets-Ultravisor">{~TS:Lab-QueueLab-TargetOption-Template:AppData.Lab.Computed.QueueLab.UltravisorOptions~}</select>
		</label>
	</div>
	<div id="Lab-QueueLab-BoardSlot"></div>
	<div id="Lab-QueueLab-ScenariosSlot"></div>
	<div id="Lab-QueueLab-RunsSlot"></div>
</div>`
		},
		{
			Hash: 'Lab-QueueLab-Board-Template',
			Template: /*html*/`{~TS:Lab-QueueLab-BoardCard-Template:AppData.Lab.Computed.QueueLab.BoardSlot~}`
		},
		{
			Hash: 'Lab-QueueLab-BoardCard-Template',
			Template: /*html*/`
<div class="lab-queue-board">
	<h3>Live queue <span class="lab-queue-board-tag">{~D:Record.Tag~}</span></h3>
	<div class="lab-queue-buckets">
		<div class="lab-queue-bucket bucket-upcoming">
			<div class="lab-queue-bucket-value">{~D:Record.Buckets.Upcoming~}</div>
			<div class="lab-queue-bucket-label">Upcoming</div>
		</div>
		<div class="lab-queue-bucket bucket-inprogress">
			<div class="lab-queue-bucket-value">{~D:Record.Buckets.InProgress~}</div>
			<div class="lab-queue-bucket-label">In Progress</div>
		</div>
		<div class="lab-queue-bucket bucket-stalled">
			<div class="lab-queue-bucket-value">{~D:Record.Buckets.Stalled~}</div>
			<div class="lab-queue-bucket-label">Stalled</div>
		</div>
		<div class="lab-queue-bucket bucket-completed">
			<div class="lab-queue-bucket-value">{~D:Record.Buckets.Completed~}</div>
			<div class="lab-queue-bucket-label">Completed</div>
		</div>
		<div class="lab-queue-bucket bucket-errored">
			<div class="lab-queue-bucket-value">{~D:Record.Buckets.Errored~}</div>
			<div class="lab-queue-bucket-label">Errored</div>
		</div>
	</div>
	{~TS:Lab-QueueLab-ByCapTable-Template:Record.ByCapacityWrap~}
	{~TS:Lab-QueueLab-ByCapEmpty-Template:Record.EmptyWrap~}
</div>`
		},
		{
			Hash: 'Lab-QueueLab-ByCapTable-Template',
			Template: /*html*/`
<table class="lab-queue-bycap-table">
	<thead>
		<tr><th>Capability</th><th>Action</th><th>Queued</th><th>Running</th><th>Stalled</th></tr>
	</thead>
	<tbody>{~TS:Lab-QueueLab-ByCapRow-Template:Record.Rows~}</tbody>
</table>`
		},
		{
			Hash: 'Lab-QueueLab-ByCapRow-Template',
			Template: /*html*/`<tr><td>{~D:Record.Capability~}</td><td>{~D:Record.Action~}</td><td>{~D:Record.Queued~}</td><td>{~D:Record.Running~}</td><td>{~D:Record.Stalled~}</td></tr>`
		},
		{
			Hash: 'Lab-QueueLab-ByCapEmpty-Template',
			Template: /*html*/`<div class="lab-queue-bycap-empty">No capabilities currently in flight.</div>`
		},
		{
			Hash: 'Lab-QueueLab-TargetOption-Template',
			Template: /*html*/`<option value="{~D:Record.Value~}" {~D:Record.SelectedAttr~} {~D:Record.DisabledAttr~}>{~D:Record.Label~}</option>`
		},
		{
			Hash: 'Lab-QueueLab-Scenarios-Template',
			Template: /*html*/`
{~TS:Lab-QueueLab-Empty-Template:AppData.Lab.Computed.QueueLab.EmptySlot~}
{~TS:Lab-QueueLab-CardsContainer-Template:AppData.Lab.Computed.QueueLab.ListSlot~}`
		},
		{
			Hash: 'Lab-QueueLab-Empty-Template',
			Template: /*html*/`<div class="lab-queue-empty">No queue scenarios found under <code>queue_scenarios/</code>.</div>`
		},
		{
			Hash: 'Lab-QueueLab-CardsContainer-Template',
			Template: /*html*/`<div class="lab-queue-scenarios">{~TS:Lab-QueueLab-Card-Template:Record.Cards~}</div>`
		},
		{
			Hash: 'Lab-QueueLab-Card-Template',
			Template: /*html*/`
<div class="lab-queue-card">
	<h3>{~D:Record.Name~}</h3>
	<div class="lab-queue-desc">{~D:Record.Description~}</div>
	<div class="lab-queue-meta">
		<span><span class="k">Beacons:</span> <span class="v">{~D:Record.BeaconCount~}</span></span>
		<span><span class="k">Workload:</span> <span class="v">{~D:Record.WorkloadCount~} items</span></span>
		<span><span class="k">Cadence:</span> <span class="v">{~D:Record.Cadence~}</span></span>
	</div>
	<div class="lab-queue-card-actions">
		<a class="lab-btn {~D:Record.Disabled~}" href="#/queuelab/{~D:Record.Hash~}/run" title="{~D:Record.Hint~}">Run on Ultravisor →</a>
	</div>
</div>`
		},
		{
			Hash: 'Lab-QueueLab-Runs-Template',
			Template: /*html*/`{~TS:Lab-QueueLab-RunsBlock-Template:AppData.Lab.Computed.QueueLab.RunsSlot~}`
		},
		{
			Hash: 'Lab-QueueLab-RunsBlock-Template',
			Template: /*html*/`
<div class="lab-queue-runs-block">
	<h3>Recent runs</h3>
	<table>
		<thead>
			<tr>
				<th>Started</th>
				<th>Scenario</th>
				<th>Status</th>
				<th>Drain</th>
				<th>Items</th>
				<th>Verdicts</th>
			</tr>
		</thead>
		<tbody>{~TS:Lab-QueueLab-RunRow-Template:Record.Rows~}</tbody>
	</table>
</div>`
		},
		{
			Hash: 'Lab-QueueLab-RunRow-Template',
			Template: /*html*/`
<tr>
	<td>{~D:Record.Started~}</td>
	<td>{~D:Record.ScenarioName~}</td>
	<td><span class="pill {~D:Record.Status~}">{~D:Record.Status~}</span></td>
	<td>{~D:Record.DrainSeconds~}s</td>
	<td>{~D:Record.Items~}</td>
	<td>{~TS:Lab-QueueLab-VerdictLine-Template:Record.Verdicts~}{~D:Record.ErrorMessage~}</td>
</tr>`
		},
		{
			Hash: 'Lab-QueueLab-VerdictLine-Template',
			Template: /*html*/`<div class="lab-queue-verdict-row {~D:Record.PassClass~}">{~D:Record.Label~}</div>`
		}
	],

	Renderables:
	[
		{
			RenderableHash:            'Lab-QueueLab-Main',
			TemplateHash:              'Lab-QueueLab-Main-Template',
			ContentDestinationAddress: '#Lab-Content-Container'
		},
		{
			RenderableHash:            'Lab-QueueLab-Board',
			TemplateHash:              'Lab-QueueLab-Board-Template',
			ContentDestinationAddress: '#Lab-QueueLab-BoardSlot'
		},
		{
			RenderableHash:            'Lab-QueueLab-Scenarios',
			TemplateHash:              'Lab-QueueLab-Scenarios-Template',
			ContentDestinationAddress: '#Lab-QueueLab-ScenariosSlot'
		},
		{
			RenderableHash:            'Lab-QueueLab-Runs',
			TemplateHash:              'Lab-QueueLab-Runs-Template',
			ContentDestinationAddress: '#Lab-QueueLab-RunsSlot'
		}
	]
};

class LabQueueLabView extends libPictView
{
	constructor(pFable, pOptions, pServiceHash)
	{
		super(pFable, pOptions, pServiceHash);
	}

	onBeforeRender(pRenderable)
	{
		if (!this.pict.AppData.Lab.QueueLab) { this.pict.AppData.Lab.QueueLab = {}; }
		if (!this.pict.AppData.Lab.Computed) { this.pict.AppData.Lab.Computed = {}; }
		let tmpState = this.pict.AppData.Lab.QueueLab;
		if (!tmpState.Targets)   { tmpState.Targets = { IDUltravisorInstance: 0 }; }
		if (!tmpState.Scenarios) { tmpState.Scenarios = []; }
		if (!tmpState.Runs)      { tmpState.Runs = []; }

		let tmpScenarios = tmpState.Scenarios;
		let tmpRuns = tmpState.Runs;

		this.pict.AppData.Lab.Computed.QueueLab =
		{
			UltravisorOptions: this._buildUltravisorOptions(tmpState),
			BoardSlot:         [this._buildBoardRecord(tmpState)],
			EmptySlot:         tmpScenarios.length === 0 ? [{}] : [],
			ListSlot:          tmpScenarios.length === 0 ? [] : [{ Cards: this._buildCards(tmpState) }],
			RunsSlot:          tmpRuns.length === 0 ? [] : [{ Rows: this._buildRunRows(tmpRuns) }]
		};
		return super.onBeforeRender(pRenderable);
	}

	onAfterRender(pRenderable, pAddress, pRecord, pContent)
	{
		let tmpHash = pRenderable && pRenderable.RenderableHash;
		if (tmpHash === 'Lab-QueueLab-Main' || !tmpHash)
		{
			this.render('Lab-QueueLab-Board');
			this.render('Lab-QueueLab-Scenarios');
			this.render('Lab-QueueLab-Runs');
		}
		this.pict.CSSMap.injectCSS();
		return super.onAfterRender(pRenderable, pAddress, pRecord, pContent);
	}

	// ── Computed builders ───────────────────────────────────────────────────

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

	_buildBoardRecord(pState)
	{
		let tmpSnap = pState.Snapshot && pState.Snapshot.Summary ? pState.Snapshot.Summary : null;
		let tmpBuckets = (tmpSnap && tmpSnap.Buckets) || { Upcoming: 0, InProgress: 0, Stalled: 0, Completed: 0, Errored: 0 };
		let tmpByCap = (tmpSnap && Array.isArray(tmpSnap.ByCapability)) ? tmpSnap.ByCapability : [];
		let tmpHasTarget = !!(pState.Targets && pState.Targets.IDUltravisorInstance);
		let tmpHasData = !!tmpSnap;
		let tmpTag = tmpHasTarget
			? (tmpHasData ? 'updated ' + this._timeAgo(tmpSnap.At) : 'waiting for first poll...')
			: 'pick a target Ultravisor above';
		return {
			Tag: tmpTag,
			Buckets:
			{
				Upcoming:   tmpBuckets.Upcoming   || 0,
				InProgress: tmpBuckets.InProgress || 0,
				Stalled:    tmpBuckets.Stalled    || 0,
				Completed:  tmpBuckets.Completed  || 0,
				Errored:    tmpBuckets.Errored    || 0
			},
			ByCapacityWrap: tmpByCap.length === 0 ? [] : [{ Rows: tmpByCap.map((pR) => (
				{
					Capability: this._escape(pR.Capability || ''),
					Action:     this._escape(pR.Action || ''),
					Queued:     pR.Queued || 0,
					Running:    pR.Running || 0,
					Stalled:    pR.Stalled || 0
				})) }],
			EmptyWrap: tmpByCap.length === 0 ? [{}] : []
		};
	}

	_buildCards(pState)
	{
		let tmpScenarios = pState.Scenarios || [];
		let tmpHasTarget = !!(pState.Targets && pState.Targets.IDUltravisorInstance);
		let tmpHint = tmpHasTarget ? 'Provision the scenario\'s beacons and drive its workload.' : 'Pick a target Ultravisor above first.';
		return tmpScenarios.map((pSc) => (
			{
				Hash:          pSc.Hash,
				Name:          this._escape(pSc.Name),
				Description:   this._escape(pSc.Description),
				BeaconCount:   pSc.BeaconCount,
				WorkloadCount: pSc.WorkloadCount,
				Cadence:       this._escape(pSc.Cadence || 'burst'),
				Disabled:      tmpHasTarget ? '' : 'disabled',
				Hint:          tmpHint
			}));
	}

	_buildRunRows(pRuns)
	{
		// Show newest first (10 max).  Each row inflates the VerdictsJSON
		// blob into per-assertion Pass/Fail lines so the operator sees the
		// outcome at a glance without opening a modal.
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
								else if (pV.Detail && typeof pV.Detail === 'object')
								{
									let tmpKeys = Object.keys(pV.Detail);
									if (tmpKeys.length > 0 && tmpKeys.length <= 4)
									{
										tmpDetail = ' [' + tmpKeys.slice(0, 4).join(', ') + ']';
									}
								}
								return {
									PassClass: pV.Pass ? 'pass' : 'fail',
									Label:     this._escape(pV.Assertion + tmpDetail)
								};
							});
					}
					catch (pErr) { /* leave empty */ }
				}
				return {
					Started:      pRun.StartedAt ? new Date(pRun.StartedAt).toLocaleTimeString() : '--',
					ScenarioName: this._escape(pRun.ScenarioName || ''),
					Status:       pRun.Status || 'unknown',
					DrainSeconds: pRun.DrainMs ? Math.round((pRun.DrainMs / 100)) / 10 : 0,
					Items:        `${pRun.TotalCompleted || 0}/${pRun.TotalEnqueued || 0}` + (pRun.TotalFailed ? ` (×${pRun.TotalFailed} failed)` : ''),
					Verdicts:     tmpVerdicts,
					ErrorMessage: pRun.ErrorMessage ? '<div class="lab-queue-verdicts">' + this._escape(pRun.ErrorMessage) + '</div>' : ''
				};
			});
	}

	_timeAgo(pISO)
	{
		if (!pISO) { return ''; }
		let tmpDelta = Math.max(0, Date.now() - Date.parse(pISO));
		if (tmpDelta < 1500)  { return 'just now'; }
		if (tmpDelta < 60000) { return Math.round(tmpDelta / 1000) + 's ago'; }
		return Math.round(tmpDelta / 60000) + 'm ago';
	}

	_escape(pStr)
	{
		return String(pStr == null ? '' : pStr)
			.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
	}
}

module.exports = LabQueueLabView;
module.exports.default_configuration = _ViewConfiguration;
