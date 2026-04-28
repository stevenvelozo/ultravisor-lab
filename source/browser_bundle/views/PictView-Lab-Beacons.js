/**
 * PictView-Lab-Beacons
 *
 * Unified beacon management page.  Renders any row in the Beacon table
 * regardless of BeaconType -- the type's DisplayName + config panel are
 * pulled from the server's Service-BeaconTypeRegistry (seeded from each
 * module's `retoldBeacon` package.json stanza).
 *
 * Renderables:
 *   Lab-Beacons-Main  -- shell: toolbar buttons + <slot> divs.  Rendered
 *                        once when the user navigates in.
 *   Lab-Beacons-List  -- beacon cards.  Re-rendered on every refreshAll
 *                        completion so the display stays fresh without
 *                        touching the form.
 *   Lab-Beacons-Form  -- create form.  Re-rendered only by form-lifecycle
 *                        routes (open / close / submit-error).  Background
 *                        polls never touch this slot.
 *
 * Interaction model (per Retold convention):
 *   - Every action is a plain `<a href="#/path">` anchor.  Navigo hash-mode
 *     intercepts the click and dispatches to the matching route handler.
 *     No inline event handlers (onclick / onchange / oninput) anywhere.
 *   - Form inputs carry no oninput/onchange -- the submit route reads
 *     values from the DOM at commit time.
 *   - Type selection is clicking a per-type "+ Add <Type>" link rather
 *     than a dropdown with an onchange handler.
 *
 * Data flow:
 *   `AppData.Lab.Beacons` is the persisted state (Beacons array, Types
 *   array, Form object, FormOpen flag).  `onBeforeRender` derives display-
 *   ready records into `AppData.Lab.Computed.Beacons` (rows, single-element
 *   slots, option arrays). Every template tag reads from those addresses;
 *   no HTML is built in JS.
 */
'use strict';

const libPictView = require('pict-view');

const _ViewConfiguration =
{
	ViewIdentifier:            'Lab-Beacons',
	DefaultRenderable:         'Lab-Beacons-Main',
	DefaultDestinationAddress: '#Lab-Content-Container',

	AutoRender: false,

	CSS: /*css*/`
.lab-beacons { padding: 20px; display: flex; flex-direction: column; gap: 16px; }
.lab-beacons-toolbar
{
	display: flex; align-items: center; justify-content: space-between;
	flex-wrap: wrap; gap: 12px;
}
.lab-beacons-toolbar h2 { margin: 0; font-size: 16px; color: #0f172a; }
.lab-beacons-type-buttons { display: flex; flex-wrap: wrap; gap: 8px; }

.lab-beacons-form
{
	background: #fff; border: 1px solid #cbd5e1; border-radius: 8px; padding: 18px;
	display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
	gap: 12px 16px; align-items: end;
}
.lab-beacons-form { align-items: start; }
.lab-beacons-form label
{
	display: flex; flex-direction: column; gap: 4px;
	font-size: 12px; font-weight: 600; color: #475569;
	text-transform: uppercase; letter-spacing: 0.3px;
}
.lab-beacons-form input, .lab-beacons-form select
{
	font-family: inherit; font-size: 14px; padding: 7px 10px;
	border: 1px solid #cbd5e1; border-radius: 6px; background: #fff; color: #0f172a;
	box-sizing: border-box; height: 36px; line-height: 1.2;
}
.lab-beacons-form .full-width { grid-column: 1 / -1; }
.lab-beacons-form-header
{
	grid-column: 1 / -1;
	display: flex; align-items: center; gap: 10px;
}
.lab-beacons-form-header h3 { margin: 0; font-size: 14px; color: #0f172a; }
.lab-beacons-form-header .lab-beacon-type-badge { font-size: 11px; }
.lab-beacons-form-desc { grid-column: 1 / -1; font-size: 12px; color: #475569; font-style: italic; }
.lab-beacons-form-deprecation
{
	grid-column: 1 / -1;
	background: #fef3c7;
	border: 1px solid #fcd34d;
	border-radius: 6px;
	padding: 8px 12px;
	font-size: 12px;
	color: #78350f;
}
.lab-beacons-form-actions { grid-column: 1 / -1; display: flex; justify-content: flex-end; gap: 8px; }
.lab-beacons-form-error { grid-column: 1 / -1; color: #b91c1c; font-size: 13px; }

.lab-beacons-advanced
{
	border-top: 1px dashed #cbd5e1; padding-top: 10px;
	font-size: 13px;
}
.lab-beacons-advanced summary
{
	cursor: pointer; color: #475569; font-weight: 500;
	padding: 4px 0; user-select: none;
}
.lab-beacons-advanced summary:hover { color: #1d4ed8; }
.lab-beacons-advanced[open] summary { color: #0f172a; }
.lab-beacons-advanced-body
{
	display: grid; grid-template-columns: 1fr 1fr; gap: 12px 20px;
	padding: 8px 4px 4px;
}
.lab-beacons-advanced-body label
{
	display: flex; flex-direction: column; gap: 4px;
	font-size: 12px; color: #475569;
}
.lab-beacons-advanced-body label.lab-uv-form-checkbox
{
	flex-direction: row; align-items: flex-start; gap: 8px;
}
.lab-beacons-advanced-body input[type="text"]
{
	width: 100%; box-sizing: border-box; padding: 6px 10px;
	border: 1px solid #cfd5dd; border-radius: 6px;
	font-size: 13px; height: 32px;
}
.lab-beacons-advanced-body label.lab-uv-form-checkbox input[type="checkbox"]
{
	height: auto; padding: 0;
}
.lab-beacons-advanced-hint
{
	grid-column: 1 / -1; margin: 0 0 6px; padding: 8px 10px;
	background: #f8fafc; border-radius: 5px; color: #475569;
	font-size: 12px; line-height: 1.5;
}

.lab-beacon-card
{
	background: #fff; border: 1px solid #e2e8f0; border-radius: 8px; padding: 14px 18px;
	display: flex; flex-direction: column; gap: 8px;
}
.lab-beacon-card-header { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; }
.lab-beacon-card-header h3 { margin: 0; font-size: 14px; color: #0f172a; }
.lab-beacon-type-badge
{
	background: #1e3a8a; color: #dbeafe; font-size: 11px; padding: 2px 8px;
	border-radius: 999px; letter-spacing: 0.3px; font-weight: 600;
}
.lab-beacon-status
{
	margin-left: auto; padding: 2px 10px; border-radius: 12px;
	font-size: 12px; font-weight: 600; background: #f1f5f9; color: #475569;
}
.lab-beacon-status.running     { background: #dcfce7; color: #166534; }
.lab-beacon-status.starting    { background: #fef9c3; color: #854d0e; }
.lab-beacon-status.provisioning { background: #fef3c7; color: #92400e; }
.lab-beacon-status.failed      { background: #fee2e2; color: #991b1b; }
.lab-beacon-status-detail
{
	font-size: 12px; color: #475569; font-style: italic;
}
.lab-beacon-actions { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; }
.lab-beacon-actions .lab-btn.disabled
{
	opacity: 0.45; pointer-events: none; cursor: default;
}
.lab-beacon-build-source
{
	display: inline-flex; align-items: center; gap: 4px;
	font-size: 11px; color: #475569;
}
.lab-beacon-build-source .label { color: #64748b; }
.lab-beacon-details
{
	display: grid; grid-template-columns: repeat(auto-fit, minmax(140px, 1fr));
	gap: 10px 16px;
	font-size: 12px;
}
.lab-beacon-details .label
{
	font-size: 11px; font-weight: 600; color: #64748b;
	text-transform: uppercase; letter-spacing: 0.3px;
}
.lab-beacon-detail-value { font-size: 13px; color: #0f172a; word-break: break-word; }

.lab-chip
{
	border: 1px solid #cbd5e1; border-radius: 999px; padding: 1px 8px;
	background: #f1f5f9; color: #475569; text-decoration: none; font-size: 11px;
	cursor: pointer; line-height: 1.4;
}
.lab-chip:hover { background: #e2e8f0; color: #0f172a; }
.lab-chip.active
{
	background: #1d4ed8; color: #fff; border-color: #1d4ed8;
	cursor: default; pointer-events: none;
}
`,

	Templates:
	[
		{
			Hash: 'Lab-Beacons-Main-Template',
			Template: /*html*/`
<div class="lab-beacons">
	<div class="lab-beacons-toolbar">
		<h2>Ultravisor Beacons</h2>
		<div class="lab-beacons-type-buttons">{~TS:Lab-Beacons-TypeButton-Template:AppData.Lab.Beacons.Types~}</div>
	</div>
	<div id="Lab-Beacons-FormSlot"></div>
	<div id="Lab-Beacons-ListSlot"></div>
</div>`
		},
		{
			// List slot — picks one of two single-element TS arrays so
			// the empty-state and the populated card grid share one
			// renderable. AppData.Lab.Computed.Beacons.{EmptySlot,RowsSlot}
			// are inverse one-element arrays driven by row count.
			Hash: 'Lab-Beacons-List-Template',
			Template: /*html*/`
{~TS:Lab-Beacons-Empty-Template:AppData.Lab.Computed.Beacons.EmptySlot~}
{~TS:Lab-Beacons-Card-Template:AppData.Lab.Computed.Beacons.Rows~}`
		},
		{
			// Form slot — single-element-array drives "is the form open?".
			Hash: 'Lab-Beacons-Form-Template',
			Template: /*html*/`{~TS:Lab-Beacons-FormBody-Template:AppData.Lab.Computed.Beacons.FormSlot~}`
		},
		{
			Hash: 'Lab-Beacons-TypeButton-Template',
			Template: /*html*/`<a class="lab-btn secondary" href="#/beacons/form/open/{~D:Record.BeaconType~}">+ Add {~D:Record.DisplayName~}</a>`
		},
		{
			Hash: 'Lab-Beacons-FormBody-Template',
			Template: /*html*/`
<div class="lab-beacons-form">
	<div class="lab-beacons-form-header">
		<h3>New beacon</h3>
		<span class="lab-beacon-type-badge">{~D:Record.TypeDisplay~}</span>
	</div>
	<div class="lab-beacons-form-desc">{~D:Record.TypeDescription~}</div>
	{~TS:Lab-Beacons-FormDeprecation-Template:Record.DeprecationSlot~}
	<label>Name
		<input type="text" id="Lab-BeaconForm-Name" placeholder="e.g. warehouse-001"
			value="{~D:Record.Name~}">
	</label>
	<label>Port
		<input type="number" id="Lab-BeaconForm-Port" min="1" max="65535"
			value="{~D:Record.Port~}">
	</label>
	{~TS:Lab-Beacons-FormUltravisorPicker-Template:Record.UltravisorPickerSlot~}
	<div class="full-width">
		<div class="lab-beacons-form" style="border:none;padding:0;">
			{~TS:Lab-Beacons-ConfigField-Text-Template:Record.ConfigFieldsText~}
			{~TS:Lab-Beacons-ConfigField-Number-Template:Record.ConfigFieldsNumber~}
			{~TS:Lab-Beacons-ConfigField-EngineDbPicker-Template:Record.ConfigFieldsEngineDb~}
		</div>
	</div>
	<details class="lab-beacons-advanced full-width">
		<summary>Advanced — admission credentials</summary>
		<div class="lab-beacons-advanced-body">
			<p class="lab-beacons-advanced-hint">
				In Secure mode, the lab automatically assigns the parent Ultravisor's bootstrap secret as this beacon's join credential.
				Override these to test rejection or promiscuous-mode behaviors.
			</p>
			<label>JoinSecret override (blank = auto-assign)
				<input type="text" id="Lab-BeaconForm-JoinSecretOverride"
					placeholder="hex string, blank for auto"
					value="{~D:Record.JoinSecretOverride~}">
			</label>
			<label class="lab-uv-form-checkbox">
				<input type="checkbox" id="Lab-BeaconForm-SkipJoinSecret" {~D:Record.SkipJoinSecretChecked~}>
				<span>Skip JoinSecret entirely (sends no credential — for testing Secure-mode rejection)</span>
			</label>
		</div>
	</details>
	<div class="lab-beacons-form-actions">
		<a class="lab-btn secondary" href="#/beacons/form/suggest-port">↻ Suggest port</a>
		<a class="lab-btn secondary" href="#/beacons/form/close">Cancel</a>
		<a class="lab-btn" href="#/beacons/submit">Create beacon</a>
	</div>
	<div class="lab-beacons-form-error">{~D:Record.Error~}</div>
</div>`
		},
		{
			// Single-row slot — populated when the active type is deprecated.
			Hash: 'Lab-Beacons-FormDeprecation-Template',
			Template: /*html*/`<div class="lab-beacons-form-deprecation" title="{~D:Record.Note~}">⚠️ {~D:Record.Note~}</div>`
		},
		{
			// Single-row slot — populated when the active type RequiresUltravisor.
			Hash: 'Lab-Beacons-FormUltravisorPicker-Template',
			Template: /*html*/`<label>Target Ultravisor
	<select id="Lab-BeaconForm-Ultravisor">
		<option value="0">-- choose an Ultravisor --</option>
		{~TS:Lab-Beacons-UltravisorOption-Template:Record.Options~}
	</select>
</label>`
		},
		{
			Hash: 'Lab-Beacons-UltravisorOption-Template',
			Template: /*html*/`<option value="{~D:Record.Value~}" {~D:Record.SelectedAttr~}>{~D:Record.Label~}</option>`
		},
		{
			Hash: 'Lab-Beacons-ConfigField-Text-Template',
			Template: /*html*/`<label>{~D:Record.Label~}<input type="text" id="Lab-BeaconForm-Cfg-{~D:Record.Name~}" value="{~D:Record.Value~}"></label>`
		},
		{
			Hash: 'Lab-Beacons-ConfigField-Number-Template',
			Template: /*html*/`<label>{~D:Record.Label~}<input type="number" id="Lab-BeaconForm-Cfg-{~D:Record.Name~}" value="{~D:Record.Value~}"></label>`
		},
		{
			Hash: 'Lab-Beacons-ConfigField-EngineDbPicker-Template',
			Template: /*html*/`<label>{~D:Record.Label~}<select id="Lab-BeaconForm-Cfg-{~D:Record.Name~}">
	<option value="">-- none --</option>
	{~TS:Lab-Beacons-EngineDbOption-Template:Record.Options~}
</select></label>`
		},
		{
			Hash: 'Lab-Beacons-EngineDbOption-Template',
			Template: /*html*/`<option value="{~D:Record.Value~}" {~D:Record.SelectedAttr~}>{~D:Record.Label~}</option>`
		},
		{
			Hash: 'Lab-Beacons-Empty-Template',
			Template: /*html*/`<div class="lab-beacons-empty">No beacons yet.  Use one of the "+ Add" buttons above to spin up a beacon.</div>`
		},
		{
			Hash: 'Lab-Beacons-Card-Template',
			Template: /*html*/`
<div class="lab-beacon-card">
	<div class="lab-beacon-card-header">
		<h3>{~D:Record.Name~}</h3>
		<span class="lab-beacon-type-badge">{~D:Record.TypeDisplay~}</span>
		<span class="lab-beacon-status {~D:Record.Status~}">{~D:Record.Status~}</span>
		<div class="lab-beacon-actions">
			<a class="lab-btn secondary small {~D:Record.StartDisabled~}" href="#/beacons/{~D:Record.IDBeacon~}/start">Start</a>
			<a class="lab-btn secondary small {~D:Record.StopDisabled~}"  href="#/beacons/{~D:Record.IDBeacon~}/stop">Stop</a>
			<a class="lab-btn secondary small" href="#/beacons/{~D:Record.IDBeacon~}/logs">Logs</a>
			{~TS:Lab-Beacons-CardRebuild-Template:Record.RebuildSlot~}
			{~TS:Lab-Beacons-CardBuildSource-Template:Record.BuildSourceSlot~}
			<a class="lab-btn danger small" href="#/beacons/{~D:Record.IDBeacon~}/remove">Remove</a>
		</div>
	</div>
	{~TS:Lab-Beacons-CardStatusDetail-Template:Record.StatusDetailSlot~}
	<div class="lab-beacon-details">
		<div>
			<div class="label">Port</div>
			<div class="lab-beacon-detail-value">127.0.0.1:{~D:Record.Port~}</div>
		</div>
		<div>
			<div class="label">Endpoint</div>
			<div class="lab-beacon-detail-value"><a href="http://127.0.0.1:{~D:Record.Port~}/" target="_blank">open ↗</a></div>
		</div>
		<div>
			<div class="label">Registered with</div>
			<div class="lab-beacon-detail-value">{~D:Record.UltravisorLabel~}</div>
		</div>
		<div>
			<div class="label">{~D:Record.RuntimeLabel~}</div>
			<div class="lab-beacon-detail-value">{~D:Record.RuntimeValue~}</div>
		</div>
	</div>
</div>`
		},
		{
			Hash: 'Lab-Beacons-CardRebuild-Template',
			Template: /*html*/`<a class="lab-btn secondary small" href="#/beacons/{~D:Record.IDBeacon~}/rebuild" title="Stop + remove container, drop cached image, rebuild from current stanza version">Rebuild</a>`
		},
		{
			Hash: 'Lab-Beacons-CardBuildSource-Template',
			Template: /*html*/`<span class="lab-beacon-build-source" title="Image source for this beacon. Source mode packs your local monorepo checkout instead of the npm registry.">
	<span class="label">Image:</span>
	<a class="lab-chip {~D:Record.IsNpmClass~}" href="#/beacons/{~D:Record.IDBeacon~}/build-source/npm" title="Published npm tarball">npm</a>
	<a class="lab-chip {~D:Record.IsSourceClass~}" href="#/beacons/{~D:Record.IDBeacon~}/build-source/source" title="Local monorepo checkout (npm pack of the sibling repo)">source</a>
</span>`
		},
		{
			Hash: 'Lab-Beacons-CardStatusDetail-Template',
			Template: /*html*/`<div class="lab-beacon-status-detail">{~D:Record.StatusDetail~}</div>`
		}
	],

	Renderables:
	[
		{
			RenderableHash:            'Lab-Beacons-Main',
			TemplateHash:              'Lab-Beacons-Main-Template',
			ContentDestinationAddress: '#Lab-Content-Container'
		},
		{
			RenderableHash:            'Lab-Beacons-List',
			TemplateHash:              'Lab-Beacons-List-Template',
			ContentDestinationAddress: '#Lab-Beacons-ListSlot'
		},
		{
			RenderableHash:            'Lab-Beacons-Form',
			TemplateHash:              'Lab-Beacons-Form-Template',
			ContentDestinationAddress: '#Lab-Beacons-FormSlot'
		}
	]
};

class LabBeaconsView extends libPictView
{
	constructor(pFable, pOptions, pServiceHash)
	{
		super(pFable, pOptions, pServiceHash);
	}

	onBeforeRender(pRenderable)
	{
		if (!this.pict.AppData.Lab.Beacons) { this.pict.AppData.Lab.Beacons = {}; }
		if (!this.pict.AppData.Lab.Computed) { this.pict.AppData.Lab.Computed = {}; }
		let tmpState = this.pict.AppData.Lab.Beacons;
		let tmpHash = pRenderable && pRenderable.RenderableHash;

		// Always build computed records — `onBeforeRender` is cheap and the
		// Main shell plus the two slot renderables all consume them. Doing
		// the work unconditionally avoids "did I update Computed before
		// rendering this slot?" bugs.
		this.pict.AppData.Lab.Computed.Beacons =
		{
			Rows:      this._buildRows(tmpState),
			EmptySlot: ((tmpState.Beacons || []).length === 0) ? [{}] : [],
			FormSlot:  tmpState.FormOpen ? [this._buildFormRecord(tmpState)] : []
		};

		return super.onBeforeRender(pRenderable);
	}

	onAfterRender(pRenderable, pAddress, pRecord, pContent)
	{
		let tmpHash = pRenderable && pRenderable.RenderableHash;
		// When the shell renders, fan out so the slot contents land in their
		// own renderables (keeps poll-driven list updates independent of the
		// form's DOM subtree).
		if (tmpHash === 'Lab-Beacons-Main' || !tmpHash)
		{
			this.render('Lab-Beacons-List');
			this.render('Lab-Beacons-Form');
		}
		this.pict.CSSMap.injectCSS();
		return super.onAfterRender(pRenderable, pAddress, pRecord, pContent);
	}

	// ====================================================================
	// Computed-record builders. None of these emit HTML — they shape data
	// for the templates above. Iteration / conditional rendering lives in
	// the templates via {~TS:~} and the single-element-slot pattern.
	// ====================================================================

	_buildRows(pState)
	{
		let tmpBeacons = pState.Beacons || [];
		if (tmpBeacons.length === 0) { return []; }

		let tmpInstances = (this.pict.AppData.Lab.Ultravisor && this.pict.AppData.Lab.Ultravisor.Instances) || [];
		let tmpTypes = pState.Types || [];

		return tmpBeacons.map((pBeacon) =>
		{
			let tmpType = tmpTypes.find((pT) => pT.BeaconType === pBeacon.BeaconType);
			let tmpUv = pBeacon.IDUltravisorInstance ? tmpInstances.find((pU) => pU.IDUltravisorInstance === pBeacon.IDUltravisorInstance) : null;
			let tmpUvLabel = tmpUv
				? `${this._escape(tmpUv.Name)} (port ${tmpUv.Port})`
				: (pBeacon.IDUltravisorInstance ? '(missing)' : 'n/a');

			// Container-mode beacons don't have a PID; the meaningful ident is
			// their container + image. Process-mode beacons stay with PID.
			let tmpRuntimeLabel = 'PID';
			let tmpRuntimeValue = pBeacon.PID ? String(pBeacon.PID) : '--';
			if (pBeacon.Runtime === 'container')
			{
				tmpRuntimeLabel = 'Image';
				tmpRuntimeValue = pBeacon.ImageTag ? this._escape(pBeacon.ImageTag) : '--';
			}

			// Build-source chip slot: visible only for container-mode beacons
			// whose type supports source builds. Driving as a single-element
			// slot lets the card template just `{~TS:~}` it.
			let tmpSupportsSource = !!(tmpType && tmpType.SupportsSourceBuild);
			let tmpBuildSource = pBeacon.BuildSource || 'npm';
			let tmpShowBuildSource = (pBeacon.Runtime === 'container' && tmpSupportsSource);
			let tmpRebuildVisible = (pBeacon.Runtime === 'container');

			return {
				IDBeacon:         pBeacon.IDBeacon,
				Name:             this._escape(pBeacon.Name),
				TypeDisplay:      tmpType ? this._escape(tmpType.DisplayName) : this._escape(pBeacon.BeaconType),
				Status:           pBeacon.Status,
				Port:             pBeacon.Port,
				RuntimeLabel:     tmpRuntimeLabel,
				RuntimeValue:     tmpRuntimeValue,
				UltravisorLabel:  tmpUvLabel,
				StartDisabled:    (pBeacon.Status === 'running' || pBeacon.Status === 'starting' || pBeacon.Status === 'provisioning') ? 'disabled' : '',
				StopDisabled:     (pBeacon.Status !== 'running') ? 'disabled' : '',
				StatusDetailSlot: pBeacon.StatusDetail
					? [{ StatusDetail: this._escape(pBeacon.StatusDetail) }]
					: [],
				RebuildSlot: tmpRebuildVisible
					? [{ IDBeacon: pBeacon.IDBeacon }]
					: [],
				BuildSourceSlot: tmpShowBuildSource
					? [
						{
							IDBeacon:       pBeacon.IDBeacon,
							IsNpmClass:     (tmpBuildSource === 'npm')    ? 'active' : '',
							IsSourceClass:  (tmpBuildSource === 'source') ? 'active' : ''
						}
					]
					: []
			};
		});
	}

	_buildFormRecord(pState)
	{
		let tmpForm = pState.Form || {};
		let tmpTypes = pState.Types || [];
		let tmpActiveType = tmpForm.BeaconType ? tmpTypes.find((pT) => pT.BeaconType === tmpForm.BeaconType) : null;

		// Ultravisor picker slot — populated only when the active type
		// requires one. Each option becomes a record the option template
		// reads via {~D:Record.X~}.
		let tmpInstances = (this.pict.AppData.Lab.Ultravisor && this.pict.AppData.Lab.Ultravisor.Instances) || [];
		let tmpUvOptions = tmpInstances
			.filter((pU) => pU.Status === 'running')
			.map((pU) => (
				{
					Value:        pU.IDUltravisorInstance,
					Label:        this._escape(pU.Name) + ' (port ' + pU.Port + ')',
					SelectedAttr: (String(tmpForm.IDUltravisorInstance) === String(pU.IDUltravisorInstance)) ? 'selected' : ''
				}));
		let tmpUvSlot = (tmpActiveType && tmpActiveType.RequiresUltravisor)
			? [{ Options: tmpUvOptions }]
			: [];

		// Config field arrays — one per shape. The form template emits
		// three TS tags in DOM order. Each field record carries everything
		// its template needs.
		let tmpConfigFields = this._buildConfigFieldGroups(tmpActiveType, tmpForm.Config || {});

		// Deprecation slot — populated only when the active type is marked
		// deprecated in the BeaconTypeRegistry.
		let tmpDeprecationSlot = (tmpActiveType && tmpActiveType.Deprecated)
			? [{ Note: this._escape(tmpActiveType.DeprecationNote || '') }]
			: [];

		return {
			Name:                  this._escape(tmpForm.Name || ''),
			Port:                  tmpForm.Port || 0,
			TypeDisplay:           tmpActiveType ? this._escape(tmpActiveType.DisplayName) : '',
			TypeDescription:       tmpActiveType ? this._escape(tmpActiveType.Description) : '',
			DeprecationSlot:       tmpDeprecationSlot,
			UltravisorPickerSlot:  tmpUvSlot,
			ConfigFieldsText:      tmpConfigFields.Text,
			ConfigFieldsNumber:    tmpConfigFields.Number,
			ConfigFieldsEngineDb:  tmpConfigFields.EngineDb,
			JoinSecretOverride:    this._escape(tmpForm.JoinSecretOverride || ''),
			SkipJoinSecretChecked: tmpForm.SkipJoinSecret ? 'checked' : '',
			Error:                 this._escape(tmpForm.Error || '')
		};
	}

	/**
	 * Bucket the active type's ConfigForm.Fields into three arrays, one
	 * per template shape. The form template emits three TS tags in DOM
	 * order so the visible field order matches the descriptor's order
	 * within each shape, but text-vs-number-vs-picker fields cluster.
	 * That's a deliberate tradeoff — the alternative is per-record
	 * template-dispatch which Pict doesn't have a clean idiom for.
	 */
	_buildConfigFieldGroups(pType, pCurrentConfig)
	{
		let tmpGroups = { Text: [], Number: [], EngineDb: [] };
		if (!pType || !pType.ConfigForm || !Array.isArray(pType.ConfigForm.Fields)) { return tmpGroups; }

		let tmpEngines = (this.pict.AppData.Lab.DBEngines && this.pict.AppData.Lab.DBEngines.Engines) || [];
		let tmpDbByEngine = (this.pict.AppData.Lab.DBEngines && this.pict.AppData.Lab.DBEngines.DatabasesByEngine) || {};

		for (let i = 0; i < pType.ConfigForm.Fields.length; i++)
		{
			let tmpField = pType.ConfigForm.Fields[i];
			let tmpRawValue = pCurrentConfig[tmpField.Name];
			if (tmpRawValue === undefined) { tmpRawValue = tmpField.Default !== undefined ? tmpField.Default : ''; }

			let tmpRecord =
			{
				Name:  this._escape(tmpField.Name),
				Label: this._escape(tmpField.Label || tmpField.Name),
				Value: this._escape(tmpRawValue)
			};

			if (tmpField.Type === 'number')
			{
				tmpGroups.Number.push(tmpRecord);
			}
			else if (tmpField.Type === 'lab-engine-database-picker')
			{
				// One combined picker across all (engine, database) pairs so
				// there's no cascading onchange between two selects. Value
				// encoded as "engineId:databaseId" and split at submit time.
				let tmpSelectedEngine = parseInt(pCurrentConfig.IDDBEngine, 10) || 0;
				let tmpSelectedDb = parseInt(pCurrentConfig.IDDatabase, 10) || 0;
				let tmpComposite = (tmpSelectedEngine && tmpSelectedDb) ? `${tmpSelectedEngine}:${tmpSelectedDb}` : '';
				let tmpOptions = [];
				for (let e = 0; e < tmpEngines.length; e++)
				{
					let tmpEng = tmpEngines[e];
					if (tmpEng.Status !== 'running') { continue; }
					let tmpDbs = tmpDbByEngine[tmpEng.IDDBEngine] || [];
					for (let d = 0; d < tmpDbs.length; d++)
					{
						let tmpDb = tmpDbs[d];
						let tmpValue = `${tmpEng.IDDBEngine}:${tmpDb.IDDatabase}`;
						tmpOptions.push(
							{
								Value:        tmpValue,
								Label:        this._escape(tmpEng.Name) + ' (' + this._escape(tmpEng.EngineType) + ') / ' + this._escape(tmpDb.Name),
								SelectedAttr: (tmpComposite === tmpValue) ? 'selected' : ''
							});
					}
				}
				tmpRecord.Options = tmpOptions;
				tmpGroups.EngineDb.push(tmpRecord);
			}
			else
			{
				tmpGroups.Text.push(tmpRecord);
			}
		}
		return tmpGroups;
	}

	_escape(pStr)
	{
		return String(pStr == null ? '' : pStr)
			.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
	}
}

module.exports = LabBeaconsView;
module.exports.default_configuration = _ViewConfiguration;
