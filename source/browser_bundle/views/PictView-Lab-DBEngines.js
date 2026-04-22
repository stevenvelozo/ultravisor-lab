/**
 * PictView-Lab-DBEngines
 *
 * Manages docker-backed DB engine cards.  Reads from
 * `AppData.Lab.DBEngines` (filled by the app's refreshAll loop) and
 * renders:
 *   - an "Add Engine" button + collapsible form
 *   - per-engine cards with status, credentials, databases, and actions
 *
 * All mutations round-trip through the LabApi provider so the server is
 * the source of truth -- this view is purely presentational.
 */
'use strict';

const libPictView = require('pict-view');

const _ViewConfiguration =
{
	ViewIdentifier:            'Lab-DBEngines',
	DefaultRenderable:         'Lab-DBEngines-Main',
	DefaultDestinationAddress: '#Lab-Content-Container',

	AutoRender: false,

	CSS: /*css*/`
.lab-engines { padding: 20px; display: flex; flex-direction: column; gap: 16px; }
.lab-engines-toolbar { display: flex; align-items: center; justify-content: space-between; }
.lab-engines-toolbar h2 { margin: 0; font-size: 16px; color: #0f172a; }
.lab-btn
{
	background: #1d4ed8;
	color: #fff;
	border: 1px solid #1d4ed8;
	border-radius: 6px;
	padding: 6px 14px;
	font-size: 13px;
	font-weight: 500;
	cursor: pointer;
}
/* When rendered as an anchor (navigateTo replaced by href) the same class
   should still look like a button. */
a.lab-btn { text-decoration: none; display: inline-flex; align-items: center; justify-content: center; }
.lab-btn:hover { background: #1e40af; border-color: #1e40af; }
.lab-btn.secondary
{
	background: transparent;
	color: #0f172a;
	border: 1px solid #cbd5e1;
}
.lab-btn.secondary:hover { background: #f1f5f9; border-color: #94a3b8; }
.lab-btn.danger
{
	background: transparent;
	color: #b91c1c;
	border: 1px solid #fecaca;
}
.lab-btn.danger:hover { background: #fef2f2; border-color: #f87171; }
.lab-btn.small { padding: 4px 10px; font-size: 12px; }
.lab-btn:disabled,
.lab-btn.disabled { opacity: 0.5; cursor: not-allowed; pointer-events: none; }

.lab-engine-form
{
	background: #fff;
	border: 1px solid #cbd5e1;
	border-radius: 8px;
	padding: 18px;
	display: grid;
	grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
	gap: 12px 16px;
	align-items: start;
}
.lab-engine-form label
{
	display: flex;
	flex-direction: column;
	gap: 4px;
	font-size: 12px;
	font-weight: 600;
	color: #475569;
	text-transform: uppercase;
	letter-spacing: 0.3px;
}
.lab-engine-form input, .lab-engine-form select
{
	font-family: inherit;
	font-size: 14px;
	padding: 7px 10px;
	border: 1px solid #cbd5e1;
	border-radius: 6px;
	background: #fff;
	color: #0f172a;
	box-sizing: border-box;
	height: 36px;
	line-height: 1.2;
}
.lab-engine-form input:focus, .lab-engine-form select:focus
{
	outline: none;
	border-color: #3b82f6;
	box-shadow: 0 0 0 3px rgba(59,130,246,0.2);
}
.lab-engine-form .lab-engine-form-actions
{
	display: flex;
	gap: 8px;
	justify-content: flex-end;
	grid-column: 1 / -1;
}
.lab-engine-form-error
{
	grid-column: 1 / -1;
	color: #b91c1c;
	font-size: 13px;
}

.lab-engine-card
{
	background: #fff;
	border: 1px solid #e2e8f0;
	border-radius: 8px;
	padding: 16px 18px;
	box-shadow: 0 1px 2px rgba(15,23,42,0.04);
	display: flex;
	flex-direction: column;
	gap: 12px;
}
.lab-engine-card-header { display: flex; align-items: center; gap: 12px; }
.lab-engine-card-header h3 { margin: 0; font-size: 15px; color: #0f172a; }
.lab-engine-type-badge
{
	font-size: 11px;
	text-transform: uppercase;
	letter-spacing: 0.3px;
	padding: 2px 8px;
	border-radius: 10px;
	background: #dbeafe;
	color: #1e40af;
	font-weight: 600;
}
.lab-engine-type-badge.mysql    { background: #fef3c7; color: #92400e; }
.lab-engine-type-badge.mssql    { background: #dcfce7; color: #166534; }
.lab-engine-type-badge.postgres { background: #dbeafe; color: #1e3a8a; }
.lab-engine-type-badge.mongodb  { background: #ecfccb; color: #3f6212; }
.lab-engine-type-badge.solr     { background: #fee2e2; color: #991b1b; }
.lab-engine-type-badge.dgraph   { background: #f3e8ff; color: #6b21a8; }
.lab-engine-status
{
	font-size: 11px;
	text-transform: uppercase;
	letter-spacing: 0.3px;
	padding: 2px 8px;
	border-radius: 10px;
	font-weight: 600;
}
.lab-engine-status.running       { background: #dcfce7; color: #166534; }
.lab-engine-status.stopped       { background: #e2e8f0; color: #475569; }
.lab-engine-status.provisioning,
.lab-engine-status.starting      { background: #fef3c7; color: #92400e; }
.lab-engine-status.stopping      { background: #fef3c7; color: #92400e; }
.lab-engine-status.failed,
.lab-engine-status.missing       { background: #fee2e2; color: #991b1b; }
.lab-engine-actions { margin-left: auto; display: flex; gap: 8px; }

.lab-engine-details
{
	display: grid;
	grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
	gap: 10px 20px;
	background: #f8fafc;
	padding: 10px 14px;
	border-radius: 6px;
	font-size: 13px;
}
.lab-engine-details .label
{
	font-size: 11px;
	text-transform: uppercase;
	letter-spacing: 0.3px;
	color: #64748b;
	font-weight: 600;
	margin-bottom: 2px;
}
.lab-engine-details code
{
	background: none;
	padding: 0;
	color: #0f172a;
	font-size: 13px;
}
.lab-engine-details .secret { display: flex; align-items: center; gap: 8px; }
.lab-engine-conn { font-family: "SF Mono", Menlo, monospace; font-size: 12.5px; word-break: break-all; }

.lab-engine-status-detail { font-size: 12px; color: #92400e; font-style: italic; }

.lab-engine-databases
{
	border-top: 1px solid #f1f5f9;
	padding-top: 12px;
	display: flex;
	flex-direction: column;
	gap: 8px;
}
.lab-engine-databases h4
{
	margin: 0;
	font-size: 12px;
	color: #475569;
	font-weight: 600;
	text-transform: uppercase;
	letter-spacing: 0.3px;
}
.lab-engine-database-row
{
	display: flex;
	align-items: center;
	gap: 8px;
	padding: 6px 10px;
	background: #f8fafc;
	border-radius: 6px;
	font-size: 13px;
}
.lab-engine-database-row code { flex: 1; background: none; padding: 0; color: #0f172a; }
.lab-engine-database-form
{
	display: flex;
	gap: 8px;
	align-items: center;
}
.lab-engine-database-form input
{
	flex: 1;
	font-family: inherit;
	font-size: 13px;
	padding: 6px 10px;
	border: 1px solid #cbd5e1;
	border-radius: 6px;
}
.lab-engines-empty
{
	padding: 32px 20px;
	text-align: center;
	color: #64748b;
	background: #fff;
	border: 1px dashed #cbd5e1;
	border-radius: 8px;
}
`,

	Templates:
	[
		{
			Hash: 'Lab-DBEngines-Main-Template',
			Template: /*html*/`
<div class="lab-engines">
	<div class="lab-engines-toolbar">
		<h2>DB Engines</h2>
		<a class="lab-btn" href="#/dbengines/form/toggle">{~D:AppData.Lab.DBEngines.FormButtonLabel~}</a>
	</div>
	<div id="Lab-Engines-FormSlot"></div>
	<div id="Lab-Engines-ListSlot"></div>
</div>`
		},
		{
			Hash: 'Lab-DBEngines-List-Template',
			Template: /*html*/`{~D:AppData.Lab.DBEngines.ListHTML~}`
		},
		{
			Hash: 'Lab-DBEngines-Form-Template',
			Template: /*html*/`{~D:AppData.Lab.DBEngines.FormHTML~}`
		},

		{
			Hash: 'Lab-DBEngines-FormBody-Template',
			Template: /*html*/`
<div class="lab-engine-form">
	<label>Name
		<input type="text" id="Lab-EngineForm-Name" placeholder="e.g. warehouse-mysql" value="{~D:Record.Name~}">
	</label>
	<label>Engine
		<select id="Lab-EngineForm-Type">{~D:Record.EngineTypeOptionsHTML~}</select>
	</label>
	<label>Host port
		<input type="number" id="Lab-EngineForm-Port" value="{~D:Record.Port~}" min="1" max="65535">
	</label>
	<label>Root password (blank = auto-generate)
		<input type="text" id="Lab-EngineForm-Password" placeholder="auto" value="{~D:Record.Password~}">
	</label>
	<div class="lab-engine-form-actions">
		<a class="lab-btn secondary" href="#/dbengines/form/suggest-port">↻ Suggest port</a>
		<a class="lab-btn secondary" href="#/dbengines/form/toggle">Cancel</a>
		<a class="lab-btn" href="#/dbengines/submit">Create engine</a>
	</div>
	<div class="lab-engine-form-error" id="Lab-EngineForm-Error">{~D:Record.Error~}</div>
</div>`
		},

		{
			Hash: 'Lab-DBEngines-Empty-Template',
			Template: /*html*/`
<div class="lab-engines-empty">No DB engines yet.  Click "Add DB Engine" above to provision one.</div>`
		},

		{
			Hash: 'Lab-DBEngines-Card-Template',
			Template: /*html*/`
<div class="lab-engine-card">
	<div class="lab-engine-card-header">
		<h3>{~D:Record.Name~}</h3>
		<span class="lab-engine-type-badge {~D:Record.EngineType~}">{~D:Record.EngineTypeDisplay~}</span>
		<span class="lab-engine-status {~D:Record.Status~}">{~D:Record.Status~}</span>
		<div class="lab-engine-actions">
			<a class="lab-btn secondary small {~D:Record.StartDisabled~}" href="#/dbengines/{~D:Record.IDDBEngine~}/start">Start</a>
			<a class="lab-btn secondary small {~D:Record.StopDisabled~}"  href="#/dbengines/{~D:Record.IDDBEngine~}/stop">Stop</a>
			<a class="lab-btn secondary small" href="#/dbengines/{~D:Record.IDDBEngine~}/logs">Logs</a>
			<a class="lab-btn danger small" href="#/dbengines/{~D:Record.IDDBEngine~}/remove">Remove</a>
		</div>
	</div>
	<div class="lab-engine-status-detail" style="display: {~D:Record.DetailDisplay~};">{~D:Record.StatusDetail~}</div>
	<div class="lab-engine-details">
		<div>
			<div class="label">Host / port</div>
			<code>127.0.0.1:{~D:Record.Port~}</code>
		</div>
		<div>
			<div class="label">Username</div>
			<code>{~D:Record.RootUsername~}</code>
		</div>
		<div>
			<div class="label">Password</div>
			<div class="secret">
				<code>{~D:Record.PasswordDisplay~}</code>
				<a class="lab-btn secondary small" href="#/dbengines/{~D:Record.IDDBEngine~}/reveal">{~D:Record.RevealLabel~}</a>
				<a class="lab-btn secondary small" href="#/dbengines/{~D:Record.IDDBEngine~}/copy-password" title="Copy password to clipboard">Copy</a>
			</div>
		</div>
		<div style="grid-column: 1 / -1;">
			<div class="label">Connection string</div>
			<code class="lab-engine-conn">{~D:Record.ConnectionDisplay~}</code>
		</div>
	</div>
	<div class="lab-engine-databases">
		<h4>{~D:Record.NounPluralUpper~} ({~D:Record.DatabaseCount~})</h4>
		<div id="Lab-Engine-{~D:Record.IDDBEngine~}-Databases">{~D:Record.DatabaseRowsHTML~}</div>
		<div class="lab-engine-database-form" style="display: {~D:Record.DatabaseFormDisplay~};">
			<input type="text" placeholder="new {~D:Record.NounSingular~} name" id="Lab-Engine-{~D:Record.IDDBEngine~}-NewDB">
			<a class="lab-btn secondary small {~D:Record.CreateDBDisabled~}" href="#/dbengines/{~D:Record.IDDBEngine~}/databases/create">+ {~D:Record.NounSingularUpper~}</a>
		</div>
	</div>
</div>`
		},

		{
			Hash: 'Lab-DBEngines-DatabaseRow-Template',
			Template: /*html*/`
<div class="lab-engine-database-row">
	<code>{~D:Record.Name~}</code>
	<a class="lab-btn danger small" href="#/dbengines/{~D:Record.IDDBEngine~}/databases/{~D:Record.IDDatabase~}/drop">Drop</a>
</div>`
		}
	],

	Renderables:
	[
		{
			RenderableHash:            'Lab-DBEngines-Main',
			TemplateHash:              'Lab-DBEngines-Main-Template',
			ContentDestinationAddress: '#Lab-Content-Container'
		},
		{
			RenderableHash:            'Lab-DBEngines-List',
			TemplateHash:              'Lab-DBEngines-List-Template',
			ContentDestinationAddress: '#Lab-Engines-ListSlot'
		},
		{
			RenderableHash:            'Lab-DBEngines-Form',
			TemplateHash:              'Lab-DBEngines-Form-Template',
			ContentDestinationAddress: '#Lab-Engines-FormSlot'
		}
	]
};

class LabDBEnginesView extends libPictView
{
	constructor(pFable, pOptions, pServiceHash)
	{
		super(pFable, pOptions, pServiceHash);
	}

	onBeforeRender(pRenderable)
	{
		if (!this.pict.AppData.Lab.DBEngines) { this.pict.AppData.Lab.DBEngines = {}; }
		let tmpState = this.pict.AppData.Lab.DBEngines;
		let tmpHash = pRenderable && pRenderable.RenderableHash;

		if (tmpHash === 'Lab-DBEngines-Main' || !tmpHash)
		{
			tmpState.FormButtonLabel = tmpState.FormOpen ? 'Close form' : '+ Add DB Engine';
		}
		if (tmpHash === 'Lab-DBEngines-List' || tmpHash === 'Lab-DBEngines-Main' || !tmpHash)
		{
			tmpState.ListHTML = this._buildListHTML(tmpState);
		}
		if (tmpHash === 'Lab-DBEngines-Form' || tmpHash === 'Lab-DBEngines-Main' || !tmpHash)
		{
			tmpState.FormHTML = tmpState.FormOpen ? this._buildFormHTML(tmpState) : '';
		}

		return super.onBeforeRender(pRenderable);
	}

	onAfterRender(pRenderable, pAddress, pRecord, pContent)
	{
		let tmpHash = pRenderable && pRenderable.RenderableHash;
		// After the shell paints, fan out into the List + Form renderables so
		// subsequent poll-only updates can target just the list slot.
		if (tmpHash === 'Lab-DBEngines-Main' || !tmpHash)
		{
			this.render('Lab-DBEngines-List');
			this.render('Lab-DBEngines-Form');
		}
		this.pict.CSSMap.injectCSS();
		return super.onAfterRender(pRenderable, pAddress, pRecord, pContent);
	}

	_buildFormHTML(pState)
	{
		// Build the <option>s for the engine type dropdown from the fetched
		// registry.  Selection reflects AppData.Form.EngineType at open time.
		let tmpForm = pState.Form || {};
		let tmpTypes = pState.EngineTypes || [];
		let tmpOptionsHtml = '';
		for (let i = 0; i < tmpTypes.length; i++)
		{
			let tmpType = tmpTypes[i];
			let tmpSelected = (tmpForm.EngineType === tmpType.EngineType) ? ' selected' : '';
			tmpOptionsHtml += `<option value="${tmpType.EngineType}" data-default-port="${tmpType.DefaultPort}"${tmpSelected}>${this._escape(tmpType.DisplayName)}</option>`;
		}

		return this.pict.parseTemplateByHash('Lab-DBEngines-FormBody-Template',
			{
				Name:                  this._escape(tmpForm.Name || ''),
				Port:                  tmpForm.Port || 0,
				Password:              this._escape(tmpForm.Password || ''),
				EngineTypeOptionsHTML: tmpOptionsHtml,
				Error:                 this._escape(tmpForm.Error || '')
			});
	}

	_buildListHTML(pState)
	{
		let tmpEngines = pState.Engines || [];
		if (tmpEngines.length === 0)
		{
			return this.pict.parseTemplateByHash('Lab-DBEngines-Empty-Template', {});
		}

		let tmpRevealed = pState.RevealedCredentials || {};
		let tmpDatabasesByEngine = pState.DatabasesByEngine || {};
		let tmpTypesByKey = this._engineTypesByKey(pState.EngineTypes || []);
		let tmpEngineTypeMetaByKey = this._engineTypeMetaByKey(pState.EngineTypes || []);

		let tmpCardsHtml = '';
		for (let i = 0; i < tmpEngines.length; i++)
		{
			let tmpEngine = tmpEngines[i];
			let tmpDatabases = tmpDatabasesByEngine[tmpEngine.IDDBEngine] || [];
			let tmpIsRevealed = !!tmpRevealed[tmpEngine.IDDBEngine];

			let tmpRows = '';
			for (let j = 0; j < tmpDatabases.length; j++)
			{
				tmpRows += this.pict.parseTemplateByHash('Lab-DBEngines-DatabaseRow-Template',
					{
						IDDBEngine: tmpEngine.IDDBEngine,
						IDDatabase: tmpDatabases[j].IDDatabase,
						Name:       this._escape(tmpDatabases[j].Name)
					});
			}
			if (tmpDatabases.length === 0)
			{
				tmpRows = '<div style="font-size:12px;color:#64748b;padding:4px 0;">No databases yet.</div>';
			}

			let tmpMeta = tmpEngineTypeMetaByKey[tmpEngine.EngineType] || { DatabaseNoun: 'database', SupportsMultipleDatabases: true };
			let tmpNounSingular = tmpMeta.DatabaseNoun || 'database';
			let tmpNounPlural   = this._pluralize(tmpNounSingular);

			tmpCardsHtml += this.pict.parseTemplateByHash('Lab-DBEngines-Card-Template',
				{
					IDDBEngine:            tmpEngine.IDDBEngine,
					Name:                  this._escape(tmpEngine.Name),
					EngineType:            tmpEngine.EngineType,
					EngineTypeDisplay:     tmpTypesByKey[tmpEngine.EngineType] || tmpEngine.EngineType,
					Status:                tmpEngine.Status,
					StatusDetail:          this._escape(tmpEngine.StatusDetail || ''),
					DetailDisplay:         tmpEngine.StatusDetail ? 'block' : 'none',
					Port:                  tmpEngine.Port,
					RootUsername:          this._escape(tmpEngine.RootUsername),
					PasswordDisplay:       tmpIsRevealed ? this._escape(tmpEngine.RootPassword) : '••••••••',
					RevealLabel:           tmpIsRevealed ? 'Hide' : 'Reveal',
					ConnectionDisplay:     this._connectionString(tmpEngine, tmpIsRevealed),
					DatabaseCount:         tmpDatabases.length,
					DatabaseRowsHTML:      tmpRows,
					StartDisabled:         (tmpEngine.Status === 'running' || tmpEngine.Status === 'starting' || tmpEngine.Status === 'provisioning') ? 'disabled' : '',
					StopDisabled:          (tmpEngine.Status !== 'running') ? 'disabled' : '',
					CreateDBDisabled:      (tmpEngine.Status !== 'running') ? 'disabled' : '',
					NounSingular:          tmpNounSingular,
					NounSingularUpper:     this._capitalize(tmpNounSingular),
					NounPluralUpper:       this._capitalize(tmpNounPlural),
					DatabaseFormDisplay:   tmpMeta.SupportsMultipleDatabases ? 'flex' : 'none'
				});
		}
		return tmpCardsHtml;
	}

	_connectionString(pEngine, pRevealed)
	{
		let tmpPassword = pRevealed ? pEngine.RootPassword : '••••••••';
		switch (pEngine.EngineType)
		{
			case 'mysql':    return this._escape(`mysql://${pEngine.RootUsername}:${tmpPassword}@127.0.0.1:${pEngine.Port}`);
			case 'postgres': return this._escape(`postgres://${pEngine.RootUsername}:${tmpPassword}@127.0.0.1:${pEngine.Port}/postgres`);
			case 'mssql':    return this._escape(`sqlserver://${pEngine.RootUsername}:${tmpPassword}@127.0.0.1:${pEngine.Port}`);
			case 'mongodb':  return this._escape(`mongodb://${pEngine.RootUsername}:${tmpPassword}@127.0.0.1:${pEngine.Port}/?authSource=admin`);
			case 'solr':     return this._escape(`http://127.0.0.1:${pEngine.Port}/solr/`);
			case 'dgraph':   return this._escape(`dgraph://127.0.0.1:${pEngine.Port} (HTTP) / 127.0.0.1:9080 (gRPC)`);
			default:         return this._escape(`${pEngine.EngineType}://127.0.0.1:${pEngine.Port}`);
		}
	}

	_engineTypesByKey(pTypes)
	{
		let tmpMap = {};
		for (let i = 0; i < pTypes.length; i++) { tmpMap[pTypes[i].EngineType] = pTypes[i].DisplayName; }
		return tmpMap;
	}

	_engineTypeMetaByKey(pTypes)
	{
		let tmpMap = {};
		for (let i = 0; i < pTypes.length; i++) { tmpMap[pTypes[i].EngineType] = pTypes[i]; }
		return tmpMap;
	}

	_capitalize(pStr)
	{
		let tmpStr = String(pStr || '');
		return tmpStr.charAt(0).toUpperCase() + tmpStr.slice(1);
	}

	_pluralize(pNoun)
	{
		if (!pNoun) { return ''; }
		if (/s$/.test(pNoun)) { return pNoun; }
		if (/y$/.test(pNoun) && !/[aeiou]y$/.test(pNoun)) { return pNoun.slice(0, -1) + 'ies'; }
		return pNoun + 's';
	}

	_escape(pStr)
	{
		return String(pStr == null ? '' : pStr)
			.replace(/&/g, '&amp;')
			.replace(/</g, '&lt;')
			.replace(/>/g, '&gt;')
			.replace(/"/g, '&quot;');
	}
}

module.exports = LabDBEnginesView;
module.exports.default_configuration = _ViewConfiguration;
