/**
 * PictView-Lab-Navigation
 *
 * Header bar + tab navigation.  Every button routes back through
 * `pict.PictApplication.setActiveView(name)` which swaps the active
 * content view for us.
 *
 * Templates read absolute AppData addresses directly; onBeforeRender
 * populates `AppData.Lab.Computed.Navigation` with derived display values.
 */
'use strict';

const libPictView = require('pict-view');

const _ViewConfiguration =
{
	ViewIdentifier:            'Lab-Navigation',
	DefaultRenderable:         'Lab-Navigation-Main',
	DefaultDestinationAddress: '#Lab-Navigation-Container',

	AutoRender: true,

	CSS: /*css*/`
.lab-header
{
	display: flex;
	align-items: center;
	gap: 16px;
	padding: 12px 20px;
	background: #0e1a2b;
	color: #f8fafc;
	border-bottom: 2px solid #1e293b;
}
.lab-header h1 { margin: 0; font-size: 18px; font-weight: 600; letter-spacing: 0.4px; }
.lab-header .lab-header-version { font-size: 12px; opacity: 0.6; margin-left: -8px; }
.lab-header .lab-header-spacer { flex: 1; }
.lab-header .lab-docker-badge
{
	padding: 4px 10px;
	border-radius: 12px;
	font-size: 12px;
	font-weight: 600;
	background: #991b1b;
	color: #fecaca;
}
.lab-header .lab-docker-badge.ok { background: #166534; color: #bbf7d0; }
.lab-header a.lab-nav-tab,
.lab-header a.lab-refresh-button
{
	background: transparent;
	color: #cbd5e1;
	border: 1px solid #334155;
	border-radius: 6px;
	padding: 6px 12px;
	font-size: 13px;
	cursor: pointer;
	text-decoration: none;
	display: inline-flex;
	align-items: center;
}
.lab-header a.lab-nav-tab:hover,
.lab-header a.lab-refresh-button:hover { border-color: #64748b; color: #f8fafc; }
.lab-header a.lab-nav-tab.active { background: #1d4ed8; border-color: #1d4ed8; color: #fff; }
.lab-header .lab-refresh-button { margin-left: auto; }

.lab-header .lab-nav-inline
{
	display: flex;
	align-items: center;
	gap: 6px;
	flex-wrap: nowrap;
}

/* Hamburger variant -- duplicates the same <a> links so Navigo still picks
   them up.  Hidden at wide widths; revealed below the breakpoint.  Uses
   native <details>/<summary> so there are no event handlers. */
.lab-header .lab-nav-hamburger
{
	display: none;
	position: relative;
}
.lab-header .lab-nav-hamburger summary
{
	list-style: none;
	cursor: pointer;
	padding: 6px 10px;
	border: 1px solid #334155;
	border-radius: 6px;
	color: #cbd5e1;
	font-size: 16px;
	line-height: 1;
	user-select: none;
}
.lab-header .lab-nav-hamburger summary::-webkit-details-marker { display: none; }
.lab-header .lab-nav-hamburger summary::marker { content: ''; }
.lab-header .lab-nav-hamburger summary:hover { border-color: #64748b; color: #f8fafc; }
.lab-header .lab-nav-hamburger[open] summary { background: #16213e; border-color: #64748b; color: #f8fafc; }

.lab-header .lab-nav-dropdown
{
	position: absolute;
	top: calc(100% + 8px);
	left: 0;
	background: #0e1a2b;
	border: 1px solid #334155;
	border-radius: 6px;
	padding: 8px;
	display: flex;
	flex-direction: column;
	gap: 4px;
	min-width: 200px;
	z-index: 200;
	box-shadow: 0 8px 18px rgba(0, 0, 0, 0.4);
}
.lab-header .lab-nav-dropdown a
{
	color: #cbd5e1;
	text-decoration: none;
	padding: 8px 12px;
	border-radius: 4px;
	font-size: 14px;
	display: block;
}
.lab-header .lab-nav-dropdown a:hover
{
	background: #16213e;
	color: #f8fafc;
}
.lab-header .lab-nav-dropdown a.active
{
	background: #1d4ed8;
	color: #fff;
}

@media (max-width: 960px)
{
	.lab-header .lab-nav-inline    { display: none; }
	.lab-header .lab-nav-hamburger { display: inline-block; }
}
`,

	Templates:
	[
		{
			Hash: 'Lab-Navigation-Main-Template',
			Template: /*html*/`
<div class="lab-header">
	<h1>Ultravisor Lab</h1>
	<span class="lab-header-version">v{~D:AppData.Lab.Status.Version~}</span>

	<details class="lab-nav-hamburger">
		<summary title="Menu">☰</summary>
		<nav class="lab-nav-dropdown">
			<a class="{~D:AppData.Lab.Computed.Navigation.OverviewClass~}"     href="#/view/overview">Overview</a>
			<a class="{~D:AppData.Lab.Computed.Navigation.EventsClass~}"       href="#/view/events">Events</a>
			<a class="{~D:AppData.Lab.Computed.Navigation.UltravisorClass~}"   href="#/view/ultravisor">Ultravisor</a>
			<a class="{~D:AppData.Lab.Computed.Navigation.BeaconsClass~}"      href="#/view/beacons">Ultravisor Beacons</a>
			<a class="{~D:AppData.Lab.Computed.Navigation.DBEnginesClass~}"    href="#/view/dbengines">DB Engines</a>
			<a class="{~D:AppData.Lab.Computed.Navigation.SeedDatasetsClass~}" href="#/view/seeddatasets">Seed Data</a>
			<a class="{~D:AppData.Lab.Computed.Navigation.QueueLabClass~}"     href="#/view/queuelab">Queue Lab</a>
		</nav>
	</details>

	<nav class="lab-nav-inline">
		<a class="lab-nav-tab {~D:AppData.Lab.Computed.Navigation.OverviewClass~}"     href="#/view/overview">Overview</a>
		<a class="lab-nav-tab {~D:AppData.Lab.Computed.Navigation.EventsClass~}"       href="#/view/events">Events</a>
		<a class="lab-nav-tab {~D:AppData.Lab.Computed.Navigation.UltravisorClass~}"   href="#/view/ultravisor">Ultravisor</a>
		<a class="lab-nav-tab {~D:AppData.Lab.Computed.Navigation.BeaconsClass~}"      href="#/view/beacons">Ultravisor Beacons</a>
		<a class="lab-nav-tab {~D:AppData.Lab.Computed.Navigation.DBEnginesClass~}"    href="#/view/dbengines">DB Engines</a>
		<a class="lab-nav-tab {~D:AppData.Lab.Computed.Navigation.SeedDatasetsClass~}" href="#/view/seeddatasets">Seed Data</a>
		<a class="lab-nav-tab {~D:AppData.Lab.Computed.Navigation.QueueLabClass~}"     href="#/view/queuelab">Queue Lab</a>
	</nav>

	<span class="lab-header-spacer"></span>
	<span class="lab-docker-badge {~D:AppData.Lab.Computed.Navigation.DockerClass~}" title="{~D:AppData.Lab.Computed.Navigation.DockerTooltip~}">docker: {~D:AppData.Lab.Computed.Navigation.DockerLabel~}</span>
	<a class="lab-refresh-button" href="#/system/reconcile">Refresh</a>
</div>`
		}
	],

	Renderables:
	[
		{
			RenderableHash:           'Lab-Navigation-Main',
			TemplateHash:             'Lab-Navigation-Main-Template',
			ContentDestinationAddress: '#Lab-Navigation-Container'
		}
	]
};

class LabNavigationView extends libPictView
{
	constructor(pFable, pOptions, pServiceHash)
	{
		super(pFable, pOptions, pServiceHash);
	}

	onBeforeRender(pRenderable)
	{
		let tmpStatus = this.pict.AppData.Lab.Status || {};
		let tmpDocker = tmpStatus.Docker || { Available: false, Version: '', Error: '' };
		let tmpActive = this.pict.AppData.Lab.ActiveView || 'Overview';

		if (!this.pict.AppData.Lab.Computed) { this.pict.AppData.Lab.Computed = {}; }
		this.pict.AppData.Lab.Computed.Navigation =
		{
			DockerLabel:         tmpDocker.Available ? (tmpDocker.Version || 'ok') : 'unavailable',
			DockerClass:         tmpDocker.Available ? 'ok' : '',
			DockerTooltip:       tmpDocker.Available ? `Docker daemon ${tmpDocker.Version} is responsive` : (tmpDocker.Error || 'Docker daemon is not responding'),
			OverviewClass:       tmpActive === 'Overview'     ? 'active' : '',
			DBEnginesClass:      tmpActive === 'DBEngines'    ? 'active' : '',
			UltravisorClass:     tmpActive === 'Ultravisor'   ? 'active' : '',
			BeaconsClass:        tmpActive === 'Beacons'      ? 'active' : '',
			SeedDatasetsClass:   tmpActive === 'SeedDatasets' ? 'active' : '',
			QueueLabClass:       tmpActive === 'QueueLab'     ? 'active' : '',
			EventsClass:         tmpActive === 'Events'       ? 'active' : ''
		};

		return super.onBeforeRender(pRenderable);
	}

	onAfterRender(pRenderable, pAddress, pRecord, pContent)
	{
		this.pict.CSSMap.injectCSS();
		return super.onAfterRender(pRenderable, pAddress, pRecord, pContent);
	}
}

module.exports = LabNavigationView;
module.exports.default_configuration = _ViewConfiguration;
