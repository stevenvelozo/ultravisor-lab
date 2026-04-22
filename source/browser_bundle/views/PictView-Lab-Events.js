/**
 * PictView-Lab-Events
 *
 * Timeline of InfrastructureEvent rows, newest first.  Severity drives row
 * color.  Phase 1 shows the boot event + any drift detections.
 */
'use strict';

const libPictView = require('pict-view');

const _ViewConfiguration =
{
	ViewIdentifier:            'Lab-Events',
	DefaultRenderable:         'Lab-Events-Main',
	DefaultDestinationAddress: '#Lab-Content-Container',

	AutoRender: false,

	CSS: /*css*/`
.lab-events { padding: 20px; }
.lab-events h2 { margin: 0 0 14px; font-size: 16px; color: #0f172a; }
.lab-events table
{
	width: 100%;
	border-collapse: collapse;
	background: #fff;
	border: 1px solid #e2e8f0;
	border-radius: 8px;
	overflow: hidden;
	font-size: 13px;
}
.lab-events th, .lab-events td
{
	padding: 10px 14px;
	text-align: left;
	border-bottom: 1px solid #f1f5f9;
	vertical-align: top;
}
.lab-events th { background: #f8fafc; color: #475569; font-weight: 600; font-size: 12px; text-transform: uppercase; letter-spacing: 0.3px; }
.lab-events tr:last-child td { border-bottom: none; }
.lab-events .sev-info    { color: #1e40af; }
.lab-events .sev-warning { color: #b45309; }
.lab-events .sev-error   { color: #b91c1c; }
.lab-events-log-link
{
	color: #1d4ed8;
	text-decoration: none;
	border-bottom: 1px dashed #93c5fd;
}
.lab-events-log-link:hover { color: #1e40af; border-bottom-color: #1e40af; }
.lab-events .lab-events-empty
{
	padding: 40px;
	text-align: center;
	color: #64748b;
	font-size: 13px;
}
`,

	Templates:
	[
		{
			Hash: 'Lab-Events-Main-Template',
			Template: /*html*/`
<div class="lab-events">
	<h2>Infrastructure Events</h2>
	<div id="Lab-Events-List"></div>
</div>`
		},
		{
			Hash: 'Lab-Events-Table-Template',
			Template: /*html*/`
<table>
	<thead>
		<tr>
			<th style="width: 170px;">Time</th>
			<th style="width: 110px;">Severity</th>
			<th style="width: 160px;">Entity</th>
			<th style="width: 160px;">Type</th>
			<th>Message</th>
		</tr>
	</thead>
	<tbody id="Lab-Events-Body"></tbody>
</table>`
		},
		{
			Hash: 'Lab-Events-Row-Template',
			Template: /*html*/`
<tr>
	<td>{~D:Record.TimeLabel~}</td>
	<td class="sev-{~D:Record.Severity~}">{~D:Record.Severity~}</td>
	<td>{~D:Record.EntityLabel~}</td>
	<td>{~D:Record.EventType~}</td>
	<td>{~D:Record.Message~}</td>
</tr>`
		},
		{
			Hash: 'Lab-Events-Empty-Template',
			Template: /*html*/`
<div class="lab-events-empty">No events yet.</div>`
		}
	],

	Renderables:
	[
		{
			RenderableHash:            'Lab-Events-Main',
			TemplateHash:              'Lab-Events-Main-Template',
			ContentDestinationAddress: '#Lab-Content-Container'
		}
	]
};

class LabEventsView extends libPictView
{
	constructor(pFable, pOptions, pServiceHash)
	{
		super(pFable, pOptions, pServiceHash);
	}

	onAfterRender(pRenderable, pAddress, pRecord, pContent)
	{
		let tmpEvents = this.pict.AppData.Lab.Events || [];

		if (tmpEvents.length === 0)
		{
			let tmpEmpty = this.pict.parseTemplateByHash('Lab-Events-Empty-Template', {});
			this.pict.ContentAssignment.assignContent('#Lab-Events-List', tmpEmpty);
		}
		else
		{
			let tmpTable = this.pict.parseTemplateByHash('Lab-Events-Table-Template', {});
			this.pict.ContentAssignment.assignContent('#Lab-Events-List', tmpTable);

			let tmpRowsHtml = '';
			for (let i = 0; i < tmpEvents.length; i++)
			{
				let tmpEvt = tmpEvents[i];

				// Make the entity label a clickable log-viewer link when
				// we know how to resolve it.  Beacon + DBEngine both have
				// log routes; other entity types (System, etc.) render flat.
				let tmpText = tmpEvt.EntityName ? `${tmpEvt.EntityType}/${tmpEvt.EntityName}` : tmpEvt.EntityType;
				let tmpEntityLabel = this._escape(tmpText);
				let tmpLogHref = '';
				if (tmpEvt.EntityID)
				{
					if (tmpEvt.EntityType === 'Beacon')   { tmpLogHref = `#/beacons/${tmpEvt.EntityID}/logs`; }
					else if (tmpEvt.EntityType === 'DBEngine') { tmpLogHref = `#/dbengines/${tmpEvt.EntityID}/logs`; }
				}
				if (tmpLogHref)
				{
					tmpEntityLabel = `<a class="lab-events-log-link" href="${tmpLogHref}" title="Open logs">${this._escape(tmpText)}</a>`;
				}

				let tmpRecord =
				{
					TimeLabel:   this._formatTime(tmpEvt.Timestamp),
					Severity:    tmpEvt.Severity || 'info',
					EntityLabel: tmpEntityLabel,
					EventType:   tmpEvt.EventType,
					Message:     this._escape(tmpEvt.Message || '')
				};
				tmpRowsHtml += this.pict.parseTemplateByHash('Lab-Events-Row-Template', tmpRecord);
			}
			this.pict.ContentAssignment.assignContent('#Lab-Events-Body', tmpRowsHtml);
		}

		this.pict.CSSMap.injectCSS();
		return super.onAfterRender(pRenderable, pAddress, pRecord, pContent);
	}

	_formatTime(pTimestamp)
	{
		if (!pTimestamp) { return '--'; }
		// SQLite's datetime() emits "YYYY-MM-DD HH:MM:SS" which JS Date
		// accepts only with a T separator in strict mode.
		let tmpISO = pTimestamp.replace(' ', 'T') + 'Z';
		let tmpDate = new Date(tmpISO);
		if (isNaN(tmpDate.getTime())) { return pTimestamp; }
		return tmpDate.toLocaleString();
	}

	_escape(pStr)
	{
		return String(pStr)
			.replace(/&/g, '&amp;')
			.replace(/</g, '&lt;')
			.replace(/>/g, '&gt;')
			.replace(/"/g, '&quot;');
	}
}

module.exports = LabEventsView;
module.exports.default_configuration = _ViewConfiguration;
