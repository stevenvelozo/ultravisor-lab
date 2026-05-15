'use strict';

const libPictView = require('pict-view');

/**
 * Lab-Layout — application chrome built on pict-section-modal's
 * shell() API. This view owns the shell; everything else (TopBar,
 * Sidebar, Settings panel, active-view center) lives in panels.
 *
 * Panel layout:
 *
 *   ┌──────────────────────────────────────────────────────────────┐
 *   │ #Theme-TopBar  (top, fixed, 48px) — BrandMark + Nav + User   │
 *   ├────────────┬─────────────────────────────────────────────────┤
 *   │ #Lab-      │ #Lab-Content-Container                          │
 *   │ Sidebar-   │ (center — the active view renders here)         │
 *   │ Host       │                                                 │
 *   │ (left,     │                                                 │
 *   │ resizable) │                                                 │
 *   └────────────┴─────────────────────────────────────────────────┘
 *
 * Plus #Lab-Settings-Panel — Hidden panel that overlays from the
 * right when the gear button in Lab-TopBar-User toggles it. No edge
 * affordance; gear is the only way in.
 *
 * The view is registered at hash 'Lab-Layout' (NOT 'Lab-Navigation'
 * any more — the old horizontal-header navigation view is gone).
 * setActiveView() in Lab-Browser-Application calls renderChrome()
 * to refresh the sidebar's active-class highlight and the topbar's
 * context label.
 */

const _ViewConfiguration =
{
	ViewIdentifier:            'Lab-Layout',
	DefaultRenderable:         'Lab-Layout-Shell',
	DefaultDestinationAddress: '#Lab-Application-Container',

	AutoRender: false,

	CSS: /*css*/`
/* height: 100% (not 100vh) so Theme-Scale's CSS zoom on <html>
   doesn't push panels off-screen — vh units render against the
   un-zoomed viewport. 100% cascades through html → body →
   container and stays in sync at any scale. */
html, body { height: 100%; margin: 0; padding: 0; }
body
{
	background: var(--theme-color-background-primary, #f1f5f9);
	color: var(--theme-color-text-primary, #0f172a);
	font-family: var(--theme-typography-family-sans, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif);
}
#Lab-Application-Container
{
	height: 100%;
	min-height: 0;
	overflow: hidden;
}

/* Shell-managed panels inherit themed surfaces from the active theme. */
.pict-modal-shell-host    { height: 100%; }
.pict-modal-shell         { background: var(--theme-color-background-primary, #f1f5f9); }
.pict-modal-shell-panel   { background: var(--theme-color-background-panel,   #ffffff); }
.pict-modal-shell-center  { background: var(--theme-color-background-primary, #f1f5f9); }

/* Sidebar destination — Lab-Sidebar view writes here. */
#Lab-Sidebar-Host
{
	height: 100%;
	min-height: 0;
	overflow-y: auto;
	background: var(--theme-color-background-panel, #ffffff);
	color: var(--theme-color-text-primary, #0f172a);
}

/* Settings panel destination — Lab-SettingsPanel writes here. */
#Lab-Settings-Panel
{
	height: 100%;
	min-height: 0;
	overflow-y: auto;
	background: var(--theme-color-background-panel, #ffffff);
	color: var(--theme-color-text-primary, #0f172a);
	border-left: 1px solid var(--theme-color-border-default, #DDD6CA);
}

/* Center workspace — feature views (Overview, Stacks, ...) write
   into #Lab-Content-Container, which the shell creates inside the
   center area. */
#Lab-Content-Container
{
	height: 100%;
	min-height: 0;
	overflow-y: auto;
	padding: 16px 20px;
	box-sizing: border-box;
	background: var(--theme-color-background-primary, #f1f5f9);
	color: var(--theme-color-text-primary, #0f172a);
}
.lab-boot-placeholder,
.lab-boot-error
{
	padding: 24px;
	color: var(--theme-color-text-muted, #64748b);
	font-style: italic;
}
.lab-boot-error
{
	color: var(--theme-color-status-error, #991b1b);
	font-style: normal;
}
`,

	Templates:
	[
		{
			Hash: 'Lab-Layout-Shell-Template',
			Template: /*html*/`
<div id="Lab-Layout-Mount" style="height:100%"></div>`
		}
	],

	Renderables:
	[
		{
			RenderableHash:     'Lab-Layout-Shell',
			TemplateHash:       'Lab-Layout-Shell-Template',
			DestinationAddress: '#Lab-Application-Container',
			RenderMethod:       'replace'
		}
	]
};

class LabLayoutView extends libPictView
{
	constructor(pFable, pOptions, pServiceHash)
	{
		super(pFable, pOptions, pServiceHash);
		this._shell = null;
		this._shellPanelsBuilt = false;
	}

	onAfterRender(pRenderable, pAddress, pRecord, pContent)
	{
		this.pict.CSSMap.injectCSS();

		if (!this._shellPanelsBuilt)
		{
			this._buildShell();
			this._shellPanelsBuilt = true;
		}

		return super.onAfterRender(pRenderable, pAddress, pRecord, pContent);
	}

	_buildShell()
	{
		let tmpModalSection = this.pict.views['Pict-Section-Modal'];
		if (!tmpModalSection || typeof tmpModalSection.shell !== 'function')
		{
			this.pict.log.warn('Lab-Layout: pict-section-modal.shell not available');
			return;
		}

		let tmpMount = document.getElementById('Lab-Layout-Mount');
		if (!tmpMount)
		{
			this.pict.log.warn('Lab-Layout: #Lab-Layout-Mount not in DOM yet');
			return;
		}

		this._shell = tmpModalSection.shell(tmpMount, { PersistenceKey: 'ultravisor-lab' });

		// Top — theme chrome. Theme-TopBar fills it with BrandMark on
		// the left, host-supplied NavView (Lab-TopBar-Nav) showing the
		// active-view label, and host-supplied UserView (Lab-TopBar-User)
		// on the right with the docker status badge, refresh button,
		// and the gear that toggles the hidden settings panel.
		this._shell.addPanel(
		{
			Hash: 'topbar',
			Side: 'top',
			Mode: 'fixed',
			Size: 48,
			ContentDestinationId: 'Theme-TopBar',
			ContentView: 'Theme-TopBar'
		});

		// Left — sidebar. Resizable, collapsible, responsive drawer
		// below 960px (matches the legacy lab-header hamburger
		// breakpoint).
		this._shell.addPanel(
		{
			Hash: 'sidebar',
			Side: 'left',
			Mode: 'resizable',
			Size: 240,
			MinSize: 180,
			MaxSize: 360,
			Title: 'Navigation',
			ContentDestinationId: 'Lab-Sidebar-Host',
			ContentView: 'Lab-Sidebar',
			ResponsiveDrawer: 960
		});

		// Right (overlay, Hidden) — settings panel. Hidden:true means
		// no edge affordance when collapsed; the gear button in the
		// User slot is the only way to reveal it. Overlay position
		// floats above content rather than pushing it aside.
		this._shell.addPanel(
		{
			Hash: 'settings',
			Side: 'right',
			Mode: 'resizable',
			Position: 'overlay',
			Size: 360,
			MinSize: 280,
			MaxSize: 540,
			Hidden: true,
			Collapsed: true,
			ContentDestinationId: 'Lab-Settings-Panel',
			ContentView: 'Lab-SettingsPanel'
		});

		// Center — workspace area. Existing feature views (Lab-Overview
		// etc.) target #Lab-Content-Container, which the shell creates
		// inside the center destination.
		this._shell.center({ ContentDestinationId: 'Lab-Content-Container' });
	}

	// ─────────────────────────────────────────────
	//  Public panel accessors used by other views
	//  (e.g. the gear button in TopBar-User)
	// ─────────────────────────────────────────────

	getSidebarPanel()  { return this._shell ? this._shell.getPanel('sidebar')  : null; }
	getSettingsPanel() { return this._shell ? this._shell.getPanel('settings') : null; }

	toggleSidebar()
	{
		let tmpPanel = this.getSidebarPanel();
		if (tmpPanel) { tmpPanel.toggle(); }
	}

	toggleSettingsPanel()
	{
		let tmpPanel = this.getSettingsPanel();
		if (tmpPanel) { tmpPanel.toggle(); }
	}

	/**
	 * Re-render the chrome views (sidebar active-class + topbar
	 * context label + docker badge). Called by Lab-Browser-Application
	 * after setActiveView or refreshAll updates AppData. The shell
	 * itself is data-free and doesn't need rebuilding.
	 */
	renderChrome()
	{
		let tmpSidebar = this.pict.views['Lab-Sidebar'];
		let tmpNav     = this.pict.views['Lab-TopBar-Nav'];
		let tmpUser    = this.pict.views['Lab-TopBar-User'];
		if (tmpSidebar) { tmpSidebar.render(); }
		if (tmpNav)     { tmpNav.render();     }
		if (tmpUser)    { tmpUser.render();    }
	}
}

module.exports = LabLayoutView;
module.exports.default_configuration = _ViewConfiguration;
