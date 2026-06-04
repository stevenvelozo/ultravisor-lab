#!/usr/bin/env node
/**
 * Bookstore Clone-to-Lake — one-shot stack seeder.
 *
 * Runs as the `seed-bookstore-clone` init container after the data-mapper +
 * customer/lake databeacons are healthy. It does NOT load the customer data
 * (that arrives pre-loaded via customer-mysql's init SQL — modelling a
 * customer's existing database). It wires up everything the clone needs and
 * then runs the clone, entirely through Ultravisor operations:
 *
 *   1. Wait for the data-mapper to be up and for its bootstrap to have
 *      provisioned the customer-main + lake-main connections.
 *   2. Introspect the customer connection and enable a read endpoint for
 *      each of the seven source tables (so PullRecords can read them).
 *   3. ensure-schema each lake RAW_<Table> archive table (created + endpoint
 *      enabled) — shape { Identity, RawJSON, RecordMD5, IngestedAt, SourceTable }.
 *   4. For each table register + run a clone operation graph on the UV:
 *        pull (customer/<Table>)
 *          → buildcomprehension (keyless rows keyed positionally record-N)
 *          → writerecordsraw (lake/RAW_<Table>, raw-archive rows)
 *      No source unique identifier is required; combinatorial duplicates land
 *      as distinct raw rows and RecordMD5 flags byte-for-byte copies.
 *
 * Talks to two REST surfaces: the data-mapper (/mapper/*) for schema +
 * endpoint admin, and the Ultravisor (/Operation, /Manifest) for the
 * operation register + run. Idempotent: re-runs upsert the operations and
 * re-enable endpoints (no-ops when already present).
 *
 * Built-in modules only (no npm install in the init container).
 *
 * @author Steven Velozo <steven@velozo.com>
 * @license MIT
 */
'use strict';

const libHttp = require('http');
const libUrl = require('url');

const MAPPER_BASE = process.env.MAPPER_BASE || 'http://retold-data-mapper:8395';
const UV_BASE     = process.env.UV_BASE     || 'http://ultravisor:54321';
const SCOPE       = process.env.SEED_SCOPE  || 'bookstore-clone';
const READY_RETRIES  = parseInt(process.env.SEED_RETRIES  || '90', 10);
const READY_DELAY_MS = parseInt(process.env.SEED_DELAY_MS || '2000', 10);
// Each clone is tiny (tens of rows) but rides the full mesh dispatch path;
// give every run a generous ceiling so a cold cache doesn't look wedged.
const RUN_TIMEOUT_MS = parseInt(process.env.SEED_RUN_TIMEOUT_MS || '300000', 10);
const RUN_POLL_MS    = parseInt(process.env.SEED_RUN_POLL_MS    || '2000', 10);

const CUSTOMER_BEACON = 'customer-databeacon';
const CUSTOMER_CONN   = 'customer-main';
const LAKE_BEACON     = 'lake-databeacon';
const LAKE_CONN       = 'lake-main';

// Source tables (string / combinatorial / keyless — see customer-init.sql).
const TABLES = ['City', 'Author', 'Bookstore', 'Book', 'Cashier', 'Price', 'Sale'];

// ── HTTP helper ─────────────────────────────────────────────────────

function request(pBase, pMethod, pPath, pBody, pTimeoutMs)
{
	let tmpUrl = libUrl.parse(pBase + pPath);
	let tmpData = pBody ? JSON.stringify(pBody) : '';
	let tmpHeaders = { 'Content-Type': 'application/json' };
	if (tmpData) tmpHeaders['Content-Length'] = Buffer.byteLength(tmpData);

	return new Promise((pResolve, pReject) =>
	{
		let tmpReq = libHttp.request(
			{
				hostname: tmpUrl.hostname,
				port:     tmpUrl.port,
				path:     tmpUrl.path,
				method:   pMethod,
				headers:  tmpHeaders
			},
			(pRes) =>
			{
				let tmpBuf = '';
				pRes.on('data', (pChunk) => { tmpBuf += pChunk; });
				pRes.on('end', () =>
				{
					let tmpJson = null;
					try { tmpJson = JSON.parse(tmpBuf); } catch (pErr) { /* not json */ }
					pResolve({ status: pRes.statusCode, body: (tmpJson !== null) ? tmpJson : tmpBuf });
				});
			});
		tmpReq.on('error', pReject);
		if (Number.isFinite(pTimeoutMs) && pTimeoutMs > 0)
		{
			tmpReq.setTimeout(pTimeoutMs, () =>
			{
				tmpReq.destroy(new Error('request timed out after ' + pTimeoutMs + 'ms: ' + pMethod + ' ' + pPath));
			});
		}
		if (tmpData) tmpReq.write(tmpData);
		tmpReq.end();
	});
}

function sleep(pMs) { return new Promise((pR) => setTimeout(pR, pMs)); }

// ── Readiness + connection resolution ───────────────────────────────

async function listConnections(pBeaconName)
{
	let tmpRes = await request(MAPPER_BASE, 'GET', '/mapper/beacon/' + encodeURIComponent(pBeaconName) + '/connections');
	if (tmpRes.status !== 200) return null;
	return (tmpRes.body && tmpRes.body.Connections) || [];
}

function findConnId(pConnections, pName)
{
	let tmpMatch = (pConnections || []).find((c) => c && c.Name === pName);
	return tmpMatch ? tmpMatch.IDBeaconConnection : 0;
}

async function waitForBootstrap()
{
	for (let i = 0; i < READY_RETRIES; i++)
	{
		try
		{
			let tmpCust = await listConnections(CUSTOMER_BEACON);
			let tmpLake = await listConnections(LAKE_BEACON);
			let tmpCustId = findConnId(tmpCust, CUSTOMER_CONN);
			let tmpLakeId = findConnId(tmpLake, LAKE_CONN);
			if (tmpCustId && tmpLakeId)
			{
				return { custConnId: tmpCustId, lakeConnId: tmpLakeId };
			}
			console.log('  waiting for bootstrap connections (customer=' + tmpCustId + ', lake=' + tmpLakeId + ')…');
		}
		catch (pErr)
		{
			console.log('  data-mapper unreachable (' + (pErr.code || pErr.message) + '), retrying…');
		}
		await sleep(READY_DELAY_MS);
	}
	throw new Error('data-mapper bootstrap connections (' + CUSTOMER_CONN + ' / ' + LAKE_CONN + ') did not appear within ' + (READY_RETRIES * READY_DELAY_MS / 1000) + 's');
}

// ── Customer endpoints (tables pre-loaded via init SQL) ──────────────

async function introspectAndEnableCustomer(pCustConnId)
{
	// Discover the pre-loaded tables on the customer connection.
	let tmpRes = await request(MAPPER_BASE, 'POST', '/mapper/beacon/' + encodeURIComponent(CUSTOMER_BEACON) + '/introspect',
		{ IDBeaconConnection: pCustConnId });
	if (tmpRes.status < 200 || tmpRes.status >= 300)
	{
		console.log('  ✗ introspect customer — HTTP ' + tmpRes.status + ': ' + JSON.stringify(tmpRes.body).slice(0, 200));
		return false;
	}
	let tmpTables = (tmpRes.body && tmpRes.body.Tables) || [];
	console.log('  ✓ introspected customer (' + tmpTables.length + ' table(s) discovered)');

	let tmpOk = true;
	for (let i = 0; i < TABLES.length; i++)
	{
		let tmpTable = TABLES[i];
		let tmpEr = await request(MAPPER_BASE, 'POST', '/mapper/admin/enable-endpoint',
			{ BeaconName: CUSTOMER_BEACON, IDBeaconConnection: pCustConnId, TableName: tmpTable });
		if (tmpEr.status >= 200 && tmpEr.status < 300)
		{
			console.log('  ✓ enabled read endpoint customer/' + tmpTable);
		}
		else
		{
			let tmpMsg = (tmpEr.body && tmpEr.body.Error) || JSON.stringify(tmpEr.body || tmpEr.status);
			if (/already|enabled/i.test(String(tmpMsg)))
			{
				console.log('  · customer/' + tmpTable + ' endpoint already enabled');
			}
			else
			{
				console.log('  ✗ enable customer/' + tmpTable + ' — HTTP ' + tmpEr.status + ': ' + tmpMsg);
				tmpOk = false;
			}
		}
	}
	return tmpOk;
}

// ── Lake RAW_ archive tables ─────────────────────────────────────────

// Meadow's standard audit-column set (mirrors the lab's other seeders).
function auditColumns(pTable)
{
	return [
		{ Column: 'ID' + pTable,    Type: 'AutoIdentity',  Size: 'Default' },
		{ Column: 'GUID' + pTable,  Type: 'AutoGUID',      Size: '36'      },
		{ Column: 'CreateDate',     Type: 'CreateDate',    Size: 'Default' },
		{ Column: 'CreatingIDUser', Type: 'CreateIDUser',  Size: 'int'     },
		{ Column: 'UpdateDate',     Type: 'UpdateDate',    Size: 'Default' },
		{ Column: 'UpdatingIDUser', Type: 'UpdateIDUser',  Size: 'int'     },
		{ Column: 'Deleted',        Type: 'Deleted',       Size: 'Default' },
		{ Column: 'DeleteDate',     Type: 'DeleteDate',    Size: 'Default' },
		{ Column: 'DeletingIDUser', Type: 'DeleteIDUser',  Size: 'int'     }
	];
}

// The raw-archive shape written by DataMapperRecords:WriteRecordsRaw.
function rawColumns()
{
	return [
		{ Column: 'Identity',    Type: 'String',   Size: '128'     },
		{ Column: 'RawJSON',     Type: 'Text',     Size: 'Default' },
		{ Column: 'RecordMD5',   Type: 'String',   Size: '32'      },
		{ Column: 'IngestedAt',  Type: 'DateTime', Size: 'Default' },
		{ Column: 'SourceTable', Type: 'String',   Size: '64'      }
	];
}

async function ensureLakeSchema(pLakeConnId, pEntity)
{
	let tmpRaw = 'RAW_' + pEntity;
	let tmpSchemaJSON =
		{
			SchemaName: 'bookstore-clone-' + tmpRaw,
			Version:    1,
			Tables:
			[
				{
					Scope:             tmpRaw,
					DefaultIdentifier: 'ID' + tmpRaw,
					Domain:            'Default',
					Schema:            auditColumns(tmpRaw).concat(rawColumns()),
					DefaultObject:     {}
				}
			]
		};
	let tmpRes = await request(MAPPER_BASE, 'POST', '/mapper/admin/ensure-schema',
		{
			BeaconName:         LAKE_BEACON,
			IDBeaconConnection: pLakeConnId,
			SchemaName:         tmpSchemaJSON.SchemaName,
			SchemaJSON:         tmpSchemaJSON,
			AutoEnable:         true
		});
	if (tmpRes.status >= 200 && tmpRes.status < 300)
	{
		let tmpCreated = (tmpRes.body && (tmpRes.body.TablesCreated || [])).join(',');
		console.log('  ✓ lake ' + tmpRaw + (tmpCreated ? ' (created: ' + tmpCreated + ')' : ' (already present)'));
		return true;
	}
	let tmpMsg = (tmpRes.body && tmpRes.body.Error) || JSON.stringify(tmpRes.body || tmpRes.status);
	console.log('  ✗ lake ' + tmpRaw + ' — HTTP ' + tmpRes.status + ': ' + tmpMsg);
	return false;
}

// ── Clone operation graph (pull → buildcomprehension → writerecordsraw) ──

function buildCloneOperation(pEntity)
{
	let tmpRaw = 'RAW_' + pEntity;
	return {
		Hash:        'clone-' + pEntity.toLowerCase() + '-to-lake',
		Name:        'Clone ' + pEntity + ' → lake ' + tmpRaw,
		Description: 'Raw-archive clone of customer ' + pEntity + ' into lake ' + tmpRaw +
			'. Pulls raw rows (no unique id required), keys them positionally, and archives each verbatim as { Identity, RawJSON, RecordMD5, IngestedAt, SourceTable }.',
		Tags:    ['bookstore-clone', 'clone', SCOPE],
		Author:  'ultravisor-lab',
		Version: '1.0.0',
		Graph:
		{
			Nodes:
			[
				{
					Hash: 'start', Type: 'start', X: 50, Y: 200, Width: 100, Height: 60, Title: 'Start',
					Ports: [ { Hash: 'start-eo-out', Direction: 'output', Side: 'right-bottom' } ]
				},
				{
					Hash: 'pull', Type: 'beacon-datamapperrecords-pullrecords',
					X: 240, Y: 180, Width: 220, Height: 140, Title: 'Pull ' + pEntity,
					Ports:
					[
						{ Hash: 'p-ei-Trigger',  Direction: 'input',  Side: 'left-bottom', Label: 'Trigger' },
						{ Hash: 'p-eo-Complete', Direction: 'output', Side: 'right-bottom', Label: 'Complete' },
						{ Hash: 'p-so-Result',   Direction: 'output', Side: 'right-top',    Label: 'Result' }
					],
					Data:
					{
						SourceBeaconName: CUSTOMER_BEACON,
						ConnectionHash:   CUSTOMER_CONN,
						Entity:           pEntity,
						BatchSize:        500,
						AffinityKey:      'data-mapper'
					}
				},
				{
					Hash: 'comprehension', Type: 'beacon-datamappertransform-buildcomprehension',
					X: 500, Y: 180, Width: 240, Height: 140, Title: 'Comprehend ' + pEntity,
					Ports:
					[
						{ Hash: 'c-ei-Trigger',      Direction: 'input',  Side: 'left-bottom', Label: 'Trigger' },
						{ Hash: 'c-eo-Complete',     Direction: 'output', Side: 'right-bottom', Label: 'Complete' },
						{ Hash: 'c-si-Records',      Direction: 'input',  Side: 'left-top',    Label: 'Records' },
						{ Hash: 'c-so-Comprehension', Direction: 'output', Side: 'right-top',   Label: 'Comprehension' }
					],
					Data:
					{
						Entity: pEntity,
						// No such column exists on the raw source rows, so every
						// row falls back to a positional record-N key — which is
						// exactly how keyless / duplicate rows all survive.
						GUIDField: 'GUID' + pEntity,
						AffinityKey: 'data-mapper'
					}
				},
				{
					Hash: 'writeraw', Type: 'beacon-datamapperrecords-writerecordsraw',
					X: 780, Y: 180, Width: 240, Height: 140, Title: 'Archive → ' + tmpRaw,
					Ports:
					[
						{ Hash: 'w-ei-Trigger',       Direction: 'input',  Side: 'left-bottom', Label: 'Trigger' },
						{ Hash: 'w-eo-Complete',      Direction: 'output', Side: 'right-bottom', Label: 'Complete' },
						{ Hash: 'w-si-Comprehension', Direction: 'input',  Side: 'left-top',    Label: 'Comprehension' }
					],
					Data:
					{
						TargetBeaconName: LAKE_BEACON,
						ConnectionHash:   LAKE_CONN,
						Entity:           tmpRaw,
						SourceTable:      pEntity,
						AffinityKey:      'data-mapper'
					}
				},
				{
					Hash: 'end', Type: 'end', X: 1060, Y: 200, Width: 100, Height: 60, Title: 'End',
					Ports: [ { Hash: 'end-ei-in', Direction: 'input', Side: 'left-bottom' } ]
				}
			],
			Connections:
			[
				{ SourceNodeHash: 'start',         SourcePortHash: 'start-eo-out',       TargetNodeHash: 'pull',          TargetPortHash: 'p-ei-Trigger' },
				{ SourceNodeHash: 'pull',          SourcePortHash: 'p-eo-Complete',      TargetNodeHash: 'comprehension', TargetPortHash: 'c-ei-Trigger' },
				{ SourceNodeHash: 'comprehension', SourcePortHash: 'c-eo-Complete',      TargetNodeHash: 'writeraw',      TargetPortHash: 'w-ei-Trigger' },
				{ SourceNodeHash: 'writeraw',      SourcePortHash: 'w-eo-Complete',      TargetNodeHash: 'end',           TargetPortHash: 'end-ei-in' },

				{ SourceNodeHash: 'pull',          SourcePortHash: 'p-so-Result',        TargetNodeHash: 'comprehension', TargetPortHash: 'c-si-Records',       ConnectionType: 'State', Data: { StateKey: 'Records' } },
				{ SourceNodeHash: 'comprehension', SourcePortHash: 'c-so-Comprehension', TargetNodeHash: 'writeraw',      TargetPortHash: 'w-si-Comprehension', ConnectionType: 'State', Data: { StateKey: 'Comprehension' } }
			],
			ViewState: { PanX: 0, PanY: 0, Zoom: 1 }
		}
	};
}

async function pollRun(pRunHash)
{
	let tmpElapsed = 0;
	while (tmpElapsed < RUN_TIMEOUT_MS)
	{
		let tmpRes = await request(UV_BASE, 'GET', '/Manifest/' + encodeURIComponent(pRunHash), null, 15000);
		if (tmpRes.status === 200 && tmpRes.body && typeof tmpRes.body === 'object')
		{
			let tmpStatus = String(tmpRes.body.Status || '').toLowerCase();
			if (tmpStatus === 'complete' || tmpStatus === 'completed' || tmpStatus === 'success')
			{
				return { ok: true, status: tmpStatus };
			}
			if (tmpStatus === 'error' || tmpStatus === 'failed' || tmpStatus === 'stalled')
			{
				return { ok: false, status: tmpStatus, manifest: tmpRes.body };
			}
		}
		await sleep(RUN_POLL_MS);
		tmpElapsed += RUN_POLL_MS;
	}
	return { ok: false, status: 'timeout' };
}

async function runClone(pEntity)
{
	let tmpOp = buildCloneOperation(pEntity);

	let tmpReg = await request(UV_BASE, 'POST', '/Operation', tmpOp, 30000);
	if (tmpReg.status < 200 || tmpReg.status >= 300)
	{
		console.log('  ✗ ' + tmpOp.Hash + ' register — HTTP ' + tmpReg.status + ': ' + JSON.stringify(tmpReg.body).slice(0, 200));
		return false;
	}

	let tmpTrig = await request(UV_BASE, 'POST', '/Operation/' + encodeURIComponent(tmpOp.Hash) + '/Execute/Async', {}, 30000);
	if (tmpTrig.status < 200 || tmpTrig.status >= 300)
	{
		console.log('  ✗ ' + tmpOp.Hash + ' trigger — HTTP ' + tmpTrig.status + ': ' + JSON.stringify(tmpTrig.body).slice(0, 300));
		return false;
	}
	let tmpRunHash = tmpTrig.body && (tmpTrig.body.RunHash || tmpTrig.body.Hash || tmpTrig.body.runHash);
	if (!tmpRunHash)
	{
		console.log('  ✗ ' + tmpOp.Hash + ' — no RunHash in trigger response: ' + JSON.stringify(tmpTrig.body).slice(0, 200));
		return false;
	}

	let tmpRun = await pollRun(tmpRunHash);
	if (tmpRun.ok)
	{
		console.log('  ✓ ' + tmpOp.Hash + ' (' + tmpRun.status + ')');
		return true;
	}
	console.log('  ✗ ' + tmpOp.Hash + ' — run ' + tmpRun.status +
		(tmpRun.manifest && tmpRun.manifest.Errors ? ': ' + JSON.stringify(tmpRun.manifest.Errors).slice(0, 240) : ''));
	return false;
}

// ── Driver ──────────────────────────────────────────────────────────

async function main()
{
	console.log('Bookstore Clone-to-Lake — Seeder');
	console.log('  mapper:  ' + MAPPER_BASE);
	console.log('  uv:      ' + UV_BASE);
	console.log('  scope:   "' + SCOPE + '"');
	console.log('');

	console.log('Waiting for data-mapper bootstrap…');
	let tmpConns = await waitForBootstrap();
	console.log('  ready (customer-main=' + tmpConns.custConnId + ', lake-main=' + tmpConns.lakeConnId + ').');
	console.log('');

	let tmpFails = 0;

	console.log('Enabling customer read endpoints (data is pre-loaded via init SQL):');
	let tmpCustOk = await introspectAndEnableCustomer(tmpConns.custConnId);
	if (!tmpCustOk) tmpFails++;

	console.log('');
	console.log('Ensuring ' + TABLES.length + ' lake RAW_ archive table(s):');
	for (let i = 0; i < TABLES.length; i++)
	{
		let tmpOk = await ensureLakeSchema(tmpConns.lakeConnId, TABLES[i]);
		if (!tmpOk) tmpFails++;
	}

	console.log('');
	console.log('Running ' + TABLES.length + ' raw clone operation(s) (customer → lake):');
	for (let i = 0; i < TABLES.length; i++)
	{
		let tmpOk = await runClone(TABLES[i]);
		if (!tmpOk) tmpFails++;
	}

	console.log('');
	if (tmpFails === 0)
	{
		console.log('✓ Done. Browse the customer beacon (7 keyless tables incl. duplicate Sales),');
		console.log('  then the lake beacon RAW_* tables (RawJSON / RecordMD5 / SourceTable per archived row).');
		process.exit(0);
	}
	console.error('✗ Completed with ' + tmpFails + ' failure(s) — see output above.');
	process.exit(1);
}

if (require.main === module)
{
	main().catch((pErr) =>
	{
		console.error('Fatal:', pErr.message || pErr);
		process.exit(1);
	});
}

module.exports = { buildCloneOperation, auditColumns, rawColumns, TABLES };
