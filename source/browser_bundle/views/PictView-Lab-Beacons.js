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
	font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, monospace;
	font-size: 12px;
}
.lab-beacons-advanced-hint
{
	grid-column: 1 / -1; font-size: 12px; color: #64748b;
	margin: 0 0 4px;
}

.lab-beacon-card
{
	background: #fff; border: 1px solid #e2e8f0; border-radius: 8px; padding: 16px 18px;
	display: flex; flex-direction: column; gap: 12px;
}
.lab-beacon-card-header { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; }
.lab-beacon-card-header h3 { margin: 0; font-size: 15px; color: #0f172a; }
.lab-beacon-type-badge
{
	font-size: 11px; text-transform: uppercase; letter-spacing: 0.3px;
	padding: 2px 8px; border-radius: 10px; background: #dbeafe; color: #1e40af; font-weight: 600;
}
.lab-beacon-status
{
	font-size: 11px; text-transform: uppercase; letter-spacing: 0.3px;
	padding: 2px 8px; border-radius: 10px; font-weight: 600;
}
.lab-beacon-status.running       { background: #dcfce7; color: #166534; }
.lab-beacon-status.stopped       { background: #e2e8f0; color: #475569; }
.lab-beacon-status.provisioning,
.lab-beacon-status.starting,
.lab-beacon-status.stopping      { background: #fef3c7; color: #92400e; }
.lab-beacon-status.failed        { background: #fee2e2; color: #991b1b; }

.lab-beacon-actions { margin-left: auto; display: flex; gap: 8px; }
.lab-beacon-details
{
	display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
	gap: 8px 20px;
	background: #f8fafc; padding: 10px 14px; border-radius: 6px; font-size: 13px;
}
.lab-beacon-details .label
{
	font-size: 11px; text-transform: uppercase; letter-spacing: 0.3px;
	color: #64748b; font-weight: 600; margin-bottom: 2px;
}
.lab-beacon-detail-value a { color: #1d4ed8; text-decoration: none; }
.lab-beacon-detail-value a:hover { text-decoration: underline; }
.lab-beacon-status-detail { font-size: 12px; color: #92400e; font-style: italic; }

.lab-beacons-empty
{
	padding: 32px 20px; text-align: center; color: #64748b;
	background: #fff; border: 1px dashed #cbd5e1; border-radius: 8px;
}

.lab-btn
{
	background: #1d4ed8; color: #fff; border: 1px solid #1d4ed8;
	border-radius: 6px; padding: 6px 14px; font-size: 13px;
	font-weight: 500; cursor: pointer;
}
a.lab-btn { text-decoration: none; display: inline-flex; align-items: center; justify-content: center; }
.lab-btn:hover { background: #1e40af; border-color: #1e40af; }
.lab-btn.secondary { background: transparent; color: #0f172a; border-color: #cbd5e1; }
.lab-btn.secondary:hover { background: #f1f5f9; border-color: #94a3b8; }
.lab-btn.danger { background: transparent; color: #b91c1c; border-color: #fecaca; }
.lab-btn.danger:hover { background: #fef2f2; border-color: #f87171; }
.lab-btn.small { padding: 4px 10px; font-size: 12px; }
.lab-btn:disabled,
.lab-btn.disabled { opacity: 0.5; cursor: not-allowed; pointer-events: none; }

/* Build-source chip cluster.  Visible on container-mode beacon cards when
   the beacon type has a sibling monorepo checkout.  The active chip is
   darkened; the inactive one is a light link the user clicks to switch. */
.lab-beacon-build-source
{
	display: inline-flex; align-items: center; gap: 4px;
	padding: 0 6px; border-left: 1px solid #e2e8f0; margin-left: 4px;
}
.lab-beacon-build-source .label
{
	font-size: 11px; text-transform: uppercase; letter-spacing: 0.3px;
	color: #64748b; font-weight: 600;
}
.lab-chip
{
	font-size: 11px; text-transform: uppercase; letter-spacing: 0.3px;
	padding: 2px 8px; border-radius: 10px; text-decoration: none;
	background: #f1f5f9; color: #475569; border: 1px solid #e2e8f0;
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
		<div class="lab-beacons-type-buttons">{~D:AppData.Lab.Beacons.TypeButtonsHTML~}</div>
	</div>
	<div id="Lab-Beacons-FormSlot"></div>
	<div id="Lab-Beacons-ListSlot"></div>
</div>`
		},
		{
			Hash: 'Lab-Beacons-List-Template',
			Template: /*html*/`{~D:AppData.Lab.Beacons.ListHTML~}`
		},
		{
			Hash: 'Lab-Beacons-Form-Template',
			Template: /*html*/`{~D:AppData.Lab.Beacons.FormHTML~}`
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
	<div class="lab-beacons-form-deprecation" style="display:{~D:Record.DeprecationDisplay~};" title="{~D:Record.DeprecationNote~}">⚠️ {~D:Record.DeprecationNote~}</div>
	<label>Name
		<input type="text" id="Lab-BeaconForm-Name" placeholder="e.g. warehouse-001"
			value="{~D:Record.Name~}">
	</label>
	<label>Port
		<input type="number" id="Lab-BeaconForm-Port" min="1" max="65535"
			value="{~D:Record.Port~}">
	</label>
	<label style="display:{~D:Record.UltravisorDisplay~};">Target Ultravisor
		<select id="Lab-BeaconForm-Ultravisor">{~D:Record.UltravisorOptionsHTML~}</select>
	</label>
	<div class="full-width">{~D:Record.ConfigFieldsHTML~}</div>
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
			Hash: 'Lab-Beacons-ConfigField-Text-Template',
			Template: /*html*/`<label>{~D:Record.Label~}<input type="text" id="Lab-BeaconForm-Cfg-{~D:Record.Name~}" value="{~D:Record.Value~}"></label>`
		},
		{
			Hash: 'Lab-Beacons-ConfigField-Number-Template',
			Template: /*html*/`<label>{~D:Record.Label~}<input type="number" id="Lab-BeaconForm-Cfg-{~D:Record.Name~}" value="{~D:Record.Value~}"></label>`
		},
		{
			Hash: 'Lab-Beacons-ConfigField-EngineDbPicker-Template',
			Template: /*html*/`<label>{~D:Record.Label~}<select id="Lab-BeaconForm-Cfg-{~D:Record.Name~}">{~D:Record.OptionsHTML~}</select></label>`
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
			<a class="lab-btn secondary small" href="#/beacons/{~D:Record.IDBeacon~}/rebuild" style="display: {~D:Record.RebuildDisplay~};" title="Stop + remove container, drop cached image, rebuild from current stanza version">Rebuild</a>
			<span class="lab-beacon-build-source" style="display: {~D:Record.BuildSourceDisplay~};" title="Image source for this beacon. Source mode packs your local monorepo checkout instead of the npm registry.">
				<span class="label">Image:</span>
				<a class="lab-chip {~D:Record.IsNpmClass~}" href="#/beacons/{~D:Record.IDBeacon~}/build-source/npm" title="Published npm tarball">npm</a>
				<a class="lab-chip {~D:Record.IsSourceClass~}" href="#/beacons/{~D:Record.IDBeacon~}/build-source/source" title="Local monorepo checkout (npm pack of the sibling repo)">source</a>
			</span>
			<a class="lab-btn danger small" href="#/beacons/{~D:Record.IDBeacon~}/remove">Remove</a>
		</div>
	</div>
	<div class="lab-beacon-status-detail" style="display: {~D:Record.DetailDisplay~};">{~D:Record.StatusDetail~}</div>
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
		let tmpState = this.pict.AppData.Lab.Beacons;
		let tmpHash = pRenderable && pRenderable.RenderableHash;

		if (tmpHash === 'Lab-Beacons-Main' || !tmpHash)
		{
			// Rebuild the "+ Add <Type>" button cluster once when the shell
			// renders (types rarely change during a session).
			let tmpTypes = tmpState.Types || [];
			let tmpBtnHtml = '';
			for (let i = 0; i < tmpTypes.length; i++)
			{
				tmpBtnHtml += this.pict.parseTemplateByHash('Lab-Beacons-TypeButton-Template', tmpTypes[i]);
			}
			tmpState.TypeButtonsHTML = tmpBtnHtml;
		}

		if (tmpHash === 'Lab-Beacons-List' || tmpHash === 'Lab-Beacons-Main' || !tmpHash)
		{
			tmpState.ListHTML = this._buildListHTML(tmpState);
		}

		if (tmpHash === 'Lab-Beacons-Form' || tmpHash === 'Lab-Beacons-Main' || !tmpHash)
		{
			tmpState.FormHTML = tmpState.FormOpen ? this._buildFormHTML(tmpState) : '';
		}

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

	_buildListHTML(pState)
	{
		let tmpBeacons = pState.Beacons || [];
		if (tmpBeacons.length === 0)
		{
			return this.pict.parseTemplateByHash('Lab-Beacons-Empty-Template', {});
		}

		let tmpInstances = (this.pict.AppData.Lab.Ultravisor && this.pict.AppData.Lab.Ultravisor.Instances) || [];
		let tmpTypes = pState.Types || [];

		let tmpHtml = '';
		for (let i = 0; i < tmpBeacons.length; i++)
		{
			let tmpBeacon = tmpBeacons[i];
			let tmpType = tmpTypes.find((pT) => pT.BeaconType === tmpBeacon.BeaconType);
			let tmpUv = tmpBeacon.IDUltravisorInstance ? tmpInstances.find((pU) => pU.IDUltravisorInstance === tmpBeacon.IDUltravisorInstance) : null;
			let tmpUvLabel = tmpUv ? `${this._escape(tmpUv.Name)} (port ${tmpUv.Port})` : (tmpBeacon.IDUltravisorInstance ? '(missing)' : 'n/a');

			// Container-mode beacons don't have a PID; the meaningful ident is
			// their container + image.  Process-mode beacons stay with PID.
			let tmpRuntimeLabel = 'PID';
			let tmpRuntimeValue = tmpBeacon.PID ? String(tmpBeacon.PID) : '--';
			if (tmpBeacon.Runtime === 'container')
			{
				tmpRuntimeLabel = 'Image';
				tmpRuntimeValue = tmpBeacon.ImageTag ? this._escape(tmpBeacon.ImageTag) : '--';
			}

			// Build-source chip state: visible only for container-mode beacons
			// whose type supports source builds (capability-provider + missing
			// sibling checkout both disqualify).  The active chip gets the
			// `active` class so CSS can highlight it; the other is a link.
			let tmpSupportsSource = !!(tmpType && tmpType.SupportsSourceBuild);
			let tmpBuildSource = tmpBeacon.BuildSource || 'npm';
			let tmpShowBuildSource = (tmpBeacon.Runtime === 'container' && tmpSupportsSource);

			tmpHtml += this.pict.parseTemplateByHash('Lab-Beacons-Card-Template',
				{
					IDBeacon:        tmpBeacon.IDBeacon,
					Name:            this._escape(tmpBeacon.Name),
					TypeDisplay:     tmpType ? this._escape(tmpType.DisplayName) : this._escape(tmpBeacon.BeaconType),
					Status:          tmpBeacon.Status,
					StatusDetail:    this._escape(tmpBeacon.StatusDetail || ''),
					DetailDisplay:   tmpBeacon.StatusDetail ? 'block' : 'none',
					Port:            tmpBeacon.Port,
					RuntimeLabel:    tmpRuntimeLabel,
					RuntimeValue:    tmpRuntimeValue,
					UltravisorLabel: tmpUvLabel,
					StartDisabled:   (tmpBeacon.Status === 'running' || tmpBeacon.Status === 'starting' || tmpBeacon.Status === 'provisioning') ? 'disabled' : '',
					StopDisabled:    (tmpBeacon.Status !== 'running') ? 'disabled' : '',
					// Rebuild only makes sense for container-mode beacons.
					RebuildDisplay:  (tmpBeacon.Runtime === 'container') ? 'inline-flex' : 'none',
					BuildSourceDisplay: tmpShowBuildSource ? 'inline-flex' : 'none',
					IsNpmClass:        (tmpBuildSource === 'npm')    ? 'active' : '',
					IsSourceClass:     (tmpBuildSource === 'source') ? 'active' : ''
				});
		}
		return tmpHtml;
	}

	_buildFormHTML(pState)
	{
		let tmpForm = pState.Form || {};
		let tmpTypes = pState.Types || [];
		let tmpActiveType = tmpForm.BeaconType ? tmpTypes.find((pT) => pT.BeaconType === tmpForm.BeaconType) : null;

		// Ultravisor <select> (running only)
		let tmpInstances = (this.pict.AppData.Lab.Ultravisor && this.pict.AppData.Lab.Ultravisor.Instances) || [];
		let tmpUvHtml = '<option value="0">-- choose an Ultravisor --</option>';
		for (let j = 0; j < tmpInstances.length; j++)
		{
			let tmpUv = tmpInstances[j];
			if (tmpUv.Status !== 'running') { continue; }
			let tmpSel = (String(tmpForm.IDUltravisorInstance) === String(tmpUv.IDUltravisorInstance)) ? ' selected' : '';
			tmpUvHtml += `<option value="${tmpUv.IDUltravisorInstance}"${tmpSel}>${this._escape(tmpUv.Name)} (port ${tmpUv.Port})</option>`;
		}

		let tmpRecord =
		{
			Name:                 this._escape(tmpForm.Name || ''),
			Port:                 tmpForm.Port || 0,
			TypeDisplay:          tmpActiveType ? this._escape(tmpActiveType.DisplayName) : '',
			TypeDescription:      tmpActiveType ? this._escape(tmpActiveType.Description) : '',
			// Legacy / deprecated beacon types surface a warning banner so
			// new deployments steer toward retold-databeacon + the lab's
			// Persistence assignment for queue / manifest persistence.
			// See modules/apps/ultravisor/docs/features/persistence-via-databeacon.md.
			DeprecationDisplay:   (tmpActiveType && tmpActiveType.Deprecated) ? 'block' : 'none',
			DeprecationNote:      (tmpActiveType && tmpActiveType.Deprecated) ? this._escape(tmpActiveType.DeprecationNote || '') : '',
			UltravisorDisplay:    (tmpActiveType && tmpActiveType.RequiresUltravisor) ? 'flex' : 'none',
			UltravisorOptionsHTML: tmpUvHtml,
			ConfigFieldsHTML:     this._renderConfigFields(tmpActiveType, tmpForm.Config || {}),
			// Advanced — admission credential overrides. Plain attribute
			// values; the consumer reads them at submit time via _domValue.
			JoinSecretOverride:   this._escape(tmpForm.JoinSecretOverride || ''),
			SkipJoinSecretChecked: tmpForm.SkipJoinSecret ? 'checked' : '',
			Error:                this._escape(tmpForm.Error || '')
		};
		return this.pict.parseTemplateByHash('Lab-Beacons-FormBody-Template', tmpRecord);
	}

	/**
	 * Render each config field from the type descriptor by dispatching to a
	 * registered pict template per field shape.  Using parseTemplateByHash
	 * (rather than concatenating raw HTML) lets pict resolve `{~D:...~}` and
	 * gives us a single place to fix if the field shape changes.
	 */
	_renderConfigFields(pType, pCurrentConfig)
	{
		if (!pType || !pType.ConfigForm || !Array.isArray(pType.ConfigForm.Fields) || pType.ConfigForm.Fields.length === 0)
		{
			return '';
		}

		let tmpEngines = (this.pict.AppData.Lab.DBEngines && this.pict.AppData.Lab.DBEngines.Engines) || [];
		let tmpDbByEngine = (this.pict.AppData.Lab.DBEngines && this.pict.AppData.Lab.DBEngines.DatabasesByEngine) || {};

		let tmpOut = '<div class="lab-beacons-form" style="border:none;padding:0;">';
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
				tmpOut += this.pict.parseTemplateByHash('Lab-Beacons-ConfigField-Number-Template', tmpRecord);
			}
			else if (tmpField.Type === 'lab-engine-database-picker')
			{
				// One combined picker across all (engine, database) pairs so
				// there's no cascading onchange between two selects.  Value
				// encoded as "engineId:databaseId" and split at submit time.
				let tmpSelectedEngine = parseInt(pCurrentConfig.IDDBEngine, 10) || 0;
				let tmpSelectedDb = parseInt(pCurrentConfig.IDDatabase, 10) || 0;
				let tmpComposite = (tmpSelectedEngine && tmpSelectedDb) ? `${tmpSelectedEngine}:${tmpSelectedDb}` : '';
				let tmpOptionsHtml = '<option value="">-- none --</option>';
				for (let e = 0; e < tmpEngines.length; e++)
				{
					let tmpEng = tmpEngines[e];
					if (tmpEng.Status !== 'running') { continue; }
					let tmpDbs = tmpDbByEngine[tmpEng.IDDBEngine] || [];
					for (let d = 0; d < tmpDbs.length; d++)
					{
						let tmpDb = tmpDbs[d];
						let tmpValue = `${tmpEng.IDDBEngine}:${tmpDb.IDDatabase}`;
						let tmpSel = (tmpComposite === tmpValue) ? ' selected' : '';
						tmpOptionsHtml += `<option value="${tmpValue}"${tmpSel}>${this._escape(tmpEng.Name)} (${this._escape(tmpEng.EngineType)}) / ${this._escape(tmpDb.Name)}</option>`;
					}
				}
				tmpRecord.OptionsHTML = tmpOptionsHtml;
				tmpOut += this.pict.parseTemplateByHash('Lab-Beacons-ConfigField-EngineDbPicker-Template', tmpRecord);
			}
			else
			{
				tmpOut += this.pict.parseTemplateByHash('Lab-Beacons-ConfigField-Text-Template', tmpRecord);
			}
		}
		tmpOut += '</div>';
		return tmpOut;
	}

	_escape(pStr)
	{
		return String(pStr == null ? '' : pStr)
			.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
	}
}

module.exports = LabBeaconsView;
module.exports.default_configuration = _ViewConfiguration;
