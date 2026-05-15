'use strict';

const libPictView = require('pict-view');

/**
 * Lab-SettingsPanel — content of the hidden right-side settings
 * panel managed by the shell. The panel itself is built in
 * Lab-Layout._buildShell() with Hidden:true; the gear button in
 * Lab-TopBar-User toggles its visibility. This view just renders
 * the panel's interior.
 *
 * Section:
 *   - Appearance — pict-section-theme controls (Picker / ModeToggle /
 *                  ScaleSelect) mounted via Theme-Section.mount() on
 *                  every render. Theme state is owned by
 *                  pict-section-theme (its own localStorage scope).
 */

const _ViewConfiguration =
{
	ViewIdentifier:            'Lab-SettingsPanel',
	DefaultRenderable:         'Lab-SettingsPanel-Display',
	DefaultDestinationAddress: '#Lab-Settings-Panel',

	AutoRender: false,

	CSS: /*css*/`
#Lab-Settings-Panel .lab-settings-body
{
	padding: 16px 18px 24px;
	font-size: 0.9rem;
	color: var(--theme-color-text-primary, #3D3229);
}
.lab-settings-section
{
	margin-bottom: 18px;
}
.lab-settings-label
{
	font-size: 0.72rem;
	font-weight: 700;
	text-transform: uppercase;
	letter-spacing: 0.6px;
	color: var(--theme-color-text-muted, #8A7F72);
	margin-bottom: 10px;
}
.lab-settings-divider
{
	height: 1px;
	background: var(--theme-color-border-light, #EDE9E3);
	margin: 14px 0;
}
.lab-settings-hint
{
	font-size: 0.78rem;
	color: var(--theme-color-text-muted, #8A7F72);
	line-height: 1.45;
}
/* Theme-controls mount point — leave layout to the views themselves;
   just stack their rows comfortably. */
#Lab-Settings-Theme .pict-theme-mount
{
	display: flex;
	flex-direction: column;
	gap: 10px;
}
#Lab-Settings-Theme .pict-theme-mount-row
{
	display: flex;
	align-items: center;
	justify-content: flex-start;
}
`,

	Templates:
	[
		{
			Hash: 'Lab-SettingsPanel-Template',
			Template: /*html*/`
<div class="lab-settings-body">
	<div class="lab-settings-section">
		<div class="lab-settings-label">Appearance</div>
		<div id="Lab-Settings-Theme"></div>
	</div>
	<div class="lab-settings-divider"></div>
	<div class="lab-settings-section">
		<div class="lab-settings-hint">More lab preferences will appear here.</div>
	</div>
</div>`
		}
	],

	Renderables:
	[
		{
			RenderableHash:     'Lab-SettingsPanel-Display',
			TemplateHash:       'Lab-SettingsPanel-Template',
			DestinationAddress: '#Lab-Settings-Panel',
			RenderMethod:       'replace'
		}
	]
};

class LabSettingsPanelView extends libPictView
{
	constructor(pFable, pOptions, pServiceHash)
	{
		super(pFable, pOptions, pServiceHash);
	}

	onAfterRender(pRenderable, pAddress, pRecord, pContent)
	{
		this.pict.CSSMap.injectCSS();

		// Mount the pict-section-theme controls. The template re-render
		// rewrites the inner HTML — including erasing previously-rendered
		// theme view containers — so we re-mount every render.
		let tmpThemeProvider = this.pict.providers && this.pict.providers['Theme-Section'];
		if (tmpThemeProvider && typeof tmpThemeProvider.mount === 'function')
		{
			tmpThemeProvider.mount(
			{
				Container: '#Lab-Settings-Theme',
				Views: ['Picker', 'ModeToggle', 'ScaleSelect']
			});
		}

		return super.onAfterRender(pRenderable, pAddress, pRecord, pContent);
	}
}

module.exports = LabSettingsPanelView;
module.exports.default_configuration = _ViewConfiguration;
