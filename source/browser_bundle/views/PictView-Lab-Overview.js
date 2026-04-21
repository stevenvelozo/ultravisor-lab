/**
 * PictView-Lab-Overview
 *
 * Dashboard view: counts per entity, docker status, last reconcile summary.
 * Reads directly from `AppData.Lab.Status`; stashes derived display strings
 * under `AppData.Lab.Computed.Overview` for the template to consume.
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
			Hash: 'Lab-Overview-Main-Template',
			Template: /*html*/`
<div class="lab-content">
	<div class="lab-overview">
		<div class="lab-card">
			<h3>DB Engines</h3>
			<div class="lab-card-value">{~D:AppData.Lab.Status.Counts.DBEngine~}</div>
			<div class="lab-card-sub">dockerized MySQL/MSSQL/Postgres</div>
		</div>
		<div class="lab-card">
			<h3>Databases</h3>
			<div class="lab-card-value">{~D:AppData.Lab.Status.Counts.Database~}</div>
			<div class="lab-card-sub">provisioned inside the engines</div>
		</div>
		<div class="lab-card">
			<h3>Databeacons</h3>
			<div class="lab-card-value">{~D:AppData.Lab.Status.Counts.Databeacon~}</div>
			<div class="lab-card-sub">supervised standalone processes</div>
		</div>
		<div class="lab-card">
			<h3>Ultravisor</h3>
			<div class="lab-card-value">{~D:AppData.Lab.Status.Counts.UltravisorInstance~}</div>
			<div class="lab-card-sub">workflow engines</div>
		</div>
		<div class="lab-card">
			<h3>Facto</h3>
			<div class="lab-card-value">{~D:AppData.Lab.Status.Counts.FactoInstance~}</div>
			<div class="lab-card-sub">warehouse instances</div>
		</div>
		<div class="lab-card">
			<h3>Ingestion Jobs</h3>
			<div class="lab-card-value">{~D:AppData.Lab.Status.Counts.IngestionJob~}</div>
			<div class="lab-card-sub">pipeline history</div>
		</div>
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
		<div class="lab-danger-action">{~D:AppData.Lab.Computed.Overview.TeardownControlHTML~}</div>
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
		// Teardown runs for several seconds; swap the danger button for an
		// inline "Cleaning..." indicator so the user knows work is underway.
		let tmpTeardownHtml = tmpOverview.TeardownInProgress
			? `<span class="lab-danger-progress"><span class="lab-spinner"></span>Cleaning environment…</span>`
			: `<a class="lab-danger-btn" href="#/system/teardown">Clean environment</a>`;

		this.pict.AppData.Lab.Computed.Overview =
		{
			DockerLine:          tmpDockerLine,
			ReconcileLine:       tmpReconcileLine,
			ServerTimeLabel:     tmpStatus.ServerTime ? new Date(tmpStatus.ServerTime).toLocaleTimeString() : '--',
			TeardownControlHTML: tmpTeardownHtml
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
