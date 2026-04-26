/**
 * Persistence-via-DataBeacon — Session 3 lab smoke
 *
 * Validates the lab side of the persistence-beacon plumbing:
 * `Service-UltravisorManager.setInstancePersistence` / `getInstancePersistence`
 * / `listBeaconConnections` correctly forward to the right HTTP surfaces and
 * marshal responses back into the lab API contract.
 *
 * Stubs replace the real UV API server and retold-databeacon HTTP surface
 * with in-process listeners — Docker isn't required for this smoke. The
 * deeper bridge → MeadowProxy → meadow REST → SQLite chain is covered by
 * `modules/apps/retold-databeacon/test/Persistence_Bridge_Smoke_tests.js`.
 *
 * @author Steven Velozo <steven@velozo.com>
 * @license MIT
 */

const Chai = require('chai');
const Expect = Chai.expect;

const libPath = require('path');
const libFs = require('fs');
const libHttp = require('http');

const libFable = require('fable');
const libServiceStateStore = require('../source/services/Service-StateStore.js');
const libServiceUltravisorManager = require('../source/services/Service-UltravisorManager.js');

const TEST_DIR = libPath.resolve(__dirname, '.test_lab_persistence');

function ensureCleanDir(pDir)
{
	if (libFs.existsSync(pDir))
	{
		libFs.rmSync(pDir, { recursive: true, force: true });
	}
	libFs.mkdirSync(pDir, { recursive: true });
}

function startStubServer(pHandler, fCallback)
{
	let tmpServer = libHttp.createServer((pReq, pRes) =>
	{
		let tmpChunks = [];
		pReq.on('data', (pChunk) => tmpChunks.push(pChunk));
		pReq.on('end', () =>
		{
			let tmpBody = Buffer.concat(tmpChunks).toString('utf8');
			pHandler(pReq, pRes, tmpBody);
		});
	});
	tmpServer.listen(0, '127.0.0.1', () =>
	{
		let tmpPort = tmpServer.address().port;
		fCallback(null, tmpServer, tmpPort);
	});
}

suite('Persistence-via-DataBeacon — Session 3 lab smoke', function ()
{
	this.timeout(15000);

	let _Fable = null;
	let _Mgr = null;

	let _UvServer = null;
	let _UvPort = 0;
	let _UvAssignments = [];   // [{BeaconID, IDBeaconConnection}, ...]
	let _UvCurrentStatus = null;

	let _BeaconServer = null;
	let _BeaconPort = 0;
	let _BeaconConnections = [];

	let _IDInstance = null;
	let _IDBeacon = null;

	suiteSetup(function (fDone)
	{
		ensureCleanDir(TEST_DIR);

		// Stub UV — responds to /Ultravisor/Persistence/Assign + Status.
		startStubServer((pReq, pRes, pBody) =>
		{
			pRes.setHeader('Content-Type', 'application/json');
			if (pReq.method === 'POST' && pReq.url === '/Ultravisor/Persistence/Assign')
			{
				let tmpParsed = pBody ? JSON.parse(pBody) : {};
				_UvAssignments.push(tmpParsed);
				let tmpState = tmpParsed.BeaconID ? 'bootstrapped' : 'unassigned';
				_UvCurrentStatus =
				{
					Queue:    { State: tmpState, AssignedBeaconID: tmpParsed.BeaconID || null, IDBeaconConnection: tmpParsed.IDBeaconConnection || 0, LastError: null, BootstrappedAt: tmpState === 'bootstrapped' ? new Date().toISOString() : null, AssignedAt: tmpState === 'bootstrapped' ? new Date().toISOString() : null },
					Manifest: { State: tmpState, AssignedBeaconID: tmpParsed.BeaconID || null, IDBeaconConnection: tmpParsed.IDBeaconConnection || 0, LastError: null, BootstrappedAt: tmpState === 'bootstrapped' ? new Date().toISOString() : null, AssignedAt: tmpState === 'bootstrapped' ? new Date().toISOString() : null }
				};
				pRes.writeHead(200);
				pRes.end(JSON.stringify({ Success: true, Queue: _UvCurrentStatus.Queue, Manifest: _UvCurrentStatus.Manifest }));
				return;
			}
			if (pReq.method === 'GET' && pReq.url === '/Ultravisor/Persistence/Status')
			{
				pRes.writeHead(200);
				pRes.end(JSON.stringify(_UvCurrentStatus || { Queue: { State: 'unassigned' }, Manifest: { State: 'unassigned' } }));
				return;
			}
			pRes.writeHead(404);
			pRes.end(JSON.stringify({ Error: 'Not found' }));
		},
		(pErr, pServer, pPort) =>
		{
			if (pErr) return fDone(pErr);
			_UvServer = pServer;
			_UvPort = pPort;

			// Stub databeacon — responds to /beacon/connections.
			startStubServer((pReq, pRes /* pBody unused */) =>
			{
				pRes.setHeader('Content-Type', 'application/json');
				if (pReq.method === 'GET' && pReq.url === '/beacon/connections')
				{
					pRes.writeHead(200);
					pRes.end(JSON.stringify({ Connections: _BeaconConnections }));
					return;
				}
				pRes.writeHead(404);
				pRes.end(JSON.stringify({ Error: 'Not found' }));
			},
			(pErr2, pServer2, pPort2) =>
			{
				if (pErr2) return fDone(pErr2);
				_BeaconServer = pServer2;
				_BeaconPort = pPort2;

				_BeaconConnections =
				[
					{ IDBeaconConnection: 1, Name: 'uv-external', Type: 'SQLite', Connected: true },
					{ IDBeaconConnection: 2, Name: 'analytics', Type: 'PostgreSQL', Connected: true }
				];

				// Boot fable + LabStateStore + UltravisorManager.
				// addAndInstantiateServiceType only takes (typeName, classRef);
				// to pass options we need addServiceType + instantiateServiceProvider.
				// Without this the StateStore writes to the lab module's
				// production data/lab.db.
				_Fable = new libFable(
					{
						Product: 'PersistenceLabSmoke',
						ProductVersion: '0.0.1',
						LogStreams: [{ streamtype: 'console', level: 'warn' }]
					});
				_Fable.serviceManager.addServiceType('LabStateStore', libServiceStateStore);
				_Fable.serviceManager.instantiateServiceProvider('LabStateStore', { DataDir: TEST_DIR }, 'LabStateStore-Default');
				_Fable.addAndInstantiateServiceType('LabUltravisorManager', libServiceUltravisorManager);
				_Fable.LabStateStore.initialize((pInitErr) =>
				{
					if (pInitErr) return fDone(pInitErr);
					_Mgr = _Fable.LabUltravisorManager;

					// Insert a UV row pointing at the stub UV port. Status = running
					// so the manager's not-running guard doesn't reject us.
					_IDInstance = _Fable.LabStateStore.insert('UltravisorInstance',
						{
							Name: 'uv-smoke',
							Port: _UvPort,
							Status: 'running'
						});

					// Insert a beacon row pointing at the stub databeacon port.
					_IDBeacon = _Fable.LabStateStore.insert('Beacon',
						{
							Name: 'persistence-smoke-databeacon',
							BeaconType: 'retold-databeacon',
							Port: _BeaconPort,
							Status: 'running'
						});

					return fDone();
				});
			});
		});
	});

	suiteTeardown(function (fDone)
	{
		let fStopBeacon = (fNext) =>
		{
			if (_BeaconServer) { _BeaconServer.close(() => fNext()); }
			else { fNext(); }
		};
		let fStopUV = (fNext) =>
		{
			if (_UvServer) { _UvServer.close(() => fNext()); }
			else { fNext(); }
		};
		fStopBeacon(() => fStopUV(() =>
		{
			try { libFs.rmSync(TEST_DIR, { recursive: true, force: true }); } catch (e) { /* ignore */ }
			fDone();
		}));
	});

	test('UltravisorInstance row carries the new IDPersistenceBeacon + IDPersistenceConnection columns (default 0)', function ()
	{
		let tmpRow = _Mgr.getInstance(_IDInstance);
		Expect(tmpRow).to.exist;
		Expect(tmpRow.IDPersistenceBeacon, 'IDPersistenceBeacon defaults to 0').to.equal(0);
		Expect(tmpRow.IDPersistenceConnection, 'IDPersistenceConnection defaults to 0').to.equal(0);
	});

	test('listBeaconConnections forwards GET /beacon/connections to the chosen databeacon and returns the payload', function (fDone)
	{
		_Mgr.listBeaconConnections(_IDBeacon, (pErr, pPayload) =>
		{
			if (pErr) return fDone(pErr);
			Expect(pPayload).to.have.property('Connections');
			Expect(pPayload.Connections).to.be.an('array').with.length(2);
			Expect(pPayload.Connections[0].Name).to.equal('uv-external');
			return fDone();
		});
	});

	test('setInstancePersistence updates the row and POSTs an Assign body to the UV with the beacon Name as mesh BeaconID', function (fDone)
	{
		_UvAssignments = [];
		_Mgr.setInstancePersistence(_IDInstance, _IDBeacon, 1, (pErr, pPersistence) =>
		{
			if (pErr) return fDone(pErr);

			Expect(_UvAssignments, 'one POST to /Ultravisor/Persistence/Assign').to.have.length(1);
			Expect(_UvAssignments[0].BeaconID, 'mesh BeaconID is the lab beacon Name').to.equal('persistence-smoke-databeacon');
			Expect(_UvAssignments[0].IDBeaconConnection).to.equal(1);

			let tmpRow = _Mgr.getInstance(_IDInstance);
			Expect(tmpRow.IDPersistenceBeacon, 'row updated').to.equal(_IDBeacon);
			Expect(tmpRow.IDPersistenceConnection).to.equal(1);

			Expect(pPersistence, 'returned Persistence object').to.exist;
			Expect(pPersistence.State, 'aggregated state').to.equal('bootstrapped');
			Expect(pPersistence.IDPersistenceBeacon).to.equal(_IDBeacon);
			Expect(pPersistence.IDPersistenceConnection).to.equal(1);
			Expect(pPersistence.BeaconRecord, 'inflated BeaconRecord').to.exist;
			Expect(pPersistence.BeaconRecord.Name).to.equal('persistence-smoke-databeacon');
			return fDone();
		});
	});

	test('getInstancePersistence pulls live status from the UV after assignment', function (fDone)
	{
		_Mgr.getInstancePersistence(_IDInstance, (pErr, pPersistence) =>
		{
			if (pErr) return fDone(pErr);
			Expect(pPersistence.State).to.equal('bootstrapped');
			Expect(pPersistence.Queue.State).to.equal('bootstrapped');
			Expect(pPersistence.Manifest.State).to.equal('bootstrapped');
			Expect(pPersistence.Queue.AssignedBeaconID).to.equal('persistence-smoke-databeacon');
			Expect(pPersistence.BootstrappedAt, 'BootstrappedAt surfaced').to.be.a('string');
			return fDone();
		});
	});

	test('clearing assignment via setInstancePersistence(0,0) flips state back to unassigned', function (fDone)
	{
		_UvAssignments = [];
		_Mgr.setInstancePersistence(_IDInstance, 0, 0, (pErr, pPersistence) =>
		{
			if (pErr) return fDone(pErr);
			Expect(_UvAssignments, 'one POST to /Ultravisor/Persistence/Assign').to.have.length(1);
			Expect(_UvAssignments[0].BeaconID, 'BeaconID null when clearing').to.equal(null);

			let tmpRow = _Mgr.getInstance(_IDInstance);
			Expect(tmpRow.IDPersistenceBeacon).to.equal(0);
			Expect(tmpRow.IDPersistenceConnection).to.equal(0);

			Expect(pPersistence.State).to.equal('unassigned');
			Expect(pPersistence.BeaconRecord).to.equal(null);
			return fDone();
		});
	});

	test('getInstancePersistence on a not-running UV reports waiting-for-beacon when an assignment is set', function (fDone)
	{
		// Re-assign so we have an active assignment row, then flip the
		// instance to stopped and re-query.
		_Mgr.setInstancePersistence(_IDInstance, _IDBeacon, 2, (pErr) =>
		{
			if (pErr) return fDone(pErr);
			_Fable.LabStateStore.update('UltravisorInstance', 'IDUltravisorInstance', _IDInstance, { Status: 'stopped' });
			_Mgr.getInstancePersistence(_IDInstance, (pErr2, pPersistence) =>
			{
				if (pErr2) return fDone(pErr2);
				Expect(pPersistence.State).to.equal('waiting-for-beacon');
				Expect(pPersistence.LastError).to.equal('Ultravisor is not running');
				// Restore for any later tests.
				_Fable.LabStateStore.update('UltravisorInstance', 'IDUltravisorInstance', _IDInstance, { Status: 'running' });
				return fDone();
			});
		});
	});

	test('listBeaconConnections fails clearly when the beacon row is not running', function (fDone)
	{
		_Fable.LabStateStore.update('Beacon', 'IDBeacon', _IDBeacon, { Status: 'stopped' });
		_Mgr.listBeaconConnections(_IDBeacon, (pErr) =>
		{
			Expect(pErr).to.exist;
			Expect(pErr.message).to.match(/not running/i);
			_Fable.LabStateStore.update('Beacon', 'IDBeacon', _IDBeacon, { Status: 'running' });
			return fDone();
		});
	});
});
