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
	background: var(--theme-color-background-secondary, #ffffff);
	border: 1px solid var(--theme-color-border-default, #e2e5ea);
	border-radius: 8px;
	padding: 16px 20px;
	margin-bottom: 12px;
	display: flex;
	align-items: center;
	gap: 16px;
}
.lab-stack-card-main { flex: 1; min-width: 0; }
.lab-stack-card h3 { margin: 0 0 4px 0; font-size: 15px; color: var(--theme-color-text-primary, #2d3748); font-weight: 600; }
.lab-stack-card .lab-stack-desc { font-size: 12px; color: var(--theme-color-text-muted, #6b7280); line-height: 1.4; }
.lab-stack-card .lab-stack-meta { display: flex; gap: 16px; margin-top: 8px; font-size: 11px; color: var(--theme-color-text-muted, #6b7280); }
.lab-stack-card .lab-stack-meta span code { color: var(--theme-color-text-primary, #2d3748); background: var(--theme-color-background-tertiary, #e4e7ec); padding: 1px 6px; border-radius: 3px; }
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
.lab-stack-status.stopped     { background: var(--theme-color-background-tertiary, #e4e7ec); color: var(--theme-color-text-secondary, #1a202c); }
.lab-stack-status.starting    { background: var(--theme-color-brand-primary, #3b82f6); color: var(--theme-color-text-onbrand, #ffffff); }
.lab-stack-status.running     { background: var(--theme-color-status-success, #10b981); color: var(--theme-color-text-onbrand, #ffffff); }
.lab-stack-status.unhealthy   { background: var(--theme-color-status-warning, #f59e0b); color: var(--theme-color-text-onbrand, #ffffff); }
.lab-stack-status.stopping    { background: var(--theme-color-background-tertiary, #e4e7ec); color: var(--theme-color-text-secondary, #1a202c); }
.lab-stack-status.error       { background: var(--theme-color-status-error, #ef4444); color: var(--theme-color-text-onbrand, #ffffff); }
.lab-stack-status.preset-blocked { background: var(--theme-color-status-error, #ef4444); color: var(--theme-color-text-onbrand, #ffffff); }

.lab-stacks-empty
{
	background: var(--theme-color-background-secondary, #ffffff);
	border: 1px dashed var(--theme-color-border-default, #e2e5ea);
	border-radius: 8px;
	padding: 40px 20px;
	text-align: center;
	color: var(--theme-color-text-muted, #6b7280);
	font-size: 14px;
}

.lab-btn
{
	display: inline-block;
	background: var(--theme-color-brand-primary, #3b82f6);
	color: var(--theme-color-text-onbrand, #ffffff);
	border: 1px solid var(--theme-color-brand-primary, #3b82f6);
	padding: 6px 14px;
	border-radius: 6px;
	font-size: 13px;
	cursor: pointer;
	text-decoration: none;
	white-space: nowrap;
}
.lab-btn:hover { background: var(--theme-color-brand-primary-hover, #2563eb); }
.lab-btn.secondary { background: transparent; color: var(--theme-color-text-primary, #2d3748); border-color: var(--theme-color-border-default, #e2e5ea); }
.lab-btn.secondary:hover { border-color: var(--theme-color-border-strong, #c8cdd5); color: var(--theme-color-text-primary, #2d3748); background: var(--theme-color-background-hover, #f0f1f4); }
.lab-btn.danger { background: var(--theme-color-status-error, #ef4444); border-color: var(--theme-color-status-error, #ef4444); color: var(--theme-color-text-onbrand, #ffffff); }
.lab-btn.danger:hover { background: var(--theme-color-status-error, #dc2626); filter: brightness(0.92); }
.lab-btn.success { background: var(--theme-color-status-success, #10b981); border-color: var(--theme-color-status-success, #10b981); color: var(--theme-color-text-onbrand, #ffffff); }
.lab-btn.success:hover { background: var(--theme-color-status-success, #059669); filter: brightness(0.92); }
.lab-btn.small { padding: 4px 10px; font-size: 12px; }
/* "Force" remove — subordinate to the regular Remove button. Slimmer,
 * outlined, faded so the operator only reaches for it when the normal
 * Remove fails. */
.lab-btn-force
{
	padding: 4px 6px !important;
	font-size: 11px !important;
	background: transparent !important;
	color: rgba(239, 68, 68, 0.85) !important;
	border: 1px solid rgba(239, 68, 68, 0.5) !important;
	letter-spacing: 0.4px;
	text-transform: uppercase;
}
.lab-btn-force:hover
{
	background: rgba(239, 68, 68, 0.12) !important;
	color: var(--theme-color-status-error, #fca5a5) !important;
}
.lab-btn.disabled { opacity: 0.4; pointer-events: none; }

.lab-preset-grid
{
	display: grid;
	grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
	gap: 14px;
}
.lab-preset-card
{
	background: var(--theme-color-background-secondary, #ffffff);
	border: 1px solid var(--theme-color-border-default, #e2e5ea);
	border-radius: 8px;
	padding: 16px;
	display: flex;
	flex-direction: column;
	gap: 10px;
}
.lab-preset-card h3 { margin: 0; font-size: 14px; font-weight: 600; color: var(--theme-color-text-primary, #2d3748); }
.lab-preset-card .lab-preset-desc { font-size: 12px; color: var(--theme-color-text-muted, #6b7280); line-height: 1.5; flex: 1; }
.lab-preset-card .lab-preset-meta { font-size: 11px; color: var(--theme-color-text-muted, #6b7280); }
.lab-preset-card .lab-preset-actions { display: flex; gap: 6px; }

/* ── Editor ──────────────────────────────────────────────────────────── */

.lab-stack-editor { background: var(--theme-color-background-secondary, #ffffff); border: 1px solid var(--theme-color-border-default, #e2e5ea); border-radius: 8px; padding: 24px; }
.lab-stack-editor-header { margin-bottom: 20px; padding-bottom: 16px; border-bottom: 1px solid var(--theme-color-border-default, #e2e5ea); }
.lab-stack-editor-header h2 { margin: 0 0 4px 0; font-size: 18px; color: var(--theme-color-text-primary, #2d3748); }
.lab-stack-editor-header .lab-stack-desc { font-size: 12px; color: var(--theme-color-text-muted, #6b7280); }

.lab-stack-section-title { font-size: 11px; text-transform: uppercase; letter-spacing: 1px; color: var(--theme-color-text-muted, #6b7280); margin: 24px 0 8px 0; font-weight: 600; }

.lab-stack-input { display: flex; flex-direction: column; gap: 4px; margin-bottom: 14px; }
.lab-stack-input label { font-size: 12px; color: var(--theme-color-text-primary, #2d3748); font-weight: 600; }
.lab-stack-input .lab-stack-input-desc { font-size: 11px; color: var(--theme-color-text-muted, #6b7280); line-height: 1.4; }
.lab-stack-input input,
.lab-stack-input select
{
	background: var(--theme-color-background-primary, #f5f6f8);
	color: var(--theme-color-text-primary, #2d3748);
	border: 1px solid var(--theme-color-border-default, #e2e5ea);
	border-radius: 4px;
	padding: 6px 10px;
	font-size: 13px;
	font-family: inherit;
}
.lab-stack-input input:focus,
.lab-stack-input select:focus { outline: none; border-color: var(--theme-color-brand-primary, #3b82f6); }
.lab-stack-input.required label::after { content: ' *'; color: var(--theme-color-status-error, #ef4444); }

.lab-stack-component-list { display: flex; flex-direction: column; gap: 8px; }
.lab-stack-component-row
{
	display: flex;
	gap: 12px;
	align-items: center;
	background: var(--theme-color-background-primary, #f5f6f8);
	border: 1px solid var(--theme-color-border-default, #e2e5ea);
	border-radius: 6px;
	padding: 10px 14px;
	font-size: 12px;
}
.lab-stack-component-row code { color: var(--theme-color-text-primary, #2d3748); background: transparent; }
.lab-stack-component-row .lab-stack-component-type { padding: 2px 8px; background: var(--theme-color-background-tertiary, #e4e7ec); border-radius: 10px; font-size: 10px; color: var(--theme-color-text-primary, #2d3748); text-transform: uppercase; letter-spacing: 0.5px; }
.lab-stack-component-row .lab-stack-component-image { color: var(--theme-color-text-muted, #6b7280); font-family: monospace; font-size: 11px; flex: 1; }

/* File overrides — one editor per Component.Files[] entry. The composer
 * materializes Content to a host file and bind-mounts it over the
 * in-container Path on launch. Path is read-only (preset declares it);
 * Content is editable. */
.lab-stack-file-override
{
	background: var(--theme-color-background-primary, #f5f6f8);
	border: 1px solid var(--theme-color-border-default, #e2e5ea);
	border-radius: 6px;
	padding: 10px 14px;
	margin: 4px 0 10px 24px;
	display: flex;
	flex-direction: column;
	gap: 6px;
}
.lab-stack-file-override label { font-size: 11px; color: var(--theme-color-text-muted, #6b7280); font-weight: 500; text-transform: uppercase; letter-spacing: 0.5px; }
.lab-stack-file-override label code { color: var(--theme-color-text-primary, #2d3748); background: transparent; font-family: monospace; font-size: 12px; text-transform: none; letter-spacing: 0; }
.lab-stack-file-override textarea
{
	background: var(--theme-color-background-secondary, #ffffff);
	color: var(--theme-color-text-primary, #2d3748);
	border: 1px solid var(--theme-color-border-default, #e2e5ea);
	border-radius: 4px;
	padding: 10px 12px;
	font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
	font-size: 12px;
	line-height: 1.5;
	min-height: 280px;
	resize: vertical;
	tab-size: 4;
}
.lab-stack-file-override textarea:focus { outline: none; border-color: var(--theme-color-brand-primary, #3b82f6); }

.lab-stack-actions { display: flex; gap: 10px; margin-top: 24px; padding-top: 16px; border-top: 1px solid var(--theme-color-border-default, #e2e5ea); }

/* ── Launch output (error panel) ─────────────────────────────────────── */

.lab-launch-output
{
	margin: 16px 0;
	border: 1px solid var(--theme-color-status-error, #ef4444);
	border-radius: 6px;
	background: var(--theme-color-background-secondary, #ffffff);
	overflow: hidden;
}
.lab-launch-output-header
{
	display: flex;
	align-items: center;
	gap: 12px;
	padding: 8px 12px;
	background: var(--theme-color-status-error, #ef4444);
	color: var(--theme-color-text-onbrand, #ffffff);
	font-size: 11px;
	text-transform: uppercase;
	letter-spacing: 1px;
}
.lab-launch-output-status { font-weight: 600; }
.lab-launch-output-path   { font-family: monospace; text-transform: none; opacity: 0.85; font-size: 11px; }
.lab-launch-output-body
{
	margin: 0;
	padding: 12px;
	font-family: monospace;
	font-size: 12px;
	color: var(--theme-color-text-primary, #2d3748);
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
	color: var(--theme-color-text-muted, #6b7280);
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
.lab-preflight-report-status.ready    { background: var(--theme-color-status-success, #10b981); color: var(--theme-color-text-onbrand, #ffffff); }
.lab-preflight-report-status.warnings { background: var(--theme-color-status-warning, #f59e0b); color: var(--theme-color-text-onbrand, #ffffff); }
.lab-preflight-report-status.blockers { background: var(--theme-color-status-error, #ef4444); color: var(--theme-color-text-onbrand, #ffffff); }
.lab-preflight-item
{
	display: flex;
	align-items: flex-start;
	gap: 10px;
	padding: 6px 10px;
	background: var(--theme-color-background-primary, #f5f6f8);
	border-left: 3px solid var(--theme-color-border-default, #e2e5ea);
	margin-bottom: 4px;
	font-size: 12px;
	line-height: 1.4;
}
.lab-preflight-item.info  { border-left-color: var(--theme-color-brand-primary, #3b82f6); }
.lab-preflight-item.warn  { border-left-color: var(--theme-color-status-warning, #f59e0b); }
.lab-preflight-item.block { border-left-color: var(--theme-color-status-error, #ef4444); }
.lab-preflight-item .lab-preflight-icon
{
	flex-shrink: 0;
	font-weight: 700;
	width: 14px;
	text-align: center;
}
.lab-preflight-item.info  .lab-preflight-icon { color: var(--theme-color-status-info, #3b82f6); }
.lab-preflight-item.warn  .lab-preflight-icon { color: var(--theme-color-status-warning, #f59e0b); }
.lab-preflight-item.block .lab-preflight-icon { color: var(--theme-color-status-error, #ef4444); }
.lab-preflight-item .lab-preflight-path { color: var(--theme-color-text-muted, #6b7280); font-family: monospace; font-size: 10px; flex-shrink: 0; min-width: 200px; }
.lab-preflight-item .lab-preflight-message { color: var(--theme-color-text-primary, #2d3748); flex: 1; }

/* ── Detail view ─────────────────────────────────────────────────────── */

.lab-stack-detail { background: var(--theme-color-background-secondary, #ffffff); border: 1px solid var(--theme-color-border-default, #e2e5ea); border-radius: 8px; padding: 24px; }
.lab-stack-detail-header { display: flex; align-items: center; gap: 12px; margin-bottom: 16px; padding-bottom: 16px; border-bottom: 1px solid var(--theme-color-border-default, #e2e5ea); }
.lab-stack-detail-header h2 { margin: 0; font-size: 18px; color: var(--theme-color-text-primary, #2d3748); flex: 1; }
.lab-stack-detail-actions { display: flex; gap: 6px; }
.lab-stack-status-card
{
	background: var(--theme-color-background-primary, #f5f6f8);
	border: 1px solid var(--theme-color-border-default, #e2e5ea);
	border-radius: 6px;
	padding: 12px 16px;
	margin-bottom: 16px;
}
.lab-stack-component-status
{
	display: grid;
	grid-template-columns: 1fr 90px 90px 100px minmax(120px, 1.2fr);
	gap: 10px;
	align-items: center;
	padding: 6px 0;
	font-size: 12px;
	border-bottom: 1px dashed var(--theme-color-border-default, #e2e5ea);
}
.lab-stack-component-status:last-child { border-bottom: none; }
.lab-stack-component-status .name { color: var(--theme-color-text-primary, #2d3748); font-weight: 600; }
.lab-stack-component-status .state { color: var(--theme-color-text-secondary, #1a202c); }
.lab-stack-component-status .health { color: var(--theme-color-text-muted, #6b7280); }
.lab-stack-component-status .uptime { color: var(--theme-color-text-muted, #6b7280); font-size: 11px; }
.lab-stack-component-status .ports { display: flex; flex-wrap: wrap; gap: 6px; justify-content: flex-end; }

.lab-port-link
{
	display: inline-flex;
	align-items: center;
	gap: 4px;
	padding: 3px 8px;
	border-radius: 4px;
	font-size: 11px;
	font-weight: 500;
	text-decoration: none;
	border: 1px solid transparent;
	transition: background 0.15s, border-color 0.15s;
	white-space: nowrap;
}
.lab-port-link:hover { text-decoration: none; }
.lab-port-link .lab-port-icon { font-size: 12px; line-height: 1; }
.lab-port-link .lab-port-num  { color: inherit; opacity: 0.85; font-family: monospace; }
.lab-port-link.lab-port-http
{
	background: rgba(59, 130, 246, 0.15);
	color: var(--theme-color-brand-primary, #3b82f6);
	border-color: rgba(59, 130, 246, 0.35);
}
.lab-port-link.lab-port-http:hover { background: rgba(59, 130, 246, 0.3); border-color: var(--theme-color-brand-primary, #3b82f6); }
.lab-port-link.lab-port-sql-mysql,
.lab-port-link.lab-port-sql-postgres,
.lab-port-link.lab-port-sql-mssql
{
	background: rgba(245, 158, 11, 0.15);
	color: var(--theme-color-status-warning, #f59e0b);
	border-color: rgba(245, 158, 11, 0.35);
	cursor: pointer;
}
.lab-port-link.lab-port-sql-mysql:hover,
.lab-port-link.lab-port-sql-postgres:hover,
.lab-port-link.lab-port-sql-mssql:hover
{
	background: rgba(245, 158, 11, 0.3);
	border-color: var(--theme-color-status-warning, #f59e0b);
}

.lab-sql-conn-table
{
	display: flex;
	flex-direction: column;
	gap: 6px;
	padding: 8px 0 12px 0;
}
.lab-sql-conn-row
{
	display: grid;
	grid-template-columns: 90px 1fr auto auto;
	align-items: center;
	gap: 10px;
	padding: 8px 12px;
	background: var(--theme-color-background-primary, #f5f6f8);
	border: 1px solid var(--theme-color-border-default, #e2e5ea);
	border-radius: 4px;
	font-size: 13px;
}
.lab-sql-conn-row .k { color: var(--theme-color-text-muted, #6b7280); font-weight: 500; text-transform: uppercase; font-size: 11px; }
.lab-sql-conn-row .v { color: var(--theme-color-text-primary, #2d3748); overflow: hidden; }
.lab-sql-conn-row .v code { background: transparent; color: var(--theme-color-text-primary, #2d3748); font-family: monospace; font-size: 12px; }
.lab-sql-conn-row .v em   { color: var(--theme-color-text-muted, #6b7280); font-style: italic; font-size: 12px; }
.lab-sql-conn-row a.lab-sql-copy,
.lab-sql-conn-row a.lab-sql-reveal
{
	background: var(--theme-color-background-tertiary, #e4e7ec);
	color: var(--theme-color-text-primary, #2d3748);
	border: 1px solid var(--theme-color-border-default, #e2e5ea);
	padding: 3px 10px;
	border-radius: 4px;
	font-size: 11px;
	text-decoration: none;
	cursor: pointer;
}
.lab-sql-conn-row a.lab-sql-copy:hover,
.lab-sql-conn-row a.lab-sql-reveal:hover { background: var(--theme-color-background-hover, #f0f1f4); border-color: var(--theme-color-border-strong, #c8cdd5); }
.lab-sql-conn-help
{
	font-size: 12px;
	color: var(--theme-color-text-muted, #6b7280);
	padding: 8px 12px;
	background: rgba(59, 130, 246, 0.08);
	border-left: 3px solid var(--theme-color-brand-primary, #3b82f6);
	border-radius: 4px;
	line-height: 1.5;
}
.lab-sql-conn-help code { background: var(--theme-color-background-tertiary, #e4e7ec); color: var(--theme-color-brand-primary, #3b82f6); padding: 1px 6px; border-radius: 3px; font-family: monospace; font-size: 11px; }

.lab-yaml-preview
{
	background: var(--theme-color-background-primary, #f5f6f8);
	border: 1px solid var(--theme-color-border-default, #e2e5ea);
	border-radius: 6px;
	padding: 14px;
	color: var(--theme-color-text-primary, #2d3748);
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
	color: var(--theme-color-text-muted, #6b7280);
	font-style: italic;
	margin-bottom: 6px;
}

.lab-stack-back-link { display: inline-block; margin-bottom: 12px; color: var(--theme-color-text-muted, #6b7280); text-decoration: none; font-size: 12px; }
.lab-stack-back-link:hover { color: var(--theme-color-text-primary, #2d3748); }

/* ── Init panel ─────────────────────────────────────────────────────────
   Surfaces the StackInitializer's persisted result for stacks that declare
   InitOperation. Phase pill color tracks the upstream phase enum.        */
.lab-stack-init-card
{
	background: var(--theme-color-background-primary, #f5f6f8);
	border: 1px solid var(--theme-color-border-default, #e2e5ea);
	border-radius: 6px;
	padding: 14px 16px;
	margin-bottom: 4px;
}
.lab-stack-init-header { display: flex; align-items: center; gap: 10px; margin-bottom: 8px; }
.lab-stack-init-header .label { font-size: 11px; text-transform: uppercase; letter-spacing: 1px; color: var(--theme-color-text-muted, #6b7280); font-weight: 600; }
.lab-stack-init-header .actions { margin-left: auto; display: flex; gap: 6px; }
.lab-stack-init-phase
{
	display: inline-flex;
	align-items: center;
	padding: 2px 10px;
	border-radius: 999px;
	font-size: 11px;
	font-weight: 600;
	text-transform: uppercase;
	letter-spacing: 0.5px;
	background: var(--theme-color-background-tertiary, #e4e7ec);
	color: var(--theme-color-text-primary, #2d3748);
}
.lab-stack-init-phase.phase-completed { background: rgba(16, 185, 129, 0.15);  color: var(--theme-color-status-success, #10b981); border: 1px solid rgba(16, 185, 129, 0.4); }
.lab-stack-init-phase.phase-running   { background: rgba(59, 130, 246, 0.15); color: var(--theme-color-brand-primary, #3b82f6); border: 1px solid rgba(59, 130, 246, 0.4); }
.lab-stack-init-phase.phase-queued    { background: rgba(168, 85, 247, 0.15); color: var(--theme-color-status-info, #3b82f6); border: 1px solid rgba(168, 85, 247, 0.4); }
.lab-stack-init-phase.phase-failed    { background: rgba(239, 68, 68, 0.15);  color: var(--theme-color-status-error, #ef4444); border: 1px solid rgba(239, 68, 68, 0.4); }
.lab-stack-init-phase.phase-error     { background: rgba(239, 68, 68, 0.15);  color: var(--theme-color-status-error, #ef4444); border: 1px solid rgba(239, 68, 68, 0.4); }
.lab-stack-init-phase.phase-skipped   { background: rgba(100, 116, 139, 0.2); color: var(--theme-color-text-muted, #6b7280); }
.lab-stack-init-phase.phase-never-run { background: rgba(100, 116, 139, 0.2); color: var(--theme-color-text-muted, #6b7280); }
.lab-stack-init-fields
{
	display: grid;
	grid-template-columns: 110px 1fr;
	row-gap: 4px;
	column-gap: 12px;
	font-size: 12px;
	color: var(--theme-color-text-primary, #2d3748);
}
.lab-stack-init-fields .k { color: var(--theme-color-text-muted, #6b7280); font-weight: 500; }
.lab-stack-init-fields .v { font-family: monospace; color: var(--theme-color-text-primary, #2d3748); word-break: break-all; }
.lab-stack-init-message { margin-top: 8px; font-size: 12px; color: var(--theme-color-text-muted, #6b7280); font-style: italic; }
.lab-stack-init-message.error { color: var(--theme-color-status-error, #ef4444); font-style: normal; }

/* docker-compose.yml header (title + Download button) */
.lab-yaml-header { display: flex; align-items: center; gap: 8px; margin: 24px 0 8px 0; }
.lab-yaml-header .lab-stack-section-title { margin: 0; flex: 1; }
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
	<a class="lab-btn" href="#/stack-form/new">+ New stack from preset</a>
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
		<a class="lab-btn small danger lab-btn-force" href="#/stacks/{~D:Record.HashEnc~}/force-remove" title="Skip compose-down — use when the stack is wedged and the regular Remove hangs.">Force</a>
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
		<a class="lab-btn" href="#/stack-form/clone-preset/{~D:Record.HashEnc~}">Clone &amp; edit</a>
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
		<a class="lab-btn success {~D:Record.LaunchDisabled~}" href="#/stacks/{~D:Record.HashEnc~}/launch">{~D:Record.LaunchLabel~}</a>
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
</div>
{~TS:Lab-Stacks-EditorFile-Template:Record.Files~}`
		},
		{
			// One file-override editor per Component.Files[] entry. Path is
			// read-only (preset declares which files are editable); Content
			// is a textarea that the application marshals back into the spec
			// on save via [data-file-component] + [data-file-index]. The
			// composer turns each into a host bind-mount at launch time.
			Hash: 'Lab-Stacks-EditorFile-Template',
			Template: /*html*/`
<div class="lab-stack-file-override">
	<label>File override · <code>{~D:Record.Path~}</code></label>
	<textarea
		class="lab-stack-file-content"
		data-file-component="{~D:Record.CompHash~}"
		data-file-index="{~D:Record.Index~}"
		spellcheck="false">{~D:Record.Content~}</textarea>
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
		<span style="color:var(--theme-color-text-muted, #64748b); font-size:11px;">{~D:Record.SummaryLine~}</span>
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
			<a class="lab-btn small success {~D:Record.UpDisabled~}" href="#/stacks/{~D:Record.HashEnc~}/launch">{~D:Record.UpLabel~}</a>
			<a class="lab-btn small danger {~D:Record.DownDisabled~}" href="#/stacks/{~D:Record.HashEnc~}/down">Teardown</a>
		</div>
	</div>

	<div class="lab-stack-status-card">
		<div class="lab-stack-section-title" style="margin:0 0 8px 0;">Components</div>
		{~TS:Lab-Stacks-DetailEmptyComponents-Template:Record.NoComponentsSlot~}
		{~TS:Lab-Stacks-DetailComponent-Template:Record.Components~}
	</div>

	{~TS:Lab-Stacks-DetailInit-Template:Record.InitSlot~}

	<div class="lab-yaml-header">
		<div class="lab-stack-section-title">docker-compose.yml</div>
		<a class="lab-btn small secondary" href="#/stacks/{~D:Record.HashEnc~}/yaml/download">Download YAML</a>
	</div>
	<div class="lab-yaml-source">{~D:Record.YamlSource~}</div>
	<div class="lab-yaml-preview">{~D:Record.YamlText~}</div>
</div>`
		},
		{
			Hash: 'Lab-Stacks-DetailInit-Template',
			Template: /*html*/`
<div class="lab-stack-section-title" style="margin:24px 0 8px 0;">Stack initialization</div>
<div class="lab-stack-init-card">
	<div class="lab-stack-init-header">
		<span class="label">Phase</span>
		<span class="lab-stack-init-phase phase-{~D:Record.PhaseClass~}">{~D:Record.Phase~}</span>
		<div class="actions">
			<a class="lab-btn small" href="#/stacks/{~D:Record.StackHashEnc~}/init/run">Re-run init</a>
			{~D:Record.ManifestLinkHTML~}
		</div>
	</div>
	<div class="lab-stack-init-fields">
		<div class="k">Operation</div><div class="v">{~D:Record.OperationHash~}</div>
		<div class="k">Run</div><div class="v">{~D:Record.RunHash~}</div>
		<div class="k">Started</div><div class="v">{~D:Record.StartedAt~}</div>
		<div class="k">Completed</div><div class="v">{~D:Record.CompletedAt~}</div>
	</div>
	<div class="lab-stack-init-message {~D:Record.MessageClass~}">{~D:Record.Message~}</div>
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
	<span class="ports">{~TS:Lab-Stacks-DetailComponentPort-Template:Record.Ports~}</span>
</div>`
		},
		{
			Hash: 'Lab-Stacks-DetailComponentPort-Template',
			Template: /*html*/`{~D:Record.LinkHTML~}`
		},
		{
			Hash: 'Lab-Stacks-DetailEmptyComponents-Template',
			Template: /*html*/`<div style="font-size:12px; color:var(--theme-color-text-muted, #64748b);">No containers running. Click <strong>Launch</strong> to bring this stack up.</div>`
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

// Classify a container port + image into a connection kind. Used to
// decide whether to render a plain web link (open in new tab) or a
// "show connection details" trigger that opens a credentials modal.
function _portKind(pContainerPort, pImage)
{
	let tmpImg = String(pImage || '').toLowerCase();
	let tmpPort = parseInt(pContainerPort, 10);
	if (tmpPort === 3306 || /\bmysql\b/.test(tmpImg) || /\bmariadb\b/.test(tmpImg)) return 'sql-mysql';
	if (tmpPort === 5432 || /\bpostgres/.test(tmpImg))                              return 'sql-postgres';
	if (tmpPort === 1433 || /\bmssql\b/.test(tmpImg) || /\bsqlserver\b/.test(tmpImg)) return 'sql-mssql';
	return 'http';
}

function _portKindLabel(pKind)
{
	if (pKind === 'sql-mysql')    return 'MySQL';
	if (pKind === 'sql-postgres') return 'PostgreSQL';
	if (pKind === 'sql-mssql')    return 'MSSQL';
	return 'Web';
}

function _portKindIcon(pKind)
{
	if (pKind === 'sql-mysql' || pKind === 'sql-postgres' || pKind === 'sql-mssql') return '⛁';
	return '↗';
}

// Walk a docker-compose YAML string and return { serviceName: [{Host, Container}] }.
// We use this rather than re-resolving ${input.X} from the spec because
// the YAML is what docker-compose actually launched — InputValues on a
// stack record can be empty (the user accepted defaults at launch time
// and they were never persisted back), but the YAML on disk is always
// the canonical "what's actually running."
function _parseYamlPortMap(pYamlText)
{
	let tmpResult = {};
	if (!pYamlText || typeof pYamlText !== 'string') return tmpResult;
	let tmpLines = pYamlText.split(/\n/);
	let tmpCurrentService = null;
	let tmpInPorts = false;
	for (let i = 0; i < tmpLines.length; i++)
	{
		let line = tmpLines[i];
		// Service header at indent 2 spaces under "services:".
		let mSvc = /^  ([A-Za-z0-9_.-]+):\s*$/.exec(line);
		if (mSvc) { tmpCurrentService = mSvc[1]; tmpInPorts = false; if (!tmpResult[tmpCurrentService]) tmpResult[tmpCurrentService] = []; continue; }
		if (!tmpCurrentService) continue;
		if (/^    ports:\s*$/.test(line)) { tmpInPorts = true; continue; }
		// Any other 4-space top-level key under a service ends the ports list.
		if (tmpInPorts && /^    [A-Za-z0-9_]+:/.test(line)) { tmpInPorts = false; }
		if (tmpInPorts)
		{
			// Lines look like:  - "55432:5432"  or  - 55432:5432  or  - "55432:5432/tcp"
			let mPort = /^\s*-\s*"?(\d+):(\d+)(?:\/[a-z]+)?"?\s*$/.exec(line);
			if (mPort) tmpResult[tmpCurrentService].push({ Host: parseInt(mPort[1], 10), Container: parseInt(mPort[2], 10) });
		}
	}
	return tmpResult;
}

// Resolve ${input.Name} placeholders. Order: explicit user values →
// preset defaults → leave the placeholder visible so the operator
// can see something is missing rather than getting a silent broken
// link.
function _resolveInputPlaceholder(pValue, pInputValues, pInputDefs)
{
	if (typeof pValue !== 'string') return String(pValue);
	if (pValue.indexOf('${input.') < 0) return pValue;
	return pValue.replace(/\$\{input\.([A-Za-z0-9_]+)\}/g, (m, key) =>
	{
		let tmpExplicit = pInputValues && pInputValues[key];
		if (tmpExplicit !== undefined && tmpExplicit !== '') return String(tmpExplicit);
		let tmpDef = pInputDefs && pInputDefs[key] && pInputDefs[key].Default;
		if (tmpDef !== undefined && tmpDef !== '') return String(tmpDef);
		return m;
	});
}

// Build the per-port link payload for one component. Each entry carries
// pre-formed HTML (LinkHTML) that the Pict template inserts verbatim;
// the values composed in are all from preset config (port numbers,
// component hashes), never user-typed input.
function _buildComponentPorts(pStackHash, pSpecComp, pInputValues, pInputDefs, pYamlPorts)
{
	// Prefer the YAML-resolved port mapping (canonical) over the raw spec
	// (which may still contain ${input.X} placeholders). Fall back to the
	// spec when YAML hasn't loaded yet so the column isn't empty.
	let tmpYamlForComp = pYamlPorts && pYamlPorts[(pSpecComp && pSpecComp.Hash) || ''];
	let tmpPorts = (tmpYamlForComp && tmpYamlForComp.length > 0)
		? tmpYamlForComp
		: ((pSpecComp && Array.isArray(pSpecComp.Ports)) ? pSpecComp.Ports : []);
	let tmpImage = (pSpecComp && pSpecComp.Image) || '';
	let tmpStackEnc = encodeURIComponent(pStackHash || '');
	let tmpCompEnc  = encodeURIComponent((pSpecComp && pSpecComp.Hash) || '');
	return tmpPorts.map((pP) =>
	{
		let tmpHostPort = _resolveInputPlaceholder(pP.Host, pInputValues, pInputDefs);
		let tmpKind = _portKind(pP.Container, tmpImage);
		let tmpKindLabel = _portKindLabel(tmpKind);
		let tmpIcon = _portKindIcon(tmpKind);
		let tmpHref;
		let tmpTarget;
		let tmpTitle;
		if (tmpKind === 'http')
		{
			tmpHref = 'http://127.0.0.1:' + tmpHostPort + '/';
			tmpTarget = '_blank';
			tmpTitle = 'Open ' + (pSpecComp.Hash || '') + ' web UI on host port ' + tmpHostPort;
		}
		else
		{
			tmpHref = '#/stack-modal/sql/' + tmpStackEnc + '/' + tmpCompEnc + '/' + encodeURIComponent(tmpHostPort);
			tmpTarget = '';
			tmpTitle = tmpKindLabel + ' connection details for ' + (pSpecComp.Hash || '') + ' on host port ' + tmpHostPort;
		}
		let tmpLinkHTML = '<a class="lab-port-link lab-port-' + tmpKind + '"'
			+ ' href="' + tmpHref + '"'
			+ (tmpTarget ? (' target="' + tmpTarget + '"') : '')
			+ ' title="' + _escapeAttr(tmpTitle) + '"'
			+ '><span class="lab-port-icon">' + tmpIcon + '</span>'
			+ '<span class="lab-port-label">' + tmpKindLabel + '</span>'
			+ '<span class="lab-port-num">:' + tmpHostPort + '</span></a>';
		return { LinkHTML: tmpLinkHTML };
	});
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
			// File overrides — preset declares the editable files via
			// Component.Files: [{Path, Content}]. The composer materializes
			// each one to a host file and bind-mounts it over the
			// in-container Path on launch (no image rebuild).
			let tmpFiles = (Array.isArray(pC.Files) ? pC.Files : []).map((pF, pIdx) =>
				(
					{
						CompHash: _escapeAttr(pC.Hash || ''),
						Index:    pIdx,
						Path:     _escape(pF.Path || ''),
						// Content goes inside a textarea: only HTML-escape
						// the text-content special chars (< > &). Quotes
						// don't need escaping here (no attribute context).
						Content:  ((typeof pF.Content === 'string') ? pF.Content : '')
							.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
					}));
			return {
				Hash:         _escape(pC.Hash),
				TypeLabel:    _escape(tmpType.replace('docker-', '')),
				ImageOrBuild: _escape(tmpImageOrBuild),
				PortsSummary: _escape(tmpPortSummary),
				Files:        tmpFiles
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

		let tmpLaunching = !!(pState.LaunchingStacks && pState.LaunchingStacks[tmpEd.Hash]);
		return {
			Name:           _escape(tmpSpec.Name || tmpEd.Hash),
			Description:    _escape(tmpSpec.Description || ''),
			HashEnc:        encodeURIComponent(tmpEd.Hash),
			Inputs:         tmpInputs,
			Components:     tmpComponents,
			PreflightSlot:  tmpPreflightSlot,
			LaunchOutputSlot: tmpLaunchSlot,
			LaunchDisabled: tmpLaunching ? 'disabled' : '',
			LaunchLabel:    tmpLaunching ? 'Launching…' : 'Save &amp; Launch'
		};
	}

	_buildDetailRecord(pState)
	{
		let tmpD = pState.DetailRecord;
		let tmpSpec = tmpD.Spec || {};
		let tmpStatus = pState.LastStatus && pState.LastStatus.Hash === tmpD.Hash
			? pState.LastStatus.Status : null;

		// Index spec components by Hash so each running container's row
		// can be joined with its declared Ports (and Image, used by the
		// SQL-vs-HTTP classifier).
		let tmpSpecByHash = {};
		(tmpSpec.Components || []).forEach((pC) => { tmpSpecByHash[pC.Hash] = pC; });

		let tmpInputValues = tmpD.InputValues || {};
		let tmpInputDefs   = tmpSpec.Inputs || {};
		let tmpYamlText    = (pState.LastYaml && pState.LastYaml.Hash === tmpD.Hash) ? (pState.LastYaml.YAML || '') : '';
		let tmpYamlPorts   = _parseYamlPortMap(tmpYamlText);
		let tmpComponents = (tmpStatus && Array.isArray(tmpStatus.Components))
			? tmpStatus.Components.map((pC) => (
				{
					Hash:    _escape(pC.Hash || ''),
					State:   _escape(pC.State || ''),
					Health:  _escape(pC.Health || ''),
					Uptime:  _escape(pC.Uptime || ''),
					Ports:   _buildComponentPorts(tmpD.Hash, tmpSpecByHash[pC.Hash], tmpInputValues, tmpInputDefs, tmpYamlPorts)
				}))
			: [];
		let tmpStatusValue = (tmpStatus && tmpStatus.Phase) || tmpD.Status || 'stopped';
		let tmpYaml = pState.LastYaml && pState.LastYaml.Hash === tmpD.Hash
			? pState.LastYaml : null;

		// InitSlot — single-element-array conditional. Only stacks with
		// `InitOperation` declared in their spec get the panel; other
		// stacks see no init UI at all (the StackInitializer would skip
		// them anyway). The data shape is built by _buildInitRecord.
		let tmpInit = (pState.LastInit && pState.LastInit.Hash === tmpD.Hash) ? pState.LastInit.Result : null;
		let tmpHasInit = !!(tmpSpec.InitOperation && tmpSpec.InitOperation.OperationHash);

		return {
			Name:           _escape(tmpSpec.Name || tmpD.Hash),
			HashEnc:        encodeURIComponent(tmpD.Hash),
			Status:         _escape(tmpStatusValue),
			StatusClass:    _statusClass(tmpStatusValue),
			Components:     tmpComponents,
			NoComponentsSlot: tmpComponents.length === 0 ? [{}] : [],
			InitSlot:       tmpHasInit ? [_buildInitRecord(tmpD.Hash, tmpInit)] : [],
			YamlText:       _escape(tmpYaml ? tmpYaml.YAML : '(YAML not loaded yet — Refresh to load)'),
			YamlSource:     _escape(tmpYaml ? tmpYaml.Source : ''),
			UpDisabled:     (!!(pState.LaunchingStacks && pState.LaunchingStacks[tmpD.Hash])
								|| tmpStatusValue === 'running'
								|| tmpStatusValue === 'starting') ? 'disabled' : '',
			UpLabel:        (pState.LaunchingStacks && pState.LaunchingStacks[tmpD.Hash]) ? 'Launching…' : 'Launch',
			DownDisabled:   (tmpStatusValue === 'stopped' || tmpStatusValue === 'stopping') ? 'disabled' : ''
		};
	}
}

function _buildInitRecord(pStackHash, pResult)
{
	// pResult is the persisted init-state.json shape:
	//   { StackHash, Phase, OperationHash, RunHash, Message, StartedAt, CompletedAt, Manifest }
	// or null when the API hasn't returned yet, or { Phase: 'never-run' } if the
	// stack has never been launched. Either way we render the same panel — the
	// fields fill in once data arrives.
	let tmpPhase = (pResult && pResult.Phase) || 'never-run';
	let tmpRunHash = (pResult && pResult.RunHash) || '';
	let tmpManifestLinkHTML = '';
	if (tmpRunHash)
	{
		// Manifest is on the stack's UV, not the lab. Most stacks publish
		// the UV on the host port the operator picked; without a deterministic
		// way to reach it from here we surface the run hash so curious
		// operators can find the manifest themselves. A future iteration
		// can stash the UltravisorURL alongside the init result and link
		// directly into the UV's manifest viewer.
		tmpManifestLinkHTML = '<span class="lab-btn small secondary" style="cursor:default;opacity:0.7;" title="Run hash on the stack&apos;s ultravisor — open /Manifest/' + _escapeAttr(tmpRunHash) + ' on its API for the full manifest.">View manifest</span>';
	}
	return {
		StackHashEnc:    encodeURIComponent(pStackHash),
		Phase:           _escape(tmpPhase),
		PhaseClass:      _escape(tmpPhase),
		OperationHash:   _escape((pResult && pResult.OperationHash) || '—'),
		RunHash:         _escape(tmpRunHash || '—'),
		StartedAt:       _escape((pResult && pResult.StartedAt) || '—'),
		CompletedAt:     _escape((pResult && pResult.CompletedAt) || '—'),
		Message:         _escape((pResult && pResult.Message) || ''),
		MessageClass:    (tmpPhase === 'failed' || tmpPhase === 'error') ? 'error' : '',
		ManifestLinkHTML: tmpManifestLinkHTML
	};
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
