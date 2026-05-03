/**
 * PictView-Lab-Stacks (Phase 8 — Pillar 4)
 *
 * One Pict view per tab, four sub-screens controlled by AppData.Lab.Stacks.Screen:
 *   'list'           → saved stacks + + Add a stack button
 *   'preset-chooser' → grid of preset cards
 *   'editor'         → input form for a single stack
 *   'detail'         → status + compose YAML preview + actions
 *
 * Sub-screens render via the single-element-array conditional pattern:
 *   AppData.Lab.Stacks.ListSlot          = (Screen === 'list')        ? [{...}] : []
 *   AppData.Lab.Stacks.PresetChooserSlot = (Screen === 'preset-chooser') ? [{...}] : []
 *   AppData.Lab.Stacks.EditorSlot        = (Screen === 'editor')      ? [{...}] : []
 *   AppData.Lab.Stacks.DetailSlot        = (Screen === 'detail')      ? [{...}] : []
 *
 * Action methods on Lab-Browser-Application (openPresetChooser, etc.)
 * mutate Screen + the associated record and re-render this view. No
 * inline event handlers in templates; everything routes through hash links.
 */

'use strict';

const libPictView = require('pict-view');

const _ViewConfiguration =
{
	ViewIdentifier:            'Lab-Stacks',
	DefaultRenderable:         'Lab-Stacks-Main',
	DefaultDestinationAddress: '#Lab-Content-Container',

	AutoRender: false,

	CSS: /*css*/`
.lab-stacks { padding: 20px; max-width: 1200px; margin: 0 auto; }
.lab-stacks-toolbar { display: flex; align-items: center; gap: 12px; margin-bottom: 16px; }
.lab-stacks-toolbar h2 { margin: 0; font-size: 20px; font-weight: 600; flex: 1; }

.lab-stack-card
{
	background: #16213e;
	border: 1px solid #1e293b;
	border-radius: 8px;
	padding: 16px 20px;
	margin-bottom: 12px;
	display: flex;
	align-items: center;
	gap: 16px;
}
.lab-stack-card-main { flex: 1; min-width: 0; }
.lab-stack-card h3 { margin: 0 0 4px 0; font-size: 15px; color: #f8fafc; font-weight: 600; }
.lab-stack-card .lab-stack-desc { font-size: 12px; color: #94a3b8; line-height: 1.4; }
.lab-stack-card .lab-stack-meta { display: flex; gap: 16px; margin-top: 8px; font-size: 11px; color: #64748b; }
.lab-stack-card .lab-stack-meta span code { color: #cbd5e1; background: #0f172a; padding: 1px 6px; border-radius: 3px; }
.lab-stack-card-actions { display: flex; gap: 6px; flex-shrink: 0; }

.lab-stack-status
{
	display: inline-block;
	padding: 2px 10px;
	border-radius: 12px;
	font-size: 11px;
	font-weight: 600;
	text-transform: uppercase;
	letter-spacing: 0.5px;
}
.lab-stack-status.stopped     { background: #334155; color: #cbd5e1; }
.lab-stack-status.starting    { background: #1d4ed8; color: #dbeafe; }
.lab-stack-status.running     { background: #166534; color: #bbf7d0; }
.lab-stack-status.unhealthy   { background: #92400e; color: #fed7aa; }
.lab-stack-status.stopping    { background: #475569; color: #e2e8f0; }
.lab-stack-status.error       { background: #991b1b; color: #fecaca; }
.lab-stack-status.preset-blocked { background: #7c2d12; color: #fed7aa; }

.lab-stacks-empty
{
	background: #16213e;
	border: 1px dashed #334155;
	border-radius: 8px;
	padding: 40px 20px;
	text-align: center;
	color: #94a3b8;
	font-size: 14px;
}

.lab-btn
{
	display: inline-block;
	background: #1d4ed8;
	color: #fff;
	border: 1px solid #1d4ed8;
	padding: 6px 14px;
	border-radius: 6px;
	font-size: 13px;
	cursor: pointer;
	text-decoration: none;
	white-space: nowrap;
}
.lab-btn:hover { background: #1e40af; }
.lab-btn.secondary { background: transparent; color: #cbd5e1; border-color: #334155; }
.lab-btn.secondary:hover { border-color: #64748b; color: #f8fafc; background: transparent; }
.lab-btn.danger { background: #991b1b; border-color: #991b1b; color: #fecaca; }
.lab-btn.danger:hover { background: #7f1d1d; }
.lab-btn.success { background: #166534; border-color: #166534; }
.lab-btn.success:hover { background: #14532d; }
.lab-btn.small { padding: 4px 10px; font-size: 12px; }
.lab-btn.disabled { opacity: 0.4; pointer-events: none; }

.lab-preset-grid
{
	display: grid;
	grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
	gap: 14px;
}
.lab-preset-card
{
	background: #16213e;
	border: 1px solid #1e293b;
	border-radius: 8px;
	padding: 16px;
	display: flex;
	flex-direction: column;
	gap: 10px;
}
.lab-preset-card h3 { margin: 0; font-size: 14px; font-weight: 600; color: #f8fafc; }
.lab-preset-card .lab-preset-desc { font-size: 12px; color: #94a3b8; line-height: 1.5; flex: 1; }
.lab-preset-card .lab-preset-meta { font-size: 11px; color: #64748b; }
.lab-preset-card .lab-preset-actions { display: flex; gap: 6px; }

/* ── Editor ──────────────────────────────────────────────────────────── */

.lab-stack-editor { background: #16213e; border: 1px solid #1e293b; border-radius: 8px; padding: 24px; }
.lab-stack-editor-header { margin-bottom: 20px; padding-bottom: 16px; border-bottom: 1px solid #1e293b; }
.lab-stack-editor-header h2 { margin: 0 0 4px 0; font-size: 18px; color: #f8fafc; }
.lab-stack-editor-header .lab-stack-desc { font-size: 12px; color: #94a3b8; }

.lab-stack-section-title { font-size: 11px; text-transform: uppercase; letter-spacing: 1px; color: #64748b; margin: 24px 0 8px 0; font-weight: 600; }

.lab-stack-input { display: flex; flex-direction: column; gap: 4px; margin-bottom: 14px; }
.lab-stack-input label { font-size: 12px; color: #cbd5e1; font-weight: 600; }
.lab-stack-input .lab-stack-input-desc { font-size: 11px; color: #94a3b8; line-height: 1.4; }
.lab-stack-input input,
.lab-stack-input select
{
	background: #0f172a;
	color: #f8fafc;
	border: 1px solid #334155;
	border-radius: 4px;
	padding: 6px 10px;
	font-size: 13px;
	font-family: inherit;
}
.lab-stack-input input:focus,
.lab-stack-input select:focus { outline: none; border-color: #1d4ed8; }
.lab-stack-input.required label::after { content: ' *'; color: #f87171; }

.lab-stack-component-list { display: flex; flex-direction: column; gap: 8px; }
.lab-stack-component-row
{
	display: flex;
	gap: 12px;
	align-items: center;
	background: #0f172a;
	border: 1px solid #1e293b;
	border-radius: 6px;
	padding: 10px 14px;
	font-size: 12px;
}
.lab-stack-component-row code { color: #cbd5e1; background: transparent; }
.lab-stack-component-row .lab-stack-component-type { padding: 2px 8px; background: #334155; border-radius: 10px; font-size: 10px; color: #cbd5e1; text-transform: uppercase; letter-spacing: 0.5px; }
.lab-stack-component-row .lab-stack-component-image { color: #94a3b8; font-family: monospace; font-size: 11px; flex: 1; }

.lab-stack-actions { display: flex; gap: 10px; margin-top: 24px; padding-top: 16px; border-top: 1px solid #1e293b; }

/* ── Launch output (error panel) ─────────────────────────────────────── */

.lab-launch-output
{
	margin: 16px 0;
	border: 1px solid #7f1d1d;
	border-radius: 6px;
	background: #1a0e0e;
	overflow: hidden;
}
.lab-launch-output-header
{
	display: flex;
	align-items: center;
	gap: 12px;
	padding: 8px 12px;
	background: #7f1d1d;
	color: #fee2e2;
	font-size: 11px;
	text-transform: uppercase;
	letter-spacing: 1px;
}
.lab-launch-output-status { font-weight: 600; }
.lab-launch-output-path   { font-family: monospace; text-transform: none; opacity: 0.8; font-size: 11px; }
.lab-launch-output-body
{
	margin: 0;
	padding: 12px;
	font-family: monospace;
	font-size: 12px;
	color: #fecaca;
	white-space: pre-wrap;
	word-break: break-word;
	max-height: 320px;
	overflow: auto;
}

/* ── Preflight report ────────────────────────────────────────────────── */

.lab-preflight-report { margin: 16px 0; }
.lab-preflight-report-header
{
	font-size: 11px;
	text-transform: uppercase;
	letter-spacing: 1px;
	font-weight: 600;
	color: #94a3b8;
	margin-bottom: 8px;
	display: flex;
	align-items: center;
	gap: 12px;
}
.lab-preflight-report-status
{
	padding: 2px 10px;
	border-radius: 10px;
	font-size: 11px;
	letter-spacing: 0.5px;
}
.lab-preflight-report-status.ready    { background: #166534; color: #bbf7d0; }
.lab-preflight-report-status.warnings { background: #92400e; color: #fed7aa; }
.lab-preflight-report-status.blockers { background: #991b1b; color: #fecaca; }
.lab-preflight-item
{
	display: flex;
	align-items: flex-start;
	gap: 10px;
	padding: 6px 10px;
	background: #0f172a;
	border-left: 3px solid #334155;
	margin-bottom: 4px;
	font-size: 12px;
	line-height: 1.4;
}
.lab-preflight-item.info  { border-left-color: #3b82f6; }
.lab-preflight-item.warn  { border-left-color: #f59e0b; }
.lab-preflight-item.block { border-left-color: #ef4444; }
.lab-preflight-item .lab-preflight-icon
{
	flex-shrink: 0;
	font-weight: 700;
	width: 14px;
	text-align: center;
}
.lab-preflight-item.info  .lab-preflight-icon { color: #60a5fa; }
.lab-preflight-item.warn  .lab-preflight-icon { color: #fbbf24; }
.lab-preflight-item.block .lab-preflight-icon { color: #f87171; }
.lab-preflight-item .lab-preflight-path { color: #64748b; font-family: monospace; font-size: 10px; flex-shrink: 0; min-width: 200px; }
.lab-preflight-item .lab-preflight-message { color: #cbd5e1; flex: 1; }

/* ── Detail view ─────────────────────────────────────────────────────── */

.lab-stack-detail { background: #16213e; border: 1px solid #1e293b; border-radius: 8px; padding: 24px; }
.lab-stack-detail-header { display: flex; align-items: center; gap: 12px; margin-bottom: 16px; padding-bottom: 16px; border-bottom: 1px solid #1e293b; }
.lab-stack-detail-header h2 { margin: 0; font-size: 18px; color: #f8fafc; flex: 1; }
.lab-stack-detail-actions { display: flex; gap: 6px; }
.lab-stack-status-card
{
	background: #0f172a;
	border: 1px solid #1e293b;
	border-radius: 6px;
	padding: 12px 16px;
	margin-bottom: 16px;
}
.lab-stack-component-status
{
	display: grid;
	grid-template-columns: 1fr 100px 100px 120px;
	gap: 10px;
	padding: 6px 0;
	font-size: 12px;
	border-bottom: 1px dashed #1e293b;
}
.lab-stack-component-status:last-child { border-bottom: none; }
.lab-stack-component-status .name { color: #f8fafc; font-weight: 600; }
.lab-stack-component-status .state { color: #cbd5e1; }
.lab-stack-component-status .health { color: #94a3b8; }
.lab-stack-component-status .uptime { color: #64748b; font-size: 11px; }

.lab-yaml-preview
{
	background: #0a0e1a;
	border: 1px solid #1e293b;
	border-radius: 6px;
	padding: 14px;
	color: #cbd5e1;
	font-family: monospace;
	font-size: 11px;
	line-height: 1.5;
	white-space: pre;
	overflow-x: auto;
	max-height: 480px;
	overflow-y: auto;
}
.lab-yaml-source
{
	font-size: 10px;
	color: #64748b;
	font-style: italic;
	margin-bottom: 6px;
}

.lab-stack-back-link { display: inline-block; margin-bottom: 12px; color: #64748b; text-decoration: none; font-size: 12px; }
.lab-stack-back-link:hover { color: #cbd5e1; }
`,

	Templates:
	[
		// ── Main shell ─────────────────────────────────────────────────
		{
			Hash: 'Lab-Stacks-Main-Template',
			Template: /*html*/`
<div class="lab-stacks">
	{~TS:Lab-Stacks-List-Template:AppData.Lab.Stacks.ListSlot~}
	{~TS:Lab-Stacks-PresetChooser-Template:AppData.Lab.Stacks.PresetChooserSlot~}
	{~TS:Lab-Stacks-Editor-Template:AppData.Lab.Stacks.EditorSlot~}
	{~TS:Lab-Stacks-Detail-Template:AppData.Lab.Stacks.DetailSlot~}
</div>`
		},

		// ── List screen ────────────────────────────────────────────────
		{
			Hash: 'Lab-Stacks-List-Template',
			Template: /*html*/`
<div class="lab-stacks-toolbar">
	<h2>Stacks</h2>
	<a class="lab-btn" href="#/stacks/new">+ New stack from preset</a>
</div>
{~TS:Lab-Stacks-Empty-Template:Record.EmptySlot~}
{~TS:Lab-Stacks-Card-Template:Record.Stacks~}`
		},
		{
			Hash: 'Lab-Stacks-Empty-Template',
			Template: /*html*/`<div class="lab-stacks-empty">No stacks yet. Click <strong>+ New stack from preset</strong> above to create one.</div>`
		},
		{
			Hash: 'Lab-Stacks-Card-Template',
			Template: /*html*/`
<div class="lab-stack-card">
	<div class="lab-stack-card-main">
		<h3>{~D:Record.Name~} <span class="lab-stack-status {~D:Record.StatusClass~}">{~D:Record.Status~}</span></h3>
		<div class="lab-stack-desc">{~D:Record.Description~}</div>
		<div class="lab-stack-meta">
			<span><code>{~D:Record.Hash~}</code></span>
			<span>{~D:Record.ComponentCount~} component{~D:Record.PluralS~}</span>
			{~TS:Lab-Stacks-PresetMeta-Template:Record.PresetSlot~}
		</div>
	</div>
	<div class="lab-stack-card-actions">
		<a class="lab-btn small" href="#/stacks/{~D:Record.HashEnc~}">Detail</a>
		<a class="lab-btn small secondary" href="#/stacks/{~D:Record.HashEnc~}/edit">Edit</a>
		<a class="lab-btn small danger" href="#/stacks/{~D:Record.HashEnc~}/remove">Remove</a>
	</div>
</div>`
		},
		{
			Hash: 'Lab-Stacks-PresetMeta-Template',
			Template: /*html*/`<span>from <code>{~D:Record.PresetSource~}</code></span>`
		},

		// ── Preset chooser ─────────────────────────────────────────────
		{
			Hash: 'Lab-Stacks-PresetChooser-Template',
			Template: /*html*/`
<a class="lab-stack-back-link" href="#/view/stacks">&larr; Back to stacks</a>
<div class="lab-stacks-toolbar">
	<h2>Choose a preset</h2>
</div>
<div class="lab-preset-grid">
	{~TS:Lab-Stacks-PresetCard-Template:Record.Presets~}
</div>`
		},
		{
			Hash: 'Lab-Stacks-PresetCard-Template',
			Template: /*html*/`
<div class="lab-preset-card">
	<h3>{~D:Record.Name~}</h3>
	<div class="lab-preset-desc">{~D:Record.Description~}</div>
	<div class="lab-preset-meta">
		{~D:Record.ComponentCount~} component{~D:Record.PluralComp~} · {~D:Record.InputCount~} input{~D:Record.PluralInp~}
	</div>
	<div class="lab-preset-actions">
		<a class="lab-btn" href="#/stacks/clone-preset/{~D:Record.HashEnc~}">Clone &amp; edit</a>
	</div>
</div>`
		},

		// ── Editor screen ──────────────────────────────────────────────
		{
			Hash: 'Lab-Stacks-Editor-Template',
			Template: /*html*/`
<a class="lab-stack-back-link" href="#/view/stacks">&larr; Back to stacks</a>
<div class="lab-stack-editor">
	<div class="lab-stack-editor-header">
		<h2>Edit · {~D:Record.Name~}</h2>
		<div class="lab-stack-desc">{~D:Record.Description~}</div>
	</div>

	<div class="lab-stack-section-title">Inputs</div>
	{~TS:Lab-Stacks-EditorInput-Template:Record.Inputs~}

	<div class="lab-stack-section-title">Components</div>
	<div class="lab-stack-component-list">
		{~TS:Lab-Stacks-EditorComponent-Template:Record.Components~}
	</div>

	<div id="Lab-Stacks-PreflightSlot">
		{~TS:Lab-Stacks-PreflightReport-Template:Record.PreflightSlot~}
	</div>

	<div id="Lab-Stacks-LaunchOutputSlot">
		{~TS:Lab-Stacks-LaunchOutput-Template:Record.LaunchOutputSlot~}
	</div>

	<div class="lab-stack-actions">
		<a class="lab-btn secondary" href="#/stacks/{~D:Record.HashEnc~}/preflight">Run preflight</a>
		<a class="lab-btn" href="#/stacks/{~D:Record.HashEnc~}/save">Save</a>
		<a class="lab-btn success" href="#/stacks/{~D:Record.HashEnc~}/launch">Save &amp; Launch</a>
	</div>
</div>`
		},
		{
			Hash: 'Lab-Stacks-EditorInput-Template',
			Template: /*html*/`
<div class="lab-stack-input {~D:Record.RequiredClass~}">
	<label for="Lab-StackInput-{~D:Record.Key~}">{~D:Record.Label~}</label>
	<div class="lab-stack-input-desc">{~D:Record.Description~}</div>
	<input
		type="{~D:Record.InputType~}"
		id="Lab-StackInput-{~D:Record.Key~}"
		data-input-key="{~D:Record.Key~}"
		placeholder="{~D:Record.Default~}"
		value="{~D:Record.Value~}">
</div>`
		},
		{
			Hash: 'Lab-Stacks-EditorComponent-Template',
			Template: /*html*/`
<div class="lab-stack-component-row">
	<code>{~D:Record.Hash~}</code>
	<span class="lab-stack-component-type">{~D:Record.TypeLabel~}</span>
	<span class="lab-stack-component-image">{~D:Record.ImageOrBuild~}</span>
	<span>{~D:Record.PortsSummary~}</span>
</div>`
		},

		// ── Preflight report (re-used in editor + detail) ──────────────
		{
			Hash: 'Lab-Stacks-PreflightReport-Template',
			Template: /*html*/`
<div class="lab-preflight-report">
	<div class="lab-preflight-report-header">
		Preflight
		<span class="lab-preflight-report-status {~D:Record.Status~}">{~D:Record.StatusLabel~}</span>
		<span style="color:#64748b; font-size:11px;">{~D:Record.SummaryLine~}</span>
	</div>
	{~TS:Lab-Stacks-PreflightItem-Template:Record.Items~}
</div>`
		},
		{
			Hash: 'Lab-Stacks-PreflightItem-Template',
			Template: /*html*/`
<div class="lab-preflight-item {~D:Record.Severity~}">
	<span class="lab-preflight-icon">{~D:Record.Icon~}</span>
	<span class="lab-preflight-path">{~D:Record.Path~}</span>
	<span class="lab-preflight-message">{~D:Record.Message~}</span>
</div>`
		},

		// ── Launch failure output (editor only) ────────────────────────
		{
			Hash: 'Lab-Stacks-LaunchOutput-Template',
			Template: /*html*/`
<div class="lab-launch-output">
	<div class="lab-launch-output-header">
		<span class="lab-launch-output-status">{~D:Record.StatusLabel~}</span>
		<span class="lab-launch-output-path">{~D:Record.ComposePath~}</span>
	</div>
	<pre class="lab-launch-output-body">{~D:Record.RawOutput~}</pre>
</div>`
		},

		// ── Detail screen ──────────────────────────────────────────────
		{
			Hash: 'Lab-Stacks-Detail-Template',
			Template: /*html*/`
<a class="lab-stack-back-link" href="#/view/stacks">&larr; Back to stacks</a>
<div class="lab-stack-detail">
	<div class="lab-stack-detail-header">
		<h2>{~D:Record.Name~}</h2>
		<span class="lab-stack-status {~D:Record.StatusClass~}">{~D:Record.Status~}</span>
		<div class="lab-stack-detail-actions">
			<a class="lab-btn small secondary" href="#/stacks/{~D:Record.HashEnc~}/edit">Edit</a>
			<a class="lab-btn small secondary" href="#/stacks/{~D:Record.HashEnc~}/refresh-status">Refresh</a>
			<a class="lab-btn small success {~D:Record.UpDisabled~}" href="#/stacks/{~D:Record.HashEnc~}/launch">Launch</a>
			<a class="lab-btn small danger {~D:Record.DownDisabled~}" href="#/stacks/{~D:Record.HashEnc~}/down">Teardown</a>
		</div>
	</div>

	<div class="lab-stack-status-card">
		<div class="lab-stack-section-title" style="margin:0 0 8px 0;">Components</div>
		{~TS:Lab-Stacks-DetailEmptyComponents-Template:Record.NoComponentsSlot~}
		{~TS:Lab-Stacks-DetailComponent-Template:Record.Components~}
	</div>

	<div class="lab-stack-section-title">docker-compose.yml</div>
	<div class="lab-yaml-source">{~D:Record.YamlSource~}</div>
	<div class="lab-yaml-preview">{~D:Record.YamlText~}</div>
</div>`
		},
		{
			Hash: 'Lab-Stacks-DetailComponent-Template',
			Template: /*html*/`
<div class="lab-stack-component-status">
	<span class="name">{~D:Record.Hash~}</span>
	<span class="state">{~D:Record.State~}</span>
	<span class="health">{~D:Record.Health~}</span>
	<span class="uptime">{~D:Record.Uptime~}</span>
</div>`
		},
		{
			Hash: 'Lab-Stacks-DetailEmptyComponents-Template',
			Template: /*html*/`<div style="font-size:12px; color:#64748b;">No containers running. Click <strong>Launch</strong> to bring this stack up.</div>`
		}
	],

	Renderables:
	[
		{
			RenderableHash:            'Lab-Stacks-Main',
			TemplateHash:              'Lab-Stacks-Main-Template',
			ContentDestinationAddress: '#Lab-Content-Container'
		}
	]
};

// ─────────────────────────────────────────────────────────────────────
// Pure helpers (escape, build records). Used by onBeforeRender to
// populate AppData.Lab.Stacks's slot fields with the data templates
// expect.
// ─────────────────────────────────────────────────────────────────────

function _escape(pStr)
{
	if (typeof pStr !== 'string') { return ''; }
	return pStr.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function _escapeAttr(pStr)
{
	if (typeof pStr !== 'string') { return ''; }
	return pStr.replace(/&/g, '&amp;').replace(/'/g, '&#39;').replace(/"/g, '&quot;')
		.replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function _statusClass(pStatus)
{
	let tmp = String(pStatus || 'stopped').toLowerCase();
	if (['stopped','starting','running','unhealthy','stopping','error'].indexOf(tmp) >= 0) return tmp;
	return 'stopped';
}

class LabStacksView extends libPictView
{
	constructor(pFable, pOptions, pServiceHash)
	{
		super(pFable, pOptions, pServiceHash);
	}

	onBeforeRender(pRenderable)
	{
		if (!this.pict.AppData.Lab.Stacks) { this.pict.AppData.Lab.Stacks = {}; }
		let tmpState = this.pict.AppData.Lab.Stacks;
		// Defaults the application bootstraps; defend against missing.
		if (!tmpState.Screen)            { tmpState.Screen = 'list'; }
		if (!Array.isArray(tmpState.Stacks))   { tmpState.Stacks = []; }
		if (!Array.isArray(tmpState.Presets))  { tmpState.Presets = []; }

		tmpState.ListSlot          = (tmpState.Screen === 'list')          ? [this._buildListRecord(tmpState)] : [];
		tmpState.PresetChooserSlot = (tmpState.Screen === 'preset-chooser')? [this._buildPresetChooserRecord(tmpState)] : [];
		tmpState.EditorSlot        = (tmpState.Screen === 'editor' && tmpState.EditorRecord)
			? [this._buildEditorRecord(tmpState)] : [];
		tmpState.DetailSlot        = (tmpState.Screen === 'detail' && tmpState.DetailRecord)
			? [this._buildDetailRecord(tmpState)] : [];

		return super.onBeforeRender(pRenderable);
	}

	onAfterRender(pRenderable, pAddress, pRecord, pContent)
	{
		this.pict.CSSMap.injectCSS();
		return super.onAfterRender(pRenderable, pAddress, pRecord, pContent);
	}

	// ====================================================================
	// Per-screen record builders
	// ====================================================================

	_buildListRecord(pState)
	{
		let tmpStacks = (pState.Stacks || []).map((pS) => (
			{
				Name:           _escape(pS.Name || pS.Hash),
				Description:    _escape(pS.Description || ''),
				Hash:           _escape(pS.Hash),
				HashEnc:        encodeURIComponent(pS.Hash),
				Status:         _escape(pS.Status || 'stopped'),
				StatusClass:    _statusClass(pS.Status),
				ComponentCount: pS.ComponentCount || 0,
				PluralS:        (pS.ComponentCount === 1 ? '' : 's'),
				PresetSlot:     pS.PresetSource ? [{ PresetSource: _escape(pS.PresetSource) }] : []
			}));
		return {
			Stacks:    tmpStacks,
			EmptySlot: tmpStacks.length === 0 ? [{}] : []
		};
	}

	_buildPresetChooserRecord(pState)
	{
		let tmpPresets = (pState.Presets || []).map((pP) => (
			{
				Name:           _escape(pP.Name || pP.Hash),
				Description:    _escape(pP.Description || ''),
				HashEnc:        encodeURIComponent(pP.Hash),
				ComponentCount: pP.ComponentCount || 0,
				InputCount:     pP.InputCount || 0,
				PluralComp:     (pP.ComponentCount === 1 ? '' : 's'),
				PluralInp:      (pP.InputCount === 1 ? '' : 's')
			}));
		return { Presets: tmpPresets };
	}

	_buildEditorRecord(pState)
	{
		let tmpEd = pState.EditorRecord;
		let tmpSpec = tmpEd.Spec || {};
		let tmpInputDefs = tmpSpec.Inputs || {};
		let tmpInputValues = pState.InputValues || {};

		let tmpInputs = Object.keys(tmpInputDefs).map((pK) =>
		{
			let tmpDef = tmpInputDefs[pK] || {};
			let tmpValue = (tmpInputValues[pK] !== undefined && tmpInputValues[pK] !== '')
				? tmpInputValues[pK]
				: (tmpDef.Default !== undefined ? tmpDef.Default : '');
			let tmpInputType = (tmpDef.Type === 'secret') ? 'password'
				: (tmpDef.Type === 'port') ? 'number'
				: 'text';
			return {
				Key:           pK,
				Label:         _escape(pK),
				Description:   _escape(tmpDef.Description || ''),
				Default:       _escapeAttr(String(tmpDef.Default !== undefined ? tmpDef.Default : '')),
				Value:         _escapeAttr(String(tmpValue !== undefined ? tmpValue : '')),
				InputType:     tmpInputType,
				RequiredClass: (tmpDef.Type === 'secret' && !tmpValue) ? 'required' : ''
			};
		});

		let tmpComponents = (tmpSpec.Components || []).map((pC) =>
		{
			let tmpType = pC.Type || 'docker-service';
			let tmpImageOrBuild = (tmpType === 'docker-build-from-folder')
				? ('build: ' + (pC.BuildContext || '?'))
				: (pC.Image || '?');
			let tmpPortSummary = (Array.isArray(pC.Ports) && pC.Ports.length > 0)
				? pC.Ports.map((pP) => (pP.Host + ':' + pP.Container)).join(', ')
				: '';
			return {
				Hash:         _escape(pC.Hash),
				TypeLabel:    _escape(tmpType.replace('docker-', '')),
				ImageOrBuild: _escape(tmpImageOrBuild),
				PortsSummary: _escape(tmpPortSummary)
			};
		});

		// Preflight results (set by application after preflight runs).
		let tmpPreflight = pState.LastPreflight && pState.LastPreflight.Hash === tmpEd.Hash
			? pState.LastPreflight.Report : null;
		let tmpPreflightSlot = tmpPreflight
			? [_buildPreflightRecord(tmpPreflight)] : [];

		// Launch failure output (compose stdout/stderr) — only show when
		// the most recent launch attempt for THIS stack returned an error.
		let tmpLaunch = pState.LastLaunchResult && pState.LastLaunchResult.Hash === tmpEd.Hash
			? pState.LastLaunchResult.Result : null;
		let tmpLaunchSlot = (tmpLaunch && tmpLaunch.Status === 'error')
			? [{
				StatusLabel: 'compose up failed',
				RawOutput:   _escape(tmpLaunch.RawOutput || '(no output captured)'),
				ComposePath: _escape(tmpLaunch.ComposePath || '')
			}]
			: [];

		return {
			Name:           _escape(tmpSpec.Name || tmpEd.Hash),
			Description:    _escape(tmpSpec.Description || ''),
			HashEnc:        encodeURIComponent(tmpEd.Hash),
			Inputs:         tmpInputs,
			Components:     tmpComponents,
			PreflightSlot:  tmpPreflightSlot,
			LaunchOutputSlot: tmpLaunchSlot
		};
	}

	_buildDetailRecord(pState)
	{
		let tmpD = pState.DetailRecord;
		let tmpSpec = tmpD.Spec || {};
		let tmpStatus = pState.LastStatus && pState.LastStatus.Hash === tmpD.Hash
			? pState.LastStatus.Status : null;

		let tmpComponents = (tmpStatus && Array.isArray(tmpStatus.Components))
			? tmpStatus.Components.map((pC) => (
				{
					Hash:    _escape(pC.Hash || ''),
					State:   _escape(pC.State || ''),
					Health:  _escape(pC.Health || ''),
					Uptime:  _escape(pC.Uptime || '')
				}))
			: [];
		let tmpStatusValue = (tmpStatus && tmpStatus.Phase) || tmpD.Status || 'stopped';
		let tmpYaml = pState.LastYaml && pState.LastYaml.Hash === tmpD.Hash
			? pState.LastYaml : null;

		return {
			Name:           _escape(tmpSpec.Name || tmpD.Hash),
			HashEnc:        encodeURIComponent(tmpD.Hash),
			Status:         _escape(tmpStatusValue),
			StatusClass:    _statusClass(tmpStatusValue),
			Components:     tmpComponents,
			NoComponentsSlot: tmpComponents.length === 0 ? [{}] : [],
			YamlText:       _escape(tmpYaml ? tmpYaml.YAML : '(YAML not loaded yet — Refresh to load)'),
			YamlSource:     _escape(tmpYaml ? tmpYaml.Source : ''),
			UpDisabled:     (tmpStatusValue === 'running' || tmpStatusValue === 'starting') ? 'disabled' : '',
			DownDisabled:   (tmpStatusValue === 'stopped' || tmpStatusValue === 'stopping') ? 'disabled' : ''
		};
	}
}

function _buildPreflightRecord(pReport)
{
	let tmpStatus = pReport.Status || 'ready';
	let tmpItems = (pReport.Items || []).map((pIt) => (
		{
			Severity: pIt.Severity || 'info',
			Icon:     (pIt.Severity === 'block') ? '✗'
				: (pIt.Severity === 'warn') ? '⚠'
				: '•',
			Path:     _escape(pIt.Path || ''),
			Message:  _escape(pIt.Message || '')
		}));
	let tmpStatusLabel = (tmpStatus === 'ready')   ? 'READY'
		: (tmpStatus === 'warnings') ? 'WARNINGS'
		: 'BLOCKERS';
	let tmpSummary = pReport.Items
		? (pReport.Items.length + ' item' + (pReport.Items.length === 1 ? '' : 's'))
		: '';
	return {
		Status:      tmpStatus,
		StatusLabel: tmpStatusLabel,
		SummaryLine: tmpSummary,
		Items:       tmpItems
	};
}

module.exports = LabStacksView;
module.exports.default_configuration = _ViewConfiguration;
