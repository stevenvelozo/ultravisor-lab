'use strict';

const libPictView = require('pict-view');

/**
 * PictView-Lab-Sidebar — vertical navigation list rendered into the
 * shell's left panel. Every link is a plain `#/view/...` hash that
 * pict-router resolves into setActiveView() on the application.
 *
 * Active state is driven by AppData.Lab.ActiveView and applied
 * through the Active* keys computed in onBeforeRender. Re-render
 * whenever the active view changes (Lab-Browser-Application.setActiveView
 * calls this view's render() after flipping AppData.Lab.ActiveView).
 */

const _ViewConfiguration =
{
	ViewIdentifier:            'Lab-Sidebar',
	DefaultRenderable:         'Lab-Sidebar-Display',
	DefaultDestinationAddress: '#Lab-Sidebar-Host',

	AutoRender: false,

	CSS: /*css*/`
.lab-sidebar
{
	display: flex;
	flex-direction: column;
	gap: 2px;
	height: 100%;
	overflow-y: auto;
	padding: 12px 10px;
	box-sizing: border-box;
	background: var(--theme-color-background-panel, #FFF);
}
.lab-sidebar-section-label
{
	font-size: 0.68rem;
	font-weight: 700;
	text-transform: uppercase;
	letter-spacing: 0.7px;
	color: var(--theme-color-text-muted, #8A7F72);
	padding: 12px 10px 4px;
}
.lab-sidebar-section-label:first-child { padding-top: 0; }
.lab-sidebar-link
{
	display: block;
	padding: 8px 12px;
	border-radius: 6px;
	font-size: 0.88rem;
	color: var(--theme-color-text-primary, #3D3229);
	text-decoration: none;
	border: 1px solid transparent;
	transition: background 100ms ease, color 100ms ease;
}
.lab-sidebar-link:hover
{
	background: var(--theme-color-background-hover, #F0EDE8);
	color: var(--theme-color-text-primary, #3D3229);
}
.lab-sidebar-link.active
{
	background: var(--theme-color-brand-primary, #2E7D74);
	color: var(--theme-color-text-on-brand, #FFF);
	font-weight: 600;
	border-color: var(--theme-color-brand-primary, #2E7D74);
}
.lab-sidebar-link.active:hover
{
	background: var(--theme-color-brand-primary-hover, #3A9E92);
	color: var(--theme-color-text-on-brand, #FFF);
}
`,

	Templates:
	[
		{
			Hash: 'Lab-Sidebar-Template',
			Template: /*html*/`
<nav class="lab-sidebar" aria-label="Primary navigation">
	<a class="lab-sidebar-link {~D:AppData.Lab.Computed.Sidebar.OverviewClass~}" href="#/view/overview">Overview</a>
	<a class="lab-sidebar-link {~D:AppData.Lab.Computed.Sidebar.StacksClass~}" href="#/view/stacks">Stacks</a>

	<div class="lab-sidebar-section-label">Services</div>
	<a class="lab-sidebar-link {~D:AppData.Lab.Computed.Sidebar.UltravisorClass~}" href="#/view/ultravisor">Ultravisor</a>
	<a class="lab-sidebar-link {~D:AppData.Lab.Computed.Sidebar.BeaconsClass~}" href="#/view/beacons">Ultravisor Beacons</a>
	<a class="lab-sidebar-link {~D:AppData.Lab.Computed.Sidebar.DBEnginesClass~}" href="#/view/dbengines">DB Engines</a>

	<div class="lab-sidebar-section-label">Experiments</div>
	<a class="lab-sidebar-link {~D:AppData.Lab.Computed.Sidebar.SeedDatasetsClass~}" href="#/view/seeddatasets">Seed Data</a>
	<a class="lab-sidebar-link {~D:AppData.Lab.Computed.Sidebar.BeaconExercisesClass~}" href="#/view/beaconexercises">Beacon Exercises</a>
	<a class="lab-sidebar-link {~D:AppData.Lab.Computed.Sidebar.OperationExercisesClass~}" href="#/view/operationexercises">Operation Exercises</a>

	<div class="lab-sidebar-section-label">Activity</div>
	<a class="lab-sidebar-link {~D:AppData.Lab.Computed.Sidebar.EventsClass~}" href="#/view/events">Events</a>
</nav>`
		}
	],

	Renderables:
	[
		{
			RenderableHash:     'Lab-Sidebar-Display',
			TemplateHash:       'Lab-Sidebar-Template',
			DestinationAddress: '#Lab-Sidebar-Host',
			RenderMethod:       'replace'
		}
	]
};

class LabSidebarView extends libPictView
{
	constructor(pFable, pOptions, pServiceHash)
	{
		super(pFable, pOptions, pServiceHash);
	}

	onBeforeRender(pRenderable)
	{
		let tmpActive = (this.pict.AppData.Lab && this.pict.AppData.Lab.ActiveView) || 'Overview';

		if (!this.pict.AppData.Lab.Computed) { this.pict.AppData.Lab.Computed = {}; }
		this.pict.AppData.Lab.Computed.Sidebar =
		{
			OverviewClass:           tmpActive === 'Overview'           ? 'active' : '',
			StacksClass:             tmpActive === 'Stacks'             ? 'active' : '',
			UltravisorClass:         tmpActive === 'Ultravisor'         ? 'active' : '',
			BeaconsClass:            tmpActive === 'Beacons'            ? 'active' : '',
			DBEnginesClass:          tmpActive === 'DBEngines'          ? 'active' : '',
			SeedDatasetsClass:       tmpActive === 'SeedDatasets'       ? 'active' : '',
			BeaconExercisesClass:    tmpActive === 'BeaconExercises'    ? 'active' : '',
			OperationExercisesClass: tmpActive === 'OperationExercises' ? 'active' : '',
			EventsClass:             tmpActive === 'Events'             ? 'active' : ''
		};

		return super.onBeforeRender(pRenderable);
	}

	onAfterRender(pRenderable, pAddress, pRecord, pContent)
	{
		this.pict.CSSMap.injectCSS();
		return super.onAfterRender(pRenderable, pAddress, pRecord, pContent);
	}
}

module.exports = LabSidebarView;
module.exports.default_configuration = _ViewConfiguration;
