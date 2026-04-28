/**
 * PictView-Lab-Ultravisor
 *
 * Manages supervised Ultravisor instances. Each instance runs the lab's
 * `lab-ultravisor.js` which hosts the Ultravisor API only. Beacons are
 * their own entity (see PictView-Lab-Beacons) registered with an
 * Ultravisor via their IDUltravisorInstance.
 *
 * Data flow: AppData.Lab.Ultravisor holds the persisted state (Instances
 * array, Form, FormOpen). onBeforeRender derives the display-ready
 * records into AppData.Lab.Computed.Ultravisor — every card field, every
 * conditional fragment, and every option list is data the templates
 * iterate via {~TS:~}. No HTML construction in JS.
 */
'use strict';

const libPictView = require('pict-view');

const _ViewConfiguration =
{
	ViewIdentifier:            'Lab-Ultravisor',
	DefaultRenderable:         'Lab-Ultravisor-Main',
	DefaultDestinationAddress: '#Lab-Content-Container',

	AutoRender: false,

	CSS: /*css*/`
.lab-uv { padding: 20px; display: flex; flex-direction: column; gap: 16px; }
.lab-uv-toolbar { display: flex; align-items: center; justify-content: space-between; }
.lab-uv-toolbar h2 { margin: 0; font-size: 16px; color: #0f172a; }

.lab-uv-form
{
	background: #fff; border: 1px solid #cbd5e1; border-radius: 8px; padding: 18px;
	display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
	gap: 12px 16px; align-items: start;
}
.lab-uv-form label
{
	display: flex; flex-direction: column; gap: 4px;
	font-size: 12px; font-weight: 600; color: #475569;
	text-transform: uppercase; letter-spacing: 0.3px;
}
.lab-uv-form input, .lab-uv-form select
{
	font-family: inherit; font-size: 14px; padding: 7px 10px;
	border: 1px solid #cbd5e1; border-radius: 6px; background: #fff; color: #0f172a;
	box-sizing: border-box; height: 36px; line-height: 1.2;
}
.lab-uv-form-actions { grid-column: 1 / -1; display: flex; justify-content: flex-end; gap: 8px; }
.lab-uv-form-error { grid-column: 1 / -1; color: #b91c1c; font-size: 13px; }
.lab-uv-form-checkbox
{
	flex-direction: row;
	align-items: center;
	gap: 8px;
	text-transform: none;
	letter-spacing: normal;
	font-weight: 500;
	color: #0f172a;
}
.lab-uv-form-checkbox input { accent-color: #1d4ed8; }

.lab-uv-card
{
	background: #fff; border: 1px solid #e2e8f0; border-radius: 8px; padding: 16px 18px;
	display: flex; flex-direction: column; gap: 12px;
}
.lab-uv-card-header { display: flex; align-items: center; gap: 12px; }
.lab-uv-card-header h3 { margin: 0; font-size: 15px; color: #0f172a; }
.lab-uv-status
{
	font-size: 11px; text-transform: uppercase; letter-spacing: 0.3px;
	padding: 2px 8px; border-radius: 10px; font-weight: 600;
}
.lab-uv-status.running       { background: #dcfce7; color: #166534; }
.lab-uv-status.stopped       { background: #e2e8f0; color: #475569; }
.lab-uv-status.provisioning,
.lab-uv-status.starting,
.lab-uv-status.stopping      { background: #fef3c7; color: #92400e; }
.lab-uv-status.failed        { background: #fee2e2; color: #991b1b; }

.lab-uv-actions { margin-left: auto; display: flex; gap: 8px; }
.lab-uv-details
{
	display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
	gap: 8px 20px;
	background: #f8fafc; padding: 10px 14px; border-radius: 6px; font-size: 13px;
}
.lab-uv-details .label
{
	font-size: 11px; text-transform: uppercase; letter-spacing: 0.3px;
	color: #64748b; font-weight: 600; margin-bottom: 2px;
}
.lab-uv-detail-value a { color: #1d4ed8; text-decoration: none; }
.lab-uv-detail-value a:hover { text-decoration: underline; }
.lab-uv-status-detail { font-size: 12px; color: #92400e; font-style: italic; }

/* Secure-mode chrome — badge sits next to the running/stopped pill, the
   actions row sits below the status detail and only renders when the UV
   is in Secure mode (rendered HTML decides visibility). */
.lab-uv-secure-badge
{
	font-size: 11px; padding: 2px 8px; border-radius: 10px;
	font-weight: 600; letter-spacing: 0.3px;
	background: #fef3c7; color: #92400e;
	border: 1px solid #fde68a;
}
.lab-uv-secure-badge.bootstrapped
{
	background: #dcfce7; color: #166534; border-color: #86efac;
}
.lab-uv-security-actions
{
	display: flex; align-items: center; gap: 12px;
	padding: 10px 14px; border-radius: 6px;
	background: #fffbeb; border: 1px solid #fde68a;
}
.lab-uv-security-hint { flex: 1; font-size: 12px; color: #78350f; }

.lab-uv-persistence-row
{
	display: flex; align-items: center; gap: 12px;
	padding: 10px 14px; border-radius: 6px;
	background: #f8fafc; border: 1px solid #e2e8f0;
}
.lab-uv-persistence-pill
{
	font-size: 11px; padding: 2px 8px; border-radius: 10px;
	white-space: nowrap; font-weight: 500;
}
.lab-uv-persistence-pill.unassigned         { background: #e2e8f0; color: #475569; }
.lab-uv-persistence-pill.waiting-for-beacon { background: #fef3c7; color: #92400e; }
.lab-uv-persistence-pill.bootstrapping      { background: #dbeafe; color: #1e40af; }
.lab-uv-persistence-pill.bootstrapped       { background: #dcfce7; color: #166534; }
.lab-uv-persistence-pill.error              { background: #fee2e2; color: #991b1b; cursor: help; }

.lab-uv-empty
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
`,

	Templates:
	[
		{
			Hash: 'Lab-Ultravisor-Main-Template',
			Template: /*html*/`
<div class="lab-uv">
	<div class="lab-uv-toolbar">
		<h2>Ultravisor Instances</h2>
		<a class="lab-btn" href="#/ultravisor/form/toggle">{~D:AppData.Lab.Computed.Ultravisor.FormButtonLabel~}</a>
	</div>
	<div id="Lab-Ultravisor-FormSlot"></div>
	<div id="Lab-Ultravisor-ListSlot"></div>
</div>`
		},
		{
			Hash: 'Lab-Ultravisor-List-Template',
			Template: /*html*/`
{~TS:Lab-Ultravisor-Empty-Template:AppData.Lab.Computed.Ultravisor.EmptySlot~}
{~TS:Lab-Ultravisor-Card-Template:AppData.Lab.Computed.Ultravisor.Rows~}`
		},
		{
			Hash: 'Lab-Ultravisor-Form-Template',
			Template: /*html*/`{~TS:Lab-Ultravisor-FormBody-Template:AppData.Lab.Computed.Ultravisor.FormSlot~}`
		},
		{
			Hash: 'Lab-Ultravisor-FormBody-Template',
			Template: /*html*/`
<div class="lab-uv-form">
	<label>Name
		<input type="text" id="Lab-UltravisorForm-Name" placeholder="e.g. lab-uv"
			value="{~D:Record.Name~}">
	</label>
	<label>API port
		<input type="number" id="Lab-UltravisorForm-Port" min="1" max="65535"
			value="{~D:Record.Port~}">
	</label>
	<label class="lab-uv-form-secure">
		<input type="checkbox" id="Lab-UltravisorForm-Secure" {~D:Record.SecureChecked~}>
		<span>Secure mode (non-promiscuous, requires auth beacon to admit other beacons)</span>
	</label>
	<div class="lab-uv-form-actions">
		<a class="lab-btn secondary" href="#/ultravisor/form/toggle">Cancel</a>
		<a class="lab-btn" href="#/ultravisor/submit">Create Ultravisor</a>
	</div>
	<div class="lab-uv-form-error">{~D:Record.Error~}</div>
</div>`
		},
		{
			Hash: 'Lab-Ultravisor-Empty-Template',
			Template: /*html*/`<div class="lab-uv-empty">No Ultravisor instances yet.  Start one to host seed-dataset operations.</div>`
		},
		{
			Hash: 'Lab-Ultravisor-Card-Template',
			Template: /*html*/`
<div class="lab-uv-card">
	<div class="lab-uv-card-header">
		<h3>{~D:Record.Name~}</h3>
		<span class="lab-uv-status {~D:Record.Status~}">{~D:Record.Status~}</span>
		{~TS:Lab-Ultravisor-SecureBadgePending-Template:Record.SecureBadgePendingSlot~}
		{~TS:Lab-Ultravisor-SecureBadgeBootstrapped-Template:Record.SecureBadgeBootstrappedSlot~}
		<div class="lab-uv-actions">
			<a class="lab-btn secondary small {~D:Record.StartDisabled~}" href="#/ultravisor/{~D:Record.IDUltravisorInstance~}/start">Start</a>
			<a class="lab-btn secondary small {~D:Record.StopDisabled~}"  href="#/ultravisor/{~D:Record.IDUltravisorInstance~}/stop">Stop</a>
			<a class="lab-btn danger small" href="#/ultravisor/{~D:Record.IDUltravisorInstance~}/remove">Remove</a>
		</div>
	</div>
	{~TS:Lab-Ultravisor-StatusDetail-Template:Record.StatusDetailSlot~}
	{~TS:Lab-Ultravisor-NeedsAuthBeacon-Template:Record.NeedsAuthBeaconSlot~}
	{~TS:Lab-Ultravisor-NeedsBootstrap-Template:Record.NeedsBootstrapSlot~}
	{~TS:Lab-Ultravisor-SecureReady-Template:Record.SecureReadySlot~}
	<div class="lab-uv-persistence-row">
		<span class="lab-uv-persistence-pill {~D:Record.Persistence.State~}" title="{~D:Record.Persistence.Tooltip~}">Persistence: {~D:Record.Persistence.Label~}</span>
		<span class="lab-uv-security-hint">{~D:Record.Persistence.Hint~}</span>
		<a class="lab-btn small {~D:Record.Persistence.ButtonDisabled~}" href="#/ultravisor/{~D:Record.IDUltravisorInstance~}/set-persistence-beacon">{~D:Record.Persistence.ButtonLabel~}</a>
	</div>
	<div class="lab-uv-details">
		<div>
			<div class="label">API port</div>
			<div class="lab-uv-detail-value">127.0.0.1:{~D:Record.Port~}</div>
		</div>
		<div>
			<div class="label">Ultravisor UI</div>
			<div class="lab-uv-detail-value"><a href="http://127.0.0.1:{~D:Record.Port~}/" target="_blank">open ↗</a></div>
		</div>
		<div>
			<div class="label">PID</div>
			<div class="lab-uv-detail-value">{~D:Record.PID~}</div>
		</div>
		<div>
			<div class="label">Paired MI beacons</div>
			<div class="lab-uv-detail-value">
				{~TS:Lab-Ultravisor-BeaconSummaryNone-Template:Record.BeaconSummaryNoneSlot~}
				{~TS:Lab-Ultravisor-BeaconSummaryItem-Template:Record.BeaconSummaryItems~}
			</div>
		</div>
	</div>
</div>`
		},
		{
			Hash: 'Lab-Ultravisor-StatusDetail-Template',
			Template: /*html*/`<div class="lab-uv-status-detail">{~D:Record.StatusDetail~}</div>`
		},
		{
			Hash: 'Lab-Ultravisor-SecureBadgePending-Template',
			Template: /*html*/`<span class="lab-uv-secure-badge" title="Secure mode, awaiting admin bootstrap">🔒 secure (pending)</span>`
		},
		{
			Hash: 'Lab-Ultravisor-SecureBadgeBootstrapped-Template',
			Template: /*html*/`<span class="lab-uv-secure-badge bootstrapped" title="Secure mode, admin bootstrapped">🔒 secure</span>`
		},
		{
			Hash: 'Lab-Ultravisor-NeedsAuthBeacon-Template',
			Template: /*html*/`<div class="lab-uv-security-actions">
	<span class="lab-uv-security-hint">No auth beacon yet — required to admit other beacons.</span>
	<a class="lab-btn small {~D:Record.ButtonDisabled~}" href="#/ultravisor/{~D:Record.IDUltravisorInstance~}/add-auth-beacon">Add auth beacon</a>
</div>`
		},
		{
			Hash: 'Lab-Ultravisor-NeedsBootstrap-Template',
			Template: /*html*/`<div class="lab-uv-security-actions">
	<span class="lab-uv-security-hint">Auth beacon connected — bootstrap the first admin to finish setup.</span>
	<a class="lab-btn small {~D:Record.ButtonDisabled~}" href="#/ultravisor/{~D:Record.IDUltravisorInstance~}/bootstrap-admin">Bootstrap admin</a>
</div>`
		},
		{
			Hash: 'Lab-Ultravisor-SecureReady-Template',
			Template: /*html*/`<div class="lab-uv-security-actions">
	<span class="lab-uv-security-hint">Secure environment is ready. Sign in via the Ultravisor UI to manage users.</span>
</div>`
		},
		{
			Hash: 'Lab-Ultravisor-BeaconSummaryNone-Template',
			Template: /*html*/`<span style="color:#64748b;">none</span>`
		},
		{
			// One per paired beacon. Each record carries either a Link
			// or a Plain slot (single-element-array) to control the link
			// vs. plain-text rendering. The Separator field is "" on the
			// last item to suppress the trailing comma.
			Hash: 'Lab-Ultravisor-BeaconSummaryItem-Template',
			Template: /*html*/`{~TS:Lab-Ultravisor-BeaconSummaryLink-Template:Record.LinkSlot~}{~TS:Lab-Ultravisor-BeaconSummaryPlain-Template:Record.PlainSlot~}{~D:Record.Separator~}`
		},
		{
			Hash: 'Lab-Ultravisor-BeaconSummaryLink-Template',
			Template: /*html*/`<a href="http://127.0.0.1:{~D:Record.Port~}/" target="_blank">{~D:Record.Label~} ↗</a>`
		},
		{
			Hash: 'Lab-Ultravisor-BeaconSummaryPlain-Template',
			Template: /*html*/`{~D:Record.Label~}`
		}
	],

	Renderables:
	[
		{
			RenderableHash:            'Lab-Ultravisor-Main',
			TemplateHash:              'Lab-Ultravisor-Main-Template',
			ContentDestinationAddress: '#Lab-Content-Container'
		},
		{
			RenderableHash:            'Lab-Ultravisor-List',
			TemplateHash:              'Lab-Ultravisor-List-Template',
			ContentDestinationAddress: '#Lab-Ultravisor-ListSlot'
		},
		{
			RenderableHash:            'Lab-Ultravisor-Form',
			TemplateHash:              'Lab-Ultravisor-Form-Template',
			ContentDestinationAddress: '#Lab-Ultravisor-FormSlot'
		}
	]
};

class LabUltravisorView extends libPictView
{
	constructor(pFable, pOptions, pServiceHash)
	{
		super(pFable, pOptions, pServiceHash);
	}

	onBeforeRender(pRenderable)
	{
		if (!this.pict.AppData.Lab.Ultravisor) { this.pict.AppData.Lab.Ultravisor = {}; }
		if (!this.pict.AppData.Lab.Computed) { this.pict.AppData.Lab.Computed = {}; }
		let tmpState = this.pict.AppData.Lab.Ultravisor;

		this.pict.AppData.Lab.Computed.Ultravisor =
		{
			FormButtonLabel: tmpState.FormOpen ? 'Close form' : '+ Add Ultravisor',
			FormSlot:        tmpState.FormOpen ? [this._buildFormRecord(tmpState)] : [],
			Rows:            this._buildRows(tmpState),
			EmptySlot:       ((tmpState.Instances || []).length === 0) ? [{}] : []
		};

		return super.onBeforeRender(pRenderable);
	}

	onAfterRender(pRenderable, pAddress, pRecord, pContent)
	{
		let tmpHash = pRenderable && pRenderable.RenderableHash;
		if (tmpHash === 'Lab-Ultravisor-Main' || !tmpHash)
		{
			this.render('Lab-Ultravisor-List');
			this.render('Lab-Ultravisor-Form');
		}
		this.pict.CSSMap.injectCSS();
		return super.onAfterRender(pRenderable, pAddress, pRecord, pContent);
	}

	// ====================================================================
	// Computed-record builders
	// ====================================================================

	_buildFormRecord(pState)
	{
		let tmpForm = pState.Form || {};
		return {
			Name:          this._escape(tmpForm.Name || ''),
			Port:          tmpForm.Port || 0,
			SecureChecked: tmpForm.Secure ? 'checked' : '',
			Error:         this._escape(tmpForm.Error || '')
		};
	}

	_buildRows(pState)
	{
		let tmpInstances = pState.Instances || [];
		if (tmpInstances.length === 0) { return []; }

		let tmpAllBeacons = (this.pict.AppData.Lab.Beacons && this.pict.AppData.Lab.Beacons.Beacons) || [];

		return tmpInstances.map((pUv) =>
		{
			let tmpPaired = tmpAllBeacons.filter((pB) => pB.IDUltravisorInstance === pUv.IDUltravisorInstance);
			let tmpRunning = (pUv.Status === 'running');

			return {
				IDUltravisorInstance: pUv.IDUltravisorInstance,
				Name:                 this._escape(pUv.Name),
				Status:               pUv.Status,
				Port:                 pUv.Port,
				PID:                  pUv.PID || '--',
				StartDisabled:        (pUv.Status === 'running' || pUv.Status === 'starting' || pUv.Status === 'provisioning') ? 'disabled' : '',
				StopDisabled:         tmpRunning ? '' : 'disabled',
				StatusDetailSlot:     pUv.StatusDetail
					? [{ StatusDetail: this._escape(pUv.StatusDetail) }]
					: [],

				// Secure-mode badges (one of three slots is non-empty)
				SecureBadgePendingSlot:      (pUv.Secure && !pUv.Bootstrapped) ? [{}] : [],
				SecureBadgeBootstrappedSlot: (pUv.Secure && pUv.Bootstrapped)  ? [{}] : [],

				// Secure-mode action rows — one of the three is populated
				// when Secure=true, all empty otherwise.
				...this._secureActionSlots(pUv, tmpPaired, tmpRunning),

				// Persistence row (always rendered; the inner template
				// reads the Persistence sub-record).
				Persistence:          this._persistenceRecord(pUv, tmpRunning),

				// Beacon summary list — either populated or with a single
				// "none" placeholder slot.
				BeaconSummaryItems:    this._beaconSummaryItems(tmpPaired),
				BeaconSummaryNoneSlot: tmpPaired.length === 0 ? [{}] : []
			};
		});
	}

	_secureActionSlots(pUv, pPaired, pRunning)
	{
		if (!pUv.Secure)
		{
			return { NeedsAuthBeaconSlot: [], NeedsBootstrapSlot: [], SecureReadySlot: [] };
		}
		let tmpHasAuth = (pPaired || []).some((pB) => pB.BeaconType === 'ultravisor-auth-beacon');
		let tmpDisabled = pRunning ? '' : 'disabled';
		let tmpRecord = { IDUltravisorInstance: pUv.IDUltravisorInstance, ButtonDisabled: tmpDisabled };

		if (!tmpHasAuth)
		{
			return { NeedsAuthBeaconSlot: [tmpRecord], NeedsBootstrapSlot: [], SecureReadySlot: [] };
		}
		if (!pUv.Bootstrapped)
		{
			return { NeedsAuthBeaconSlot: [], NeedsBootstrapSlot: [tmpRecord], SecureReadySlot: [] };
		}
		return { NeedsAuthBeaconSlot: [], NeedsBootstrapSlot: [], SecureReadySlot: [{}] };
	}

	_persistenceRecord(pUv, pRunning)
	{
		let tmpPersistence = pUv.Persistence || { State: 'unassigned' };
		let tmpState = tmpPersistence.State || 'unassigned';
		let tmpLabel;
		switch (tmpState)
		{
			case 'unassigned':         tmpLabel = 'unassigned'; break;
			case 'waiting-for-beacon': tmpLabel = 'waiting for beacon'; break;
			case 'bootstrapping':      tmpLabel = 'bootstrapping…'; break;
			case 'bootstrapped':       tmpLabel = 'bootstrapped'; break;
			case 'error':              tmpLabel = 'error'; break;
			default:                   tmpLabel = tmpState;
		}
		let tmpHint;
		let tmpBeacon = tmpPersistence.BeaconRecord;
		if (tmpState === 'unassigned')
		{
			tmpHint = 'No persistence beacon — queue + manifest stay in-process.';
		}
		else if (tmpBeacon && tmpBeacon.Name)
		{
			tmpHint = 'Routed to ' + tmpBeacon.Name + ' (connection ' + (tmpPersistence.IDPersistenceConnection || 0) + ').';
		}
		else
		{
			tmpHint = 'Beacon ID ' + (tmpPersistence.IDPersistenceBeacon || 0) + ' (no record).';
		}
		return {
			State:           tmpState,
			Label:           tmpLabel,
			Tooltip:         (tmpState === 'error' && tmpPersistence.LastError) ? this._escape(tmpPersistence.LastError) : '',
			Hint:            this._escape(tmpHint),
			ButtonLabel:     (tmpState === 'unassigned') ? 'Assign persistence' : 'Change persistence',
			ButtonDisabled:  pRunning ? '' : 'disabled'
		};
	}

	_beaconSummaryItems(pPaired)
	{
		return pPaired.map((pB, pIdx) =>
		{
			let tmpLabel = `${this._escape(pB.Name)} (${this._escape(pB.BeaconType)}, ${pB.Status})`;
			let tmpRecord = { Label: tmpLabel, Port: pB.Port };
			let tmpIsLink = (pB.Status === 'running');
			return {
				LinkSlot:  tmpIsLink ? [tmpRecord] : [],
				PlainSlot: tmpIsLink ? [] : [tmpRecord],
				Separator: (pIdx < pPaired.length - 1) ? ', ' : ''
			};
		});
	}

	_escape(pStr)
	{
		return String(pStr == null ? '' : pStr)
			.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
	}
}

module.exports = LabUltravisorView;
module.exports.default_configuration = _ViewConfiguration;
