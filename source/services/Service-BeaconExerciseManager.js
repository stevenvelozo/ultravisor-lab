/**
 * Service-BeaconExerciseManager
 *
 * Loads queue-testing scenarios from beacon_exercises/<name>/scenario.json,
 * provisions the synthetic beacons each scenario asks for, drives a
 * declared workload against the target Ultravisor's queue, taps the
 * queue.* WebSocket envelopes, persists run + event rows, and evaluates
 * structured assertions on the result.
 *
 * Public surface:
 *   list()                                     -- catalog
 *   get(pHash)                                  -- one scenario fixture
 *   run(pHash, pOptions, fCallback)             -- start a run; returns {IDBeaconExerciseRun, Status}
 *   listRuns()                                  -- historical runs
 *   getRun(pID)                                 -- one run + verdicts
 *   listRunEvents(pID, pPaging)                 -- raw envelopes for a run
 *   cancelRun(pID, fCallback)                   -- best-effort cancel of outstanding work items
 *
 * The scenario JSON shape lives at beacon_exercises/<name>/scenario.json:
 *   { Hash, Name, Description, Targets: { RequireUVName? },
 *     Beacons: [{ Name, Capability, Actions, MaxConcurrent, DefaultDurationMs, RunMode }],
 *     Workload: [{ Capability, Action, Count, Settings }],
 *     Cadence:  { Strategy: serial|burst|interleave, EnqueueIntervalMs },
 *     Assertions: { MaxDrainSeconds?, MinObservedConcurrencyByCapability?,
 *                   NoCrossCapabilityHeadOfLineBlocking?, MaxFailedItems? } }
 */

'use strict';

const libPath = require('path');
const libFs = require('fs');
const libHttp = require('http');
const libChildProcess = require('child_process');
const libFableServiceProviderBase = require('fable-serviceproviderbase');

const libQueueWebSocketTap = require('./queue/QueueWebSocketTap.js');

const BEACON_EXERCISES_ROOT = libPath.resolve(__dirname, '..', '..', 'beacon_exercises');
const SYNTHETIC_BEACON_BIN = libPath.resolve(__dirname, '..', 'synthetic-beacon', 'bin', 'synthetic-beacon-runner.js');

// The harness logs into the target UV with a hardcoded admin user it
// bootstraps on first run.  The credentials are intentionally trivial --
// scenario UVs are local test rigs created by the operator on demand.
// If the user already exists (re-run on the same UV), login just succeeds.
const HARNESS_ADMIN_USER = 'harness-admin';
const HARNESS_ADMIN_PASSWORD = 'harness-pass';

// Shared keep-alive HTTP agent — same shape and reasoning as
// Service-OperationExerciseManager. Bounded socket pool (maxSockets=64)
// + idle reuse window (keepAliveMsecs=30000) so a high-volume burst
// can't exhaust the local ephemeral-port table the way a fresh-socket
// per-request loop does.
const KEEPALIVE_HTTP_AGENT = new libHttp.Agent({
	keepAlive: true,
	maxSockets: 64,
	keepAliveMsecs: 30000
});

const TERMINAL_TOPICS = new Set(['queue.completed', 'queue.failed', 'queue.canceled']);
const RECOGNIZED_CAPABILITY_TOPICS = new Set(
	[
		'queue.enqueued',
		'queue.dispatched',
		'queue.running',
		'queue.completed',
		'queue.failed',
		'queue.canceled',
		// Phase 2: stall lifecycle.  queue.stalled removes the item
		// from the Pending/Running counters (the scheduler force-finalizes
		// it via the Coordinator's stall path); queue.unstalled puts a
		// recovered item back into Running.
		'queue.stalled',
		'queue.unstalled'
	]);

class ServiceBeaconExerciseManager extends libFableServiceProviderBase
{
	constructor(pFable, pOptions, pServiceHash)
	{
		super(pFable, pOptions, pServiceHash);
		this.serviceType = 'LabBeaconExerciseManager';

		this._catalog = this._buildCatalog();
		this._activeRuns = new Map();  // IDBeaconExerciseRun → run context
	}

	// ── Catalog ────────────────────────────────────────────────────────────

	_buildCatalog()
	{
		let tmpCatalog = [];
		let tmpEntries = [];
		try { tmpEntries = libFs.readdirSync(BEACON_EXERCISES_ROOT); }
		catch (pErr)
		{
			this.fable.log.warn(`BeaconExerciseManager: cannot read ${BEACON_EXERCISES_ROOT} (${pErr.message})`);
			return [];
		}
		for (let i = 0; i < tmpEntries.length; i++)
		{
			let tmpEntry = tmpEntries[i];
			if (tmpEntry.startsWith('_') || tmpEntry.startsWith('.')) { continue; }
			let tmpDir = libPath.join(BEACON_EXERCISES_ROOT, tmpEntry);
			let tmpScenarioPath = libPath.join(tmpDir, 'exercise.json');
			if (!libFs.existsSync(tmpScenarioPath)) { continue; }
			try
			{
				let tmpScenario = JSON.parse(libFs.readFileSync(tmpScenarioPath, 'utf8'));
				tmpCatalog.push({ FolderName: tmpEntry, ScenarioDir: tmpDir, Scenario: tmpScenario });
			}
			catch (pParseErr)
			{
				this.fable.log.warn(`BeaconExerciseManager: invalid scenario.json in ${tmpEntry}: ${pParseErr.message}`);
			}
		}
		return tmpCatalog;
	}

	list()
	{
		return this._catalog.map((pEntry) =>
			{
				let tmpScenario = pEntry.Scenario;
				return {
					FolderName:    pEntry.FolderName,
					Hash:          tmpScenario.Hash || pEntry.FolderName,
					Name:          tmpScenario.Name || pEntry.FolderName,
					Description:   tmpScenario.Description || '',
					BeaconCount:   Array.isArray(tmpScenario.Beacons) ? tmpScenario.Beacons.length : 0,
					WorkloadCount: this._totalWorkloadCount(tmpScenario),
					Cadence:       (tmpScenario.Cadence && tmpScenario.Cadence.Strategy) || 'burst'
				};
			});
	}

	get(pHash)
	{
		let tmpEntry = this._catalog.find((pE) =>
			(pE.Scenario.Hash || pE.FolderName) === pHash);
		return tmpEntry ? tmpEntry.Scenario : null;
	}

	_totalWorkloadCount(pScenario)
	{
		if (!pScenario || !Array.isArray(pScenario.Workload)) { return 0; }
		let tmpTotal = 0;
		for (let i = 0; i < pScenario.Workload.length; i++)
		{
			tmpTotal += (pScenario.Workload[i].Count || 0);
		}
		return tmpTotal;
	}

	// ── Persistence helpers ────────────────────────────────────────────────

	listRuns()
	{
		return this.fable.LabStateStore.list('BeaconExerciseRun');
	}

	getRun(pID)
	{
		let tmpID = parseInt(pID, 10);
		if (!Number.isFinite(tmpID) || tmpID <= 0) { return null; }
		return this.fable.LabStateStore.getById('BeaconExerciseRun', 'IDBeaconExerciseRun', tmpID);
	}

	listRunEvents(pID, pPaging)
	{
		let tmpID = parseInt(pID, 10);
		if (!Number.isFinite(tmpID) || tmpID <= 0) { return []; }
		// list() orders by PK DESC newest-first; we want chronological for
		// timeline reading.  Reverse here; offset/limit are applied by the
		// route layer if needed.
		let tmpRows = this.fable.LabStateStore.list('BeaconExerciseEvent',
			{ IDBeaconExerciseRun: tmpID });
		tmpRows.reverse();
		let tmpOffset = (pPaging && Number.isFinite(parseInt(pPaging.offset, 10))) ? parseInt(pPaging.offset, 10) : 0;
		let tmpLimit = (pPaging && Number.isFinite(parseInt(pPaging.limit, 10))) ? parseInt(pPaging.limit, 10) : tmpRows.length;
		return tmpRows.slice(tmpOffset, tmpOffset + tmpLimit);
	}

	// ── Run a scenario ─────────────────────────────────────────────────────

	run(pHash, pOptions, fCallback)
	{
		let tmpScenario = this.get(pHash);
		if (!tmpScenario) { return fCallback(new Error(`Unknown scenario: ${pHash}`)); }

		let tmpUVManager = this.fable.LabUltravisorManager;
		let tmpInstanceID = parseInt(pOptions && pOptions.IDUltravisorInstance, 10);
		let tmpInstance = null;
		if (Number.isFinite(tmpInstanceID) && tmpInstanceID > 0)
		{
			tmpInstance = tmpUVManager.getInstance(tmpInstanceID);
		}
		else if (tmpScenario.Targets && tmpScenario.Targets.RequireUVName)
		{
			let tmpAll = this.fable.LabStateStore.list('UltravisorInstance', { Name: tmpScenario.Targets.RequireUVName });
			tmpInstance = tmpAll.length > 0 ? tmpAll[0] : null;
		}
		if (!tmpInstance) { return fCallback(new Error('Target Ultravisor not found.')); }
		if (tmpInstance.Status !== 'running') { return fCallback(new Error(`Ultravisor '${tmpInstance.Name}' is not running.`)); }
		// Auth flow branches on the UV's mode + auth-beacon presence:
		//   - Secure + auth-beacon attached: bootstrap-or-login path
		//     produces a session cookie, sent on enqueues.
		//   - Promiscuous + no auth-beacon: UV's _requireSession (post
		//     anonymous-fallback fix, ultravisor>=1.0.31) synthesizes an
		//     anonymous session, so the harness enqueues without a
		//     cookie and the UV accepts it.
		// The two unsupported configs (Secure + no auth-beacon, or
		// promiscuous + auth-beacon attached) are surfaced to the
		// operator via the BeaconExercises view's hint and won't get this far.

		let tmpUVURL = `http://127.0.0.1:${tmpInstance.Port}`;

		// Persist the run row first so the IDBeaconExerciseRun is available
		// even if provisioning fails (the row records the failure).
		let tmpStartedAt = new Date().toISOString();
		let tmpRunID = this.fable.LabStateStore.insert('BeaconExerciseRun',
			{
				ScenarioHash:         tmpScenario.Hash || pHash,
				ScenarioName:         tmpScenario.Name || pHash,
				IDUltravisorInstance: tmpInstance.IDUltravisorInstance,
				Status:               'running',
				StartedAt:            tmpStartedAt,
				CompletedAt:          '',
				DrainMs:              0,
				TotalEnqueued:        0,
				TotalCompleted:       0,
				TotalFailed:          0,
				VerdictsJSON:         '',
				TimingJSON:           '',
				ErrorMessage:         ''
			});

		let tmpRunCtx =
			{
				IDBeaconExerciseRun: tmpRunID,
				Scenario:           tmpScenario,
				Instance:           tmpInstance,
				UVURL:              tmpUVURL,
				SessionCookie:      '',         // populated by _ensureLoggedIn
				UVRunID:            '',         // hub-assigned RunID from /Beacon/Run/Start; set in _startUVRun
				ChildProcesses:     [],          // PID list for child-process beacons
				BeaconsByName:      new Map(),   // Name → beacon spec (for assertion analysis)
				CapabilitySlots:    new Map(),   // Capability → total MaxConcurrent across scenario beacons
				OutstandingHashes:  new Set(),
				PendingByCapability:new Map(),   // Capability → Set<hash>
				RunningByCapability:new Map(),   // Capability → Set<hash>
				MaxConcurrencyByCapability: new Map(),
				CapabilityForHash:  new Map(),   // hash → Capability (since not all envelopes carry it)
				FailedHashes:       new Set(),
				CompletedHashes:    new Set(),
				EnqueuedHashes:     new Set(),
				// Phase 2: Stalled tracking for the MaxStalledItems and
				// StalledRecovered assertions.  EverStalledHashes counts
				// every distinct work item that flipped to Stalled at
				// least once during the run.  RecoveredStalledHashes
				// counts the subset that came back via queue.unstalled
				// before the operation finalized.
				EverStalledHashes:  new Set(),
				RecoveredStalledHashes: new Set(),
				FirstEnqueueAt:     0,
				FirstDispatchedAt:  0,
				DrainedAt:          0,
				EnvelopeCount:      0,
				HistoryReset:       false,
				Tap:                null,
				CompletionTimer:    null,
				FinishedSettling:   false,
				// Tracking for enqueue-side failures so the run row's
				// ErrorMessage carries the actual cause instead of a
				// downstream "Drain watchdog fired" symptom when nothing
				// ever made it onto the queue.
				EnqueueErrorCount:  0,
				FirstEnqueueError:  '',
				AbortReason:        ''
			};
		this._activeRuns.set(tmpRunID, tmpRunCtx);

		// Pre-compute the capability → slot count map from the scenario.
		this._buildCapabilitySlotMap(tmpScenario, tmpRunCtx);

		// Login (bootstrapping the admin if first run) → start UV Run →
		// provision beacons → start tap → drive cadence → wait for drain.
		// Wrapping every scenario in a hub-owned Run (via /Beacon/Run/Start)
		// makes the work items first-class citizens of UV's execution
		// machinery: each item's RunID is set, the run shows up in UV's
		// /Beacon/Queue, and a manifest is finalized on End.  Without
		// this, items dispatch but UV sees them as orphan work items
		// with no Run wrapping them and no manifest entry.
		this._ensureLoggedIn(tmpRunCtx, (pLoginErr) =>
			{
				if (pLoginErr)
				{
					this._finishRun(tmpRunCtx, 'failed', pLoginErr.message);
					return;
				}
				this._startUVRun(tmpRunCtx, (pRunErr) =>
					{
						if (pRunErr)
						{
							this._finishRun(tmpRunCtx, 'failed', pRunErr.message);
							return;
						}
						this._provisionBeacons(tmpRunCtx, (pProvisionErr) =>
							{
								if (pProvisionErr)
								{
									this._finishRun(tmpRunCtx, 'failed', pProvisionErr.message);
									return;
								}
								this._startWebSocketTap(tmpRunCtx);
								this._driveCadence(tmpRunCtx);
								this._armDrainWatchdog(tmpRunCtx);
							});
					});
			});

		return fCallback(null, { IDBeaconExerciseRun: tmpRunID, Status: 'running' });
	}

	// ── Auth: bootstrap-if-needed + login ──────────────────────────────────

	_ensureLoggedIn(pCtx, fCallback)
	{
		// Promiscuous UVs (Secure: false, no BootstrapAuthSecret) rely
		// on the UV's anonymous-fallback path -- /Beacon/Work/Enqueue
		// returns a synthetic anonymous session when no auth-beacon is
		// connected.  No login required; SessionCookie stays empty.
		// Requires ultravisor>=1.0.31 in the running container; older
		// versions will 401 unconditionally and the run will fail with
		// a clear "Enqueue rejected" error from _enqueueOne.
		if (!pCtx.Instance.Secure || !pCtx.Instance.BootstrapAuthSecret)
		{
			return fCallback(null);
		}

		// Try login first.  If the admin already exists from a prior run,
		// this short-circuits the bootstrap path entirely.
		this._login(pCtx, (pLoginErr, pCookie) =>
			{
				if (!pLoginErr && pCookie)
				{
					pCtx.SessionCookie = pCookie;
					return fCallback(null);
				}
				// Login failed.  Bootstrap the admin and retry.  Bootstrap
				// can only run on a Secure UV that hasn't been bootstrapped
				// yet -- both checks happen inside _bootstrapAdmin.
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
					// Take the first cookie's name=value pair (everything before the first ';').
					tmpCookie = tmpSetCookie[0].split(';')[0];
				}
				return fCallback(null, tmpCookie);
			});
	}

	// ── UV Run lifecycle (wraps the scenario in a hub-owned Run) ──────────

	_startUVRun(pCtx, fCallback)
	{
		// Attach the scenario's stable hash as IdempotencyKey so a
		// re-run of the same scenario against the same UV doesn't
		// stack up duplicate Run rows on UV's side -- it's the run-
		// manager's job to dedup.  IdempotencyKey is conceptually a
		// per-attempt token; we'd usually generate a new one each
		// click, but for the harness's repeat-runs flow re-using the
		// hash is fine (and makes audit history terser).
		let tmpBody = JSON.stringify(
			{
				IdempotencyKey: `qs-${pCtx.Scenario.Hash || ''}-${pCtx.IDBeaconExerciseRun}`,
				SubmitterTag:   'ultravisor-lab/beacon-exercise',
				Metadata:
					{
						ScenarioHash: pCtx.Scenario.Hash || '',
						ScenarioName: pCtx.Scenario.Name || '',
						IDBeaconExerciseRun: pCtx.IDBeaconExerciseRun
					}
			});
		this._httpPostJSON(pCtx.UVURL + '/Beacon/Run/Start', tmpBody, this._cookieHeaders(pCtx),
			(pErr, pResponse, pStatus) =>
			{
				if (pErr) { return fCallback(new Error(`Run/Start failed: ${pErr.message}`)); }
				if (pStatus >= 400)
				{
					let tmpDetail = (pResponse && pResponse.Error) || `HTTP ${pStatus}`;
					return fCallback(new Error(`Run/Start rejected: ${tmpDetail}`));
				}
				if (!pResponse || !pResponse.RunID)
				{
					return fCallback(new Error('Run/Start succeeded but no RunID in response.'));
				}
				pCtx.UVRunID = pResponse.RunID;
				this.fable.log.info(`BeaconExerciseManager: scenario run ${pCtx.IDBeaconExerciseRun} → UV RunID=${pCtx.UVRunID}`);
				return fCallback(null);
			});
	}

	_endUVRun(pCtx, pState, fCallback)
	{
		// Best-effort.  If End fails (e.g. UV unreachable mid-teardown),
		// log and proceed -- the lab-side run row is already final.
		if (!pCtx.UVRunID)
		{
			return fCallback ? fCallback(null) : null;
		}
		let tmpURL = `${pCtx.UVURL}/Beacon/Run/${encodeURIComponent(pCtx.UVRunID)}/End`;
		let tmpBody = JSON.stringify({ State: pState || 'Ended' });
		this._httpPostJSON(tmpURL, tmpBody, this._cookieHeaders(pCtx), (pErr, pResponse, pStatus) =>
			{
				if (pErr || pStatus >= 400)
				{
					let tmpReason = pErr ? pErr.message : `HTTP ${pStatus}: ${(pResponse && pResponse.Error) || ''}`;
					this.fable.log.warn(`BeaconExerciseManager: Run/End failed for run ${pCtx.IDBeaconExerciseRun} (UV RunID=${pCtx.UVRunID}): ${tmpReason}`);
				}
				return fCallback ? fCallback(null) : null;
			});
	}

	_bootstrapAdmin(pCtx, fCallback)
	{
		let tmpInstance = pCtx.Instance;
		// We do NOT short-circuit on the lab row's `Bootstrapped` flag.
		// The auth-beacon's MemoryAuthProvider keeps the bootstrap-token
		// flag in-memory; if the auth beacon was restarted (lab restart,
		// container restart) the in-memory user dataset is gone but the
		// row flag persists.  In that case we need to re-bootstrap so the
		// fresh auth beacon learns about the harness-admin user again.
		// If the auth beacon's flag is already consumed (no restart, but
		// login still failed for some other reason), the BootstrapAdmin
		// call will return Success: false with a clear reason -- which is
		// what the operator should see, not a stale "already bootstrapped"
		// error from the lab row.
		let tmpPayload = JSON.stringify(
			{
				Token: tmpInstance.BootstrapAuthSecret,
				UserSpec:
				{
					Username: HARNESS_ADMIN_USER,
					Password: HARNESS_ADMIN_PASSWORD,
					Roles: ['admin'],
					FullName: 'Queue Scenario Harness Admin',
					Email: 'harness-admin@ultravisor-lab.local'
				}
			});
		this._httpPostJSON(pCtx.UVURL + '/Beacon/BootstrapAdmin', tmpPayload, null, (pErr, pBody, pStatus) =>
			{
				if (pErr) { return fCallback(pErr); }
				if (!pBody || pBody.Success !== true)
				{
					return fCallback(new Error(`Bootstrap admin failed: ${(pBody && pBody.Reason) || 'unknown'}`));
				}
				// Mark the row Bootstrapped so future runs skip this branch.
				try
				{
					this.fable.LabStateStore.update('UltravisorInstance', 'IDUltravisorInstance',
						tmpInstance.IDUltravisorInstance, { Bootstrapped: true });
				}
				catch (pUpdateErr) { /* best-effort */ }
				return fCallback(null);
			});
	}

	_buildCapabilitySlotMap(pScenario, pCtx)
	{
		if (!Array.isArray(pScenario.Beacons)) { return; }
		for (let i = 0; i < pScenario.Beacons.length; i++)
		{
			let tmpBeacon = pScenario.Beacons[i];
			pCtx.BeaconsByName.set(tmpBeacon.Name, tmpBeacon);
			let tmpCap = tmpBeacon.Capability;
			let tmpMax = Number.isFinite(tmpBeacon.MaxConcurrent) ? tmpBeacon.MaxConcurrent : 1;
			pCtx.CapabilitySlots.set(tmpCap, (pCtx.CapabilitySlots.get(tmpCap) || 0) + tmpMax);
		}
	}

	// ── Beacon provisioning ────────────────────────────────────────────────

	_provisionBeacons(pCtx, fCallback)
	{
		let tmpBeacons = pCtx.Scenario.Beacons || [];
		if (tmpBeacons.length === 0) { return fCallback(null); }

		let tmpRemaining = tmpBeacons.length;
		let tmpFailed = false;
		let fOne = (pErr) =>
			{
				if (tmpFailed) { return; }
				if (pErr) { tmpFailed = true; return fCallback(pErr); }
				tmpRemaining--;
				if (tmpRemaining === 0) { return fCallback(null); }
			};

		for (let i = 0; i < tmpBeacons.length; i++)
		{
			let tmpBeacon = tmpBeacons[i];
			let tmpMode = tmpBeacon.RunMode || 'child-process';
			if (tmpMode === 'child-process')
			{
				this._spawnChildProcessBeacon(pCtx, tmpBeacon, fOne);
			}
			else if (tmpMode === 'docker')
			{
				this._provisionDockerBeacon(pCtx, tmpBeacon, fOne);
			}
			else
			{
				return fCallback(new Error(`Unknown RunMode '${tmpMode}' for beacon '${tmpBeacon.Name}'`));
			}
		}
	}

	_spawnChildProcessBeacon(pCtx, pBeaconSpec, fCallback)
	{
		// Secure UVs require the BootstrapAuthSecret as the join secret.
		// Promiscuous UVs accept empty.  Both paths are covered here so a
		// single spawn helper works regardless of UV mode.
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
			'--default-duration-ms', String(pBeaconSpec.DefaultDurationMs || 2000)
		];
		let tmpChild;
		try
		{
			tmpChild = libChildProcess.spawn(process.execPath, tmpArgs,
				{ stdio: ['ignore', 'pipe', 'pipe'] });
		}
		catch (pErr) { return fCallback(pErr); }

		pCtx.ChildProcesses.push(
			{ PID: tmpChild.pid, BeaconName: pBeaconSpec.Name, Process: tmpChild });

		let tmpStderrBuf = '';
		tmpChild.stderr.on('data', (pBuf) => { tmpStderrBuf += pBuf.toString('utf8'); });
		tmpChild.stdout.on('data', () => { /* ignore stdout */ });
		tmpChild.on('error', (pErr) =>
			{
				this.fable.log.warn(`Synthetic beacon '${pBeaconSpec.Name}' child-process error: ${pErr.message}`);
			});
		tmpChild.on('exit', (pCode, pSignal) =>
			{
				if (pCode !== 0 && pCode !== null && !pCtx.FinishedSettling)
				{
					this.fable.log.warn(
						`Synthetic beacon '${pBeaconSpec.Name}' exited with code ${pCode} (sig ${pSignal}).  Stderr: ${tmpStderrBuf.slice(-200)}`);
				}
			});

		this._waitForBeaconRegistered(pCtx, pBeaconSpec, 0, fCallback);
	}

	_waitForBeaconRegistered(pCtx, pBeaconSpec, pAttempt, fCallback)
	{
		if (pAttempt >= 30) { return fCallback(new Error(`Beacon '${pBeaconSpec.Name}' did not register within 30 attempts (15s).`)); }
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

	_provisionDockerBeacon(pCtx, pBeaconSpec, fCallback)
	{
		// Docker mode goes through the lab beacon manager.  For v1, child-
		// process is the supported path; Docker mode requires the container
		// manager to know how to stage the lab-local synthetic-beacon source
		// into the build context (see the Dockerfile's wiring note).  Until
		// that's verified end-to-end, fail fast with a clear message rather
		// than silently degrade.
		return fCallback(new Error(
			`Docker mode for synthetic beacons is not yet wired to the container manager.  ` +
			`Use RunMode='child-process' (the v1 default) for beacon '${pBeaconSpec.Name}'.`));
	}

	// ── WebSocket tap ──────────────────────────────────────────────────────

	_startWebSocketTap(pCtx)
	{
		pCtx.Tap = new libQueueWebSocketTap(
			{
				ServerURL: pCtx.UVURL,
				OnEnvelope: (pEnv) => this._handleEnvelope(pCtx, pEnv),
				OnError: (pErr) =>
					{
						this.fable.log.warn(`BeaconExerciseManager: WS tap error on run ${pCtx.IDBeaconExerciseRun}: ${pErr.message || pErr}`);
					},
				OnReset: () => { pCtx.HistoryReset = true; },
				Log: this.fable.log
			});
		pCtx.Tap.start();
	}

	_handleEnvelope(pCtx, pEnvelope)
	{
		pCtx.EnvelopeCount++;

		// Persist the envelope row (best-effort; storage failures are
		// surfaced via log but don't tank the run).
		let tmpPayload = pEnvelope.Payload || {};
		let tmpHash = tmpPayload.WorkItemHash || '';
		let tmpCap = tmpPayload.Capability || (tmpHash && pCtx.CapabilityForHash.get(tmpHash)) || '';
		let tmpBeaconID = tmpPayload.BeaconID || tmpPayload.AssignedBeaconID || '';
		try
		{
			this.fable.LabStateStore.insert('BeaconExerciseEvent',
				{
					IDBeaconExerciseRun: pCtx.IDBeaconExerciseRun,
					Topic:              pEnvelope.Topic || '',
					EventGUID:          pEnvelope.EventGUID || '',
					WorkItemHash:       tmpHash,
					Capability:         tmpCap,
					BeaconID:           tmpBeaconID,
					EmittedAt:          pEnvelope.EmittedAt || new Date().toISOString(),
					PayloadJSON:        JSON.stringify(tmpPayload)
				});
		}
		catch (pErr)
		{
			this.fable.log.warn(`BeaconExerciseManager: could not persist event row: ${pErr.message}`);
		}

		// queue.summary carries per-capability { Queued, Running, Stalled }
		// snapshots we use to track peak concurrency.  The scheduler emits
		// these on a fixed cadence (~1s), so they're a stable signal even
		// when work items are pushed directly via WebSocket (which bypasses
		// queue.dispatched broadcasts).
		if (pEnvelope.Topic === 'queue.summary')
		{
			let tmpByCap = (pEnvelope.Payload && Array.isArray(pEnvelope.Payload.ByCapability))
				? pEnvelope.Payload.ByCapability
				: [];
			for (let i = 0; i < tmpByCap.length; i++)
			{
				let tmpRow = tmpByCap[i];
				if (!tmpRow || !tmpRow.Capability) { continue; }
				let tmpRunning = Number.isFinite(tmpRow.Running) ? tmpRow.Running : 0;
				let tmpPeak = pCtx.MaxConcurrencyByCapability.get(tmpRow.Capability) || 0;
				if (tmpRunning > tmpPeak) { pCtx.MaxConcurrencyByCapability.set(tmpRow.Capability, tmpRunning); }
			}
			return;
		}

		// Update in-memory counters.  Skip envelopes that aren't for our
		// scenario's hashes (other clients may share this UV).
		if (!RECOGNIZED_CAPABILITY_TOPICS.has(pEnvelope.Topic)) { return; }
		if (!tmpHash || !pCtx.OutstandingHashes.has(tmpHash))
		{
			// queue.enqueued may arrive before we registered the hash if the
			// runner is enqueueing in parallel; tolerate by skipping.
			return;
		}
		if (tmpCap && !pCtx.CapabilityForHash.has(tmpHash))
		{
			pCtx.CapabilityForHash.set(tmpHash, tmpCap);
		}
		else if (!tmpCap && pCtx.CapabilityForHash.has(tmpHash))
		{
			tmpCap = pCtx.CapabilityForHash.get(tmpHash);
		}
		if (!tmpCap) { return; }

		switch (pEnvelope.Topic)
		{
			case 'queue.enqueued':
				this._setAdd(pCtx.PendingByCapability, tmpCap, tmpHash);
				if (!pCtx.FirstEnqueueAt) { pCtx.FirstEnqueueAt = Date.now(); }
				break;
			case 'queue.dispatched':
				if (!pCtx.FirstDispatchedAt) { pCtx.FirstDispatchedAt = Date.now(); }
				break;
			case 'queue.running':
				this._setRemove(pCtx.PendingByCapability, tmpCap, tmpHash);
				this._setAdd(pCtx.RunningByCapability, tmpCap, tmpHash);
				this._observeMaxConcurrency(pCtx, tmpCap);
				if (!pCtx.FirstDispatchedAt) { pCtx.FirstDispatchedAt = Date.now(); }
				break;
			case 'queue.completed':
				pCtx.CompletedHashes.add(tmpHash);
				pCtx.OutstandingHashes.delete(tmpHash);
				this._setRemove(pCtx.PendingByCapability, tmpCap, tmpHash);
				this._setRemove(pCtx.RunningByCapability, tmpCap, tmpHash);
				this._maybeFinishOnDrain(pCtx);
				break;
			case 'queue.failed':
				pCtx.FailedHashes.add(tmpHash);
				pCtx.OutstandingHashes.delete(tmpHash);
				this._setRemove(pCtx.PendingByCapability, tmpCap, tmpHash);
				this._setRemove(pCtx.RunningByCapability, tmpCap, tmpHash);
				this._maybeFinishOnDrain(pCtx);
				break;
			case 'queue.canceled':
				pCtx.OutstandingHashes.delete(tmpHash);
				this._setRemove(pCtx.PendingByCapability, tmpCap, tmpHash);
				this._setRemove(pCtx.RunningByCapability, tmpCap, tmpHash);
				this._maybeFinishOnDrain(pCtx);
				break;
			case 'queue.stalled':
				// Track for MaxStalledItems assertion.  The Coordinator's
				// stall path force-finalizes the work item; we expect a
				// follow-on queue.failed/queue.completed in most paths,
				// but treat the stall itself as terminal for accounting
				// (drop from Pending/Running and decrement Outstanding)
				// so the drain watchdog doesn't hang waiting for a
				// completion that won't arrive.
				pCtx.EverStalledHashes.add(tmpHash);
				pCtx.OutstandingHashes.delete(tmpHash);
				this._setRemove(pCtx.PendingByCapability, tmpCap, tmpHash);
				this._setRemove(pCtx.RunningByCapability, tmpCap, tmpHash);
				this._maybeFinishOnDrain(pCtx);
				break;
			case 'queue.unstalled':
				// Item recovered before stall-finalize landed.  Put it
				// back into RunningByCapability and re-add to Outstanding
				// so the drain accounting reflects reality.
				pCtx.RecoveredStalledHashes.add(tmpHash);
				pCtx.OutstandingHashes.add(tmpHash);
				this._setAdd(pCtx.RunningByCapability, tmpCap, tmpHash);
				break;
		}
	}

	_setAdd(pMap, pKey, pValue)
	{
		if (!pMap.has(pKey)) { pMap.set(pKey, new Set()); }
		pMap.get(pKey).add(pValue);
	}

	_setRemove(pMap, pKey, pValue)
	{
		let tmpSet = pMap.get(pKey);
		if (tmpSet) { tmpSet.delete(pValue); }
	}

	_observeMaxConcurrency(pCtx, pCap)
	{
		let tmpRunning = pCtx.RunningByCapability.get(pCap);
		let tmpCurrent = tmpRunning ? tmpRunning.size : 0;
		let tmpPeak = pCtx.MaxConcurrencyByCapability.get(pCap) || 0;
		if (tmpCurrent > tmpPeak) { pCtx.MaxConcurrencyByCapability.set(pCap, tmpCurrent); }
	}

	// ── Cadence drivers ────────────────────────────────────────────────────

	_driveCadence(pCtx)
	{
		let tmpStrategy = (pCtx.Scenario.Cadence && pCtx.Scenario.Cadence.Strategy) || 'burst';
		let tmpItems = this._expandWorkload(pCtx.Scenario);
		if (tmpItems.length === 0) { this._maybeFinishOnDrain(pCtx); return; }
		switch (tmpStrategy)
		{
			case 'serial':     this._driveSerial(pCtx, tmpItems);     break;
			case 'interleave': this._driveInterleave(pCtx, tmpItems); break;
			case 'burst':
			default:           this._driveBurst(pCtx, tmpItems);
		}
	}

	_expandWorkload(pScenario)
	{
		let tmpItems = [];
		let tmpWorkload = pScenario.Workload || [];
		for (let i = 0; i < tmpWorkload.length; i++)
		{
			let tmpEntry = tmpWorkload[i];
			let tmpCount = tmpEntry.Count || 0;
			for (let n = 0; n < tmpCount; n++)
			{
				tmpItems.push(
					{
						Capability: tmpEntry.Capability,
						Action:     tmpEntry.Action,
						Settings:   Object.assign({}, tmpEntry.Settings || {}),
						EntryIndex: i,
						SubIndex:   n
					});
			}
		}
		return tmpItems;
	}

	_driveBurst(pCtx, pItems)
	{
		for (let i = 0; i < pItems.length; i++)
		{
			this._enqueueOne(pCtx, pItems[i], i, () => { /* counters tracked via WS */ });
		}
	}

	_driveInterleave(pCtx, pItems)
	{
		// Group by Workload entry, then round-robin one from each in turn.
		let tmpGroups = [];
		let tmpByEntry = new Map();
		for (let i = 0; i < pItems.length; i++)
		{
			let tmpEntry = pItems[i].EntryIndex;
			if (!tmpByEntry.has(tmpEntry)) { tmpByEntry.set(tmpEntry, []); tmpGroups.push(tmpEntry); }
			tmpByEntry.get(tmpEntry).push(pItems[i]);
		}
		let tmpInterval = (pCtx.Scenario.Cadence && Number.isFinite(pCtx.Scenario.Cadence.EnqueueIntervalMs))
			? pCtx.Scenario.Cadence.EnqueueIntervalMs
			: 50;
		let tmpScheduleIndex = 0;
		let tmpEnqueueAtMs = 0;
		while (true)
		{
			let tmpEmittedAny = false;
			for (let g = 0; g < tmpGroups.length; g++)
			{
				let tmpQueue = tmpByEntry.get(tmpGroups[g]);
				if (tmpQueue.length === 0) { continue; }
				let tmpItem = tmpQueue.shift();
				let tmpDelay = tmpEnqueueAtMs;
				let tmpIdx = tmpScheduleIndex++;
				setTimeout(() =>
					{
						this._enqueueOne(pCtx, tmpItem, tmpIdx, () => {});
					}, tmpDelay);
				tmpEnqueueAtMs += tmpInterval;
				tmpEmittedAny = true;
			}
			if (!tmpEmittedAny) { break; }
		}
	}

	_driveSerial(pCtx, pItems)
	{
		// Enqueue first; on terminal event for that hash, enqueue next.
		// Implemented by latching on _maybeFinishOnDrain and the per-hash
		// Outstanding tracking: we only enqueue [n+1] when [n] has settled.
		let tmpIdx = 0;
		let fNext = () =>
			{
				if (tmpIdx >= pItems.length) { return; }
				let tmpItem = pItems[tmpIdx];
				let tmpThisIdx = tmpIdx;
				tmpIdx++;
				this._enqueueOne(pCtx, tmpItem, tmpThisIdx, () =>
					{
						// Wait for this hash to land terminal before next enqueue.
						let tmpInterval = setInterval(() =>
							{
								if (pCtx.FinishedSettling) { clearInterval(tmpInterval); return; }
								if (pCtx.OutstandingHashes.size === 0)
								{
									clearInterval(tmpInterval);
									fNext();
								}
							}, 50);
					});
			};
		fNext();
	}

	_enqueueOne(pCtx, pItem, pIdx, fCallback)
	{
		let tmpBody = JSON.stringify(
			{
				Capability: pItem.Capability,
				Action:     pItem.Action,
				Settings:   pItem.Settings || {},
				RunID:      pCtx.UVRunID || '',
				Metadata:
					{
						ScenarioRunID:    pCtx.IDBeaconExerciseRun,
						ScenarioItemIdx:  pIdx
					}
			});
		// Don't keep firing enqueues against a UV that's already
		// rejected one before any item landed -- the run is going to
		// fail the same way 20 times in a row otherwise.  AbortReason
		// is set the moment we decide to short-circuit.
		if (pCtx.AbortReason)
		{
			return fCallback(new Error(pCtx.AbortReason));
		}

		this._httpPostJSON(pCtx.UVURL + '/Beacon/Work/Enqueue', tmpBody, this._cookieHeaders(pCtx), (pErr, pResponse, pStatus) =>
			{
				let tmpReason = '';
				if (pErr)
				{
					tmpReason = pErr.message || String(pErr);
				}
				else if (pStatus >= 400)
				{
					let tmpDetail = (pResponse && pResponse.Error) || (pResponse ? JSON.stringify(pResponse).slice(0, 160) : '');
					tmpReason = `HTTP ${pStatus}` + (tmpDetail ? ` — ${tmpDetail}` : '');
				}

				if (tmpReason)
				{
					pCtx.EnqueueErrorCount++;
					if (!pCtx.FirstEnqueueError) { pCtx.FirstEnqueueError = tmpReason; }
					this.fable.log.warn(`BeaconExerciseManager: enqueue failed for run ${pCtx.IDBeaconExerciseRun} (item ${pIdx}): ${tmpReason}`);
					// Fail fast when the very first attempts all fail
					// before any item has landed.  Without this the
					// drain watchdog (≥35s) would fire with a symptom
					// message; this surfaces the actual cause now.
					if (pCtx.EnqueuedHashes.size === 0 && !pCtx.FinishedSettling)
					{
						pCtx.AbortReason = tmpReason;
						this._finishRun(pCtx, 'failed', `Enqueue rejected: ${tmpReason}`);
					}
					return fCallback(new Error(`Enqueue rejected: ${tmpReason}`));
				}

				if (pResponse && pResponse.WorkItemHash)
				{
					pCtx.OutstandingHashes.add(pResponse.WorkItemHash);
					pCtx.EnqueuedHashes.add(pResponse.WorkItemHash);
					pCtx.CapabilityForHash.set(pResponse.WorkItemHash, pItem.Capability);
					if (!pCtx.FirstEnqueueAt) { pCtx.FirstEnqueueAt = Date.now(); }
				}
				return fCallback(null, pResponse);
			});
	}

	// ── Drain detection + finalize ─────────────────────────────────────────

	_armDrainWatchdog(pCtx)
	{
		let tmpMaxSec = (pCtx.Scenario.Assertions && Number.isFinite(pCtx.Scenario.Assertions.MaxDrainSeconds))
			? pCtx.Scenario.Assertions.MaxDrainSeconds
			: 120;
		// Add 10s grace so the watchdog only fires if the assertion would
		// have failed anyway.  Real failure surfaces via the assertion engine.
		pCtx.CompletionTimer = setTimeout(() =>
			{
				if (pCtx.FinishedSettling) { return; }
				this._finishRun(pCtx, 'timed-out', `Drain watchdog fired after ${tmpMaxSec + 10}s.`);
			}, (tmpMaxSec + 10) * 1000);
		if (pCtx.CompletionTimer.unref) { pCtx.CompletionTimer.unref(); }
	}

	_maybeFinishOnDrain(pCtx)
	{
		if (pCtx.FinishedSettling) { return; }
		if (pCtx.OutstandingHashes.size > 0) { return; }
		// All known hashes have a terminal envelope.  Give a brief settle
		// window so any tail envelopes (queue.summary) land before we lock
		// counters and persist.
		setTimeout(() =>
			{
				if (pCtx.FinishedSettling) { return; }
				if (pCtx.OutstandingHashes.size > 0) { return; }
				pCtx.DrainedAt = Date.now();
				this._finishRun(pCtx, 'complete', '');
			}, 250);
	}

	_finishRun(pCtx, pStatus, pErrorMessage)
	{
		if (pCtx.FinishedSettling) { return; }
		pCtx.FinishedSettling = true;
		if (pCtx.CompletionTimer) { clearTimeout(pCtx.CompletionTimer); pCtx.CompletionTimer = null; }

		let tmpDrainedAt = pCtx.DrainedAt || Date.now();
		let tmpDrainMs = pCtx.FirstEnqueueAt ? (tmpDrainedAt - pCtx.FirstEnqueueAt) : 0;

		let tmpVerdicts = (pStatus === 'complete')
			? this._evaluateAssertions(pCtx, tmpDrainMs)
			: [];

		let tmpTiming =
			{
				EnqueuedAtMs:       pCtx.FirstEnqueueAt || 0,
				FirstDispatchedAt:  pCtx.FirstDispatchedAt || 0,
				DrainedAtMs:        tmpDrainedAt,
				DrainMs:            tmpDrainMs,
				DrainSeconds:       Math.round(tmpDrainMs / 100) / 10,
				EnvelopeCount:      pCtx.EnvelopeCount,
				HistoryReset:       pCtx.HistoryReset
			};

		let tmpFinalStatus = pStatus;
		if (pStatus === 'complete' && tmpVerdicts.some((pV) => pV.Pass === false))
		{
			tmpFinalStatus = 'failed-assertions';
		}

		// Promote enqueue-side errors into the run row when the
		// caller-supplied message doesn't already cover them.  The
		// fast-fail path in _enqueueOne already passes a fully-formed
		// reason via pErrorMessage and sets pCtx.AbortReason; in that
		// case we don't want to append a duplicate.  We DO append when
		// _finishRun was reached via a different path (watchdog, cancel,
		// manual stop) and there are still enqueue errors worth
		// surfacing.
		let tmpErrorMessage = pErrorMessage || '';
		if (pCtx.FirstEnqueueError && !pCtx.AbortReason)
		{
			let tmpFromEnqueue = (pCtx.EnqueuedHashes.size === 0)
				? `Enqueue failed (${pCtx.EnqueueErrorCount} attempts): ${pCtx.FirstEnqueueError}`
				: `${pCtx.EnqueueErrorCount} enqueue error(s); first: ${pCtx.FirstEnqueueError}`;
			tmpErrorMessage = tmpErrorMessage
				? (tmpErrorMessage + ' — ' + tmpFromEnqueue)
				: tmpFromEnqueue;
		}

		let tmpMaxConcurrencyByCapability = {};
		pCtx.MaxConcurrencyByCapability.forEach((pV, pK) => { tmpMaxConcurrencyByCapability[pK] = pV; });

		try
		{
			this.fable.LabStateStore.update('BeaconExerciseRun', 'IDBeaconExerciseRun', pCtx.IDBeaconExerciseRun,
				{
					Status:         tmpFinalStatus,
					CompletedAt:    new Date().toISOString(),
					DrainMs:        tmpDrainMs,
					TotalEnqueued:  pCtx.EnqueuedHashes.size,
					TotalCompleted: pCtx.CompletedHashes.size,
					TotalFailed:    pCtx.FailedHashes.size,
					VerdictsJSON:   JSON.stringify({ Verdicts: tmpVerdicts, MaxConcurrencyByCapability: tmpMaxConcurrencyByCapability }),
					TimingJSON:     JSON.stringify(tmpTiming),
					ErrorMessage:   tmpErrorMessage
				});
		}
		catch (pErr)
		{
			this.fable.log.warn(`BeaconExerciseManager: could not finalize run row ${pCtx.IDBeaconExerciseRun}: ${pErr.message}`);
		}

		try
		{
			this.fable.LabStateStore.recordEvent(
				{
					EntityType: 'BeaconExerciseRun',
					EntityID:   pCtx.IDBeaconExerciseRun,
					EntityName: pCtx.Scenario.Name || pCtx.Scenario.Hash || '',
					EventType:  'beacon-exercise-' + tmpFinalStatus,
					Severity:   tmpFinalStatus === 'complete' ? 'info' : 'warning',
					Message:    `Scenario '${pCtx.Scenario.Name}' ended ${tmpFinalStatus} (drain ${tmpTiming.DrainSeconds}s)`,
					Detail:     JSON.stringify(
						{
							Verdicts: tmpVerdicts,
							Timing:   tmpTiming,
							ErrorMessage: tmpErrorMessage
						})
				});
		}
		catch (pErr) { /* event logging is best-effort */ }

		this._teardownRun(pCtx);
	}

	_teardownRun(pCtx)
	{
		// End the UV-side Run so the manifest pipeline finalizes.
		// Map the lab-side terminal state to a sensible UV state:
		//   complete           → 'Ended'
		//   failed-assertions  → 'Ended' (the work itself completed; the
		//                                 lab's verdict layer judged it)
		//   failed / timed-out → 'Failed'
		//   canceled           → 'Canceled'
		// Best-effort; failures are logged and don't block teardown.
		let tmpUVState = 'Ended';
		// We don't have direct access to the run row's Status here,
		// but pCtx.AbortReason / OutstandingHashes give us enough.
		if (pCtx.AbortReason || (pCtx.FirstEnqueueError && pCtx.EnqueuedHashes.size === 0))
		{
			tmpUVState = 'Failed';
		}
		else if (pCtx.OutstandingHashes.size > 0)
		{
			// Watchdog or cancel path with items still in flight.
			tmpUVState = (pCtx.FailedHashes.size > 0) ? 'Failed' : 'Canceled';
		}
		this._endUVRun(pCtx, tmpUVState);

		if (pCtx.Tap) { try { pCtx.Tap.stop(); } catch (pErr) { /* best effort */ } pCtx.Tap = null; }
		for (let i = 0; i < pCtx.ChildProcesses.length; i++)
		{
			let tmpChild = pCtx.ChildProcesses[i];
			try { tmpChild.Process.kill('SIGTERM'); }
			catch (pErr) { /* best effort */ }
		}
		// Hard-kill grace.
		setTimeout(() =>
			{
				for (let i = 0; i < pCtx.ChildProcesses.length; i++)
				{
					let tmpChild = pCtx.ChildProcesses[i];
					try { tmpChild.Process.kill('SIGKILL'); }
					catch (pErr) { /* gone already */ }
				}
			}, 5000).unref();
		this._activeRuns.delete(pCtx.IDBeaconExerciseRun);
	}

	// ── Cancel ─────────────────────────────────────────────────────────────

	cancelRun(pID, fCallback)
	{
		let tmpID = parseInt(pID, 10);
		let tmpCtx = this._activeRuns.get(tmpID);
		if (!tmpCtx) { return fCallback(new Error(`Run ${tmpID} is not active.`)); }
		let tmpHashes = Array.from(tmpCtx.OutstandingHashes);
		let tmpRemaining = tmpHashes.length;
		let tmpUncancelable = [];
		if (tmpRemaining === 0)
		{
			this._finishRun(tmpCtx, 'canceled', 'No outstanding work items at cancel time.');
			return fCallback(null, { Canceled: 0, Uncancelable: [] });
		}
		for (let i = 0; i < tmpHashes.length; i++)
		{
			let tmpHash = tmpHashes[i];
			let tmpURL = `${tmpCtx.UVURL}/Beacon/Work/${encodeURIComponent(tmpHash)}/Cancel`;
			this._httpPostJSON(tmpURL, '{}', this._cookieHeaders(tmpCtx), (pErr, pBody) =>
				{
					if (pErr || !pBody || pBody.Canceled === false) { tmpUncancelable.push(tmpHash); }
					tmpRemaining--;
					if (tmpRemaining === 0)
					{
						this._finishRun(tmpCtx, 'canceled', `Cancel issued; uncancelable=${tmpUncancelable.length}`);
						fCallback(null, { Canceled: tmpHashes.length - tmpUncancelable.length, Uncancelable: tmpUncancelable });
					}
				});
		}
	}

	_cookieHeaders(pCtx)
	{
		return pCtx.SessionCookie ? { Cookie: pCtx.SessionCookie } : null;
	}

	// ── Assertion engine ───────────────────────────────────────────────────

	_evaluateAssertions(pCtx, pDrainMs)
	{
		let tmpResults = [];
		let tmpAsserts = pCtx.Scenario.Assertions || {};

		if (Number.isFinite(tmpAsserts.MaxDrainSeconds))
		{
			let tmpObserved = Math.round(pDrainMs / 100) / 10;
			tmpResults.push(
				{
					Assertion: 'MaxDrainSeconds',
					Pass: tmpObserved <= tmpAsserts.MaxDrainSeconds,
					Spec: tmpAsserts.MaxDrainSeconds,
					Observed: tmpObserved
				});
		}

		if (Number.isFinite(tmpAsserts.MaxFailedItems))
		{
			tmpResults.push(
				{
					Assertion: 'MaxFailedItems',
					Pass: pCtx.FailedHashes.size <= tmpAsserts.MaxFailedItems,
					Spec: tmpAsserts.MaxFailedItems,
					Observed: pCtx.FailedHashes.size
				});
		}

		// Phase 2: stall-aware assertions.  MaxStalledItems is a soft
		// gate (default omitted = no constraint, default 0 if a scenario
		// declares stall sensitivity); StalledRecovered counts items
		// that flipped Stalled then came back via queue.unstalled before
		// the operation finalized.
		if (Number.isFinite(tmpAsserts.MaxStalledItems))
		{
			tmpResults.push(
				{
					Assertion: 'MaxStalledItems',
					Pass: pCtx.EverStalledHashes.size <= tmpAsserts.MaxStalledItems,
					Spec: tmpAsserts.MaxStalledItems,
					Observed: pCtx.EverStalledHashes.size
				});
		}
		if (Number.isFinite(tmpAsserts.StalledRecovered))
		{
			tmpResults.push(
				{
					Assertion: 'StalledRecovered',
					Pass: pCtx.RecoveredStalledHashes.size >= tmpAsserts.StalledRecovered,
					Spec: tmpAsserts.StalledRecovered,
					Observed: pCtx.RecoveredStalledHashes.size
				});
		}

		if (tmpAsserts.MinObservedConcurrencyByCapability && typeof tmpAsserts.MinObservedConcurrencyByCapability === 'object')
		{
			let tmpDetail = {};
			let tmpAllPass = true;
			let tmpKeys = Object.keys(tmpAsserts.MinObservedConcurrencyByCapability);
			for (let i = 0; i < tmpKeys.length; i++)
			{
				let tmpCap = tmpKeys[i];
				let tmpExpect = tmpAsserts.MinObservedConcurrencyByCapability[tmpCap];
				let tmpObserved = pCtx.MaxConcurrencyByCapability.get(tmpCap) || 0;
				let tmpOK = tmpObserved >= tmpExpect;
				tmpDetail[tmpCap] = { Spec: tmpExpect, Observed: tmpObserved, Pass: tmpOK };
				if (!tmpOK) { tmpAllPass = false; }
			}
			tmpResults.push(
				{
					Assertion: 'MinObservedConcurrencyByCapability',
					Pass: tmpAllPass,
					Detail: tmpDetail
				});
		}

		if (tmpAsserts.NoCrossCapabilityHeadOfLineBlocking)
		{
			tmpResults.push(this._evaluateBlockingWindows(pCtx));
		}

		return tmpResults;
	}

	_evaluateBlockingWindows(pCtx)
	{
		// Walk the persisted queue.summary timeline in chronological order.
		// At every snapshot, for each declared capability, check:
		//   summary[cap].Queued > 0  AND  summary[cap].Running < capabilitySlots
		// → that's a blocking window (pending work, idle slot).  We use
		// queue.summary because the UV pushes work items via WS-direct
		// (bypassing the scheduler's queue.dispatched broadcast) -- summary
		// is the only stable signal that captures concurrency state.
		// Contiguous "blocked" snapshots collapse into one window with
		// FromMs/ToMs relative to the run's first-enqueue timestamp.
		let tmpEvents = this.fable.LabStateStore.list('BeaconExerciseEvent',
			{ IDBeaconExerciseRun: pCtx.IDBeaconExerciseRun });
		tmpEvents.reverse();  // list() is newest-first; we want chronological

		let tmpOpenWindow = new Map(); // cap → { FromMs, QueueDepthAtStart }
		let tmpWindows = [];
		let tmpStartMs = pCtx.FirstEnqueueAt || 0;

		for (let i = 0; i < tmpEvents.length; i++)
		{
			let tmpRow = tmpEvents[i];
			if (tmpRow.Topic !== 'queue.summary') { continue; }
			let tmpPayload = null;
			try { tmpPayload = JSON.parse(tmpRow.PayloadJSON || '{}'); }
			catch (pErr) { continue; }
			let tmpByCap = (tmpPayload && Array.isArray(tmpPayload.ByCapability))
				? tmpPayload.ByCapability
				: [];
			let tmpEmittedMs = Date.parse(tmpRow.EmittedAt) || 0;
			let tmpRelMs = tmpEmittedMs - tmpStartMs;

			// Build a {cap: {Queued, Running}} map for fast lookup.
			let tmpSnap = new Map();
			for (let j = 0; j < tmpByCap.length; j++)
			{
				let tmpRowCap = tmpByCap[j];
				if (!tmpRowCap || !tmpRowCap.Capability) { continue; }
				let tmpExisting = tmpSnap.get(tmpRowCap.Capability) || { Queued: 0, Running: 0 };
				tmpExisting.Queued += (Number.isFinite(tmpRowCap.Queued) ? tmpRowCap.Queued : 0);
				tmpExisting.Running += (Number.isFinite(tmpRowCap.Running) ? tmpRowCap.Running : 0);
				tmpSnap.set(tmpRowCap.Capability, tmpExisting);
			}

			// For each declared scenario capability, evaluate blocking.
			pCtx.CapabilitySlots.forEach((pSlots, pCap) =>
				{
					let tmpRowSnap = tmpSnap.get(pCap) || { Queued: 0, Running: 0 };
					let tmpBlocked = tmpRowSnap.Queued > 0 && tmpRowSnap.Running < pSlots;
					if (tmpBlocked && !tmpOpenWindow.has(pCap))
					{
						tmpOpenWindow.set(pCap, { FromMs: tmpRelMs, QueueDepthAtStart: tmpRowSnap.Queued });
					}
					else if (!tmpBlocked && tmpOpenWindow.has(pCap))
					{
						let tmpOpen = tmpOpenWindow.get(pCap);
						tmpOpenWindow.delete(pCap);
						let tmpDuration = tmpRelMs - tmpOpen.FromMs;
						// Filter windows shorter than the summary cadence
						// (~1s) to avoid flagging the natural lag between
						// "first enqueue" and "first summary tick".
						if (tmpDuration >= 1500)
						{
							tmpWindows.push(
								{
									FromMs: tmpOpen.FromMs,
									ToMs: tmpRelMs,
									DurationMs: tmpDuration,
									BlockedCapability: pCap,
									QueueDepthAtStart: tmpOpen.QueueDepthAtStart
								});
						}
					}
				});
		}

		return {
			Assertion: 'NoCrossCapabilityHeadOfLineBlocking',
			Pass: tmpWindows.length === 0,
			Detail: { BlockingWindows: tmpWindows }
		};
	}

	// ── HTTP helpers ───────────────────────────────────────────────────────

	_httpPostJSON(pURL, pBodyString, pExtraHeaders, fCallback)
	{
		// Backward-compat: callers that pass (url, body, callback) without
		// headers still work.  Keep the rare callers explicit about it.
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
				'Content-Length': Buffer.byteLength(pBodyString)
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
		tmpReq.write(pBodyString);
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

module.exports = ServiceBeaconExerciseManager;
