/**
 * PictView-Lab-Overview
 *
 * Dashboard view: counts per entity, docker status, last reconcile summary.
 * Reads directly from `AppData.Lab.Status`; stashes derived display strings
 * under `AppData.Lab.Computed.Overview` for the template to consume.
 *
 * The "Clean environment" call-to-action toggles between an idle button and
 * an in-progress spinner. Rather than building HTML in JS, the view sets two
 * sibling slot arrays (one populated, one empty) and the template's `TS`
 * tags pick exactly one branch — see `AppData.Lab.Overview.Teardown*Slot`.
 */
'use strict';

const libPictView = require('pict-view');

const _ViewConfiguration =
{
	ViewIdentifier:            'Lab-Overview',
	DefaultRenderable:         'Lab-Overview-Main',
	DefaultDestinationAddress: '#Lab-Content-Container',

	AutoRender: false,

	CSS: /*css*/`
.lab-content { padding: 20px; }
.lab-overview
{
	display: grid;
	grid-template-columns: repeat(auto-fill, minmax(220px, 1fr));
	gap: 16px;
}
.lab-card
{
	background: #fff;
	border: 1px solid #e2e8f0;
	border-radius: 8px;
	padding: 16px 18px;
	box-shadow: 0 1px 2px rgba(15,23,42,0.04);
}
.lab-card h3 { margin: 0 0 6px; font-size: 13px; font-weight: 600; color: #475569; letter-spacing: 0.3px; text-transform: uppercase; }
.lab-card .lab-card-value { font-size: 28px; font-weight: 600; color: #0f172a; }
.lab-card .lab-card-sub   { font-size: 12px; color: #64748b; margin-top: 6px; }
.lab-meta
{
	margin-top: 24px;
	padding: 14px 18px;
	background: #f8fafc;
	border: 1px solid #e2e8f0;
	border-radius: 8px;
	color: #334155;
	font-size: 13px;
	line-height: 1.55;
}
.lab-meta strong { color: #0f172a; }
.lab-meta .lab-meta-row { display: flex; gap: 24px; }
.lab-meta .lab-meta-row > div { flex: 1; }

.lab-danger
{
	margin-top: 20px;
	padding: 14px 18px;
	background: #fef2f2;
	border: 1px solid #fecaca;
	border-radius: 8px;
	display: flex;
	align-items: center;
	justify-content: space-between;
	gap: 16px;
}
.lab-danger .lab-danger-text { color: #7f1d1d; font-size: 13px; line-height: 1.5; }
.lab-danger .lab-danger-text strong { display: block; color: #991b1b; font-size: 13px; margin-bottom: 2px; }
.lab-danger a.lab-danger-btn
{
	background: #991b1b;
	color: #fff;
	border: 1px solid #991b1b;
	border-radius: 6px;
	padding: 8px 14px;
	font-size: 13px;
	font-weight: 500;
	cursor: pointer;
	white-space: nowrap;
	text-decoration: none;
	display: inline-flex;
	align-items: center;
	justify-content: center;
}
.lab-danger a.lab-danger-btn:hover { background: #7f1d1d; border-color: #7f1d1d; }
.lab-danger .lab-danger-progress
{
	display: inline-flex;
	align-items: center;
	gap: 8px;
	color: #991b1b;
	font-size: 13px;
	font-weight: 500;
	font-style: italic;
	padding: 8px 14px;
	white-space: nowrap;
}
.lab-spinner
{
	width: 12px;
	height: 12px;
	border: 2px solid rgba(153, 27, 27, 0.25);
	border-top-color: #991b1b;
	border-radius: 50%;
	animation: lab-spin 0.8s linear infinite;
}
@keyframes lab-spin { to { transform: rotate(360deg); } }
`,

	Templates:
	[
		{
			Hash: 'Lab-Overview-Card-Template',
			Template: /*html*/`
<div class="lab-card">
	<h3>{~D:Record.Title~}</h3>
	<div class="lab-card-value">{~D:Record.Value~}</div>
	<div class="lab-card-sub">{~D:Record.SubTitle~}</div>
</div>`
		},
		{
			// Renders inside the danger-zone "action" slot when teardown is
			// already running — driven by a single-element TS array.
			Hash: 'Lab-Overview-TeardownBusy-Template',
			Template: /*html*/`<span class="lab-danger-progress"><span class="lab-spinner"></span>Cleaning environment…</span>`
		},
		{
			// Renders inside the danger-zone "action" slot when teardown is idle.
			Hash: 'Lab-Overview-TeardownIdle-Template',
			Template: /*html*/`<a class="lab-danger-btn" href="#/system/teardown">Clean environment</a>`
		},
		{
			Hash: 'Lab-Overview-Main-Template',
			Template: /*html*/`
<div class="lab-content">
	<div class="lab-overview">
		{~TS:Lab-Overview-Card-Template:AppData.Lab.Computed.Overview.Cards~}
	</div>

	<div class="lab-meta">
		<div class="lab-meta-row">
			<div>
				<strong>Docker</strong><br>
				{~D:AppData.Lab.Computed.Overview.DockerLine~}
			</div>
			<div>
				<strong>Last reconcile</strong><br>
				{~D:AppData.Lab.Computed.Overview.ReconcileLine~}
			</div>
			<div>
				<strong>Server</strong><br>
				Ultravisor-Lab v{~D:AppData.Lab.Status.Version~} at {~D:AppData.Lab.Computed.Overview.ServerTimeLabel~}
			</div>
		</div>
	</div>

	<div class="lab-danger">
		<div class="lab-danger-text">
			<strong>Clean environment</strong>
			Removes every lab-managed docker container, supervised process, and database row (DB engines, databases, databeacons, ultravisors, ingestion history).  Seed dataset fixtures and lab itself stay.
		</div>
		<div class="lab-danger-action">
			{~TS:Lab-Overview-TeardownBusy-Template:AppData.Lab.Computed.Overview.TeardownBusySlot~}
			{~TS:Lab-Overview-TeardownIdle-Template:AppData.Lab.Computed.Overview.TeardownIdleSlot~}
		</div>
	</div>
</div>`
		}
	],

	Renderables:
	[
		{
			RenderableHash:            'Lab-Overview-Main',
			TemplateHash:              'Lab-Overview-Main-Template',
			ContentDestinationAddress: '#Lab-Content-Container'
		}
	]
};

class LabOverviewView extends libPictView
{
	constructor(pFable, pOptions, pServiceHash)
	{
		super(pFable, pOptions, pServiceHash);
	}

	onBeforeRender(pRenderable)
	{
		let tmpStatus    = this.pict.AppData.Lab.Status || {};
		let tmpDocker    = tmpStatus.Docker || { Available: false, Version: '', Error: '' };
		let tmpReconcile = tmpStatus.LastReconcile || null;
		let tmpCounts    = tmpStatus.Counts || {};

		let tmpDockerLine;
		if (tmpDocker.Available)
		{
			tmpDockerLine = `Available, daemon ${tmpDocker.Version || 'unknown version'}`;
		}
		else
		{
			tmpDockerLine = 'Not responding';
			if (tmpDocker.Error) { tmpDockerLine += ' -- ' + tmpDocker.Error.split('\n')[0].slice(0, 120); }
		}

		let tmpReconcileLine;
		if (!tmpReconcile)
		{
			tmpReconcileLine = 'Not yet run';
		}
		else
		{
			let tmpContainers = tmpReconcile.Containers || {};
			let tmpProcesses  = tmpReconcile.Processes  || {};
			let tmpWhen = new Date(tmpReconcile.FinishedAt || tmpReconcile.StartedAt);
			tmpReconcileLine = `${tmpWhen.toLocaleTimeString()} -- `
				+ `${tmpContainers.Checked || 0} containers, `
				+ `${tmpProcesses.Checked || 0} processes, `
				+ `${(tmpContainers.Drift || 0) + (tmpProcesses.Drift || 0)} drift`;
		}

		if (!this.pict.AppData.Lab.Computed) { this.pict.AppData.Lab.Computed = {}; }
		let tmpOverview = this.pict.AppData.Lab.Overview || {};

		// Card grid is data-driven so each tile is one row in a TS array;
		// adding a card is one entry, no template surgery.
		let tmpCards =
		[
			{ Title: 'DB Engines',     Value: tmpCounts.DBEngine || 0,           SubTitle: 'dockerized MySQL/MSSQL/Postgres' },
			{ Title: 'Databases',      Value: tmpCounts.Database || 0,           SubTitle: 'provisioned inside the engines' },
			{ Title: 'Databeacons',    Value: tmpCounts.Databeacon || 0,         SubTitle: 'supervised standalone processes' },
			{ Title: 'Ultravisor',     Value: tmpCounts.UltravisorInstance || 0, SubTitle: 'workflow engines' },
			{ Title: 'Facto',          Value: tmpCounts.FactoInstance || 0,      SubTitle: 'warehouse instances' },
			{ Title: 'Ingestion Jobs', Value: tmpCounts.IngestionJob || 0,       SubTitle: 'pipeline history' }
		];

		// Two sibling slot arrays drive the if/else for the danger-zone
		// action: exactly one is populated, the other is empty. Empty
		// arrays render nothing through TS.
		let tmpBusy = !!tmpOverview.TeardownInProgress;

		this.pict.AppData.Lab.Computed.Overview =
		{
			Cards:            tmpCards,
			DockerLine:       tmpDockerLine,
			ReconcileLine:    tmpReconcileLine,
			ServerTimeLabel:  tmpStatus.ServerTime ? new Date(tmpStatus.ServerTime).toLocaleTimeString() : '--',
			TeardownBusySlot: tmpBusy ? [{}] : [],
			TeardownIdleSlot: tmpBusy ? []   : [{}]
		};

		return super.onBeforeRender(pRenderable);
	}

	onAfterRender(pRenderable, pAddress, pRecord, pContent)
	{
		this.pict.CSSMap.injectCSS();
		return super.onAfterRender(pRenderable, pAddress, pRecord, pContent);
	}
}

module.exports = LabOverviewView;
module.exports.default_configuration = _ViewConfiguration;
