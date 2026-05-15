'use strict';

const libPictView = require('pict-view');

/**
 * PictView-Lab-TopBar-Nav — slot view rendered into Theme-TopBar's
 * NavView slot. Shows the currently-active view as a context label
 * (e.g. "Overview", "Stacks", "DB Engines") plus the build version.
 * The brand wordmark is rendered to the left by Theme-TopBar's
 * BrandMark; action buttons live in the User slot.
 *
 * Re-render whenever AppData.Lab.ActiveView changes (handled by
 * Lab-Browser-Application.setActiveView).
 */

const _VIEW_LABELS =
{
	'Overview':           'Overview',
	'Stacks':             'Stacks',
	'Ultravisor':         'Ultravisor',
	'Beacons':            'Ultravisor Beacons',
	'DBEngines':          'DB Engines',
	'SeedDatasets':       'Seed Data',
	'BeaconExercises':    'Beacon Exercises',
	'OperationExercises': 'Operation Exercises',
	'Events':             'Events'
};

const _ViewConfiguration =
{
	ViewIdentifier:            'Lab-TopBar-Nav',
	DefaultRenderable:         'Lab-TopBar-Nav-Display',
	DefaultDestinationAddress: '#Theme-TopBar-Nav',

	AutoRender: false,

	CSS: /*css*/`
.lab-topbar-nav
{
	display: flex;
	align-items: center;
	height: 100%;
	min-width: 0;
	padding: 0 12px;
	gap: 10px;
	/* Topbar panel uses background-panel; use on-panel text, not on-brand. */
	color: var(--theme-color-text-primary, #0f172a);
	font-size: 0.95rem;
}
.lab-topbar-nav-label
{
	font-weight: 600;
	letter-spacing: 0.2px;
	overflow: hidden;
	text-overflow: ellipsis;
	white-space: nowrap;
}
.lab-topbar-nav-version
{
	font-size: 0.72rem;
	color: var(--theme-color-text-muted, #64748b);
	font-variant-numeric: tabular-nums;
}
`,

	Templates:
	[
		{
			Hash: 'Lab-TopBar-Nav-Template',
			Template: /*html*/`
<div class="lab-topbar-nav">
	<span class="lab-topbar-nav-label">{~D:AppData.Lab.Computed.TopBarNav.Label~}</span>
	{~TS:Lab-TopBar-Nav-Version-Row:AppData.Lab.Computed.TopBarNav.VersionSlot~}
</div>`
		},
		{
			Hash: 'Lab-TopBar-Nav-Version-Row',
			Template: /*html*/`<span class="lab-topbar-nav-version">v{~D:Record.Version~}</span>`
		}
	],

	Renderables:
	[
		{
			RenderableHash:     'Lab-TopBar-Nav-Display',
			TemplateHash:       'Lab-TopBar-Nav-Template',
			DestinationAddress: '#Theme-TopBar-Nav',
			RenderMethod:       'replace'
		}
	]
};

class LabTopBarNavView extends libPictView
{
	constructor(pFable, pOptions, pServiceHash)
	{
		super(pFable, pOptions, pServiceHash);
	}

	onBeforeRender(pRenderable)
	{
		let tmpActive = (this.pict.AppData.Lab && this.pict.AppData.Lab.ActiveView) || 'Overview';
		let tmpVersion = (this.pict.AppData.Lab && this.pict.AppData.Lab.Status && this.pict.AppData.Lab.Status.Version) || '';

		if (!this.pict.AppData.Lab.Computed) { this.pict.AppData.Lab.Computed = {}; }
		this.pict.AppData.Lab.Computed.TopBarNav =
		{
			Label:       _VIEW_LABELS[tmpActive] || tmpActive,
			VersionSlot: tmpVersion ? [{ Version: tmpVersion }] : []
		};

		return super.onBeforeRender(pRenderable);
	}

	onAfterRender(pRenderable, pAddress, pRecord, pContent)
	{
		this.pict.CSSMap.injectCSS();
		return super.onAfterRender(pRenderable, pAddress, pRecord, pContent);
	}
}

module.exports = LabTopBarNavView;
module.exports.default_configuration = _ViewConfiguration;
