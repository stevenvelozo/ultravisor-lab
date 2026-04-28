/**
 * PictView-Lab-Events
 *
 * Timeline of InfrastructureEvent rows, newest first.  Severity drives row
 * color.  Phase 1 shows the boot event + any drift detections.
 *
 * Events flow data-only through `AppData.Lab.Computed.Events`:
 *   - `Rows`: pre-shaped row records the table iterates via `{~TS:~}`.
 *   - `EmptySlot`: 1-element array when there are no events (drives the
 *     "No events yet" message); empty otherwise.
 *   - `TableSlot`: the inverse — populated when there are events.
 * No HTML construction in JS, no `assignContent` calls.
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
	{~TS:Lab-Events-Empty-Template:AppData.Lab.Computed.Events.EmptySlot~}
	{~TS:Lab-Events-Table-Template:AppData.Lab.Computed.Events.TableSlot~}
</div>`
		},
		{
			Hash: 'Lab-Events-Empty-Template',
			Template: /*html*/`<div class="lab-events-empty">No events yet.</div>`
		},
		{
			// Rendered once when there is at least one event. Hosts the
			// per-row TS so the rows iterate from AppData.
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
	<tbody>{~TS:Lab-Events-Row-Template:AppData.Lab.Computed.Events.Rows~}</tbody>
</table>`
		},
		{
			Hash: 'Lab-Events-Row-Template',
			Template: /*html*/`
<tr>
	<td>{~D:Record.TimeLabel~}</td>
	<td class="sev-{~D:Record.Severity~}">{~D:Record.Severity~}</td>
	<td>{~TS:Lab-Events-EntityLink-Template:Record.LinkSlot~}{~TS:Lab-Events-EntityText-Template:Record.PlainSlot~}</td>
	<td>{~D:Record.EventType~}</td>
	<td>{~D:Record.Message~}</td>
</tr>`
		},
		{
			// Single-row slot — populated when a log href is available.
			// Record fields: Href, Text.
			Hash: 'Lab-Events-EntityLink-Template',
			Template: /*html*/`<a class="lab-events-log-link" href="{~D:Record.Href~}" title="Open logs">{~D:Record.Text~}</a>`
		},
		{
			// Single-row slot — populated when no log href is available.
			Hash: 'Lab-Events-EntityText-Template',
			Template: /*html*/`{~D:Record.Text~}`
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

	onBeforeRender(pRenderable)
	{
		let tmpEvents = this.pict.AppData.Lab.Events || [];

		if (!this.pict.AppData.Lab.Computed) { this.pict.AppData.Lab.Computed = {}; }

		let tmpRows = tmpEvents.map((pEvt) =>
		{
			let tmpText = pEvt.EntityName ? `${pEvt.EntityType}/${pEvt.EntityName}` : pEvt.EntityType;
			let tmpHref = '';
			if (pEvt.EntityID)
			{
				if      (pEvt.EntityType === 'Beacon')   { tmpHref = `#/beacons/${pEvt.EntityID}/logs`; }
				else if (pEvt.EntityType === 'DBEngine') { tmpHref = `#/dbengines/${pEvt.EntityID}/logs`; }
			}
			let tmpEntity = { Href: tmpHref, Text: this._escape(tmpText) };
			return {
				TimeLabel: this._formatTime(pEvt.Timestamp),
				Severity:  pEvt.Severity || 'info',
				EventType: pEvt.EventType,
				Message:   this._escape(pEvt.Message || ''),
				LinkSlot:  tmpHref ? [tmpEntity] : [],
				PlainSlot: tmpHref ? []          : [tmpEntity]
			};
		});

		this.pict.AppData.Lab.Computed.Events =
		{
			Rows:      tmpRows,
			EmptySlot: tmpRows.length === 0 ? [{}] : [],
			TableSlot: tmpRows.length === 0 ? []   : [{}]
		};

		return super.onBeforeRender(pRenderable);
	}

	onAfterRender(pRenderable, pAddress, pRecord, pContent)
	{
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
