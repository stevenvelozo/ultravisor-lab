/**
 * PictView-Lab-Ultravisor
 *
 * Manages supervised Ultravisor instances.  Each instance runs the lab's
 * `lab-ultravisor.js` which hosts the Ultravisor API only.  Beacons are
 * their own entity (see PictView-Lab-Beacons) registered with an
 * Ultravisor via their IDUltravisorInstance.
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
		<a class="lab-btn" href="#/ultravisor/form/toggle">{~D:AppData.Lab.Ultravisor.FormButtonLabel~}</a>
	</div>
	<div id="Lab-Ultravisor-FormSlot"></div>
	<div id="Lab-Ultravisor-ListSlot"></div>
</div>`
		},
		{
			Hash: 'Lab-Ultravisor-List-Template',
			Template: /*html*/`{~D:AppData.Lab.Ultravisor.ListHTML~}`
		},
		{
			Hash: 'Lab-Ultravisor-Form-Template',
			Template: /*html*/`{~D:AppData.Lab.Ultravisor.FormHTML~}`
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
			Template: /*html*/`
<div class="lab-uv-empty">No Ultravisor instances yet.  Start one to host seed-dataset operations.</div>`
		},
		{
			Hash: 'Lab-Ultravisor-Card-Template',
			Template: /*html*/`
<div class="lab-uv-card">
	<div class="lab-uv-card-header">
		<h3>{~D:Record.Name~}</h3>
		<span class="lab-uv-status {~D:Record.Status~}">{~D:Record.Status~}</span>
		{~D:Record.SecureBadgeHTML~}
		<div class="lab-uv-actions">
			<a class="lab-btn secondary small {~D:Record.StartDisabled~}" href="#/ultravisor/{~D:Record.IDUltravisorInstance~}/start">Start</a>
			<a class="lab-btn secondary small {~D:Record.StopDisabled~}"  href="#/ultravisor/{~D:Record.IDUltravisorInstance~}/stop">Stop</a>
			<a class="lab-btn danger small" href="#/ultravisor/{~D:Record.IDUltravisorInstance~}/remove">Remove</a>
		</div>
	</div>
	<div class="lab-uv-status-detail" style="display: {~D:Record.DetailDisplay~};">{~D:Record.StatusDetail~}</div>
	{~D:Record.SecurityActionsHTML~}
	{~D:Record.PersistenceRowHTML~}
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
			<div class="lab-uv-detail-value">{~D:Record.BeaconSummaryHTML~}</div>
		</div>
	</div>
</div>`
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
		let tmpState = this.pict.AppData.Lab.Ultravisor;
		let tmpHash = pRenderable && pRenderable.RenderableHash;

		if (tmpHash === 'Lab-Ultravisor-Main' || !tmpHash)
		{
			tmpState.FormButtonLabel = tmpState.FormOpen ? 'Close form' : '+ Add Ultravisor';
		}
		if (tmpHash === 'Lab-Ultravisor-List' || tmpHash === 'Lab-Ultravisor-Main' || !tmpHash)
		{
			tmpState.ListHTML = this._buildListHTML(tmpState);
		}
		if (tmpHash === 'Lab-Ultravisor-Form' || tmpHash === 'Lab-Ultravisor-Main' || !tmpHash)
		{
			tmpState.FormHTML = tmpState.FormOpen ? this._buildFormHTML(tmpState) : '';
		}

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

	_buildFormHTML(pState)
	{
		let tmpForm = pState.Form || {};
		return this.pict.parseTemplateByHash('Lab-Ultravisor-FormBody-Template',
			{
				Name:  this._escape(tmpForm.Name || ''),
				Port:  tmpForm.Port || 0,
				// `checked` only when truthy — the template injects this
				// value verbatim into the input attribute, so an empty
				// string keeps the checkbox unchecked without any extra
				// conditional rendering.
				SecureChecked: tmpForm.Secure ? 'checked' : '',
				Error: this._escape(tmpForm.Error || '')
			});
	}

	_buildListHTML(pState)
	{
		let tmpInstances = pState.Instances || [];
		if (tmpInstances.length === 0)
		{
			return this.pict.parseTemplateByHash('Lab-Ultravisor-Empty-Template', {});
		}

		let tmpAllBeacons = (this.pict.AppData.Lab.Beacons && this.pict.AppData.Lab.Beacons.Beacons) || [];
		let tmpHtml = '';
		for (let i = 0; i < tmpInstances.length; i++)
		{
			let tmpUv = tmpInstances[i];
			let tmpPaired = tmpAllBeacons.filter((pB) => pB.IDUltravisorInstance === tmpUv.IDUltravisorInstance);

			let tmpBeaconSummaryHtml;
			if (tmpPaired.length === 0)
			{
				tmpBeaconSummaryHtml = '<span style="color:#64748b;">none</span>';
			}
			else
			{
				tmpBeaconSummaryHtml = tmpPaired.map((pB) =>
					{
						let tmpLabel = `${this._escape(pB.Name)} (${this._escape(pB.BeaconType)}, ${pB.Status})`;
						if (pB.Status === 'running')
						{
							return `<a href="http://127.0.0.1:${pB.Port}/" target="_blank">${tmpLabel} ↗</a>`;
						}
						return tmpLabel;
					}).join(', ');
			}

			tmpHtml += this.pict.parseTemplateByHash('Lab-Ultravisor-Card-Template',
				{
					IDUltravisorInstance: tmpUv.IDUltravisorInstance,
					Name:              this._escape(tmpUv.Name),
					Status:            tmpUv.Status,
					StatusDetail:      this._escape(tmpUv.StatusDetail || ''),
					DetailDisplay:     tmpUv.StatusDetail ? 'block' : 'none',
					Port:              tmpUv.Port,
					PID:               tmpUv.PID || '--',
					BeaconSummaryHTML: tmpBeaconSummaryHtml,
					SecureBadgeHTML:    this._secureBadgeHTML(tmpUv),
					SecurityActionsHTML: this._securityActionsHTML(tmpUv, tmpPaired),
					PersistenceRowHTML: this._persistenceRowHTML(tmpUv),
					StartDisabled:     (tmpUv.Status === 'running' || tmpUv.Status === 'starting' || tmpUv.Status === 'provisioning') ? 'disabled' : '',
					StopDisabled:      (tmpUv.Status !== 'running') ? 'disabled' : ''
				});
		}
		return tmpHtml;
	}

	// ── Secure-mode card chrome ────────────────────────────────────────────
	//
	// The badge is a small read-only indicator next to the running/stopped
	// pill. Security actions live in their own row under the status detail
	// because they only show conditionally and would otherwise compete with
	// the existing Start/Stop/Remove cluster for visual real estate.

	_secureBadgeHTML(pUv)
	{
		if (!pUv.Secure) { return ''; }
		if (pUv.Bootstrapped)
		{
			return '<span class="lab-uv-secure-badge bootstrapped" title="Secure mode, admin bootstrapped">🔒 secure</span>';
		}
		return '<span class="lab-uv-secure-badge" title="Secure mode, awaiting admin bootstrap">🔒 secure (pending)</span>';
	}

	_securityActionsHTML(pUv, pPaired)
	{
		if (!pUv.Secure) { return ''; }

		// "Has auth beacon" is determined by checking the paired beacons
		// for one whose BeaconType matches the auth-beacon stanza. We
		// don't gate on Status here — even a 'failed' or 'starting' auth
		// beacon counts as "exists" so the operator doesn't accidentally
		// spawn two.
		let tmpHasAuth = (pPaired || []).some((pB) => pB.BeaconType === 'ultravisor-auth-beacon');

		// UV must be running before either action makes sense — both
		// require an HTTP roundtrip to the Ultravisor process.
		let tmpDisabled = (pUv.Status !== 'running') ? ' disabled' : '';

		let tmpInner = '';
		if (!tmpHasAuth)
		{
			tmpInner = ''
				+ '<span class="lab-uv-security-hint">No auth beacon yet — required to admit other beacons.</span>'
				+ `<a class="lab-btn small${tmpDisabled}" href="#/ultravisor/${pUv.IDUltravisorInstance}/add-auth-beacon">Add auth beacon</a>`;
		}
		else if (!pUv.Bootstrapped)
		{
			tmpInner = ''
				+ '<span class="lab-uv-security-hint">Auth beacon connected — bootstrap the first admin to finish setup.</span>'
				+ `<a class="lab-btn small${tmpDisabled}" href="#/ultravisor/${pUv.IDUltravisorInstance}/bootstrap-admin">Bootstrap admin</a>`;
		}
		else
		{
			tmpInner = '<span class="lab-uv-security-hint">Secure environment is ready. Sign in via the Ultravisor UI to manage users.</span>';
		}
		return '<div class="lab-uv-security-actions">' + tmpInner + '</div>';
	}

	// ── Persistence-beacon row (Session 3) ────────────────────────────
	//
	// One row per UV showing the assigned databeacon (if any) plus a
	// status pill that the lab's fast-poll keeps fresh. Always rendered
	// regardless of Secure mode; persistence is orthogonal to auth.

	_persistenceRowHTML(pUv)
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
		let tmpTitle = '';
		if (tmpState === 'error' && tmpPersistence.LastError)
		{
			tmpTitle = ' title="' + this._escape(tmpPersistence.LastError) + '"';
		}
		let tmpBeacon = tmpPersistence.BeaconRecord;
		let tmpHint;
		if (tmpState === 'unassigned')
		{
			tmpHint = '<span class="lab-uv-security-hint">No persistence beacon — queue + manifest stay in-process.</span>';
		}
		else if (tmpBeacon && tmpBeacon.Name)
		{
			tmpHint = '<span class="lab-uv-security-hint">Routed to <strong>'
				+ this._escape(tmpBeacon.Name) + '</strong> (connection ' + (tmpPersistence.IDPersistenceConnection || 0) + ').</span>';
		}
		else
		{
			tmpHint = '<span class="lab-uv-security-hint">Beacon ID ' + (tmpPersistence.IDPersistenceBeacon || 0) + ' (no record).</span>';
		}
		let tmpDisabled = (pUv.Status !== 'running') ? ' disabled' : '';
		let tmpButtonLabel = (tmpState === 'unassigned') ? 'Assign persistence' : 'Change persistence';
		return '<div class="lab-uv-persistence-row">'
			+ '<span class="lab-uv-persistence-pill ' + tmpState + '"' + tmpTitle + '>Persistence: ' + tmpLabel + '</span>'
			+ tmpHint
			+ '<a class="lab-btn small' + tmpDisabled + '" href="#/ultravisor/' + pUv.IDUltravisorInstance + '/set-persistence-beacon">'
			+ tmpButtonLabel + '</a>'
			+ '</div>';
	}

	_escape(pStr)
	{
		return String(pStr == null ? '' : pStr)
			.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
	}
}

module.exports = LabUltravisorView;
module.exports.default_configuration = _ViewConfiguration;
