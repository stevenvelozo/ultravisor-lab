'use strict';

const libPictView = require('pict-view');

/**
 * PictView-Lab-TopBar-User — slot view rendered into Theme-TopBar's
 * UserView slot. Hosts the Docker daemon status badge, a Refresh
 * button (re-runs the reconcile), and the gear button that toggles
 * the hidden settings panel managed by Lab-Layout.
 *
 * Re-render whenever AppData.Lab.Status.Docker changes (driven by
 * the periodic refreshAll in Lab-Browser-Application).
 */

const _ViewConfiguration =
{
	ViewIdentifier:            'Lab-TopBar-User',
	DefaultRenderable:         'Lab-TopBar-User-Display',
	DefaultDestinationAddress: '#Theme-TopBar-User',

	AutoRender: false,

	CSS: /*css*/`
.lab-topbar-user
{
	display: flex;
	align-items: center;
	height: 100%;
	gap: 8px;
	padding: 0 12px;
	/* Topbar uses background-panel; use on-panel text, not on-brand. */
	color: var(--theme-color-text-primary, #0f172a);
	font-size: 0.78rem;
}
.lab-topbar-user-docker
{
	padding: 4px 10px;
	border-radius: 12px;
	font-size: 0.72rem;
	font-weight: 600;
	letter-spacing: 0.3px;
	background: var(--theme-color-status-error, #991b1b);
	color: var(--theme-color-text-on-brand, #ffffff);
	white-space: nowrap;
}
.lab-topbar-user-docker.ok
{
	background: var(--theme-color-status-success, #166534);
	color: var(--theme-color-text-on-brand, #ffffff);
}
.lab-topbar-user-btn
{
	height: 30px;
	padding: 0 12px;
	display: inline-flex;
	align-items: center;
	justify-content: center;
	gap: 6px;
	line-height: 1;
	border: 1px solid var(--theme-color-border-default, #DDD6CA);
	border-radius: 4px;
	cursor: pointer;
	font-size: 0.78rem;
	font-weight: 600;
	box-sizing: border-box;
	text-decoration: none;
	background: transparent;
	color: var(--theme-color-text-secondary, #475569);
}
.lab-topbar-user-btn:hover
{
	color: var(--theme-color-text-primary, #0f172a);
	border-color: var(--theme-color-brand-primary, #2E7D74);
	background: var(--theme-color-background-hover, rgba(0, 0, 0, 0.04));
}
.lab-topbar-user-btn-gear
{
	padding: 0 8px;
	width: 32px;
}
.lab-topbar-user-btn-gear svg
{
	width: 16px;
	height: 16px;
}

@media (max-width: 768px)
{
	.lab-topbar-user-docker { display: none; }
	.lab-topbar-user-btn { height: 28px; padding: 0 10px; font-size: 0.72rem; }
}
`,

	Templates:
	[
		{
			Hash: 'Lab-TopBar-User-Template',
			Template: /*html*/`
<div class="lab-topbar-user">
	<span class="lab-topbar-user-docker {~D:AppData.Lab.Computed.TopBarUser.DockerClass~}"
		title="{~D:AppData.Lab.Computed.TopBarUser.DockerTooltip~}">docker: {~D:AppData.Lab.Computed.TopBarUser.DockerLabel~}</span>
	<a class="lab-topbar-user-btn" href="#/system/reconcile" title="Refresh status">Refresh</a>
	<button class="lab-topbar-user-btn lab-topbar-user-btn-gear"
		onclick="_Pict.views['Lab-Layout'].toggleSettingsPanel()"
		title="Settings" aria-label="Settings">
		<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"
			stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
			<circle cx="12" cy="12" r="3"/>
			<path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/>
		</svg>
	</button>
</div>`
		}
	],

	Renderables:
	[
		{
			RenderableHash:     'Lab-TopBar-User-Display',
			TemplateHash:       'Lab-TopBar-User-Template',
			DestinationAddress: '#Theme-TopBar-User',
			RenderMethod:       'replace'
		}
	]
};

class LabTopBarUserView extends libPictView
{
	constructor(pFable, pOptions, pServiceHash)
	{
		super(pFable, pOptions, pServiceHash);
	}

	onBeforeRender(pRenderable)
	{
		let tmpStatus = (this.pict.AppData.Lab && this.pict.AppData.Lab.Status) || {};
		let tmpDocker = tmpStatus.Docker || { Available: false, Version: '', Error: '' };

		if (!this.pict.AppData.Lab.Computed) { this.pict.AppData.Lab.Computed = {}; }
		this.pict.AppData.Lab.Computed.TopBarUser =
		{
			DockerLabel:   tmpDocker.Available ? (tmpDocker.Version || 'ok') : 'unavailable',
			DockerClass:   tmpDocker.Available ? 'ok' : '',
			DockerTooltip: tmpDocker.Available
				? ('Docker daemon ' + (tmpDocker.Version || '') + ' is responsive')
				: (tmpDocker.Error || 'Docker daemon is not responding')
		};

		return super.onBeforeRender(pRenderable);
	}

	onAfterRender(pRenderable, pAddress, pRecord, pContent)
	{
		this.pict.CSSMap.injectCSS();
		return super.onAfterRender(pRenderable, pAddress, pRecord, pContent);
	}
}

module.exports = LabTopBarUserView;
module.exports.default_configuration = _ViewConfiguration;
