/**
 * PictView-Lab-SeedDatasets
 *
 * Browse pre-packaged seed datasets, pick a target Ultravisor + databeacon,
 * and kick off an ETL run through the mesh.  Recent ingestion jobs show
 * below so users can watch their seed complete without leaving the tab.
 *
 * Data flow: persisted state lives in `AppData.Lab.SeedDatasets`. The
 * derived display records — target dropdowns, dataset cards, job rows —
 * land in `AppData.Lab.Computed.SeedDatasets` during onBeforeRender.
 * Templates iterate via {~TS:~}; no HTML construction in JS.
 */
'use strict';

const libPictView = require('pict-view');

const _ViewConfiguration =
{
	ViewIdentifier:            'Lab-SeedDatasets',
	DefaultRenderable:         'Lab-SeedDatasets-Main',
	DefaultDestinationAddress: '#Lab-Content-Container',

	AutoRender: false,

	CSS: /*css*/`
.lab-seeds { padding: 20px; display: flex; flex-direction: column; gap: 16px; }
.lab-seeds-toolbar { display: flex; align-items: center; justify-content: space-between; }
.lab-seeds-toolbar h2 { margin: 0; font-size: 16px; color: #0f172a; }

.lab-seeds-targets
{
	background: #fff; border: 1px solid #e2e8f0; border-radius: 8px; padding: 14px 18px;
	display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 10px 20px;
	align-items: start;
}
.lab-seeds-targets label
{
	display: flex; flex-direction: column; gap: 4px;
	font-size: 12px; font-weight: 600; color: #475569;
	text-transform: uppercase; letter-spacing: 0.3px;
}
.lab-seeds-targets input, .lab-seeds-targets select
{
	font-family: inherit; font-size: 14px; padding: 7px 10px;
	border: 1px solid #cbd5e1; border-radius: 6px; background: #fff; color: #0f172a;
	box-sizing: border-box; height: 36px; line-height: 1.2;
}

.lab-seeds-list { display: grid; grid-template-columns: repeat(auto-fit, minmax(320px, 1fr)); gap: 16px; }

.lab-seed-card
{
	background: #fff; border: 1px solid #e2e8f0; border-radius: 8px; padding: 16px 18px;
	display: flex; flex-direction: column; gap: 10px;
}
.lab-seed-card h3 { margin: 0; font-size: 15px; color: #0f172a; }
.lab-seed-card .lab-seed-desc { font-size: 13px; color: #475569; line-height: 1.5; }
.lab-seed-card .lab-seed-meta
{
	display: flex; flex-wrap: wrap; gap: 12px;
	padding: 8px 10px; background: #f8fafc; border-radius: 6px;
	font-size: 12px; color: #475569;
}
.lab-seed-card .lab-seed-meta span { display: inline-flex; gap: 4px; align-items: center; }
.lab-seed-card .lab-seed-meta .k
{
	font-size: 11px; text-transform: uppercase; letter-spacing: 0.3px; color: #64748b;
}
.lab-seed-card .lab-seed-meta .v { color: #0f172a; font-weight: 500; }
.lab-seed-entities
{
	display: flex; flex-direction: column; gap: 4px;
	padding: 8px 10px; background: #f8fafc; border-radius: 6px;
	font-size: 12px; color: #475569;
}
.lab-seed-entities .entity-row { display: flex; justify-content: space-between; gap: 8px; }
.lab-seed-entities .entity-row code { background: none; color: #0f172a; padding: 0; font-size: 12px; }
.lab-seed-card .lab-seed-op
{
	font-size: 11px; color: #1e40af; background: #dbeafe;
	padding: 2px 8px; border-radius: 10px; font-weight: 600;
	display: inline-block; width: max-content;
}
.lab-seed-card-actions { display: flex; justify-content: flex-end; gap: 8px; margin-top: 4px; }

.lab-seeds-empty
{
	padding: 32px 20px; text-align: center; color: #64748b;
	background: #fff; border: 1px dashed #cbd5e1; border-radius: 8px;
}

.lab-jobs-block
{
	background: #fff; border: 1px solid #e2e8f0; border-radius: 8px; overflow: hidden;
}
.lab-jobs-block h3
{
	margin: 0; padding: 12px 18px; background: #f8fafc;
	border-bottom: 1px solid #e2e8f0; font-size: 13px; color: #475569;
	font-weight: 600; text-transform: uppercase; letter-spacing: 0.3px;
}
.lab-jobs-block table { width: 100%; border-collapse: collapse; font-size: 12.5px; }
.lab-jobs-block th, .lab-jobs-block td
{
	padding: 8px 14px; text-align: left; border-bottom: 1px solid #f1f5f9;
}
.lab-jobs-block th { background: #fcfcfd; color: #64748b; font-weight: 600; font-size: 11px; text-transform: uppercase; letter-spacing: 0.3px; }
.lab-jobs-block tr:last-child td { border-bottom: none; }
.lab-jobs-block .status-running  { color: #92400e; font-weight: 600; }
.lab-jobs-block .status-complete { color: #166534; font-weight: 600; }
.lab-jobs-block .status-failed   { color: #991b1b; font-weight: 600; }
.lab-jobs-block .status-submitting,
.lab-jobs-block .status-timed-out { color: #64748b; font-weight: 600; }

.lab-btn
{
	background: #1d4ed8; color: #fff; border: 1px solid #1d4ed8;
	border-radius: 6px; padding: 6px 14px; font-size: 13px;
	font-weight: 500; cursor: pointer;
}
a.lab-btn { text-decoration: none; display: inline-flex; align-items: center; justify-content: center; }
.lab-btn:hover { background: #1e40af; border-color: #1e40af; }
.lab-btn.secondary { background: transparent; color: #0f172a; border-color: #cbd5e1; }
.lab-btn.secondary:hover { background: #f1f5f9; border-color: #94a3b8; }
.lab-btn.small { padding: 4px 10px; font-size: 12px; }
.lab-btn:disabled,
.lab-btn.disabled { opacity: 0.5; cursor: not-allowed; pointer-events: none; }
`,

	Templates:
	[
		{
			Hash: 'Lab-SeedDatasets-Main-Template',
			Template: /*html*/`
<div class="lab-seeds">
	<div class="lab-seeds-toolbar">
		<h2>Seed Datasets</h2>
	</div>
	<div class="lab-seeds-targets">
		<label>Target Ultravisor
			<select id="Lab-SeedTargets-Ultravisor">{~TS:Lab-SeedDatasets-TargetOption-Template:AppData.Lab.Computed.SeedDatasets.UltravisorOptions~}</select>
		</label>
		<label>Target Databeacon
			<select id="Lab-SeedTargets-Databeacon">{~TS:Lab-SeedDatasets-TargetOption-Template:AppData.Lab.Computed.SeedDatasets.DatabeaconOptions~}</select>
		</label>
		<label>Target DB Engine (for quick-seed)
			<select id="Lab-SeedTargets-DBEngine">{~TS:Lab-SeedDatasets-TargetOption-Template:AppData.Lab.Computed.SeedDatasets.DBEngineOptions~}</select>
		</label>
	</div>
	<div id="Lab-SeedDatasets-ListSlot"></div>
	<div id="Lab-SeedDatasets-JobsSlot"></div>
</div>`
		},
		{
			Hash: 'Lab-SeedDatasets-List-Template',
			Template: /*html*/`
{~TS:Lab-SeedDatasets-Empty-Template:AppData.Lab.Computed.SeedDatasets.EmptySlot~}
{~TS:Lab-SeedDatasets-CardsContainer-Template:AppData.Lab.Computed.SeedDatasets.ListSlot~}`
		},
		{
			Hash: 'Lab-SeedDatasets-JobsSlot-Template',
			Template: /*html*/`{~TS:Lab-SeedDatasets-Jobs-Template:AppData.Lab.Computed.SeedDatasets.JobsSlot~}`
		},
		{
			Hash: 'Lab-SeedDatasets-TargetOption-Template',
			Template: /*html*/`<option value="{~D:Record.Value~}" {~D:Record.SelectedAttr~} {~D:Record.DisabledAttr~}>{~D:Record.Label~}</option>`
		},
		{
			Hash: 'Lab-SeedDatasets-Empty-Template',
			Template: /*html*/`<div class="lab-seeds-empty">No seed datasets found under <code>seed_datasets/</code>.</div>`
		},
		{
			// Wrapper container — renders the grid only when there are datasets
			// (single-element-array slot via ListSlot). Inner TS iterates the
			// dataset records on the same record context (Record.Cards).
			Hash: 'Lab-SeedDatasets-CardsContainer-Template',
			Template: /*html*/`<div class="lab-seeds-list">{~TS:Lab-SeedDatasets-Card-Template:Record.Cards~}</div>`
		},
		{
			Hash: 'Lab-SeedDatasets-Card-Template',
			Template: /*html*/`
<div class="lab-seed-card">
	<h3>{~D:Record.Name~}</h3>
	<div class="lab-seed-desc">{~D:Record.Description~}</div>
	<div class="lab-seed-meta">
		<span><span class="k">Total rows:</span> <span class="v">{~D:Record.TotalRows~}</span></span>
		<span><span class="k">Correlation:</span> <span class="v">{~D:Record.Correlation~}</span></span>
	</div>
	<div class="lab-seed-entities">{~TS:Lab-SeedDatasets-EntityRow-Template:Record.Entities~}</div>
	<div class="lab-seed-op">Ultravisor op: {~D:Record.OperationHash~}</div>
	<div class="lab-seed-card-actions">
		<a class="lab-btn secondary {~D:Record.EngineDisabled~}" href="#/seeds/{~D:Record.Hash~}/seed-to-engine" title="{~D:Record.EngineHint~}">Seed into engine →</a>
		<a class="lab-btn {~D:Record.BeaconDisabled~}" href="#/seeds/{~D:Record.Hash~}/run" title="{~D:Record.BeaconHint~}">Run on beacon →</a>
	</div>
</div>`
		},
		{
			Hash: 'Lab-SeedDatasets-EntityRow-Template',
			Template: /*html*/`<div class="entity-row"><code>{~D:Record.Name~}</code><span>{~D:Record.RowCount~} rows</span></div>`
		},
		{
			// Outer block — only rendered when there's at least one job
			// (driven by AppData.Lab.Computed.SeedDatasets.JobsSlot).
			Hash: 'Lab-SeedDatasets-Jobs-Template',
			Template: /*html*/`
<div class="lab-jobs-block">
	<h3>Recent ingestion jobs</h3>
	<table>
		<thead>
			<tr>
				<th>Started</th>
				<th>Dataset</th>
				<th>Status</th>
				<th>Parsed</th>
				<th>Loaded</th>
				<th>Detail</th>
			</tr>
		</thead>
		<tbody>{~TS:Lab-SeedDatasets-JobRow-Template:Record.Rows~}</tbody>
	</table>
</div>`
		},
		{
			Hash: 'Lab-SeedDatasets-JobRow-Template',
			Template: /*html*/`
<tr>
	<td>{~D:Record.Started~}</td>
	<td>{~D:Record.DatasetName~}</td>
	<td class="status-{~D:Record.Status~}">{~D:Record.Status~}</td>
	<td>{~D:Record.Parsed~}</td>
	<td>{~D:Record.Loaded~}</td>
	<td>{~D:Record.Detail~}</td>
</tr>`
		}
	],

	Renderables:
	[
		{
			RenderableHash:            'Lab-SeedDatasets-Main',
			TemplateHash:              'Lab-SeedDatasets-Main-Template',
			ContentDestinationAddress: '#Lab-Content-Container'
		},
		{
			RenderableHash:            'Lab-SeedDatasets-List',
			TemplateHash:              'Lab-SeedDatasets-List-Template',
			ContentDestinationAddress: '#Lab-SeedDatasets-ListSlot'
		},
		{
			RenderableHash:            'Lab-SeedDatasets-Jobs',
			TemplateHash:              'Lab-SeedDatasets-JobsSlot-Template',
			ContentDestinationAddress: '#Lab-SeedDatasets-JobsSlot'
		}
	]
};

class LabSeedDatasetsView extends libPictView
{
	constructor(pFable, pOptions, pServiceHash)
	{
		super(pFable, pOptions, pServiceHash);
	}

	onBeforeRender(pRenderable)
	{
		if (!this.pict.AppData.Lab.SeedDatasets) { this.pict.AppData.Lab.SeedDatasets = {}; }
		if (!this.pict.AppData.Lab.Computed) { this.pict.AppData.Lab.Computed = {}; }
		let tmpState = this.pict.AppData.Lab.SeedDatasets;
		if (!tmpState.Targets) { tmpState.Targets = { IDUltravisorInstance: 0, IDBeacon: 0, IDDBEngine: 0 }; }

		let tmpDatasets = tmpState.Datasets || [];
		let tmpJobs = tmpState.Jobs || [];

		this.pict.AppData.Lab.Computed.SeedDatasets =
		{
			UltravisorOptions: this._buildUltravisorOptions(tmpState),
			DatabeaconOptions: this._buildDatabeaconOptions(tmpState),
			DBEngineOptions:   this._buildDBEngineOptions(tmpState),
			EmptySlot:         tmpDatasets.length === 0 ? [{}] : [],
			ListSlot:          tmpDatasets.length === 0 ? [] : [{ Cards: this._buildCards(tmpState) }],
			JobsSlot:          tmpJobs.length === 0    ? [] : [{ Rows: this._buildJobRows(tmpJobs) }]
		};

		return super.onBeforeRender(pRenderable);
	}

	onAfterRender(pRenderable, pAddress, pRecord, pContent)
	{
		let tmpHash = pRenderable && pRenderable.RenderableHash;
		if (tmpHash === 'Lab-SeedDatasets-Main' || !tmpHash)
		{
			this.render('Lab-SeedDatasets-List');
			this.render('Lab-SeedDatasets-Jobs');
		}
		this.pict.CSSMap.injectCSS();
		return super.onAfterRender(pRenderable, pAddress, pRecord, pContent);
	}

	// ====================================================================
	// Computed-record builders
	//
	// We show all candidates (not just Status==='running') so the user can
	// see *why* something they created doesn't appear as a ready target
	// after a lab restart. Non-running entries are disabled and tagged
	// with their status.
	// ====================================================================

	_buildUltravisorOptions(pState)
	{
		let tmpInstances = (this.pict.AppData.Lab.Ultravisor && this.pict.AppData.Lab.Ultravisor.Instances) || [];
		let tmpHead = [{ Value: 0, Label: '-- choose an Ultravisor --', SelectedAttr: '', DisabledAttr: '' }];
		let tmpTargetID = (pState.Targets && pState.Targets.IDUltravisorInstance) || 0;
		return tmpHead.concat(tmpInstances.map((pUv) =>
		{
			let tmpRunning = pUv.Status === 'running';
			let tmpTag = tmpRunning ? `port ${pUv.Port}` : (pUv.Status || 'stopped');
			return {
				Value:        pUv.IDUltravisorInstance,
				Label:        this._escape(pUv.Name) + ' (' + tmpTag + ')',
				SelectedAttr: (tmpRunning && String(tmpTargetID) === String(pUv.IDUltravisorInstance)) ? 'selected' : '',
				DisabledAttr: tmpRunning ? '' : 'disabled'
			};
		}));
	}

	_buildDatabeaconOptions(pState)
	{
		// Only retold-databeacon rows are seed-capable.
		let tmpBeacons = (this.pict.AppData.Lab.Beacons && this.pict.AppData.Lab.Beacons.Beacons) || [];
		let tmpHead = [{ Value: 0, Label: '-- choose a databeacon --', SelectedAttr: '', DisabledAttr: '' }];
		let tmpTargetID = (pState.Targets && pState.Targets.IDBeacon) || 0;
		return tmpHead.concat(tmpBeacons
			.filter((pB) => pB.BeaconType === 'retold-databeacon')
			.map((pB) =>
			{
				let tmpRunning = pB.Status === 'running';
				let tmpTag = tmpRunning ? `port ${pB.Port}` : (pB.Status || 'stopped');
				return {
					Value:        pB.IDBeacon,
					Label:        this._escape(pB.Name) + ' (' + tmpTag + ')',
					SelectedAttr: (tmpRunning && String(tmpTargetID) === String(pB.IDBeacon)) ? 'selected' : '',
					DisabledAttr: tmpRunning ? '' : 'disabled'
				};
			}));
	}

	_buildDBEngineOptions(pState)
	{
		let tmpEngines = (this.pict.AppData.Lab.DBEngines && this.pict.AppData.Lab.DBEngines.Engines) || [];
		let tmpHead = [{ Value: 0, Label: '-- choose a DB engine --', SelectedAttr: '', DisabledAttr: '' }];
		let tmpTargetID = (pState.Targets && pState.Targets.IDDBEngine) || 0;
		return tmpHead.concat(tmpEngines.map((pEng) =>
		{
			let tmpRunning = pEng.Status === 'running';
			let tmpTag = tmpRunning ? pEng.EngineType : (pEng.EngineType + ' · ' + (pEng.Status || 'stopped'));
			return {
				Value:        pEng.IDDBEngine,
				Label:        this._escape(pEng.Name) + ' (' + tmpTag + ')',
				SelectedAttr: (tmpRunning && String(tmpTargetID) === String(pEng.IDDBEngine)) ? 'selected' : '',
				DisabledAttr: tmpRunning ? '' : 'disabled'
			};
		}));
	}

	_buildCards(pState)
	{
		let tmpDatasets = pState.Datasets || [];
		let tmpTargets = pState.Targets || {};
		let tmpBeaconReady = !!(tmpTargets.IDUltravisorInstance && tmpTargets.IDBeacon);
		let tmpEngineReady = !!(tmpTargets.IDUltravisorInstance && tmpTargets.IDDBEngine);
		let tmpBeaconHint = tmpBeaconReady ? 'Seed into the selected databeacon\'s attached database.' : 'Pick both Target Ultravisor and Target Databeacon above.';
		let tmpEngineHint = tmpEngineReady ? 'Auto-create a database + beacon on the chosen engine and seed.' : 'Pick both Target Ultravisor and Target DB Engine above.';

		return tmpDatasets.map((pDs) => (
			{
				Hash:           pDs.Hash,
				Name:           this._escape(pDs.Name),
				Description:    this._escape(pDs.Description),
				TotalRows:      pDs.TotalRows,
				Correlation:    this._escape(pDs.Correlation || 'n/a'),
				Entities:       (pDs.Entities || []).map((pE) => (
					{ Name: this._escape(pE.Name), RowCount: pE.RowCount })),
				OperationHash:  pDs.OperationHash,
				BeaconDisabled: tmpBeaconReady ? '' : 'disabled',
				EngineDisabled: tmpEngineReady ? '' : 'disabled',
				BeaconHint:     tmpBeaconHint,
				EngineHint:     tmpEngineHint
			}));
	}

	_buildJobRows(pJobs)
	{
		return pJobs.map((pJob) => (
			{
				Started:     pJob.StartedAt ? new Date(pJob.StartedAt).toLocaleTimeString() : '--',
				DatasetName: this._escape(pJob.DatasetName || ''),
				Status:      pJob.Status || 'unknown',
				Parsed:      pJob.ParsedCount || 0,
				Loaded:      pJob.LoadedCount || 0,
				Detail:      this._escape((pJob.ErrorMessage || '').slice(0, 80))
			}));
	}

	_escape(pStr)
	{
		return String(pStr == null ? '' : pStr)
			.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
	}
}

module.exports = LabSeedDatasetsView;
module.exports.default_configuration = _ViewConfiguration;
