/**
 * Service-OperationExerciseManager
 *
 * Loads multi-phase operation graphs from operation_library/<name>/operation.json
 * and exercise definitions from operation_exercises/<name>/exercise.json,
 * provisions a shared synthetic-beacon fleet (declared in
 * operation_exercises/_suite.json), registers operations with the target
 * Ultravisor, kicks them at the cadences declared by each exercise, polls
 * the UV's /Manifest/<RunHash> endpoint to track per-run lifecycle, and
 * evaluates structured assertions on the result.
 *
 * Public surface (parallels Service-BeaconExerciseManager):
 *   list()                           -- catalog of exercises
 *   get(pHash)                       -- one exercise fixture
 *   run(pHash, pOptions, fCallback)  -- start a run; returns {IDOperationExerciseRun, Status}
 *   listRuns()                       -- historical runs
 *   getRun(pID)                      -- one run + verdicts
 *   listRunEvents(pID, pPaging)      -- captured per-run events
 *   cancelRun(pID, fCallback)        -- best-effort cancel of in-flight UV runs
 *
 * The fleet is the suite-level lifecycle owner: provisioned once per UV per
 * lab process lifetime (cached in this._FleetByUV) and torn down only when
 * the lab exits.  Individual exercise runs do NOT kill fleet beacons; they
 * just stop watching them.  This keeps repeated exercise runs cheap.
 */

'use strict';

const libPath = require('path');
const libFs = require('fs');
const libHttp = require('http');
const libChildProcess = require('child_process');
const libFableServiceProviderBase = require('fable-serviceproviderbase');

const OPERATION_LIBRARY_ROOT  = libPath.resolve(__dirname, '..', '..', 'operation_library');
const OPERATION_EXERCISES_ROOT = libPath.resolve(__dirname, '..', '..', 'operation_exercises');
const SUITE_FILE              = 'oe_suite.json';  // unused (using _suite.json convention)
const SYNTHETIC_BEACON_BIN    = libPath.resolve(__dirname, '..', 'synthetic-beacon', 'bin', 'synthetic-beacon-runner.js');

const HARNESS_ADMIN_USER     = 'harness-admin';
const HARNESS_ADMIN_PASSWORD = 'harness-pass';

// UV manifest statuses we treat as terminal for an operation run.
// UV 1.0.34+ emits the canonical 7-state enum (Complete, Failed, Stalled,
// Error, Abandoned). 'Error' and 'Failed' are kept as a pair for
// backward compatibility with pre-1.0.33 builds where unhandled errors
// surfaced as 'Error' at the operation level.
const TERMINAL_RUN_STATES = new Set(['Complete', 'Error', 'Failed', 'Stalled', 'Abandoned', 'Canceled']);

// Shared keep-alive HTTP agent for every outbound call to the target
// UV. Phase 4 hardens the lab against the EADDRNOTAVAIL cascade we hit
// in huge-stress: without keep-alive, each kick / manifest poll opens
// a fresh TCP connection from a fresh ephemeral port and the local
// port table fills inside ~30s of sustained traffic. With keep-alive
// the connection pool tops out at maxSockets sockets and Node reuses
// idle ones for 30s.
const KEEPALIVE_HTTP_AGENT = new libHttp.Agent({
	keepAlive: true,
	maxSockets: 64,
	keepAliveMsecs: 30000
});

class ServiceOperationExerciseManager extends libFableServiceProviderBase
{
	constructor(pFable, pOptions, pServiceHash)
	{
		super(pFable, pOptions, pServiceHash);
		this.serviceType = 'LabOperationExerciseManager';

		this._suite           = this._loadSuite();
		this._operationCache  = this._loadOperationLibrary();
		this._catalog         = this._buildCatalog();
		this._activeRuns      = new Map();   // IDOperationExerciseRun → run context
		// Fleet provisioning state per UV: { Provisioned: bool, ChildProcesses: [], BeaconNames: Set }
		// Reused across exercise runs so we don't re-spawn duplicates.
		this._FleetByUV       = new Map();
	}

	// ── Catalog loading ────────────────────────────────────────────────────

	_loadSuite()
	{
		let tmpPath = libPath.join(OPERATION_EXERCISES_ROOT, '_suite.json');
		if (!libFs.existsSync(tmpPath))
		{
			this.fable.log.warn(`OperationExerciseManager: suite file missing at ${tmpPath}`);
			return { Fleet: { Beacons: [] } };
		}
		try { return JSON.parse(libFs.readFileSync(tmpPath, 'utf8')); }
		catch (pErr)
		{
			this.fable.log.warn(`OperationExerciseManager: invalid suite file: ${pErr.message}`);
			return { Fleet: { Beacons: [] } };
		}
	}

	_loadOperationLibrary()
	{
		let tmpMap = new Map();
		let tmpEntries = [];
		try { tmpEntries = libFs.readdirSync(OPERATION_LIBRARY_ROOT); }
		catch (pErr)
		{
			this.fable.log.warn(`OperationExerciseManager: cannot read ${OPERATION_LIBRARY_ROOT} (${pErr.message})`);
			return tmpMap;
		}
		for (let i = 0; i < tmpEntries.length; i++)
		{
			let tmpEntry = tmpEntries[i];
			if (tmpEntry.startsWith('_') || tmpEntry.startsWith('.')) { continue; }
			let tmpOpPath = libPath.join(OPERATION_LIBRARY_ROOT, tmpEntry, 'operation.json');
			if (!libFs.existsSync(tmpOpPath)) { continue; }
			try
			{
				let tmpOp = JSON.parse(libFs.readFileSync(tmpOpPath, 'utf8'));
				let tmpHash = tmpOp.Hash || tmpEntry;
				tmpMap.set(tmpHash, tmpOp);
			}
			catch (pErr)
			{
				this.fable.log.warn(`OperationExerciseManager: invalid operation.json in ${tmpEntry}: ${pErr.message}`);
			}
		}
		return tmpMap;
	}

	_buildCatalog()
	{
		let tmpCatalog = [];
		let tmpEntries = [];
		try { tmpEntries = libFs.readdirSync(OPERATION_EXERCISES_ROOT); }
		catch (pErr)
		{
			this.fable.log.warn(`OperationExerciseManager: cannot read ${OPERATION_EXERCISES_ROOT} (${pErr.message})`);
			return [];
		}
		for (let i = 0; i < tmpEntries.length; i++)
		{
			let tmpEntry = tmpEntries[i];
			if (tmpEntry.startsWith('_') || tmpEntry.startsWith('.')) { continue; }
			let tmpDir = libPath.join(OPERATION_EXERCISES_ROOT, tmpEntry);
			let tmpExercisePath = libPath.join(tmpDir, 'exercise.json');
			if (!libFs.existsSync(tmpExercisePath)) { continue; }
			try
			{
				let tmpExercise = JSON.parse(libFs.readFileSync(tmpExercisePath, 'utf8'));
				tmpCatalog.push({ FolderName: tmpEntry, ExerciseDir: tmpDir, Exercise: tmpExercise });
			}
			catch (pParseErr)
			{
				this.fable.log.warn(`OperationExerciseManager: invalid exercise.json in ${tmpEntry}: ${pParseErr.message}`);
			}
		}
		return tmpCatalog;
	}

	list()
	{
		return this._catalog.map((pEntry) =>
			{
				let tmpExercise = pEntry.Exercise;
				let tmpKickCount = this._totalKickCount(tmpExercise);
				return {
					FolderName:    pEntry.FolderName,
					Hash:          tmpExercise.Hash || pEntry.FolderName,
					Name:          tmpExercise.Name || pEntry.FolderName,
					Description:   tmpExercise.Description || '',
					OperationCount: Array.isArray(tmpExercise.Operations) ? tmpExercise.Operations.length : 0,
					KickCount:     tmpKickCount,
					BeaconCount:   (this._suite && this._suite.Fleet && Array.isArray(this._suite.Fleet.Beacons))
						? this._suite.Fleet.Beacons.length
						: 0
				};
			});
	}

	get(pHash)
	{
		let tmpEntry = this._catalog.find((pE) => (pE.Exercise.Hash || pE.FolderName) === pHash);
		return tmpEntry ? tmpEntry.Exercise : null;
	}

	_totalKickCount(pExercise)
	{
		if (!pExercise || !Array.isArray(pExercise.Kicks)) { return 0; }
		let tmpTotal = 0;
		for (let i = 0; i < pExercise.Kicks.length; i++)
		{
			tmpTotal += (pExercise.Kicks[i].Count || 0);
		}
		return tmpTotal;
	}

	// ── Persistence helpers ────────────────────────────────────────────────

	listRuns()
	{
		return this.fable.LabStateStore.list('OperationExerciseRun');
	}

	getRun(pID)
	{
		let tmpID = parseInt(pID, 10);
		if (!Number.isFinite(tmpID) || tmpID <= 0) { return null; }
		return this.fable.LabStateStore.getById('OperationExerciseRun', 'IDOperationExerciseRun', tmpID);
	}

	listRunEvents(pID, pPaging)
	{
		let tmpID = parseInt(pID, 10);
		if (!Number.isFinite(tmpID) || tmpID <= 0) { return []; }
		let tmpRows = this.fable.LabStateStore.list('OperationExerciseEvent',
			{ IDOperationExerciseRun: tmpID });
		tmpRows.reverse();  // chronological for timeline display
		let tmpOffset = (pPaging && Number.isFinite(parseInt(pPaging.offset, 10))) ? parseInt(pPaging.offset, 10) : 0;
		let tmpLimit = (pPaging && Number.isFinite(parseInt(pPaging.limit, 10))) ? parseInt(pPaging.limit, 10) : tmpRows.length;
		return tmpRows.slice(tmpOffset, tmpOffset + tmpLimit);
	}

	// ── Run an exercise ────────────────────────────────────────────────────

	run(pHash, pOptions, fCallback)
	{
		let tmpExercise = this.get(pHash);
		if (!tmpExercise) { return fCallback(new Error(`Unknown exercise: ${pHash}`)); }

		let tmpUVManager = this.fable.LabUltravisorManager;
		let tmpInstanceID = parseInt(pOptions && pOptions.IDUltravisorInstance, 10);
		let tmpInstance = null;
		if (Number.isFinite(tmpInstanceID) && tmpInstanceID > 0)
		{
			tmpInstance = tmpUVManager.getInstance(tmpInstanceID);
		}
		else if (tmpExercise.Targets && tmpExercise.Targets.RequireUVName)
		{
			let tmpAll = this.fable.LabStateStore.list('UltravisorInstance', { Name: tmpExercise.Targets.RequireUVName });
			tmpInstance = tmpAll.length > 0 ? tmpAll[0] : null;
		}
		if (!tmpInstance) { return fCallback(new Error('Target Ultravisor not found.')); }
		if (tmpInstance.Status !== 'running') { return fCallback(new Error(`Ultravisor '${tmpInstance.Name}' is not running.`)); }

		// Validate operation references resolve in the library before any
		// side effects.  Catches typos in the exercise file early.
		let tmpReferenced = Array.isArray(tmpExercise.Operations) ? tmpExercise.Operations : [];
		for (let i = 0; i < tmpReferenced.length; i++)
		{
			if (!this._operationCache.has(tmpReferenced[i]))
			{
				return fCallback(new Error(`Operation '${tmpReferenced[i]}' not found in library.`));
			}
		}

		let tmpUVURL = `http://127.0.0.1:${tmpInstance.Port}`;

		// Persist the run row up-front so the ID is available even when
		// provisioning fails (the row records the failure).
		let tmpStartedAt = new Date().toISOString();
		let tmpRunID = this.fable.LabStateStore.insert('OperationExerciseRun',
			{
				ExerciseHash:         tmpExercise.Hash || pHash,
				ExerciseName:         tmpExercise.Name || pHash,
				IDUltravisorInstance: tmpInstance.IDUltravisorInstance,
				Status:               'running',
				StartedAt:            tmpStartedAt,
				CompletedAt:          '',
				DurationMs:           0,
				TotalKicked:          0,
				TotalCompleted:       0,
				TotalFailed:          0,
				VerdictsJSON:         '',
				TimingJSON:           '',
				ErrorMessage:         ''
			});

		let tmpRunCtx =
			{
				IDOperationExerciseRun: tmpRunID,
				Exercise:               tmpExercise,
				Instance:               tmpInstance,
				UVURL:                  tmpUVURL,
				SessionCookie:          '',
				FirstKickAt:            0,
				DrainedAt:              0,
				FinishedSettling:       false,
				CompletionTimer:        null,
				PollTimer:              null,
				// RunHash → { OperationHash, KickedAt, State, Override?, KickIndex }
				OperationRuns:          new Map(),
				// Operation hash variants we registered for Override kicks (so we
				// can teardown if needed; UV upserts on Hash so cleanup is
				// optional).
				EphemeralOperationHashes: new Set(),
				// Total kicks scheduled (count of kicks expected to be issued);
				// used for assertion math even if some kick HTTP calls fail.
				TotalKicked:            0,
				FailedKicks:            0,
				FirstKickError:         '',
				AbortReason:            ''
			};
		this._activeRuns.set(tmpRunID, tmpRunCtx);

		// Login (if Secure) → ensure fleet → register operations → drive kicks.
		this._ensureLoggedIn(tmpRunCtx, (pLoginErr) =>
			{
				if (pLoginErr)
				{
					this._finishRun(tmpRunCtx, 'failed', pLoginErr.message);
					return;
				}
				this._ensureFleet(tmpRunCtx, (pFleetErr) =>
					{
						if (pFleetErr)
						{
							this._finishRun(tmpRunCtx, 'failed', pFleetErr.message);
							return;
						}
						this._registerOperations(tmpRunCtx, (pRegErr) =>
							{
								if (pRegErr)
								{
									this._finishRun(tmpRunCtx, 'failed', pRegErr.message);
									return;
								}
								this._driveKicks(tmpRunCtx);
								this._armWatchdog(tmpRunCtx);
								this._startPolling(tmpRunCtx);
							});
					});
			});

		return fCallback(null, { IDOperationExerciseRun: tmpRunID, Status: 'running' });
	}

	// ── Auth ───────────────────────────────────────────────────────────────

	_ensureLoggedIn(pCtx, fCallback)
	{
		// Same logic as Service-BeaconExerciseManager:
		//   - Promiscuous + no auth-beacon: UV synthesizes anonymous session,
		//     no login required.
		//   - Secure + auth-beacon: bootstrap admin (idempotent) + login.
		if (!pCtx.Instance.Secure || !pCtx.Instance.BootstrapAuthSecret)
		{
			return fCallback(null);
		}
		this._login(pCtx, (pLoginErr, pCookie) =>
			{
				if (!pLoginErr && pCookie)
				{
					pCtx.SessionCookie = pCookie;
					return fCallback(null);
				}
				this._bootstrapAdmin(pCtx, (pBootErr) =>
					{
						if (pBootErr) { return fCallback(pBootErr); }
						this._login(pCtx, (pRetryErr, pRetryCookie) =>
							{
								if (pRetryErr) { return fCallback(pRetryErr); }
								if (!pRetryCookie) { return fCallback(new Error('Login succeeded but no Set-Cookie header.')); }
								pCtx.SessionCookie = pRetryCookie;
								return fCallback(null);
							});
					});
			});
	}

	_login(pCtx, fCallback)
	{
		let tmpBody = JSON.stringify({ UserName: HARNESS_ADMIN_USER, Password: HARNESS_ADMIN_PASSWORD });
		this._httpPostJSON(pCtx.UVURL + '/1.0/Authenticate', tmpBody, null, (pErr, pBody, pStatus, pHeaders) =>
			{
				if (pErr) { return fCallback(pErr); }
				if (!pBody || pBody.LoggedIn !== true)
				{
					return fCallback(new Error(`Login failed: ${(pBody && pBody.Error) || 'unknown'}`));
				}
				let tmpCookie = '';
				let tmpSetCookie = pHeaders && pHeaders['set-cookie'];
				if (Array.isArray(tmpSetCookie) && tmpSetCookie.length > 0)
				{
					tmpCookie = tmpSetCookie[0].split(';')[0];
				}
				return fCallback(null, tmpCookie);
			});
	}

	_bootstrapAdmin(pCtx, fCallback)
	{
		let tmpInstance = pCtx.Instance;
		let tmpPayload = JSON.stringify(
			{
				Token: tmpInstance.BootstrapAuthSecret,
				UserSpec:
				{
					Username: HARNESS_ADMIN_USER,
					Password: HARNESS_ADMIN_PASSWORD,
					Roles: ['admin'],
					FullName: 'Operation Exercise Harness Admin',
					Email: 'harness-admin@ultravisor-lab.local'
				}
			});
		this._httpPostJSON(pCtx.UVURL + '/Beacon/BootstrapAdmin', tmpPayload, null, (pErr, pBody) =>
			{
				if (pErr) { return fCallback(pErr); }
				if (!pBody || pBody.Success !== true)
				{
					return fCallback(new Error(`Bootstrap admin failed: ${(pBody && pBody.Reason) || 'unknown'}`));
				}
				try
				{
					this.fable.LabStateStore.update('UltravisorInstance', 'IDUltravisorInstance',
						tmpInstance.IDUltravisorInstance, { Bootstrapped: true });
				}
				catch (pUpdateErr) { /* best-effort */ }
				return fCallback(null);
			});
	}

	_cookieHeaders(pCtx)
	{
		return pCtx.SessionCookie ? { Cookie: pCtx.SessionCookie } : null;
	}

	// ── Fleet provisioning (suite-level, lazy, cached per UV) ──────────────

	_ensureFleet(pCtx, fCallback)
	{
		let tmpUvID = pCtx.Instance.IDUltravisorInstance;
		let tmpFleetState = this._FleetByUV.get(tmpUvID);
		if (tmpFleetState && tmpFleetState.Provisioned)
		{
			// Verify the cached beacons are still alive (quick capability ping).
			// If the UV restarted between exercise runs, our spawned children
			// are still running but unregistered with the new UV instance --
			// detect that by re-checking /Beacon/Capabilities.
			return this._verifyFleetStillRegistered(pCtx, tmpFleetState, fCallback);
		}
		// Fresh provision.
		tmpFleetState =
			{
				Provisioned:    false,
				ChildProcesses: [],
				BeaconNames:    new Set(),
				UvID:           tmpUvID
			};
		this._FleetByUV.set(tmpUvID, tmpFleetState);

		let tmpFleet = (this._suite && this._suite.Fleet && Array.isArray(this._suite.Fleet.Beacons))
			? this._suite.Fleet.Beacons : [];
		if (tmpFleet.length === 0)
		{
			tmpFleetState.Provisioned = true;
			return fCallback(null);
		}

		let tmpRemaining = tmpFleet.length;
		let tmpFailed = false;
		let fOne = (pErr) =>
			{
				if (tmpFailed) { return; }
				if (pErr) { tmpFailed = true; return fCallback(pErr); }
				tmpRemaining--;
				if (tmpRemaining === 0)
				{
					tmpFleetState.Provisioned = true;
					return fCallback(null);
				}
			};
		for (let i = 0; i < tmpFleet.length; i++)
		{
			this._spawnFleetBeacon(pCtx, tmpFleetState, tmpFleet[i], fOne);
		}
	}

	_verifyFleetStillRegistered(pCtx, pFleetState, fCallback)
	{
		let tmpFleet = (this._suite && this._suite.Fleet && Array.isArray(this._suite.Fleet.Beacons))
			? this._suite.Fleet.Beacons : [];
		this._httpGetJSON(pCtx.UVURL + '/Beacon/Capabilities', (pErr, pBody) =>
			{
				if (pErr || !pBody || !Array.isArray(pBody.Capabilities))
				{
					// Can't tell -- assume still good and proceed.  If the
					// real registrations are gone, the kick will fail and
					// the operator will see a clear error.
					return fCallback(null);
				}
				let tmpCaps = new Set(pBody.Capabilities);
				let tmpMissing = [];
				for (let i = 0; i < tmpFleet.length; i++)
				{
					if (!tmpCaps.has(tmpFleet[i].Capability)) { tmpMissing.push(tmpFleet[i].Capability); }
				}
				if (tmpMissing.length === 0) { return fCallback(null); }
				// A capability went missing -- typically because the UV
				// restarted.  Re-spawn the missing ones (best-effort: leave
				// the still-running children alone).
				this.fable.log.warn(`OperationExerciseManager: re-spawning ${tmpMissing.length} fleet beacons (UV may have restarted).`);
				let tmpToRespawn = tmpFleet.filter((pB) => tmpMissing.indexOf(pB.Capability) >= 0);
				let tmpRem = tmpToRespawn.length;
				let tmpDone = false;
				for (let i = 0; i < tmpToRespawn.length; i++)
				{
					this._spawnFleetBeacon(pCtx, pFleetState, tmpToRespawn[i], (pSpawnErr) =>
						{
							if (tmpDone) { return; }
							if (pSpawnErr) { tmpDone = true; return fCallback(pSpawnErr); }
							tmpRem--;
							if (tmpRem === 0) { tmpDone = true; return fCallback(null); }
						});
				}
			});
	}

	_spawnFleetBeacon(pCtx, pFleetState, pBeaconSpec, fCallback)
	{
		let tmpJoinSecret = (pCtx.Instance && pCtx.Instance.Secure && pCtx.Instance.BootstrapAuthSecret)
			? pCtx.Instance.BootstrapAuthSecret
			: '';
		let tmpArgs =
		[
			SYNTHETIC_BEACON_BIN,
			'--ultravisor',          pCtx.UVURL,
			'--name',                pBeaconSpec.Name,
			'--join-secret',         tmpJoinSecret,
			'--capability',          pBeaconSpec.Capability,
			'--actions',             (pBeaconSpec.Actions || ['Process']).join(','),
			'--max-concurrent',      String(pBeaconSpec.MaxConcurrent || 1),
			'--default-duration-ms', String(pBeaconSpec.DefaultDurationMs || 1500)
		];
		// Optional HTTP listener — exercises UV's direct reachability
		// probe path.  When the suite spec sets BindPort > 0, the
		// synthetic beacon spins up an HTTP server and registers its
		// {Protocol, IP, Port} so UV can probe and other beacons can
		// reach it directly without the WS broker.  AdvertiseIP is
		// distinct from BindIP because UV often runs in a container
		// while the lab spawns beacons on the host: bind 0.0.0.0 to
		// listen everywhere, advertise host.docker.internal so the
		// container's probe reaches back to the host.
		if (Number.isFinite(pBeaconSpec.BindPort) && pBeaconSpec.BindPort > 0)
		{
			tmpArgs.push('--bind-port', String(pBeaconSpec.BindPort));
			if (pBeaconSpec.BindIP)       { tmpArgs.push('--bind-ip',       pBeaconSpec.BindIP); }
			if (pBeaconSpec.BindProtocol) { tmpArgs.push('--bind-protocol', pBeaconSpec.BindProtocol); }
			if (pBeaconSpec.AdvertiseIP)  { tmpArgs.push('--advertise-ip',  pBeaconSpec.AdvertiseIP); }
		}
		// Phase 4 — Pillar 3: pass through transport mode when set in
		// the suite spec. 'poll' forces HTTP-only on this beacon so the
		// regression exercise can prove the polling code path works.
		if (pBeaconSpec.Mode === 'poll' || pBeaconSpec.Mode === 'auto')
		{
			tmpArgs.push('--mode', pBeaconSpec.Mode);
		}
		let tmpChild;
		try
		{
			tmpChild = libChildProcess.spawn(process.execPath, tmpArgs,
				{ stdio: ['ignore', 'pipe', 'pipe'] });
		}
		catch (pErr) { return fCallback(pErr); }

		pFleetState.ChildProcesses.push({ PID: tmpChild.pid, BeaconName: pBeaconSpec.Name, Process: tmpChild });
		pFleetState.BeaconNames.add(pBeaconSpec.Name);

		let tmpStderrBuf = '';
		tmpChild.stderr.on('data', (pBuf) => { tmpStderrBuf += pBuf.toString('utf8'); });
		tmpChild.stdout.on('data', () => { /* ignore */ });
		tmpChild.on('error', (pErr) =>
			{
				this.fable.log.warn(`Fleet beacon '${pBeaconSpec.Name}' child-process error: ${pErr.message}`);
			});
		tmpChild.on('exit', (pCode, pSignal) =>
			{
				if (pCode !== 0 && pCode !== null)
				{
					this.fable.log.warn(
						`Fleet beacon '${pBeaconSpec.Name}' exited code=${pCode} sig=${pSignal}.  Stderr: ${tmpStderrBuf.slice(-200)}`);
				}
			});
		this._waitForBeaconRegistered(pCtx, pBeaconSpec, 0, fCallback);
	}

	_waitForBeaconRegistered(pCtx, pBeaconSpec, pAttempt, fCallback)
	{
		if (pAttempt >= 30) { return fCallback(new Error(`Fleet beacon '${pBeaconSpec.Name}' did not register within 15s.`)); }
		this._httpGetJSON(pCtx.UVURL + '/Beacon/Capabilities', (pErr, pBody) =>
			{
				if (pErr) { return setTimeout(() => this._waitForBeaconRegistered(pCtx, pBeaconSpec, pAttempt + 1, fCallback), 500); }
				if (pBody && Array.isArray(pBody.Capabilities) && pBody.Capabilities.indexOf(pBeaconSpec.Capability) >= 0)
				{
					return fCallback(null);
				}
				return setTimeout(() => this._waitForBeaconRegistered(pCtx, pBeaconSpec, pAttempt + 1, fCallback), 500);
			});
	}

	// ── Operation registration with the UV ─────────────────────────────────

	_registerOperations(pCtx, fCallback)
	{
		let tmpOps = Array.isArray(pCtx.Exercise.Operations) ? pCtx.Exercise.Operations : [];
		if (tmpOps.length === 0) { return fCallback(null); }
		let tmpIdx = 0;
		let tmpNext = () =>
			{
				if (tmpIdx >= tmpOps.length) { return fCallback(null); }
				let tmpOpHash = tmpOps[tmpIdx++];
				let tmpDef = this._operationCache.get(tmpOpHash);
				if (!tmpDef) { return fCallback(new Error(`Operation '${tmpOpHash}' not found in library.`)); }
				this._registerOneOperation(pCtx, tmpDef, (pErr) =>
					{
						if (pErr) { return fCallback(pErr); }
						return tmpNext();
					});
			};
		tmpNext();
	}

	_registerOneOperation(pCtx, pOperationDef, fCallback)
	{
		// Check if it already exists; UV's POST /Operation upserts so this
		// is a soft optimization, but it also keeps logs clean on re-runs.
		let tmpURL = pCtx.UVURL + '/Operation/' + encodeURIComponent(pOperationDef.Hash);
		this._httpGetJSON(tmpURL, (pGetErr, pBody, pStatus) =>
			{
				if (!pGetErr && pStatus === 200 && pBody && pBody.Hash === pOperationDef.Hash)
				{
					// Already registered.  POST anyway to refresh the graph
					// in case the library was edited between runs -- POST
					// /Operation upserts on Hash.
				}
				let tmpPostBody = JSON.stringify(pOperationDef);
				this._httpPostJSON(pCtx.UVURL + '/Operation', tmpPostBody, this._cookieHeaders(pCtx),
					(pPostErr, pPostBody, pPostStatus) =>
					{
						if (pPostErr) { return fCallback(new Error(`Operation registration failed: ${pPostErr.message}`)); }
						if (pPostStatus >= 400)
						{
							let tmpReason = (pPostBody && pPostBody.Error) || `HTTP ${pPostStatus}`;
							return fCallback(new Error(`Operation '${pOperationDef.Hash}' registration rejected: ${tmpReason}`));
						}
						return fCallback(null);
					});
			});
	}

	// ── Kick scheduling ────────────────────────────────────────────────────

	_driveKicks(pCtx)
	{
		let tmpKicks = Array.isArray(pCtx.Exercise.Kicks) ? pCtx.Exercise.Kicks : [];
		// Pre-count total expected kicks for assertion math even if some
		// kicks fail at HTTP level.
		let tmpExpected = 0;
		for (let i = 0; i < tmpKicks.length; i++)
		{
			tmpExpected += (tmpKicks[i].Count || 0);
		}
		pCtx.TotalKicked = tmpExpected;
		try
		{
			this.fable.LabStateStore.update('OperationExerciseRun', 'IDOperationExerciseRun',
				pCtx.IDOperationExerciseRun, { TotalKicked: tmpExpected });
		}
		catch (pErr) { /* best-effort */ }

		let tmpGlobalKickIdx = 0;
		for (let i = 0; i < tmpKicks.length; i++)
		{
			let tmpKick = tmpKicks[i];
			let tmpCount = tmpKick.Count || 0;
			let tmpAtMs = tmpKick.EnqueueAtMs || 0;
			let tmpInterval = Number.isFinite(tmpKick.EnqueueIntervalMs) ? tmpKick.EnqueueIntervalMs : 0;
			for (let n = 0; n < tmpCount; n++)
			{
				let tmpDelay = tmpAtMs + n * tmpInterval;
				let tmpThisKickIdx = tmpGlobalKickIdx++;
				let tmpKickRef = tmpKick;
				let tmpSubIdx = n;
				setTimeout(() =>
					{
						if (pCtx.FinishedSettling) { return; }
						this._kickOperation(pCtx, tmpKickRef, tmpThisKickIdx, tmpSubIdx);
					}, tmpDelay);
			}
		}
		// If no kicks scheduled, finish immediately.
		if (tmpExpected === 0)
		{
			setTimeout(() => this._maybeFinishOnDrain(pCtx), 100);
		}
	}

	_kickOperation(pCtx, pKick, pKickIdx, pSubIdx)
	{
		let tmpOpHash = pKick.OperationHash;
		let tmpOpDef = this._operationCache.get(tmpOpHash);
		if (!tmpOpDef)
		{
			pCtx.FailedKicks++;
			if (!pCtx.FirstKickError) { pCtx.FirstKickError = `Unknown operation '${tmpOpHash}'`; }
			return;
		}

		// If this kick has overrides, register an ephemeral clone with a
		// suffixed Hash so the override only affects this kick.  POSTing the
		// override directly onto the canonical operation would taint
		// concurrent kicks of the same operation.
		let tmpUseHash = tmpOpHash;
		let tmpHasOverride = pKick.Override && typeof pKick.Override === 'object' && Object.keys(pKick.Override).length > 0;

		let fAfterRegister = () =>
			{
				let tmpURL = pCtx.UVURL + '/Operation/' + encodeURIComponent(tmpUseHash) + '/Execute/Async';
				let tmpKickedAt = Date.now();
				if (!pCtx.FirstKickAt) { pCtx.FirstKickAt = tmpKickedAt; }
				this._httpPostJSON(tmpURL, '{}', this._cookieHeaders(pCtx), (pErr, pBody, pStatus) =>
					{
						if (pErr || pStatus >= 400)
						{
							let tmpReason = pErr ? pErr.message : `HTTP ${pStatus}: ${(pBody && pBody.Error) || ''}`;
							pCtx.FailedKicks++;
							if (!pCtx.FirstKickError) { pCtx.FirstKickError = tmpReason; }
							this.fable.log.warn(`OperationExerciseManager: kick #${pKickIdx} (${tmpUseHash}) failed: ${tmpReason}`);
							this._recordEvent(pCtx, '', tmpUseHash, 'kick-failed', { Reason: tmpReason, KickIdx: pKickIdx });
							return;
						}
						if (!pBody || !pBody.RunHash)
						{
							pCtx.FailedKicks++;
							let tmpReason = 'Execute/Async returned no RunHash';
							if (!pCtx.FirstKickError) { pCtx.FirstKickError = tmpReason; }
							return;
						}
						pCtx.OperationRuns.set(pBody.RunHash,
							{
								OperationHash: tmpOpHash,
								UsedHash:      tmpUseHash,
								KickedAt:      tmpKickedAt,
								State:         pBody.Status || 'Pending',
								KickIdx:       pKickIdx,
								SubIdx:        pSubIdx,
								Override:      pKick.Override || null,
								CompletedAt:   0
							});
						this._recordEvent(pCtx, pBody.RunHash, tmpOpHash, 'kicked',
							{ KickIdx: pKickIdx, UsedHash: tmpUseHash, Override: pKick.Override || null });
					});
			};

		if (!tmpHasOverride) { return fAfterRegister(); }

		// Build mutated clone.  The override keys follow a "<NodeWord><SettingName>"
		// pattern -- e.g. ParseFailRate maps to the parse node's Settings.FailRate.
		// For each override key, we look for a node whose hash starts with
		// the lower-cased prefix and apply the suffix-derived key into its
		// Settings block.  Keys that don't match a node are silently ignored.
		let tmpClone = JSON.parse(JSON.stringify(tmpOpDef));
		tmpUseHash = `${tmpOpHash}-k${pCtx.IDOperationExerciseRun}-${pKickIdx}`;
		tmpClone.Hash = tmpUseHash;
		tmpClone.Name = (tmpClone.Name || tmpOpHash) + ` (kick ${pKickIdx})`;
		this._applyOverrideToOperation(tmpClone, pKick.Override);
		pCtx.EphemeralOperationHashes.add(tmpUseHash);
		this._registerOneOperation(pCtx, tmpClone, (pErr) =>
			{
				if (pErr)
				{
					pCtx.FailedKicks++;
					if (!pCtx.FirstKickError) { pCtx.FirstKickError = pErr.message; }
					this.fable.log.warn(`OperationExerciseManager: override op registration for kick #${pKickIdx} failed: ${pErr.message}`);
					return;
				}
				return fAfterRegister();
			});
	}

	/**
	 * Apply a kick's Override block onto an operation graph clone.  Each
	 * override key is a CamelCase string of the form "<NodePrefix><SettingName>"
	 * (e.g. ParseFailRate, LoadDurationMs).  We match against node hashes
	 * (case-insensitive prefix); the settings we know how to merge are the
	 * synthetic-beacon recognized keys: DurationMs, JitterMs, FailRate,
	 * LogLines, OutputBytes.
	 */
	_applyOverrideToOperation(pOp, pOverride)
	{
		let tmpKnownSettings = ['DurationMs', 'JitterMs', 'FailRate', 'LogLines', 'OutputBytes'];
		let tmpKeys = Object.keys(pOverride);
		let tmpNodes = (pOp.Graph && Array.isArray(pOp.Graph.Nodes)) ? pOp.Graph.Nodes : [];
		for (let k = 0; k < tmpKeys.length; k++)
		{
			let tmpKey = tmpKeys[k];
			let tmpVal = pOverride[tmpKey];
			// Find the longest known-setting suffix that matches; the
			// remainder is the node prefix.
			let tmpSetting = '';
			let tmpNodePrefix = '';
			for (let s = 0; s < tmpKnownSettings.length; s++)
			{
				if (tmpKey.toLowerCase().endsWith(tmpKnownSettings[s].toLowerCase()))
				{
					tmpSetting = tmpKnownSettings[s];
					tmpNodePrefix = tmpKey.slice(0, tmpKey.length - tmpSetting.length).toLowerCase();
					break;
				}
			}
			if (!tmpSetting)
			{
				this.fable.log.warn(`OperationExerciseManager: override key '${tmpKey}' does not match a known setting suffix; ignored.`);
				continue;
			}
			let tmpMatched = 0;
			for (let n = 0; n < tmpNodes.length; n++)
			{
				let tmpNode = tmpNodes[n];
				if (!tmpNode || !tmpNode.Hash) { continue; }
				if (tmpNode.Hash.toLowerCase().indexOf(tmpNodePrefix) !== 0) { continue; }
				// UV's ExecutionEngine reads node.Data as the flat settings
				// bag (see _resolveStateConnections); keys go directly on Data.
				if (!tmpNode.Data) { tmpNode.Data = {}; }
				tmpNode.Data[tmpSetting] = tmpVal;
				tmpMatched++;
			}
			if (tmpMatched === 0)
			{
				this.fable.log.warn(`OperationExerciseManager: override key '${tmpKey}' matched no nodes (prefix='${tmpNodePrefix}').`);
			}
		}
	}

	// ── Event capture ──────────────────────────────────────────────────────

	_recordEvent(pCtx, pRunHash, pOperationHash, pEventType, pPayload)
	{
		try
		{
			this.fable.LabStateStore.insert('OperationExerciseEvent',
				{
					IDOperationExerciseRun: pCtx.IDOperationExerciseRun,
					RunHash:                pRunHash || '',
					OperationHash:          pOperationHash || '',
					EventType:              pEventType || '',
					EmittedAt:              new Date().toISOString(),
					PayloadJSON:            pPayload ? JSON.stringify(pPayload) : ''
				});
		}
		catch (pErr) { /* best-effort */ }
	}

	// ── Polling for run lifecycles ────────────────────────────────────────

	_startPolling(pCtx)
	{
		// Poll /Manifest/<RunHash> for each tracked run.  Driven by a fixed
		// 500ms cadence; a manifest service WS subscription would be lower
		// latency but adds protocol surface -- polling matches the v1
		// approach the spec calls out as preferred.
		pCtx.PollTimer = setInterval(() => this._pollOnce(pCtx), 500);
		if (pCtx.PollTimer.unref) { pCtx.PollTimer.unref(); }
	}

	_pollOnce(pCtx)
	{
		if (pCtx.FinishedSettling)
		{
			if (pCtx.PollTimer) { clearInterval(pCtx.PollTimer); pCtx.PollTimer = null; }
			return;
		}
		if (pCtx.OperationRuns.size === 0)
		{
			// No kicks have landed yet.  Check if all kicks have failed (no
			// hope of finishing).
			if (pCtx.FailedKicks >= pCtx.TotalKicked && pCtx.TotalKicked > 0)
			{
				this._finishRun(pCtx, 'failed', `All ${pCtx.TotalKicked} kicks failed: ${pCtx.FirstKickError}`);
			}
			return;
		}

		let tmpHashes = [];
		pCtx.OperationRuns.forEach((pV, pK) =>
			{
				if (TERMINAL_RUN_STATES.has(pV.State)) { return; }
				tmpHashes.push(pK);
			});
		if (tmpHashes.length === 0)
		{
			// All in terminal state -- check drain.
			this._maybeFinishOnDrain(pCtx);
			return;
		}
		// Fan out manifest reads.  Manifests are small; one HTTP each is fine.
		let tmpRem = tmpHashes.length;
		for (let i = 0; i < tmpHashes.length; i++)
		{
			let tmpHash = tmpHashes[i];
			let tmpURL = pCtx.UVURL + '/Manifest/' + encodeURIComponent(tmpHash);
			this._httpGetJSON(tmpURL, (pErr, pBody, pStatus) =>
				{
					tmpRem--;
					if (pErr || pStatus >= 400 || !pBody) { return; }
					let tmpRec = pCtx.OperationRuns.get(tmpHash);
					if (!tmpRec) { return; }
					// As of UV 1.0.33, the engine rolls up unhandled
					// beacon errors to Status='Failed' directly (the
					// previous workaround that scanned TaskOutputs for
					// _BeaconError is no longer needed -- the engine
					// now records the failure into Errors[] and
					// finalizeExecution emits Failed from there).
					let tmpNewState = pBody.Status || tmpRec.State;
					if (tmpNewState !== tmpRec.State)
					{
						let tmpPrior = tmpRec.State;
						tmpRec.State = tmpNewState;
						this._recordEvent(pCtx, tmpHash, tmpRec.OperationHash, 'state-change',
							{ From: tmpPrior, To: tmpNewState });
						if (TERMINAL_RUN_STATES.has(tmpNewState))
						{
							tmpRec.CompletedAt = Date.now();
						}
					}
					if (tmpRem === 0)
					{
						// All polled this tick; check drain.
						let tmpAnyOpen = false;
						pCtx.OperationRuns.forEach((pV) =>
							{
								if (!TERMINAL_RUN_STATES.has(pV.State)) { tmpAnyOpen = true; }
							});
						if (!tmpAnyOpen) { this._maybeFinishOnDrain(pCtx); }
					}
				});
		}
	}

	_armWatchdog(pCtx)
	{
		let tmpMaxSec = (pCtx.Exercise.Assertions && Number.isFinite(pCtx.Exercise.Assertions.MaxOperationDurationSeconds))
			? pCtx.Exercise.Assertions.MaxOperationDurationSeconds
			: 120;
		// Add a generous grace so the watchdog only fires if the assertion
		// would have failed anyway.  Real failure surfaces via the assertion
		// engine.
		pCtx.CompletionTimer = setTimeout(() =>
			{
				if (pCtx.FinishedSettling) { return; }
				this._finishRun(pCtx, 'timed-out', `Watchdog fired after ${tmpMaxSec + 15}s`);
			}, (tmpMaxSec + 15) * 1000);
		if (pCtx.CompletionTimer.unref) { pCtx.CompletionTimer.unref(); }
	}

	_maybeFinishOnDrain(pCtx)
	{
		if (pCtx.FinishedSettling) { return; }
		// All kicks accounted for: we have one OperationRuns entry per
		// successful kick.  Failed kicks won't get an entry; they're counted
		// in FailedKicks.  Drain when (entries-in-terminal-state +
		// failed-kicks) >= TotalKicked.
		let tmpTerminalCount = 0;
		pCtx.OperationRuns.forEach((pV) =>
			{
				if (TERMINAL_RUN_STATES.has(pV.State)) { tmpTerminalCount++; }
			});
		let tmpDone = (tmpTerminalCount + pCtx.FailedKicks) >= pCtx.TotalKicked;
		if (!tmpDone) { return; }
		// Settle window for any tail events.
		setTimeout(() =>
			{
				if (pCtx.FinishedSettling) { return; }
				let tmpTC = 0;
				pCtx.OperationRuns.forEach((pV) =>
					{
						if (TERMINAL_RUN_STATES.has(pV.State)) { tmpTC++; }
					});
				if ((tmpTC + pCtx.FailedKicks) < pCtx.TotalKicked) { return; }
				pCtx.DrainedAt = Date.now();
				this._finishRun(pCtx, 'complete', '');
			}, 250);
	}

	// ── Finalize + assertions ──────────────────────────────────────────────

	_finishRun(pCtx, pStatus, pErrorMessage)
	{
		if (pCtx.FinishedSettling) { return; }
		pCtx.FinishedSettling = true;
		if (pCtx.CompletionTimer) { clearTimeout(pCtx.CompletionTimer); pCtx.CompletionTimer = null; }
		if (pCtx.PollTimer) { clearInterval(pCtx.PollTimer); pCtx.PollTimer = null; }

		let tmpDrainedAt = pCtx.DrainedAt || Date.now();
		let tmpDurationMs = pCtx.FirstKickAt ? (tmpDrainedAt - pCtx.FirstKickAt) : 0;

		let tmpVerdicts = (pStatus === 'complete')
			? this._evaluateAssertions(pCtx)
			: [];

		let tmpCompleted = 0;
		let tmpFailed = 0;
		pCtx.OperationRuns.forEach((pV) =>
			{
				if (pV.State === 'Complete') { tmpCompleted++; }
				else if (pV.State === 'Error' || pV.State === 'Failed' || pV.State === 'Abandoned' || pV.State === 'Canceled') { tmpFailed++; }
			});
		// FailedKicks (HTTP layer) also count toward failure for visibility.
		tmpFailed += pCtx.FailedKicks;

		let tmpTiming =
			{
				FirstKickAt:  pCtx.FirstKickAt || 0,
				DrainedAtMs:  tmpDrainedAt,
				DurationMs:   tmpDurationMs,
				DurationSeconds: Math.round(tmpDurationMs / 100) / 10,
				PerRun:       this._buildPerRunTiming(pCtx)
			};

		let tmpFinalStatus = pStatus;
		if (pStatus === 'complete' && tmpVerdicts.some((pV) => pV.Pass === false))
		{
			tmpFinalStatus = 'failed-assertions';
		}

		let tmpErrorMessage = pErrorMessage || '';
		if (pCtx.FirstKickError && !tmpErrorMessage)
		{
			tmpErrorMessage = `${pCtx.FailedKicks} kick error(s); first: ${pCtx.FirstKickError}`;
		}

		try
		{
			this.fable.LabStateStore.update('OperationExerciseRun', 'IDOperationExerciseRun', pCtx.IDOperationExerciseRun,
				{
					Status:         tmpFinalStatus,
					CompletedAt:    new Date().toISOString(),
					DurationMs:     tmpDurationMs,
					TotalKicked:    pCtx.TotalKicked,
					TotalCompleted: tmpCompleted,
					TotalFailed:    tmpFailed,
					VerdictsJSON:   JSON.stringify({ Verdicts: tmpVerdicts }),
					TimingJSON:     JSON.stringify(tmpTiming),
					ErrorMessage:   tmpErrorMessage
				});
		}
		catch (pErr)
		{
			this.fable.log.warn(`OperationExerciseManager: could not finalize run row ${pCtx.IDOperationExerciseRun}: ${pErr.message}`);
		}

		try
		{
			this.fable.LabStateStore.recordEvent(
				{
					EntityType: 'OperationExerciseRun',
					EntityID:   pCtx.IDOperationExerciseRun,
					EntityName: pCtx.Exercise.Name || pCtx.Exercise.Hash || '',
					EventType:  'operation-exercise-' + tmpFinalStatus,
					Severity:   tmpFinalStatus === 'complete' ? 'info' : 'warning',
					Message:    `Exercise '${pCtx.Exercise.Name}' ended ${tmpFinalStatus} (${tmpTiming.DurationSeconds}s)`,
					Detail:     JSON.stringify({ Verdicts: tmpVerdicts, Timing: tmpTiming, ErrorMessage: tmpErrorMessage })
				});
		}
		catch (pErr) { /* best-effort */ }

		this._activeRuns.delete(pCtx.IDOperationExerciseRun);
		// Note: we deliberately do NOT teardown fleet child processes here;
		// the suite owns the fleet lifecycle and beacons stay up so the next
		// exercise run is fast.  See _shutdown() (called on lab exit).
	}

	_buildPerRunTiming(pCtx)
	{
		let tmpRows = [];
		pCtx.OperationRuns.forEach((pV, pK) =>
			{
				tmpRows.push(
					{
						RunHash:       pK,
						OperationHash: pV.OperationHash,
						UsedHash:      pV.UsedHash,
						KickedAt:      pV.KickedAt,
						CompletedAt:   pV.CompletedAt,
						DurationMs:    pV.CompletedAt ? (pV.CompletedAt - pV.KickedAt) : 0,
						State:         pV.State,
						HadOverride:   !!pV.Override
					});
			});
		// Sort by kick time for readability.
		tmpRows.sort((pA, pB) => pA.KickedAt - pB.KickedAt);
		return tmpRows;
	}

	_evaluateAssertions(pCtx)
	{
		let tmpResults = [];
		let tmpA = pCtx.Exercise.Assertions || {};

		let tmpCompleted = 0;
		let tmpFailedTerminal = 0;
		let tmpStalledTerminal = 0;
		pCtx.OperationRuns.forEach((pV) =>
			{
				if (pV.State === 'Complete') { tmpCompleted++; }
				else if (pV.State === 'Stalled') { tmpStalledTerminal++; }
				else if (pV.State === 'Error' || pV.State === 'Failed' || pV.State === 'Abandoned' || pV.State === 'Canceled')
				{
					tmpFailedTerminal++;
				}
			});
		let tmpFailedTotal = tmpFailedTerminal + pCtx.FailedKicks;

		if (tmpA.AllOperationsCompleted === true)
		{
			let tmpExpected = pCtx.TotalKicked;
			tmpResults.push(
				{
					Assertion: 'AllOperationsCompleted',
					Pass:      tmpCompleted === tmpExpected,
					Spec:      tmpExpected,
					Observed:  tmpCompleted
				});
		}

		if (Number.isFinite(tmpA.MaxOperationDurationSeconds))
		{
			let tmpMaxObserved = 0;
			let tmpAnyOver = false;
			pCtx.OperationRuns.forEach((pV) =>
				{
					if (!pV.CompletedAt) { return; }
					let tmpD = (pV.CompletedAt - pV.KickedAt) / 1000;
					if (tmpD > tmpMaxObserved) { tmpMaxObserved = tmpD; }
					if (tmpD > tmpA.MaxOperationDurationSeconds) { tmpAnyOver = true; }
				});
			tmpResults.push(
				{
					Assertion: 'MaxOperationDurationSeconds',
					Pass:      !tmpAnyOver,
					Spec:      tmpA.MaxOperationDurationSeconds,
					Observed:  Math.round(tmpMaxObserved * 10) / 10
				});
		}

		if (Number.isFinite(tmpA.MaxFailedOperations))
		{
			tmpResults.push(
				{
					Assertion: 'MaxFailedOperations',
					Pass:      tmpFailedTotal <= tmpA.MaxFailedOperations,
					Spec:      tmpA.MaxFailedOperations,
					Observed:  tmpFailedTotal
				});
		}

		// Phase 2: count operation runs that finalized as Stalled.
		// Default omitted = no constraint; a scenario can declare 0 to
		// require zero stalls (the typical fixture expectation since the
		// happy-path fixtures never kill a beacon mid-run).
		if (Number.isFinite(tmpA.MaxStalledItems))
		{
			tmpResults.push(
				{
					Assertion: 'MaxStalledItems',
					Pass:      tmpStalledTerminal <= tmpA.MaxStalledItems,
					Spec:      tmpA.MaxStalledItems,
					Observed:  tmpStalledTerminal
				});
		}

		if (Number.isFinite(tmpA.MinSuccessfulOperations))
		{
			tmpResults.push(
				{
					Assertion: 'MinSuccessfulOperations',
					Pass:      tmpCompleted >= tmpA.MinSuccessfulOperations,
					Spec:      tmpA.MinSuccessfulOperations,
					Observed:  tmpCompleted
				});
		}

		if (tmpA.FailureIsolation === true)
		{
			// When ≥1 op failed, every other op should have completed
			// cleanly.  Detect cascade by checking that no Complete=false
			// entry exists outside the explicitly-failure-injected kicks.
			// Stalled counts as failed for cascade detection — a stall in
			// one op shouldn't take other ops down with it.
			let tmpAnyFailed = (tmpFailedTotal + tmpStalledTerminal) > 0;
			let tmpUnexpectedFailures = [];
			pCtx.OperationRuns.forEach((pV, pK) =>
				{
					if (pV.State === 'Complete') { return; }
					if (pV.Override) { return; }  // explicitly failure-injected
					if (TERMINAL_RUN_STATES.has(pV.State) && pV.State !== 'Complete')
					{
						tmpUnexpectedFailures.push({ RunHash: pK, State: pV.State });
					}
				});
			tmpResults.push(
				{
					Assertion: 'FailureIsolation',
					Pass:      tmpAnyFailed && tmpUnexpectedFailures.length === 0,
					Spec:      'No cascade failures from injected-failure ops',
					Observed:  tmpUnexpectedFailures.length === 0 ? 'isolated' : `${tmpUnexpectedFailures.length} cascaded`,
					Detail:    { CascadedFailures: tmpUnexpectedFailures }
				});
		}

		return tmpResults;
	}

	// ── Cancel ─────────────────────────────────────────────────────────────

	cancelRun(pID, fCallback)
	{
		let tmpID = parseInt(pID, 10);
		let tmpCtx = this._activeRuns.get(tmpID);
		if (!tmpCtx) { return fCallback(new Error(`Run ${tmpID} is not active.`)); }
		// Best-effort: call Manifest/<RunHash>/Abandon for every non-terminal
		// run.
		let tmpHashes = [];
		tmpCtx.OperationRuns.forEach((pV, pK) =>
			{
				if (!TERMINAL_RUN_STATES.has(pV.State)) { tmpHashes.push(pK); }
			});
		if (tmpHashes.length === 0)
		{
			this._finishRun(tmpCtx, 'canceled', 'No outstanding operation runs at cancel time.');
			return fCallback(null, { Canceled: 0, Uncancelable: [] });
		}
		let tmpRem = tmpHashes.length;
		let tmpUncancelable = [];
		for (let i = 0; i < tmpHashes.length; i++)
		{
			let tmpHash = tmpHashes[i];
			let tmpURL = `${tmpCtx.UVURL}/Manifest/${encodeURIComponent(tmpHash)}/Abandon`;
			this._httpPostJSON(tmpURL, '{}', this._cookieHeaders(tmpCtx), (pErr, pBody, pStatus) =>
				{
					if (pErr || pStatus >= 400) { tmpUncancelable.push(tmpHash); }
					tmpRem--;
					if (tmpRem === 0)
					{
						this._finishRun(tmpCtx, 'canceled', `Cancel issued; uncancelable=${tmpUncancelable.length}`);
						fCallback(null, { Canceled: tmpHashes.length - tmpUncancelable.length, Uncancelable: tmpUncancelable });
					}
				});
		}
	}

	// ── HTTP helpers (mirrors Service-BeaconExerciseManager) ───────────────

	_httpPostJSON(pURL, pBodyString, pExtraHeaders, fCallback)
	{
		if (typeof pExtraHeaders === 'function' && fCallback === undefined)
		{
			fCallback = pExtraHeaders;
			pExtraHeaders = null;
		}
		let tmpURL;
		try { tmpURL = new URL(pURL); } catch (pErr) { return fCallback(pErr); }
		let tmpHeaders =
			{
				'Content-Type':   'application/json',
				'Content-Length': Buffer.byteLength(pBodyString || '')
			};
		if (pExtraHeaders && typeof pExtraHeaders === 'object')
		{
			let tmpKeys = Object.keys(pExtraHeaders);
			for (let i = 0; i < tmpKeys.length; i++) { tmpHeaders[tmpKeys[i]] = pExtraHeaders[tmpKeys[i]]; }
		}
		let tmpReq = libHttp.request(
			{
				hostname: tmpURL.hostname,
				port:     tmpURL.port || 80,
				path:     tmpURL.pathname + (tmpURL.search || ''),
				method:   'POST',
				headers:  tmpHeaders,
				agent:    KEEPALIVE_HTTP_AGENT
			},
			(pRes) =>
			{
				let tmpChunks = [];
				pRes.on('data', (pChunk) => tmpChunks.push(pChunk));
				pRes.on('end', () =>
					{
						let tmpRaw = Buffer.concat(tmpChunks).toString('utf8');
						let tmpBody = null;
						try { tmpBody = JSON.parse(tmpRaw); } catch (pErr) { /* leave null */ }
						return fCallback(null, tmpBody, pRes.statusCode, pRes.headers);
					});
			});
		tmpReq.on('error', (pErr) => fCallback(pErr));
		tmpReq.write(pBodyString || '');
		tmpReq.end();
	}

	_httpGetJSON(pURL, fCallback)
	{
		let tmpURL;
		try { tmpURL = new URL(pURL); } catch (pErr) { return fCallback(pErr); }
		let tmpReq = libHttp.request(
			{
				hostname: tmpURL.hostname,
				port:     tmpURL.port || 80,
				path:     tmpURL.pathname + (tmpURL.search || ''),
				method:   'GET',
				agent:    KEEPALIVE_HTTP_AGENT
			},
			(pRes) =>
			{
				let tmpChunks = [];
				pRes.on('data', (pChunk) => tmpChunks.push(pChunk));
				pRes.on('end', () =>
					{
						let tmpRaw = Buffer.concat(tmpChunks).toString('utf8');
						let tmpBody = null;
						try { tmpBody = JSON.parse(tmpRaw); } catch (pErr) { /* leave null */ }
						return fCallback(null, tmpBody, pRes.statusCode);
					});
			});
		tmpReq.on('error', (pErr) => fCallback(pErr));
		tmpReq.end();
	}
}

module.exports = ServiceOperationExerciseManager;
