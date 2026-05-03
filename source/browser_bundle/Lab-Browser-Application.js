/**
 * Lab-Browser-Application
 *
 * Top-level Pict application for the ultravisor-lab browser bundle.
 * Registers all views + providers, runs a 10-second polling loop that
 * keeps AppData fresh, and owns every UI action method the router invokes.
 *
 * Interaction model (per Retold convention):
 *   - Inter-view navigation goes through pict-router (`navigateTo(path)`).
 *   - In-view navigation is JS-to-view: action methods on this application
 *     call into view.render() directly.
 *   - Views do NOT attach inline event handlers that mutate state; any
 *     `onclick` in a template is a `navigateTo(...)` call, and the matching
 *     route fires an action method here.  Form inputs carry no oninput /
 *     onchange handlers -- submit actions marshal values from the DOM at
 *     submit time.
 */
'use strict';

const libPictApplication = require('pict-application');
const libPictRouter = require('pict-router');
const libPictSectionModal = require('pict-section-modal');
const libChance = require('chance');

const libApiProvider        = require('./providers/PictProvider-Lab-Api.js');
const libRouterConfig       = require('./providers/PictRouter-Lab-Configuration.json');
const libNavigationView     = require('./views/PictView-Lab-Navigation.js');
const libOverviewView       = require('./views/PictView-Lab-Overview.js');
const libEventsView         = require('./views/PictView-Lab-Events.js');
const libDBEnginesView      = require('./views/PictView-Lab-DBEngines.js');
const libUltravisorView     = require('./views/PictView-Lab-Ultravisor.js');
const libBeaconsView        = require('./views/PictView-Lab-Beacons.js');
const libSeedDatasetsView   = require('./views/PictView-Lab-SeedDatasets.js');
const libBeaconExercisesView       = require('./views/PictView-Lab-BeaconExercises.js');
const libOperationExercisesView    = require('./views/PictView-Lab-OperationExercises.js');
const libStacksView                = require('./views/PictView-Lab-Stacks.js');

const POLL_INTERVAL_MS = 10000;

class LabBrowserApplication extends libPictApplication
{
	constructor(pFable, pOptions, pServiceHash)
	{
		super(pFable, pOptions, pServiceHash);

		this._Chance = new libChance();

		this.pict.addProvider('LabApi',     libApiProvider.default_configuration, libApiProvider);
		this.pict.addProvider('PictRouter', libRouterConfig,                      libPictRouter);

		this.pict.addView('Lab-Navigation',   libNavigationView.default_configuration,   libNavigationView);
		this.pict.addView('Lab-Overview',     libOverviewView.default_configuration,     libOverviewView);
		this.pict.addView('Lab-DBEngines',    libDBEnginesView.default_configuration,    libDBEnginesView);
		this.pict.addView('Lab-Ultravisor',   libUltravisorView.default_configuration,   libUltravisorView);
		this.pict.addView('Lab-Beacons',      libBeaconsView.default_configuration,      libBeaconsView);
		this.pict.addView('Lab-SeedDatasets', libSeedDatasetsView.default_configuration, libSeedDatasetsView);
		this.pict.addView('Lab-BeaconExercises',     libBeaconExercisesView.default_configuration,     libBeaconExercisesView);
		this.pict.addView('Lab-OperationExercises',  libOperationExercisesView.default_configuration,  libOperationExercisesView);
		this.pict.addView('Lab-Stacks',       libStacksView.default_configuration,       libStacksView);
		this.pict.addView('Lab-Events',       libEventsView.default_configuration,       libEventsView);

		// Modal + toast toolkit: replaces window.alert/confirm app-wide.
		this.pict.addView('Modal',            {},                                        libPictSectionModal);

		this._pollTimer = null;
	}

	onBeforeInitializeAsync(fCallback)
	{
		this.pict.AppData.Lab =
		{
			ActiveView: 'Overview',
			Status:
			{
				Product:    'Ultravisor-Lab',
				Version:    '',
				Docker:     { Available: false, Version: '', Error: '' },
				Counts:     { DBEngine: 0, Database: 0, UltravisorInstance: 0, Beacon: 0, FactoInstance: 0, IngestionJob: 0 },
				LastReconcile: null
			},
			Events: [],
			DBEngines:
			{
				FormOpen:            false,
				EngineTypes:         [],
				Engines:             [],
				DatabasesByEngine:   {},
				RevealedCredentials: {},
				Form:                { Name: '', EngineType: 'mysql', Port: 3306, Password: '', Error: '' }
			},
			Ultravisor:
			{
				FormOpen:  false,
				Instances: [],
				Form:      { Name: '', Port: 54321, Secure: false, Error: '' }
			},
			Beacons:
			{
				FormOpen: false,
				Types:    [],
				Beacons:  [],
				Form:     { Name: '', BeaconType: '', Port: 0, IDUltravisorInstance: 0, Config: {}, JoinSecretOverride: '', SkipJoinSecret: false, Error: '' }
			},
			SeedDatasets:
			{
				Datasets:   [],
				Jobs:       [],
				Targets:    { IDUltravisorInstance: 0, IDBeacon: 0, IDDBEngine: 0 }
			},
			BeaconExercises:
			{
				Scenarios: [],
				Runs:      [],
				Snapshot:  null,
				Targets:   { IDUltravisorInstance: 0 }
			},
			OperationExercises:
			{
				Exercises: [],
				Runs:      [],
				Targets:   { IDUltravisorInstance: 0 }
			},
			Stacks:
			{
				Screen:        'list',          // 'list' | 'preset-chooser' | 'editor' | 'detail'
				Stacks:        [],              // saved stacks (summary rows)
				Presets:       [],              // preset library (summary rows)
				EditorRecord:  null,            // full Stack record being edited
				DetailRecord:  null,            // full Stack record on detail page
				InputValues:   {},              // user-entered input values for editor
				LastPreflight:    null,         // { Hash, Report } most recent preflight
				LastStatus:       null,         // { Hash, Status } most recent status poll
				LastYaml:         null,         // { Hash, YAML, Source }
				LastLaunchResult: null          // { Hash, Result } last upStack response (incl. RawOutput on failure)
			}
		};
		return super.onBeforeInitializeAsync(fCallback);
	}

	onAfterInitializeAsync(fCallback)
	{
		this._bootstrapEngineTypes(
			() =>
			{
				this._bootstrapSeedCatalog(
					() =>
					{
						this._bootstrapBeaconExercises(
							() =>
							{
								this._bootstrapOperationExercises(
									() =>
									{
										this._bootstrapBeaconTypes(
											() =>
											{
												this.refreshAll(
													() =>
													{
														this._pollTimer = setInterval(() => this.refreshAll(() => {}), POLL_INTERVAL_MS);
														return super.onAfterInitializeAsync(fCallback);
													});
											});
									});
							});
					});
			});
	}

	_bootstrapBeaconTypes(fCallback)
	{
		this.pict.providers.LabApi.getBeaconTypes(
			(pErr, pPayload) =>
			{
				if (!pErr && pPayload && Array.isArray(pPayload.BeaconTypes))
				{
					this.pict.AppData.Lab.Beacons.Types = pPayload.BeaconTypes;
				}
				return fCallback();
			});
	}

	onLoginAsync(fCallback) { return super.onLoginAsync(fCallback); }
	onLoadDataAsync(fCallback) { return super.onLoadDataAsync(fCallback); }

	/**
	 * Navigate to a route using pict-router.  Every `onclick` in the lab's
	 * view templates calls into this method so all action dispatch flows
	 * through the router's route table.
	 */
	navigateTo(pRoute)
	{
		this.pict.providers.PictRouter.navigate(pRoute);
	}

	// ── Modal / toast helpers ────────────────────────────────────────────────
	// Thin wrappers around pict-section-modal so handlers stay terse and the
	// modal service can be swapped without touching every call site.

	_modal()
	{
		return this.pict.views.Modal;
	}

	_toast(pMessage, pType, pOptions)
	{
		let tmpOpts = Object.assign({ type: pType || 'info', duration: 3500 }, pOptions || {});
		return this._modal().toast(pMessage, tmpOpts);
	}

	_toastError(pMessage)   { return this._toast(pMessage, 'error', { duration: 6000 }); }
	_toastSuccess(pMessage) { return this._toast(pMessage, 'success'); }
	_toastWarning(pMessage) { return this._toast(pMessage, 'warning'); }

	/**
	 * Read the value of a DOM input/select by CSS selector via Pict's
	 * ContentAssignment abstraction (not `document.querySelector`).  Returns
	 * the string value or `null` if the element isn't present.  Route
	 * handlers call this at submit time to marshal form values in lieu of
	 * per-field oninput/onchange handlers.
	 */
	_domValue(pSelector)
	{
		let tmpElement = this.pict.ContentAssignment.getElement(pSelector);
		if (!tmpElement) { return null; }
		// ContentAssignment returns a single element in browser mode; tolerate
		// array-like shapes too for SSR symmetry.
		let tmpNode = (typeof tmpElement.length === 'number' && !('value' in tmpElement)) ? tmpElement[0] : tmpElement;
		if (!tmpNode) { return null; }
		return ('value' in tmpNode) ? tmpNode.value : null;
	}

	_confirmDanger(pMessage, pOptions)
	{
		return this._modal().confirm(pMessage, Object.assign({ dangerous: true, confirmLabel: 'Remove', cancelLabel: 'Cancel' }, pOptions || {}));
	}

	setActiveView(pViewName)
	{
		this.pict.AppData.Lab.ActiveView = pViewName;
		this.pict.views['Lab-Navigation'].render();
		this._mountActive();
	}

	/**
	 * Full view mount: renders the active view's default (Main) renderable,
	 * which paints the shell and fans out to List + Form renderables via
	 * onAfterRender.  Triggered by navigation (setActiveView).
	 */
	_mountActive()
	{
		let tmpName = this.pict.AppData.Lab.ActiveView;
		if      (tmpName === 'Overview')     { this.pict.views['Lab-Overview'].render(); }
		else if (tmpName === 'DBEngines')    { this.pict.views['Lab-DBEngines'].render(); }
		else if (tmpName === 'Ultravisor')   { this.pict.views['Lab-Ultravisor'].render(); }
		else if (tmpName === 'Beacons')      { this.pict.views['Lab-Beacons'].render(); }
		else if (tmpName === 'SeedDatasets') { this.pict.views['Lab-SeedDatasets'].render(); }
		else if (tmpName === 'BeaconExercises')     { this.pict.views['Lab-BeaconExercises'].render(); }
		else if (tmpName === 'OperationExercises')  { this.pict.views['Lab-OperationExercises'].render(); }
		else if (tmpName === 'Events')       { this.pict.views['Lab-Events'].render(); }
		else if (tmpName === 'Stacks')       { this.pict.views['Lab-Stacks'].render(); }
	}

	/**
	 * Background-poll render: only repaints the List renderable of the
	 * active feature view, leaving the form subtree untouched.  Skipped when
	 * the user is focused on a list-embedded input (e.g. the "new database"
	 * field in a DB engine card) so typing there isn't clobbered.
	 */
	_refreshActiveList()
	{
		let tmpName = this.pict.AppData.Lab.ActiveView;
		if (tmpName === 'Overview')   { this.pict.views['Lab-Overview'].render(); return; }
		if (tmpName === 'Events')     { this.pict.views['Lab-Events'].render(); return; }

		// Focus-preserving guard for views whose List renderable contains
		// embedded inputs (e.g. DB engine cards have a "+ database" input).
		let tmpActive = document.activeElement;
		let tmpFocusedOnListInput = tmpActive && tmpActive.id && (
			tmpActive.id.startsWith('Lab-Engine-') // new-database input inside each DB engine card
		);
		if (tmpFocusedOnListInput) { return; }

		if (tmpName === 'DBEngines')    { this.pict.views['Lab-DBEngines'].render('Lab-DBEngines-List'); }
		else if (tmpName === 'Ultravisor')   { this.pict.views['Lab-Ultravisor'].render('Lab-Ultravisor-List'); }
		else if (tmpName === 'Beacons')      { this.pict.views['Lab-Beacons'].render('Lab-Beacons-List'); }
		else if (tmpName === 'SeedDatasets')
		{
			this.pict.views['Lab-SeedDatasets'].render('Lab-SeedDatasets-List');
			this.pict.views['Lab-SeedDatasets'].render('Lab-SeedDatasets-Jobs');
		}
		else if (tmpName === 'BeaconExercises')
		{
			this.pict.views['Lab-BeaconExercises'].render('Lab-BeaconExercises-Board');
			this.pict.views['Lab-BeaconExercises'].render('Lab-BeaconExercises-Scenarios');
			this.pict.views['Lab-BeaconExercises'].render('Lab-BeaconExercises-Runs');
		}
		else if (tmpName === 'OperationExercises')
		{
			this.pict.views['Lab-OperationExercises'].render('Lab-OperationExercises-Active');
			this.pict.views['Lab-OperationExercises'].render('Lab-OperationExercises-Cards');
			this.pict.views['Lab-OperationExercises'].render('Lab-OperationExercises-Runs');
		}
	}

	refreshAll(fCallback)
	{
		let tmpApi = this.pict.providers.LabApi;
		let tmpPending = 9;  // status, events, engines, ultravisors, beacons, jobs, queue runs, queue snapshot, op-exercise runs
		let tmpDone = () =>
		{
			tmpPending--;
			if (tmpPending <= 0)
			{
				// Inflate per-UV persistence state, then re-arm the
				// transient-state fast-poll, then re-render.
				this._refreshAllUvPersistence(() =>
				{
					this._applySeedTargetDefaults();
					this._applyBeaconExerciseTargetDefaults();
					this._applyOperationExerciseTargetDefaults();
					this._refreshActiveList();
					this.pict.views['Lab-Navigation'].render();
					this._pumpPersistencePollers();
					return fCallback();
				});
			}
		};

		tmpApi.getStatus((pErr, pStatus) =>
			{
				if (!pErr && pStatus) { this.pict.AppData.Lab.Status = pStatus; }
				tmpDone();
			});

		tmpApi.getEvents(100, (pErr, pPayload) =>
			{
				if (!pErr && pPayload && Array.isArray(pPayload.Events))
				{
					this.pict.AppData.Lab.Events = pPayload.Events;
				}
				tmpDone();
			});

		tmpApi.listEngines((pErr, pPayload) =>
			{
				if (!pErr && pPayload && Array.isArray(pPayload.Records))
				{
					// Newest first.  Numeric IDs already arrive DESC from the
					// state store, but coerce here so optimistic ghosts (string
					// IDs starting with "pending-") land at the top anyway.
					let tmpEngines = pPayload.Records.slice().sort(
						(pA, pB) =>
						{
							let tmpAID = typeof pA.IDDBEngine === 'number' ? pA.IDDBEngine : Number.MAX_SAFE_INTEGER;
							let tmpBID = typeof pB.IDDBEngine === 'number' ? pB.IDDBEngine : Number.MAX_SAFE_INTEGER;
							return tmpBID - tmpAID;
						});
					this.pict.AppData.Lab.DBEngines.Engines = tmpEngines;
					this._refreshEngineDatabases(tmpEngines, tmpDone);
					return;
				}
				tmpDone();
			});

		tmpApi.listUltravisorInstances((pErr, pPayload) =>
			{
				if (!pErr && pPayload && Array.isArray(pPayload.Records))
				{
					this.pict.AppData.Lab.Ultravisor.Instances = pPayload.Records;
				}
				tmpDone();
			});

		tmpApi.listBeacons((pErr, pPayload) =>
			{
				if (!pErr && pPayload && Array.isArray(pPayload.Records))
				{
					this.pict.AppData.Lab.Beacons.Beacons = pPayload.Records;
				}
				tmpDone();
			});

		tmpApi.listIngestionJobs((pErr, pPayload) =>
			{
				if (!pErr && pPayload && Array.isArray(pPayload.Records))
				{
					this.pict.AppData.Lab.SeedDatasets.Jobs = pPayload.Records;
				}
				tmpDone();
			});

		tmpApi.listBeaconExerciseRuns((pErr, pPayload) =>
			{
				if (!pErr && pPayload && Array.isArray(pPayload.Runs))
				{
					this.pict.AppData.Lab.BeaconExercises.Runs = pPayload.Runs;
				}
				tmpDone();
			});

		tmpApi.listOperationExerciseRuns((pErr, pPayload) =>
			{
				if (!pErr && pPayload && Array.isArray(pPayload.Runs))
				{
					this.pict.AppData.Lab.OperationExercises.Runs = pPayload.Runs;
				}
				tmpDone();
			});

		// Queue snapshot only when (a) the BeaconExercises tab is active and
		// (b) the user has picked a target UV.  Skipping otherwise keeps
		// the background poll cheap and avoids 404s from non-running UVs.
		let tmpUvID = parseInt(
			(this.pict.AppData.Lab.BeaconExercises && this.pict.AppData.Lab.BeaconExercises.Targets && this.pict.AppData.Lab.BeaconExercises.Targets.IDUltravisorInstance) || 0, 10);
		let tmpActiveQueue = this.pict.AppData.Lab.ActiveView === 'BeaconExercises';
		if (tmpActiveQueue && tmpUvID > 0)
		{
			tmpApi.getQueueSnapshot(tmpUvID, (pErr, pPayload) =>
				{
					if (!pErr && pPayload) { this.pict.AppData.Lab.BeaconExercises.Snapshot = pPayload; }
					tmpDone();
				});
		}
		else
		{
			// Clear stale snapshot if user moved off the tab or unset target.
			if (!tmpActiveQueue || tmpUvID === 0) { this.pict.AppData.Lab.BeaconExercises.Snapshot = null; }
			tmpDone();
		}
	}

	_refreshEngineDatabases(pEngines, fCallback)
	{
		let tmpApi = this.pict.providers.LabApi;
		let tmpState = this.pict.AppData.Lab.DBEngines;

		if (pEngines.length === 0)
		{
			tmpState.DatabasesByEngine = {};
			return fCallback();
		}

		let tmpPending = pEngines.length;
		let tmpNext = () =>
		{
			tmpPending--;
			if (tmpPending <= 0) { return fCallback(); }
		};

		for (let i = 0; i < pEngines.length; i++)
		{
			((pEngine) =>
			{
				tmpApi.getEngine(pEngine.IDDBEngine,
					(pErr, pPayload) =>
					{
						if (!pErr && pPayload && Array.isArray(pPayload.Databases))
						{
							tmpState.DatabasesByEngine[pEngine.IDDBEngine] = pPayload.Databases;
						}
						tmpNext();
					});
			})(pEngines[i]);
		}
	}

	/**
	 * For each UV row, attach a Persistence object to power the lab's
	 * status pill. Unassigned UVs get a synthesized stub (no HTTP); UVs
	 * with an assignment get a fresh fetch from the lab API. The fast-
	 * poll loop (_pumpPersistencePollers) takes over for transient
	 * states once steady refreshes complete.
	 */
	_refreshAllUvPersistence(fCallback)
	{
		let tmpInstances = (this.pict.AppData.Lab.Ultravisor && this.pict.AppData.Lab.Ultravisor.Instances) || [];
		if (tmpInstances.length === 0) { return fCallback(); }

		let tmpRemaining = tmpInstances.length;
		let tmpNext = () =>
		{
			tmpRemaining--;
			if (tmpRemaining <= 0) { return fCallback(); }
		};

		let tmpApi = this.pict.providers.LabApi;
		for (let i = 0; i < tmpInstances.length; i++)
		{
			((pUv) =>
			{
				let tmpAssigned = parseInt(pUv.IDPersistenceBeacon, 10) || 0;
				if (tmpAssigned === 0)
				{
					pUv.Persistence =
					{
						IDPersistenceBeacon: 0,
						IDPersistenceConnection: 0,
						BeaconRecord: null,
						ConnectionRecord: null,
						State: 'unassigned',
						LastError: null,
						BootstrappedAt: null
					};
					return tmpNext();
				}
				tmpApi.getUltravisorPersistenceStatus(pUv.IDUltravisorInstance,
					(pErr, pPayload) =>
					{
						if (!pErr && pPayload && pPayload.Persistence)
						{
							pUv.Persistence = pPayload.Persistence;
						}
						else if (!pUv.Persistence)
						{
							// Unable to reach the UV — surface a waiting
							// state so the pill renders something.
							pUv.Persistence =
							{
								IDPersistenceBeacon: tmpAssigned,
								IDPersistenceConnection: parseInt(pUv.IDPersistenceConnection, 10) || 0,
								BeaconRecord: null,
								ConnectionRecord: null,
								State: 'waiting-for-beacon',
								LastError: pErr ? pErr.message : 'No persistence status returned',
								BootstrappedAt: null
							};
						}
						tmpNext();
					});
			})(tmpInstances[i]);
		}
	}

	triggerReconcile(fCallback)
	{
		this.pict.providers.LabApi.reconcileNow(
			() => this.refreshAll(fCallback || function () {}));
	}

	cleanEnvironment()
	{
		// Short-circuit when there's nothing to clean.  Previously the user
		// got the full confirm flow -> summary modal showing zeros, which
		// felt broken.  Now we inspect the last status snapshot and toast
		// if every tracked entity is absent.
		let tmpCounts = (this.pict.AppData.Lab.Status && this.pict.AppData.Lab.Status.Counts) || {};
		let tmpTotal = (tmpCounts.DBEngine || 0)
			+ (tmpCounts.Database || 0)
			+ (tmpCounts.UltravisorInstance || 0)
			+ (tmpCounts.Beacon || 0)
			+ (tmpCounts.FactoInstance || 0)
			+ (tmpCounts.IngestionJob || 0);
		if (tmpTotal === 0)
		{
			this._toast('Environment is already clean — no engines, ultravisors, beacons, or history to remove.', 'info', { duration: 4500 });
			return;
		}

		this._modal().doubleConfirm(
			'This will stop and delete every lab-managed docker container, supervised process, and tracked database row.  Seed dataset fixtures and lab itself stay.',
			{
				title:         'Clean environment',
				confirmPhrase: 'CLEAN',
				phrasePrompt:  'Type "{phrase}" to confirm:',
				confirmLabel:  'Clean everything',
				cancelLabel:   'Cancel'
			})
			.then((pConfirmed) =>
				{
					if (!pConfirmed) { return; }

					// Swap the Clean environment button for an inline spinner
					// immediately -- teardown takes several seconds while
					// docker containers stop.  Cleared in both branches below.
					if (!this.pict.AppData.Lab.Overview) { this.pict.AppData.Lab.Overview = {}; }
					this.pict.AppData.Lab.Overview.TeardownInProgress = true;
					this.pict.views['Lab-Overview'].render();

					this.pict.providers.LabApi.teardown(
						(pErr, pSummary) =>
						{
							this.pict.AppData.Lab.Overview.TeardownInProgress = false;
							this.pict.views['Lab-Overview'].render();

							if (pErr) { this._toastError('Teardown failed: ' + pErr.message); return; }

							this._modal().show(
								{
									title:   'Environment cleaned',
									content: `<ul style="margin:0;padding-left:20px;line-height:1.7;">
										<li><strong>${pSummary.DBEngines.Removed}</strong> / ${pSummary.DBEngines.Attempted} DB engines removed</li>
										<li><strong>${pSummary.Beacons.Removed}</strong> / ${pSummary.Beacons.Attempted} beacons removed</li>
										<li><strong>${pSummary.UltravisorInstances.Removed}</strong> / ${pSummary.UltravisorInstances.Attempted} ultravisors removed</li>
										<li><strong>${pSummary.IngestionJobsCleared}</strong> ingestion jobs cleared</li>
										<li><strong>${pSummary.EventsCleared}</strong> events cleared</li>
									</ul>`,
									buttons: [{ Hash: 'ok', Label: 'OK', Style: 'primary' }]
								});
							this.refreshAll(() => {});
						});
				});
	}

	// ── Seed catalog bootstrap ──────────────────────────────────────────────

	_bootstrapSeedCatalog(fCallback)
	{
		this.pict.providers.LabApi.getSeedDatasets(
			(pErr, pPayload) =>
			{
				if (!pErr && pPayload && Array.isArray(pPayload.Datasets))
				{
					this.pict.AppData.Lab.SeedDatasets.Datasets = pPayload.Datasets;
				}
				return fCallback();
			});
	}

	_bootstrapBeaconExercises(fCallback)
	{
		this.pict.providers.LabApi.listBeaconExercises(
			(pErr, pPayload) =>
			{
				if (!pErr && pPayload && Array.isArray(pPayload.Scenarios))
				{
					this.pict.AppData.Lab.BeaconExercises.Scenarios = pPayload.Scenarios;
				}
				return fCallback();
			});
	}

	_bootstrapOperationExercises(fCallback)
	{
		this.pict.providers.LabApi.listOperationExercises(
			(pErr, pPayload) =>
			{
				if (!pErr && pPayload && Array.isArray(pPayload.Exercises))
				{
					this.pict.AppData.Lab.OperationExercises.Exercises = pPayload.Exercises;
				}
				return fCallback();
			});
	}

	// ── DB Engine form ──────────────────────────────────────────────────────

	_bootstrapEngineTypes(fCallback)
	{
		this.pict.providers.LabApi.getEngineTypes(
			(pErr, pPayload) =>
			{
				if (!pErr && pPayload && Array.isArray(pPayload.EngineTypes))
				{
					this.pict.AppData.Lab.DBEngines.EngineTypes = pPayload.EngineTypes;
					let tmpFirst = pPayload.EngineTypes[0];
					if (tmpFirst)
					{
						this.pict.AppData.Lab.DBEngines.Form.EngineType = tmpFirst.EngineType;
						this.pict.AppData.Lab.DBEngines.Form.Port = tmpFirst.SuggestedHostPort || tmpFirst.DefaultPort;
					}
				}
				return fCallback();
			});
	}

	toggleEngineForm()
	{
		let tmpState = this.pict.AppData.Lab.DBEngines;
		tmpState.FormOpen = !tmpState.FormOpen;
		if (!tmpState.FormOpen)
		{
			tmpState.Form.Error = '';
			this.pict.views['Lab-DBEngines'].render('Lab-DBEngines-Form');
			return;
		}

		// Opening the form: regenerate name if empty, and ask the server for
		// the next free host port so the prefill never collides.
		if (!tmpState.Form.Name)
		{
			tmpState.Form.Name = this._randomEngineName();
		}
		this.pict.views['Lab-DBEngines'].render('Lab-DBEngines-Form');
		this._refreshSuggestedEnginePort(tmpState.Form.EngineType);
	}

	_refreshSuggestedEnginePort(pEngineType)
	{
		this.pict.providers.LabApi.getNextEnginePort(pEngineType,
			(pErr, pPayload) =>
			{
				if (pErr || !pPayload || !pPayload.Port) { return; }
				let tmpForm = this.pict.AppData.Lab.DBEngines.Form;
				// Only overwrite if the user hasn't typed a custom port since
				// the request was dispatched (avoids clobbering in-flight edits).
				let tmpActive = document.activeElement;
				if (tmpActive && tmpActive.id === 'Lab-EngineForm-Port') { return; }
				tmpForm.Port = pPayload.Port;
				this.pict.views['Lab-DBEngines'].render('Lab-DBEngines-Form');
			});
	}

	_randomEngineName()
	{
		return this._Chance.word({ syllables: 2 }).toLowerCase();
	}

	/**
	 * Suggest the next `prefix-NNN` name for a given entity list.  Scans
	 * existing names for the same prefix, picks max-number + 1, pads to 3
	 * digits.  Used by the databeacon + ultravisor create forms so users
	 * don't have to invent names by hand.
	 */
	_nextSequentialName(pPrefix, pExistingNames)
	{
		let tmpPattern = new RegExp('^' + pPrefix + '-(\\d+)$');
		let tmpMax = 0;
		for (let i = 0; i < pExistingNames.length; i++)
		{
			let tmpMatch = tmpPattern.exec(pExistingNames[i] || '');
			if (tmpMatch)
			{
				let tmpNum = parseInt(tmpMatch[1], 10);
				if (Number.isFinite(tmpNum) && tmpNum > tmpMax) { tmpMax = tmpNum; }
			}
		}
		return `${pPrefix}-${String(tmpMax + 1).padStart(3, '0')}`;
	}

	/**
	 * Route handler for /dbengines/form/suggest-port -- read the currently
	 * selected engine type from the DOM and fetch a fresh suggested port.
	 * Used because there is no onchange on the engine-type select; users
	 * explicitly click "Suggest port" after picking a type.
	 */
	suggestEnginePortFromForm()
	{
		let tmpTypeEl = this._domValue('#Lab-EngineForm-Type');
		let tmpEngineType = tmpTypeEl || this.pict.AppData.Lab.DBEngines.Form.EngineType || 'mysql';
		this._refreshSuggestedEnginePort(tmpEngineType);
	}

	submitEngineForm()
	{
		let tmpState = this.pict.AppData.Lab.DBEngines;
		let tmpForm = tmpState.Form;

		tmpForm.Name       = (this._domValue('#Lab-EngineForm-Name') || '').trim();
		tmpForm.EngineType = this._domValue('#Lab-EngineForm-Type') || 'mysql';
		tmpForm.Port       = parseInt(this._domValue('#Lab-EngineForm-Port') || '0', 10);
		tmpForm.Password   = this._domValue('#Lab-EngineForm-Password') || '';
		tmpForm.Error      = '';

		if (!tmpForm.Name) { tmpForm.Error = 'Name is required.'; this.pict.views['Lab-DBEngines'].render('Lab-DBEngines-Form'); return; }
		if (!tmpForm.Port || tmpForm.Port < 1 || tmpForm.Port > 65535) { tmpForm.Error = 'Port must be between 1 and 65535.'; this.pict.views['Lab-DBEngines'].render('Lab-DBEngines-Form'); return; }

		// Optimistic UI: close the form, prepend a "provisioning" ghost card
		// to the engine list, then dispatch the POST.  When refreshAll later
		// replaces the list from the server, the ghost is seamlessly
		// replaced by the real row (same Name + EngineType, at the top
		// because rowid DESC).
		let tmpRequest =
			{
				Name:         tmpForm.Name,
				EngineType:   tmpForm.EngineType,
				Port:         tmpForm.Port,
				RootPassword: tmpForm.Password
			};

		let tmpGhostID = 'pending-' + Date.now();
		let tmpAdapter = (tmpState.EngineTypes || []).find((pT) => pT.EngineType === tmpForm.EngineType) || {};
		let tmpGhost =
			{
				IDDBEngine:    tmpGhostID,
				Name:          tmpForm.Name,
				EngineType:    tmpForm.EngineType,
				Port:          tmpForm.Port,
				Status:        'provisioning',
				StatusDetail:  'Submitting...',
				RootUsername:  tmpAdapter.DefaultUsername || 'root',
				RootPassword:  '',
				_Optimistic:   true
			};
		tmpState.Engines = [tmpGhost].concat(tmpState.Engines || []);
		tmpState.FormOpen = false;
		tmpForm.Name = '';
		tmpForm.Password = '';
		// Optimistic ghost lives in the List; hide the form.
		this.pict.views['Lab-DBEngines'].render('Lab-DBEngines-List');
		this.pict.views['Lab-DBEngines'].render('Lab-DBEngines-Form');

		this.pict.providers.LabApi.createEngine(tmpRequest,
			(pErr) =>
			{
				if (pErr)
				{
					// Roll the UI back: drop the ghost, reopen the form with the error.
					tmpState.Engines = (tmpState.Engines || []).filter((pE) => pE.IDDBEngine !== tmpGhostID);
					tmpForm.Name  = tmpRequest.Name;
					tmpForm.Error = pErr.message || 'Create failed.';
					tmpState.FormOpen = true;
					this.pict.views['Lab-DBEngines'].render('Lab-DBEngines-List');
					this.pict.views['Lab-DBEngines'].render('Lab-DBEngines-Form');
					return;
				}
				tmpForm.Error = '';
				this.refreshAll(() => {});
			});
	}

	startEngine(pID) { this.pict.providers.LabApi.startEngine(pID, (pErr) => { if (pErr) { this._toastError('Start failed: ' + pErr.message); return; } this.refreshAll(() => {}); }); }
	stopEngine(pID)  { this.pict.providers.LabApi.stopEngine(pID,  (pErr) => { if (pErr) { this._toastError('Stop failed: '  + pErr.message); return; } this.refreshAll(() => {}); }); }
	removeEngine(pID)
	{
		this._confirmDanger('Remove this engine?  The docker container will be deleted.',
			{ title: 'Remove DB Engine' })
			.then((pConfirmed) =>
				{
					if (!pConfirmed) { return; }
					this.pict.providers.LabApi.removeEngine(pID,
						(pErr) =>
						{
							if (pErr) { this._toastError('Remove failed: ' + pErr.message); return; }
							this.refreshAll(() => {});
						});
				});
	}
	toggleCredentialReveal(pID)
	{
		let tmpState = this.pict.AppData.Lab.DBEngines;
		tmpState.RevealedCredentials[pID] = !tmpState.RevealedCredentials[pID];
		this.pict.views['Lab-DBEngines'].render('Lab-DBEngines-List');
	}

	/**
	 * Copy the root password for an engine to the system clipboard.  Uses
	 * navigator.clipboard.writeText when available; falls back to a textarea
	 * select/execCommand('copy') on older browsers that block async clipboard
	 * without a secure context.
	 */
	copyEnginePassword(pID)
	{
		let tmpEngine = ((this.pict.AppData.Lab.DBEngines && this.pict.AppData.Lab.DBEngines.Engines) || [])
			.find((pR) => String(pR.IDDBEngine) === String(pID));
		if (!tmpEngine) { this._toastError('Engine not found.'); return; }

		let tmpPassword = tmpEngine.RootPassword || '';
		if (!tmpPassword) { this._toastWarning('No password on this engine.'); return; }

		let fDone = (pOk, pErr) =>
		{
			if (pOk) { this._toastSuccess(`Password for '${tmpEngine.Name}' copied to clipboard.`); return; }
			this._toastError('Copy failed' + (pErr ? (': ' + pErr) : '.') + ' Reveal + select manually.');
		};

		if (navigator && navigator.clipboard && typeof navigator.clipboard.writeText === 'function')
		{
			navigator.clipboard.writeText(tmpPassword)
				.then(() => fDone(true))
				.catch((pEx) => this._copyFallback(tmpPassword, fDone, pEx));
			return;
		}

		this._copyFallback(tmpPassword, fDone);
	}

	_copyFallback(pText, fDone, pOriginalError)
	{
		try
		{
			let tmpTA = document.createElement('textarea');
			tmpTA.value = pText;
			tmpTA.setAttribute('readonly', '');
			// Keep it off-screen; the select/copy still works.
			tmpTA.style.position = 'fixed';
			tmpTA.style.top = '-9999px';
			document.body.appendChild(tmpTA);
			tmpTA.select();
			let tmpOk = document.execCommand && document.execCommand('copy');
			document.body.removeChild(tmpTA);
			if (tmpOk) { fDone(true); return; }
			fDone(false, pOriginalError ? pOriginalError.message : 'execCommand returned false');
		}
		catch (pEx)
		{
			fDone(false, pEx.message);
		}
	}
	createDatabase(pEngineID)
	{
		let tmpSelector = `#Lab-Engine-${pEngineID}-NewDB`;
		let tmpName = (this._domValue(tmpSelector) || '').trim();
		if (!tmpName) { this._toastWarning('Enter a database name first.'); return; }
		this.pict.providers.LabApi.createDatabase(pEngineID, tmpName,
			(pErr) =>
			{
				if (pErr) { this._toastError('Create failed: ' + pErr.message); return; }
				// Clear the input via ContentAssignment so we stay off direct DOM APIs.
				let tmpEl = this.pict.ContentAssignment.getElement(tmpSelector);
				if (tmpEl && 'value' in tmpEl) { tmpEl.value = ''; }
				this.refreshAll(() => {});
			});
	}
	dropDatabase(pEngineID, pDatabaseID)
	{
		this._confirmDanger('Drop this database?  This cannot be undone.',
			{ title: 'Drop database', confirmLabel: 'Drop' })
			.then((pConfirmed) =>
				{
					if (!pConfirmed) { return; }
					this.pict.providers.LabApi.dropDatabase(pEngineID, pDatabaseID,
						(pErr) =>
						{
							if (pErr) { this._toastError('Drop failed: ' + pErr.message); return; }
							this.refreshAll(() => {});
						});
				});
	}

	// ── Unified Beacons form ────────────────────────────────────────────────

	/**
	 * Route handler for `/beacons/form/open/:type` -- open the create form
	 * pre-locked to `pBeaconType`.  There is no "switch type after open"
	 * flow; the user closes + picks a different "+ Add" button instead.
	 */
	openBeaconFormForType(pBeaconType)
	{
		let tmpState = this.pict.AppData.Lab.Beacons;
		let tmpType = (tmpState.Types || []).find((pT) => pT.BeaconType === pBeaconType);
		if (!tmpType)
		{
			this._toastError(`Unknown beacon type: ${pBeaconType}`);
			return;
		}

		tmpState.FormOpen  = true;
		tmpState.Form.BeaconType = tmpType.BeaconType;
		tmpState.Form.Config     = this._defaultConfigFor(tmpType);
		tmpState.Form.Error      = '';
		// Seed with the type's DefaultPort so the form never shows "0"; the
		// async next-port fetch below will write a non-colliding suggestion
		// directly to the DOM when it lands.
		tmpState.Form.Port       = tmpType.DefaultPort || 8500;
		if (!tmpState.Form.Name)
		{
			let tmpNames = (tmpState.Beacons || []).map((pB) => pB.Name);
			tmpState.Form.Name = this._nextSequentialName('beacon', tmpNames);
		}

		// Render the form only -- the list subtree is untouched.  The
		// refreshAll fires list-only renders when it completes.
		this.pict.views['Lab-Beacons'].render('Lab-Beacons-Form');
		this.refreshAll(() => {});
		this._refreshSuggestedBeaconPort();
	}

	/**
	 * Route handler for `/beacons/form/close` -- hide the create form and
	 * clear its error.  Called by the Cancel button.
	 */
	closeBeaconForm()
	{
		let tmpState = this.pict.AppData.Lab.Beacons;
		tmpState.FormOpen = false;
		tmpState.Form.Error = '';
		this.pict.views['Lab-Beacons'].render('Lab-Beacons-Form');
	}

	/**
	 * Route handler for `/beacons/form/suggest-port` -- fetch a fresh
	 * suggested port for the currently-selected beacon type.  Users click
	 * the "Suggest port" button explicitly since there is no onchange.
	 */
	suggestBeaconPortFromForm()
	{
		this._refreshSuggestedBeaconPort();
	}

	_defaultConfigFor(pType)
	{
		let tmpOut = {};
		if (!pType || !pType.ConfigForm || !Array.isArray(pType.ConfigForm.Fields)) { return tmpOut; }
		for (let i = 0; i < pType.ConfigForm.Fields.length; i++)
		{
			let tmpField = pType.ConfigForm.Fields[i];
			if (tmpField.Default !== undefined) { tmpOut[tmpField.Name] = tmpField.Default; }
		}
		return tmpOut;
	}

	_refreshSuggestedBeaconPort()
	{
		// Use the type's DefaultPort if set so different beacon families
		// land in their natural ranges (8500 for databeacon, 54500 for
		// orator-conversion, etc.).
		let tmpState = this.pict.AppData.Lab.Beacons;
		let tmpType = (tmpState.Types || []).find((pT) => pT.BeaconType === tmpState.Form.BeaconType);
		let tmpStart = tmpType && tmpType.DefaultPort ? tmpType.DefaultPort : 8500;

		this.pict.providers.LabApi.getNextBeaconPort(tmpStart,
			(pErr, pPayload) =>
			{
				if (pErr || !pPayload || !pPayload.Port) { return; }
				this.pict.AppData.Lab.Beacons.Form.Port = pPayload.Port;
				this.pict.views['Lab-Beacons'].render('Lab-Beacons-Form');
			});
	}

	/**
	 * Marshal the beacon form from the DOM, apply any per-type shape fixups
	 * (e.g. split the engine-database composite picker value back into
	 * IDDBEngine + IDDatabase), validate, and POST.
	 */
	submitBeaconForm()
	{
		let tmpState = this.pict.AppData.Lab.Beacons;
		let tmpForm = tmpState.Form;
		let tmpTypeDesc = (tmpState.Types || []).find((pT) => pT.BeaconType === tmpForm.BeaconType);
		if (!tmpTypeDesc)
		{
			tmpForm.Error = 'Beacon type is missing; reopen the form via the "+ Add" button.';
			this.pict.views['Lab-Beacons'].render('Lab-Beacons-Form');
			return;
		}

		tmpForm.Name                 = (this._domValue('#Lab-BeaconForm-Name') || '').trim();
		tmpForm.Port                 = parseInt(this._domValue('#Lab-BeaconForm-Port') || '0', 10);
		tmpForm.IDUltravisorInstance = parseInt(this._domValue('#Lab-BeaconForm-Ultravisor') || '0', 10);
		// Advanced — admission credential overrides. The override slot
		// is read as text; the SkipJoinSecret toggle is read directly
		// from the DOM (checkbox value isn't surfaced via _domValue).
		tmpForm.JoinSecretOverride = (this._domValue('#Lab-BeaconForm-JoinSecretOverride') || '').trim();
		let tmpSkipEl = (typeof document !== 'undefined')
			? document.getElementById('Lab-BeaconForm-SkipJoinSecret') : null;
		tmpForm.SkipJoinSecret = !!(tmpSkipEl && tmpSkipEl.checked);
		tmpForm.Error                = '';

		// Read each declared config field from the DOM and stuff it into
		// Form.Config, applying type-specific reshaping (combined pickers).
		let tmpConfig = {};
		if (tmpTypeDesc.ConfigForm && Array.isArray(tmpTypeDesc.ConfigForm.Fields))
		{
			for (let i = 0; i < tmpTypeDesc.ConfigForm.Fields.length; i++)
			{
				let tmpField = tmpTypeDesc.ConfigForm.Fields[i];
				let tmpRaw = this._domValue(`#Lab-BeaconForm-Cfg-${tmpField.Name}`);
				if (tmpRaw === null) { continue; }

				if (tmpField.Type === 'lab-engine-database-picker')
				{
					// Composite value "engineId:databaseId" -> split into two
					// numeric config keys so server sees the same shape.
					if (tmpRaw && tmpRaw.indexOf(':') > 0)
					{
						let tmpParts = tmpRaw.split(':');
						tmpConfig.IDDBEngine = parseInt(tmpParts[0], 10) || 0;
						tmpConfig.IDDatabase = parseInt(tmpParts[1], 10) || 0;
					}
					else
					{
						tmpConfig.IDDBEngine = 0;
						tmpConfig.IDDatabase = 0;
					}
				}
				else if (tmpField.Type === 'number')
				{
					let tmpNum = parseInt(tmpRaw, 10);
					tmpConfig[tmpField.Name] = Number.isFinite(tmpNum) ? tmpNum : 0;
				}
				else
				{
					tmpConfig[tmpField.Name] = tmpRaw;
				}
			}
		}
		tmpForm.Config = tmpConfig;

		if (!tmpForm.Name) { tmpForm.Error = 'Name is required.'; this.pict.views['Lab-Beacons'].render('Lab-Beacons-Form'); return; }
		if (!tmpForm.Port || tmpForm.Port < 1) { tmpForm.Error = 'Port is required.'; this.pict.views['Lab-Beacons'].render('Lab-Beacons-Form'); return; }
		if (tmpTypeDesc.RequiresUltravisor && !tmpForm.IDUltravisorInstance)
		{
			tmpForm.Error = `${tmpTypeDesc.DisplayName} requires a target Ultravisor.`;
			this.pict.views['Lab-Beacons'].render('Lab-Beacons-Form');
			return;
		}

		this.pict.providers.LabApi.createBeacon(
			{
				Name:                 tmpForm.Name,
				BeaconType:           tmpForm.BeaconType,
				Port:                 tmpForm.Port,
				IDUltravisorInstance: tmpForm.IDUltravisorInstance,
				Config:               tmpConfig,
				// Optional admission overrides. When both are blank/false,
				// the lab falls back to its automatic JoinSecret assignment
				// (parent UV's BootstrapAuthSecret). The server interprets
				// SkipJoinSecret as "send no credential" — useful for
				// forcing rejection in non-promiscuous mode.
				JoinSecretOverride:   tmpForm.JoinSecretOverride || '',
				SkipJoinSecret:       !!tmpForm.SkipJoinSecret
			},
			(pErr) =>
			{
				if (pErr) { tmpForm.Error = pErr.message || 'Create failed.'; this.pict.views['Lab-Beacons'].render('Lab-Beacons-Form'); return; }
				tmpState.FormOpen = false;
				tmpForm.Name = '';
				tmpForm.JoinSecretOverride = '';
				tmpForm.SkipJoinSecret = false;
				tmpForm.Config = this._defaultConfigFor(tmpTypeDesc);
				tmpForm.Error = '';
				this.pict.views['Lab-Beacons'].render('Lab-Beacons-Form');
				this.refreshAll(() => {});
			});
	}

	startBeacon(pID) { this.pict.providers.LabApi.startBeacon(pID, (pErr) => { if (pErr) { this._toastError('Start failed: ' + pErr.message); return; } this.refreshAll(() => {}); }); }
	stopBeacon(pID)  { this.pict.providers.LabApi.stopBeacon(pID,  (pErr) => { if (pErr) { this._toastError('Stop failed: '  + pErr.message); return; } this.refreshAll(() => {}); }); }
	removeBeacon(pID)
	{
		this._confirmDanger('Remove this beacon?  Its process will be stopped and its state deleted.',
			{ title: 'Remove beacon' })
			.then((pConfirmed) =>
				{
					if (!pConfirmed) { return; }
					this.pict.providers.LabApi.removeBeacon(pID,
						(pErr) =>
						{
							if (pErr) { this._toastError('Remove failed: ' + pErr.message); return; }
							this.refreshAll(() => {});
						});
				});
	}

	rebuildBeaconImage(pID)
	{
		this._modal().confirm(
			'Rebuild this beacon\'s image?  The running container will be stopped and recreated from the current stanza version.  This is safe; the beacon\'s config and data dir are preserved.',
			{
				title: 'Rebuild beacon image',
				confirmLabel: 'Rebuild',
				cancelLabel: 'Cancel'
			})
			.then((pConfirmed) =>
				{
					if (!pConfirmed) { return; }
					this._toast('Rebuilding… (first build of a new version can take a few minutes)', 'info');
					this.pict.providers.LabApi.rebuildBeaconImage(pID,
						(pErr) =>
						{
							if (pErr) { this._toastError('Rebuild failed: ' + pErr.message); return; }
							this.refreshAll(() => {});
						});
				});
	}

	/**
	 * Toggle a beacon's image between published-npm and local-monorepo-source
	 * builds.  Routed from the beacon card's Source dropdown anchors
	 * (#/beacons/:id/build-source/npm and /source).  The server-side flow
	 * stops + removes the container, wipes the source tag when switching TO
	 * source (so the next build picks up current disk), and starts fresh --
	 * see BeaconManager.switchBeaconBuildSource.
	 */
	switchBeaconBuildSource(pID, pBuildSource)
	{
		let tmpTarget = (pBuildSource === 'source') ? 'source' : 'npm';
		let tmpBody = (tmpTarget === 'source')
			? 'Switch this beacon to a SOURCE build?  The image will be packed from your local monorepo checkout (npm pack of the sibling repo).  Transitive dependencies still come from npm.  The existing npm image stays cached so you can switch back quickly.'
			: 'Switch this beacon back to an NPM build?  The cached npm image will be reused if present, otherwise it\'s rebuilt from the registry version in the stanza.  Your source image stays cached for next time.';
		this._modal().confirm(
			tmpBody,
			{
				title: `Switch to ${tmpTarget}-built image`,
				confirmLabel: 'Switch',
				cancelLabel: 'Cancel'
			})
			.then((pConfirmed) =>
				{
					if (!pConfirmed) { return; }
					this._toast(`Switching to ${tmpTarget} build…`, 'info');
					this.pict.providers.LabApi.switchBeaconBuildSource(pID, tmpTarget,
						(pErr) =>
						{
							if (pErr) { this._toastError('Switch failed: ' + pErr.message); return; }
							this.refreshAll(() => {});
						});
				});
	}

	// ── Log viewer (shared across Beacon + DBEngine) ────────────────────────

	openBeaconLogs(pID)  { return this._openLogs('Beacon',   pID); }
	openEngineLogs(pID)  { return this._openLogs('DBEngine', pID); }

	// Route aliases -- re-open with fresh content.
	refreshBeaconLogs(pID) { return this._openLogs('Beacon',   pID); }
	refreshEngineLogs(pID) { return this._openLogs('DBEngine', pID); }

	/**
	 * Generic log-modal entry point.  Looks up the entity's display name
	 * from AppData, calls the right API endpoint based on EntityType, and
	 * renders the result in a dark <pre> modal with Refresh / Close buttons.
	 * The Refresh button dismisses + re-opens so the modal never has to
	 * mutate its own DOM -- keeps the pict-section-modal contract clean.
	 */
	_openLogs(pEntityType, pID)
	{
		let tmpApi = this.pict.providers.LabApi;
		let tmpLookupName, tmpFetcher;

		if (pEntityType === 'Beacon')
		{
			let tmpBeacon = ((this.pict.AppData.Lab.Beacons && this.pict.AppData.Lab.Beacons.Beacons) || [])
				.find((pR) => String(pR.IDBeacon) === String(pID));
			tmpLookupName = tmpBeacon ? tmpBeacon.Name : `beacon #${pID}`;
			tmpFetcher = (fCb) => tmpApi.getBeaconLogs(pID, 500, fCb);
		}
		else if (pEntityType === 'DBEngine')
		{
			let tmpEngine = ((this.pict.AppData.Lab.DBEngines && this.pict.AppData.Lab.DBEngines.Engines) || [])
				.find((pR) => String(pR.IDDBEngine) === String(pID));
			tmpLookupName = tmpEngine ? tmpEngine.Name : `engine #${pID}`;
			tmpFetcher = (fCb) => tmpApi.getEngineLogs(pID, 500, fCb);
		}
		else
		{
			this._toastError(`No log viewer for entity type '${pEntityType}'.`);
			return;
		}

		let tmpTitle = `Logs — ${tmpLookupName}`;

		tmpFetcher((pErr, pPayload) =>
			{
				if (pErr)
				{
					this._toastError('Could not load logs: ' + pErr.message);
					return;
				}

				let tmpLines   = (pPayload && pPayload.Lines) || [];
				let tmpSource  = (pPayload && pPayload.Source) || '';
				let tmpRuntime = (pPayload && pPayload.Runtime) || '';

				let tmpToolbar = `<div class="lab-log-toolbar">`
					+ `<span class="lab-log-badge">${this._escapeHTML(tmpRuntime || 'process')}</span>`
					+ `<span class="lab-log-source" title="${this._escapeHTML(tmpSource)}">${this._escapeHTML(tmpSource) || '(no source)'}</span>`
					+ `<span class="lab-log-count">${tmpLines.length} lines</span>`
					+ `</div>`;

				let tmpBody = tmpLines.length === 0
					? `<div class="lab-log-empty">No log output yet.</div>`
					: `<pre class="lab-log-content">${tmpLines.map((pL) => this._escapeHTML(pL)).join('\n')}</pre>`;

				this._modal().show(
					{
						title:     tmpTitle,
						content:   tmpToolbar + tmpBody,
						width:     'min(1100px, 92vw)',
						closeable: true,
						buttons:
						[
							{ Hash: 'refresh', Label: 'Refresh', Style: 'secondary' },
							{ Hash: 'close',   Label: 'Close',   Style: 'primary'   }
						],
						// Jump the <pre> to the tail on open so the newest
						// lines are visible first -- setting scrollTop to
						// scrollHeight lands at the bottom of the pane.
						onOpen: (pDialog) =>
							{
								let tmpPre = pDialog && pDialog.querySelector ? pDialog.querySelector('.lab-log-content') : null;
								if (tmpPre) { tmpPre.scrollTop = tmpPre.scrollHeight; }
							}
					})
					.then((pHash) =>
						{
							if (pHash === 'refresh')
							{
								// Small defer so the modal finishes its dismiss animation
								// before we open the replacement; avoids an odd double-stack
								// while the overlay is fading out.
								setTimeout(() => this._openLogs(pEntityType, pID), 80);
							}
						});
			});
	}

	_escapeHTML(pStr)
	{
		return String(pStr == null ? '' : pStr)
			.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
			.replace(/"/g, '&quot;').replace(/'/g, '&#39;');
	}

	// ── Ultravisor form ─────────────────────────────────────────────────────

	toggleUltravisorForm()
	{
		let tmpState = this.pict.AppData.Lab.Ultravisor;
		tmpState.FormOpen = !tmpState.FormOpen;
		if (!tmpState.FormOpen)
		{
			tmpState.Form.Error = '';
			this.pict.views['Lab-Ultravisor'].render('Lab-Ultravisor-Form');
			return;
		}
		if (!tmpState.Form.Name)
		{
			let tmpNames = (tmpState.Instances || []).map((pU) => pU.Name);
			tmpState.Form.Name = this._nextSequentialName('ultravisor', tmpNames);
		}
		this.pict.views['Lab-Ultravisor'].render('Lab-Ultravisor-Form');
		this._refreshSuggestedUltravisorPort();
	}

	_refreshSuggestedUltravisorPort()
	{
		this.pict.providers.LabApi.getNextUltravisorPort(
			(pErr, pPayload) =>
			{
				if (pErr || !pPayload || !pPayload.Port) { return; }
				let tmpForm = this.pict.AppData.Lab.Ultravisor.Form;
				let tmpActive = document.activeElement;
				if (tmpActive && tmpActive.id === 'Lab-UltravisorForm-Port') { return; }
				tmpForm.Port = pPayload.Port;
				this.pict.views['Lab-Ultravisor'].render('Lab-Ultravisor-Form');
			});
	}

	submitUltravisorForm()
	{
		let tmpState = this.pict.AppData.Lab.Ultravisor;
		let tmpForm = tmpState.Form;

		tmpForm.Name  = (this._domValue('#Lab-UltravisorForm-Name') || '').trim();
		tmpForm.Port  = parseInt(this._domValue('#Lab-UltravisorForm-Port') || '0', 10);
		// Read the checkbox directly — the form view doesn't bind it
		// to the AppData state at edit time, so the source of truth at
		// submit time is the DOM. Keep the read defensive in case the
		// element disappeared (e.g. test environments without the form).
		let tmpSecureEl = (typeof document !== 'undefined')
			? document.getElementById('Lab-UltravisorForm-Secure') : null;
		tmpForm.Secure = !!(tmpSecureEl && tmpSecureEl.checked);
		tmpForm.Error = '';

		if (!tmpForm.Name) { tmpForm.Error = 'Name is required.'; this.pict.views['Lab-Ultravisor'].render('Lab-Ultravisor-Form'); return; }
		if (!tmpForm.Port || tmpForm.Port < 1) { tmpForm.Error = 'Port is required.'; this.pict.views['Lab-Ultravisor'].render('Lab-Ultravisor-Form'); return; }

		this.pict.providers.LabApi.createUltravisor(
			{ Name: tmpForm.Name, Port: tmpForm.Port, Secure: tmpForm.Secure },
			(pErr) =>
			{
				if (pErr) { tmpForm.Error = pErr.message || 'Create failed.'; this.pict.views['Lab-Ultravisor'].render('Lab-Ultravisor-Form'); return; }
				tmpState.FormOpen = false;
				tmpForm.Name = '';
				tmpForm.Secure = false;
				tmpForm.Error = '';
				this.pict.views['Lab-Ultravisor'].render('Lab-Ultravisor-Form');
				this.refreshAll(() => {});
			});
	}

	startUltravisor(pID) { this.pict.providers.LabApi.startUltravisor(pID, (pErr) => { if (pErr) { this._toastError('Start failed: ' + pErr.message); return; } this.refreshAll(() => {}); }); }
	stopUltravisor(pID)  { this.pict.providers.LabApi.stopUltravisor(pID,  (pErr) => { if (pErr) { this._toastError('Stop failed: '  + pErr.message); return; } this.refreshAll(() => {}); }); }
	removeUltravisor(pID)
	{
		this._confirmDanger('Remove this Ultravisor?  Any beacons registered with it will be removed too.',
			{ title: 'Remove Ultravisor' })
			.then((pConfirmed) =>
				{
					if (!pConfirmed) { return; }
					this.pict.providers.LabApi.removeUltravisor(pID,
						(pErr) =>
						{
							if (pErr) { this._toastError('Remove failed: ' + pErr.message); return; }
							this.refreshAll(() => {});
						});
				});
	}

	// ── Secure-mode shortcuts ────────────────────────────────────────────
	//
	// "Add auth beacon" creates a beacon paired with a Secure UV without
	// the operator having to fill in the generic beacon form. We pick the
	// type, derive a name from the UV's name, and let the lab's existing
	// createBeacon flow do the spawn + JoinSecret plumbing.

	addAuthBeacon(pID)
	{
		let tmpUv = (this.pict.AppData.Lab.Ultravisor.Instances || [])
			.find((pU) => pU.IDUltravisorInstance === pID);
		if (!tmpUv) { this._toastError('Ultravisor not found in local state.'); return; }
		if (!tmpUv.Secure)
		{
			this._toastError('Ultravisor is not in Secure mode — auth beacon would be ignored.');
			return;
		}
		// Auto-name "<UV-Name>-auth" so the operator doesn't have to think
		// of one. If they want a different name they can use the generic
		// beacon form.
		let tmpName = `${tmpUv.Name}-auth`;
		this.pict.providers.LabApi.createBeacon(
		{
			Name:                 tmpName,
			BeaconType:           'ultravisor-auth-beacon',
			Port:                 0,
			IDUltravisorInstance: pID,
			Config:               {}
		}, (pErr) =>
		{
			if (pErr) { this._toastError('Add auth beacon failed: ' + pErr.message); return; }
			this._toastSuccess(`Auth beacon '${tmpName}' starting…`);
			this.refreshAll(() => {});
		});
	}

	bootstrapAdmin(pID)
	{
		let tmpUv = (this.pict.AppData.Lab.Ultravisor.Instances || [])
			.find((pU) => pU.IDUltravisorInstance === pID);
		if (!tmpUv) { this._toastError('Ultravisor not found.'); return; }
		if (tmpUv.Bootstrapped) { this._toastError('Already bootstrapped.'); return; }

		// Modal-driven prompt — Username + Password fields read at submit
		// time via _domValue. We DON'T persist these to AppData; the form
		// value is only ever held in the DOM during the dialog's lifetime.
		let tmpContent = ''
			+ '<p>Mint the first admin user for <strong>' + this._htmlEscape(tmpUv.Name) + '</strong>.</p>'
			+ '<p style="font-size:12px;color:#64748b;margin-top:8px;">'
			+ 'This consumes the one-time bootstrap token. Subsequent users go through the auth-beacon\'s normal admin-gated path.</p>'
			+ '<label style="display:block;margin-top:10px;">Username'
			+ '<input type="text" id="Lab-UV-BootstrapAdmin-Username" autocomplete="username" autofocus '
			+ 'style="width:100%;box-sizing:border-box;padding:6px 10px;border:1px solid #cfd5dd;border-radius:6px;margin-top:4px;">'
			+ '</label>'
			+ '<label style="display:block;margin-top:10px;">Password'
			+ '<input type="password" id="Lab-UV-BootstrapAdmin-Password" autocomplete="new-password" '
			+ 'style="width:100%;box-sizing:border-box;padding:6px 10px;border:1px solid #cfd5dd;border-radius:6px;margin-top:4px;">'
			+ '</label>';
		this._modal().show(
		{
			title: 'Bootstrap admin',
			content: tmpContent,
			closeable: true,
			buttons:
			[
				{ Hash: 'cancel', Label: 'Cancel' },
				{ Hash: 'go',     Label: 'Create admin', Style: 'primary' }
			]
		}).then((pChoice) =>
		{
			if (pChoice !== 'go') { return; }
			let tmpUsername = (this._domValue('#Lab-UV-BootstrapAdmin-Username') || '').trim();
			let tmpPassword = this._domValue('#Lab-UV-BootstrapAdmin-Password') || '';
			if (!tmpUsername || !tmpPassword)
			{
				this._toastError('Username and password are both required.');
				return;
			}
			this.pict.providers.LabApi.bootstrapAdminForUltravisor(pID,
				{ Username: tmpUsername, Password: tmpPassword },
				(pErr, pBody) =>
				{
					if (pErr)
					{
						let tmpReason = (pErr.body && pErr.body.Reason) || pErr.message || 'Bootstrap failed';
						this._toastError('Bootstrap failed: ' + tmpReason);
						return;
					}
					if (pBody && pBody.Success === false)
					{
						this._toastError('Bootstrap rejected: ' + (pBody.Reason || 'Unknown reason'));
						return;
					}
					this._toastSuccess(`Admin '${tmpUsername}' created. Sign into the Ultravisor UI to continue.`);
					this.refreshAll(() => {});
				});
		});
	}

	// Local HTML escape for modal content (no shared util in this app yet).
	_htmlEscape(pStr)
	{
		return String(pStr == null ? '' : pStr)
			.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
			.replace(/"/g, '&quot;').replace(/'/g, '&#39;');
	}

	// ── Persistence-beacon assignment (Session 3) ────────────────────────────

	setPersistenceBeacon(pID)
	{
		let tmpUv = (this.pict.AppData.Lab.Ultravisor.Instances || [])
			.find((pU) => pU.IDUltravisorInstance === pID);
		if (!tmpUv) { this._toastError('Ultravisor not found in local state.'); return; }
		if (tmpUv.Status !== 'running')
		{
			this._toastError('Ultravisor must be running before assigning persistence.');
			return;
		}

		// Step 1: dropdown of running databeacons. Filter to type +
		// status so the operator can't pick something nonsensical. The
		// connections sub-select gets populated lazily on beacon change.
		let tmpDataBeacons = (this.pict.AppData.Lab.Beacons.Beacons || [])
			.filter((pB) => pB.BeaconType === 'retold-databeacon' && pB.Status === 'running');

		if (tmpDataBeacons.length === 0)
		{
			this._modal().show(
			{
				title: 'No databeacons available',
				content: '<p>Spawn a <strong>retold-databeacon</strong> first, then add a connection inside it.</p>',
				closeable: true,
				buttons: [{ Hash: 'ok', Label: 'OK', Style: 'primary' }]
			});
			return;
		}

		let tmpCurrentBeaconID = parseInt(tmpUv.IDPersistenceBeacon, 10) || 0;
		let tmpCurrentConnID = parseInt(tmpUv.IDPersistenceConnection, 10) || 0;
		let tmpBeaconOptions = '<option value="0">— select a databeacon —</option>';
		for (let b = 0; b < tmpDataBeacons.length; b++)
		{
			let tmpBeacon = tmpDataBeacons[b];
			let tmpSel = (tmpBeacon.IDBeacon === tmpCurrentBeaconID) ? ' selected' : '';
			tmpBeaconOptions += '<option value="' + tmpBeacon.IDBeacon + '"' + tmpSel + '>'
				+ this._htmlEscape(tmpBeacon.Name) + ' (port ' + tmpBeacon.Port + ')</option>';
		}

		let tmpContent = ''
			+ '<p>Route queue + manifest persistence for <strong>' + this._htmlEscape(tmpUv.Name) + '</strong> through a databeacon.</p>'
			+ '<p style="font-size:12px;color:#64748b;margin-top:8px;">'
			+ 'The databeacon needs at least one connection configured (engine + database). Pick a connection and the bridge will create the UV* tables on first save.</p>'
			+ '<label style="display:block;margin-top:10px;">Databeacon'
			+ '<select id="Lab-UV-PersistenceBeacon-Beacon" '
			+ 'style="width:100%;box-sizing:border-box;padding:6px 10px;border:1px solid #cfd5dd;border-radius:6px;margin-top:4px;">'
			+ tmpBeaconOptions + '</select></label>'
			+ '<label style="display:block;margin-top:10px;">Connection'
			+ '<select id="Lab-UV-PersistenceBeacon-Connection" disabled '
			+ 'style="width:100%;box-sizing:border-box;padding:6px 10px;border:1px solid #cfd5dd;border-radius:6px;margin-top:4px;">'
			+ '<option value="0">— pick a databeacon first —</option></select></label>'
			+ '<div id="Lab-UV-PersistenceBeacon-ConnHelp" style="font-size:11px;color:#94a3b8;margin-top:4px;"></div>';

		// Hook the beacon-select change AFTER the modal renders so the
		// connection list refreshes lazily. setTimeout(0) gives the modal
		// a tick to insert the content into the DOM.
		setTimeout(() =>
		{
			let tmpBeaconEl = document.getElementById('Lab-UV-PersistenceBeacon-Beacon');
			let tmpConnEl = document.getElementById('Lab-UV-PersistenceBeacon-Connection');
			let tmpHelpEl = document.getElementById('Lab-UV-PersistenceBeacon-ConnHelp');
			if (!tmpBeaconEl || !tmpConnEl) return;

			let fLoadConnections = (pBID) =>
			{
				let tmpBeaconID = parseInt(pBID, 10) || 0;
				if (!tmpBeaconID)
				{
					tmpConnEl.innerHTML = '<option value="0">— pick a databeacon first —</option>';
					tmpConnEl.disabled = true;
					tmpHelpEl.textContent = '';
					return;
				}
				tmpConnEl.innerHTML = '<option value="0">loading…</option>';
				tmpConnEl.disabled = true;
				this.pict.providers.LabApi.listBeaconConnections(tmpBeaconID,
					(pErr, pPayload) =>
					{
						if (pErr)
						{
							tmpConnEl.innerHTML = '<option value="0">— error loading connections —</option>';
							tmpHelpEl.textContent = pErr.message || 'Failed to load connections.';
							return;
						}
						let tmpConnections = (pPayload && Array.isArray(pPayload.Connections)) ? pPayload.Connections : (Array.isArray(pPayload) ? pPayload : []);
						if (tmpConnections.length === 0)
						{
							tmpConnEl.innerHTML = '<option value="0">— no connections in this databeacon —</option>';
							tmpHelpEl.textContent = 'Add a connection inside the databeacon first.';
							return;
						}
						let tmpHTML = '<option value="0">— select a connection —</option>';
						for (let c = 0; c < tmpConnections.length; c++)
						{
							let tmpConn = tmpConnections[c];
							let tmpConnID = tmpConn.IDBeaconConnection || tmpConn.ID || 0;
							let tmpName = tmpConn.Name || ('Connection ' + tmpConnID);
							let tmpType = tmpConn.Type || '';
							let tmpSel = (tmpConnID === tmpCurrentConnID && tmpBeaconID === tmpCurrentBeaconID) ? ' selected' : '';
							tmpHTML += '<option value="' + tmpConnID + '"' + tmpSel + '>'
								+ this._htmlEscape(tmpName) + (tmpType ? ' (' + this._htmlEscape(tmpType) + ')' : '')
								+ '</option>';
						}
						tmpConnEl.innerHTML = tmpHTML;
						tmpConnEl.disabled = false;
						tmpHelpEl.textContent = '';
					});
			};

			tmpBeaconEl.addEventListener('change', (pEv) => fLoadConnections(pEv.target.value));
			// Pre-load if the UV already has an assignment.
			if (tmpCurrentBeaconID > 0) { fLoadConnections(tmpCurrentBeaconID); }
		}, 0);

		let tmpButtons =
		[
			{ Hash: 'cancel', Label: 'Cancel' }
		];
		if (tmpCurrentBeaconID > 0)
		{
			tmpButtons.push({ Hash: 'clear', Label: 'Clear assignment' });
		}
		tmpButtons.push({ Hash: 'save', Label: 'Save', Style: 'primary' });

		this._modal().show(
		{
			title: 'Persistence beacon',
			content: tmpContent,
			closeable: true,
			buttons: tmpButtons
		}).then((pChoice) =>
		{
			if (pChoice === 'cancel') { return; }
			let tmpBody;
			if (pChoice === 'clear')
			{
				tmpBody = { IDBeacon: null, IDBeaconConnection: 0 };
			}
			else
			{
				let tmpIDBeacon = parseInt(this._domValue('#Lab-UV-PersistenceBeacon-Beacon') || '0', 10);
				let tmpIDConn = parseInt(this._domValue('#Lab-UV-PersistenceBeacon-Connection') || '0', 10);
				if (tmpIDBeacon === 0)
				{
					this._toastError('Pick a databeacon (or use Clear assignment).');
					return;
				}
				if (tmpIDConn === 0)
				{
					this._toastError('Pick a connection inside the databeacon.');
					return;
				}
				tmpBody = { IDBeacon: tmpIDBeacon, IDBeaconConnection: tmpIDConn };
			}

			this.pict.providers.LabApi.setPersistenceBeacon(pID, tmpBody,
				(pErr) =>
				{
					if (pErr)
					{
						this._toastError('Persistence assignment failed: ' + (pErr.message || 'Unknown error'));
						return;
					}
					this._toastSuccess(pChoice === 'clear' ? 'Persistence assignment cleared.' : 'Persistence assignment saved — bootstrapping…');
					this.refreshAll(() => {});
				});
		});
	}

	// ── Persistence pill fast-poll ───────────────────────────────────────────
	// While a UV's persistence is in a transient state (waiting-for-beacon /
	// bootstrapping), we poll its /persistence-status every 2s so the pill
	// reflects state changes faster than the global 10s refresh. Pollers
	// stop themselves once steady, and clean up on view destroy.

	_pumpPersistencePollers()
	{
		this._persistencePollers = this._persistencePollers || {};
		let tmpInstances = (this.pict.AppData.Lab.Ultravisor && this.pict.AppData.Lab.Ultravisor.Instances) || [];
		let tmpActiveIDs = new Set();
		for (let i = 0; i < tmpInstances.length; i++)
		{
			let tmpUv = tmpInstances[i];
			let tmpState = tmpUv.Persistence && tmpUv.Persistence.State;
			if (tmpState === 'waiting-for-beacon' || tmpState === 'bootstrapping')
			{
				tmpActiveIDs.add(tmpUv.IDUltravisorInstance);
				if (!this._persistencePollers[tmpUv.IDUltravisorInstance])
				{
					this._startPersistencePoller(tmpUv.IDUltravisorInstance);
				}
			}
		}
		// Stop pollers for UVs that no longer exist or are now steady.
		let tmpKeys = Object.keys(this._persistencePollers);
		for (let k = 0; k < tmpKeys.length; k++)
		{
			let tmpID = parseInt(tmpKeys[k], 10);
			if (!tmpActiveIDs.has(tmpID))
			{
				this._stopPersistencePoller(tmpID);
			}
		}
	}

	_startPersistencePoller(pID)
	{
		this._persistencePollers = this._persistencePollers || {};
		if (this._persistencePollers[pID]) return;
		this._persistencePollers[pID] = setInterval(() =>
		{
			this.pict.providers.LabApi.getUltravisorPersistenceStatus(pID,
				(pErr, pPayload) =>
				{
					if (pErr || !pPayload || !pPayload.Persistence) return;
					let tmpInstances = (this.pict.AppData.Lab.Ultravisor && this.pict.AppData.Lab.Ultravisor.Instances) || [];
					let tmpRow = tmpInstances.find((pU) => pU.IDUltravisorInstance === pID);
					if (tmpRow)
					{
						tmpRow.Persistence = pPayload.Persistence;
					}
					this._refreshActiveList();
					// Stop ourselves once we see a steady state — let
					// _pumpPersistencePollers handle re-arming if it
					// flips back to transient on the next refreshAll.
					let tmpState = pPayload.Persistence.State;
					if (tmpState !== 'waiting-for-beacon' && tmpState !== 'bootstrapping')
					{
						this._stopPersistencePoller(pID);
					}
				});
		}, 2000);
	}

	_stopPersistencePoller(pID)
	{
		if (!this._persistencePollers || !this._persistencePollers[pID]) return;
		clearInterval(this._persistencePollers[pID]);
		delete this._persistencePollers[pID];
	}

	_stopAllPersistencePollers()
	{
		if (!this._persistencePollers) return;
		let tmpKeys = Object.keys(this._persistencePollers);
		for (let k = 0; k < tmpKeys.length; k++)
		{
			clearInterval(this._persistencePollers[tmpKeys[k]]);
		}
		this._persistencePollers = {};
	}

	// ── Seed dataset actions ────────────────────────────────────────────────

	/**
	 * Read the three target selectors from the DOM so run/seed-to-engine
	 * actions pick up whatever the user has selected without per-change
	 * handlers syncing to AppData.
	 */
	_readSeedTargetsFromDOM()
	{
		return {
			IDUltravisorInstance: parseInt(this._domValue('#Lab-SeedTargets-Ultravisor') || '0', 10),
			IDBeacon:             parseInt(this._domValue('#Lab-SeedTargets-Databeacon') || '0', 10),
			IDDBEngine:           parseInt(this._domValue('#Lab-SeedTargets-DBEngine')   || '0', 10)
		};
	}

	/**
	 * After every refresh, if exactly one entity of a given type is running
	 * and the user hasn't picked one yet, auto-select it.  Clears stale
	 * selections whose entity is no longer running.  This is the "if there's
	 * only one, just use it" behavior.
	 */
	_applySeedTargetDefaults()
	{
		let tmpTargets = (this.pict.AppData.Lab.SeedDatasets && this.pict.AppData.Lab.SeedDatasets.Targets) || {};
		let tmpUVs     = ((this.pict.AppData.Lab.Ultravisor && this.pict.AppData.Lab.Ultravisor.Instances) || []).filter((pR) => pR.Status === 'running');
		// Only retold-databeacon rows can be seed targets today.
		let tmpBeacons = ((this.pict.AppData.Lab.Beacons && this.pict.AppData.Lab.Beacons.Beacons) || []).filter((pR) => pR.Status === 'running' && pR.BeaconType === 'retold-databeacon');
		let tmpEngines = ((this.pict.AppData.Lab.DBEngines && this.pict.AppData.Lab.DBEngines.Engines) || []).filter((pR) => pR.Status === 'running');

		this._autoPickTarget(tmpTargets, 'IDUltravisorInstance', tmpUVs,     'IDUltravisorInstance');
		this._autoPickTarget(tmpTargets, 'IDBeacon',             tmpBeacons, 'IDBeacon');
		this._autoPickTarget(tmpTargets, 'IDDBEngine',           tmpEngines, 'IDDBEngine');
	}

	_autoPickTarget(pTargets, pField, pRunningRows, pIDKey)
	{
		let tmpCurrent = pTargets[pField] || 0;
		// Drop a stale selection that's no longer in the running set.
		if (tmpCurrent && !pRunningRows.some((pR) => pR[pIDKey] === tmpCurrent))
		{
			pTargets[pField] = 0;
			tmpCurrent = 0;
		}
		// Exactly one running + nothing picked => pick it.
		if (!tmpCurrent && pRunningRows.length === 1)
		{
			pTargets[pField] = pRunningRows[0][pIDKey];
		}
	}

	runSeedDataset(pDatasetHash)
	{
		let tmpTargets = this._readSeedTargetsFromDOM();
		this.pict.AppData.Lab.SeedDatasets.Targets = Object.assign(
			this.pict.AppData.Lab.SeedDatasets.Targets || {}, tmpTargets);

		if (!tmpTargets.IDUltravisorInstance || !tmpTargets.IDBeacon)
		{
			this._toastWarning('Pick a target Ultravisor and Databeacon first.');
			return;
		}
		this.pict.providers.LabApi.runSeedDataset(pDatasetHash,
			{
				IDUltravisorInstance: tmpTargets.IDUltravisorInstance,
				IDBeacon:             tmpTargets.IDBeacon
			},
			(pErr, pResult) =>
			{
				if (pErr) { this._toastError('Run failed: ' + pErr.message); return; }
				this._toastSuccess(`Seed '${pDatasetHash}' running...`);
				this.refreshAll(() => {});
			});
	}

	seedDatasetToEngine(pDatasetHash)
	{
		let tmpTargets = this._readSeedTargetsFromDOM();
		this.pict.AppData.Lab.SeedDatasets.Targets = Object.assign(
			this.pict.AppData.Lab.SeedDatasets.Targets || {}, tmpTargets);

		if (!tmpTargets.IDUltravisorInstance || !tmpTargets.IDDBEngine)
		{
			this._toastWarning('Pick a target Ultravisor and DB engine first.');
			return;
		}
		this._toast(`Provisioning database + beacon for '${pDatasetHash}'...`, 'info', { duration: 2500 });
		this.pict.providers.LabApi.seedDatasetToEngine(pDatasetHash,
			{
				IDUltravisorInstance: tmpTargets.IDUltravisorInstance,
				IDDBEngine:           tmpTargets.IDDBEngine
			},
			(pErr, pResult) =>
			{
				if (pErr) { this._toastError('Quick-seed failed: ' + pErr.message); return; }
				this._toastSuccess(`Seed '${pDatasetHash}' running...`);
				this.refreshAll(() => {});
			});
	}

	// ── Beacon Exercises handlers ──────────────────────────────────────────────────

	_readBeaconExerciseTargetFromDOM()
	{
		let tmpVal = this._domValue('#Lab-BeaconExercises-Targets-Ultravisor');
		let tmpID = parseInt(tmpVal, 10);
		return Number.isFinite(tmpID) ? tmpID : 0;
	}

	/**
	 * onchange handler on the Beacon Exercises UV dropdown.  Syncs the DOM-side
	 * selection back to AppData so the scenario cards re-evaluate their
	 * disabled state (Secure-required + running-required) and the snapshot
	 * poll picks up the new target.
	 */
	setBeaconExerciseTargetUV()
	{
		let tmpUvID = this._readBeaconExerciseTargetFromDOM();
		if (!this.pict.AppData.Lab.BeaconExercises.Targets) { this.pict.AppData.Lab.BeaconExercises.Targets = {}; }
		this.pict.AppData.Lab.BeaconExercises.Targets.IDUltravisorInstance = tmpUvID;
		// Clear stale snapshot when target changes; the next refresh will
		// fetch the new target's snapshot if active and target is set.
		this.pict.AppData.Lab.BeaconExercises.Snapshot = null;
		// Re-render the BeaconExercises view's slots so cards update their
		// disabled state immediately, without waiting for the next poll.
		if (this.pict.AppData.Lab.ActiveView === 'BeaconExercises')
		{
			this.pict.views['Lab-BeaconExercises'].render('Lab-BeaconExercises-Board');
			this.pict.views['Lab-BeaconExercises'].render('Lab-BeaconExercises-Scenarios');
		}
	}

	/**
	 * Auto-pick the first running UV (Secure or promiscuous) as the
	 * BeaconExercises target if none is set yet.  Called from refreshAll
	 * after instances list lands.  Mirrors _applySeedTargetDefaults's
	 * pattern.  The card-enable rule downstream evaluates whether the
	 * UV's auth configuration actually allows scenarios to run, so the
	 * operator sees a specific hint when an auto-picked UV isn't
	 * usable rather than no defaulting at all.
	 */
	_applyBeaconExerciseTargetDefaults()
	{
		let tmpState = this.pict.AppData.Lab.BeaconExercises;
		if (!tmpState) { return; }
		if (!tmpState.Targets) { tmpState.Targets = {}; }
		if (tmpState.Targets.IDUltravisorInstance) { return; }  // already chosen
		let tmpInstances = (this.pict.AppData.Lab.Ultravisor && this.pict.AppData.Lab.Ultravisor.Instances) || [];
		let tmpEligible = tmpInstances.filter((pUv) => pUv.Status === 'running');
		if (tmpEligible.length === 0) { return; }
		tmpState.Targets.IDUltravisorInstance = tmpEligible[0].IDUltravisorInstance;
	}

	runBeaconExercise(pHash)
	{
		let tmpUvID = this._readBeaconExerciseTargetFromDOM();
		this.pict.AppData.Lab.BeaconExercises.Targets.IDUltravisorInstance = tmpUvID;
		if (!tmpUvID)
		{
			this._toastWarning('Pick a target Ultravisor first.');
			return;
		}
		this._toast(`Starting scenario '${pHash}'...`, 'info', { duration: 2500 });
		this.pict.providers.LabApi.runBeaconExercise(pHash, { IDUltravisorInstance: tmpUvID },
			(pErr, pResult) =>
			{
				if (pErr) { this._toastError('Run failed: ' + pErr.message); return; }
				this._toastSuccess(`Scenario '${pHash}' running (run #${pResult.IDBeaconExerciseRun}).`);
				this.refreshAll(() => {});
			});
	}

	cancelBeaconExerciseRun(pID)
	{
		this.pict.providers.LabApi.cancelBeaconExerciseRun(pID, (pErr, pResult) =>
			{
				if (pErr) { this._toastError('Cancel failed: ' + pErr.message); return; }
				let tmpUncan = (pResult && pResult.Uncancelable) ? pResult.Uncancelable.length : 0;
				this._toast(`Cancel issued (uncancelable=${tmpUncan}).`, 'info');
				this.refreshAll(() => {});
			});
	}

	// ── Operation Exercises handlers ──────────────────────────────────────

	_readOperationExerciseTargetFromDOM()
	{
		let tmpVal = this._domValue('#Lab-OperationExercises-Targets-Ultravisor');
		let tmpID = parseInt(tmpVal, 10);
		return Number.isFinite(tmpID) ? tmpID : 0;
	}

	setOperationExerciseTargetUV()
	{
		let tmpUvID = this._readOperationExerciseTargetFromDOM();
		if (!this.pict.AppData.Lab.OperationExercises.Targets) { this.pict.AppData.Lab.OperationExercises.Targets = {}; }
		this.pict.AppData.Lab.OperationExercises.Targets.IDUltravisorInstance = tmpUvID;
		if (this.pict.AppData.Lab.ActiveView === 'OperationExercises')
		{
			this.pict.views['Lab-OperationExercises'].render('Lab-OperationExercises-Cards');
		}
	}

	_applyOperationExerciseTargetDefaults()
	{
		let tmpState = this.pict.AppData.Lab.OperationExercises;
		if (!tmpState) { return; }
		if (!tmpState.Targets) { tmpState.Targets = {}; }
		if (tmpState.Targets.IDUltravisorInstance) { return; }
		let tmpInstances = (this.pict.AppData.Lab.Ultravisor && this.pict.AppData.Lab.Ultravisor.Instances) || [];
		let tmpEligible = tmpInstances.filter((pUv) => pUv.Status === 'running');
		if (tmpEligible.length === 0) { return; }
		tmpState.Targets.IDUltravisorInstance = tmpEligible[0].IDUltravisorInstance;
	}

	runOperationExercise(pHash)
	{
		let tmpUvID = this._readOperationExerciseTargetFromDOM();
		this.pict.AppData.Lab.OperationExercises.Targets.IDUltravisorInstance = tmpUvID;
		if (!tmpUvID)
		{
			this._toastWarning('Pick a target Ultravisor first.');
			return;
		}
		this._toast(`Starting exercise '${pHash}'...`, 'info', { duration: 2500 });
		this.pict.providers.LabApi.runOperationExercise(pHash, { IDUltravisorInstance: tmpUvID },
			(pErr, pResult) =>
			{
				if (pErr) { this._toastError('Run failed: ' + pErr.message); return; }
				this._toastSuccess(`Exercise '${pHash}' running (run #${pResult.IDOperationExerciseRun}).`);
				this.refreshAll(() => {});
			});
	}

	cancelOperationExerciseRun(pID)
	{
		this.pict.providers.LabApi.cancelOperationExerciseRun(pID, (pErr, pResult) =>
			{
				if (pErr) { this._toastError('Cancel failed: ' + pErr.message); return; }
				let tmpUncan = (pResult && pResult.Uncancelable) ? pResult.Uncancelable.length : 0;
				this._toast(`Cancel issued (uncancelable=${tmpUncan}).`, 'info');
				this.refreshAll(() => {});
			});
	}

	// ─────────────────────────────────────────────────────────────────
	//  Stacks (Phase 8)
	// ─────────────────────────────────────────────────────────────────

	openStacks()
	{
		this.pict.AppData.Lab.Stacks.Screen = 'list';
		this._loadStacks(() =>
		{
			this.setActiveView('Stacks');
		});
	}

	openPresetChooser()
	{
		this.pict.AppData.Lab.Stacks.Screen = 'preset-chooser';
		this._loadPresets(() =>
		{
			this.setActiveView('Stacks');
		});
	}

	openStackEditor(pHash)
	{
		this.pict.providers.LabApi.getStack(pHash, (pErr, pResult) =>
		{
			if (pErr) { this._toastError('Load failed: ' + pErr.message); return; }
			let tmpRecord = pResult && pResult.Stack;
			if (!tmpRecord) { this._toastError('Stack not found'); return; }
			let tmpState = this.pict.AppData.Lab.Stacks;
			tmpState.Screen = 'editor';
			tmpState.EditorRecord = tmpRecord;
			// Saved input values come back on the record; clone so
			// in-progress edits don't mutate it.
			tmpState.InputValues = Object.assign({}, tmpRecord.InputValues || {});
			tmpState.LastPreflight = null;
			tmpState.LastLaunchResult = null;
			// setActiveView covers the deep-link case where the user
			// landed here from outside the Stacks tab; it's idempotent
			// when Stacks is already active.
			this.setActiveView('Stacks');
		});
	}

	openStackDetail(pHash)
	{
		this.pict.providers.LabApi.getStack(pHash, (pErr, pResult) =>
		{
			if (pErr) { this._toastError('Load failed: ' + pErr.message); return; }
			let tmpRecord = pResult && pResult.Stack;
			if (!tmpRecord) { this._toastError('Stack not found'); return; }
			let tmpState = this.pict.AppData.Lab.Stacks;
			tmpState.Screen = 'detail';
			tmpState.DetailRecord = tmpRecord;
			// Fire two parallel refreshes — status + YAML.
			this._loadStackStatus(pHash, () => {
				this._loadStackYaml(pHash, () => {
					this.setActiveView('Stacks');
				});
			});
		});
	}

	cloneStackPreset(pPresetHash)
	{
		this.pict.providers.LabApi.clonePreset(pPresetHash, '', (pErr, pResult) =>
		{
			if (pErr) { this._toastError('Clone failed: ' + pErr.message); return; }
			let tmpStack = pResult && pResult.Stack;
			if (!tmpStack) { this._toastError('Clone returned no stack'); return; }
			this._toastSuccess('Cloned preset → ' + tmpStack.Hash);
			// Drop straight into editor for the clone.
			this.openStackEditor(tmpStack.Hash);
		});
	}

	saveStackFromEditor(pHash)
	{
		let tmpState = this.pict.AppData.Lab.Stacks;
		if (!tmpState.EditorRecord || tmpState.EditorRecord.Hash !== pHash)
		{
			this._toastError('Editor state lost; reopen the stack');
			return;
		}
		// Marshal current input field values + send them along with the
		// spec. The Stack table has an InputValuesJSON column so values
		// persist across reloads and across machines (canonical in SQLite).
		this._marshalEditorInputs();
		this.pict.providers.LabApi.saveStack(tmpState.EditorRecord.Spec, tmpState.InputValues, (pErr, pResult) =>
		{
			if (pErr) { this._toastError('Save failed: ' + pErr.message); return; }
			// Refresh EditorRecord with what the server canonicalized.
			let tmpSaved = pResult && pResult.Stack;
			if (tmpSaved) { tmpState.EditorRecord = tmpSaved; }
			this._toastSuccess('Stack saved');
		});
	}

	runStackPreflight(pHash)
	{
		let tmpState = this.pict.AppData.Lab.Stacks;
		this._marshalEditorInputs();
		this.pict.providers.LabApi.preflightStack(pHash, tmpState.InputValues, (pErr, pResult) =>
		{
			if (pErr) { this._toastError('Preflight failed: ' + pErr.message); return; }
			tmpState.LastPreflight = { Hash: pHash, Report: (pResult && pResult.Report) || { Status:'ready', Items:[] } };
			this.pict.views['Lab-Stacks'].render();
		});
	}

	launchStack(pHash)
	{
		let tmpState = this.pict.AppData.Lab.Stacks;
		this._marshalEditorInputs();
		// Persist the inputs we're about to launch with so the editor
		// remembers them on next visit (the button is "Save & Launch").
		// Skip when EditorRecord is missing — e.g. launch fired from
		// the detail view, where we don't have the spec in hand.
		if (tmpState.EditorRecord && tmpState.EditorRecord.Hash === pHash)
		{
			this.pict.providers.LabApi.saveStack(
				tmpState.EditorRecord.Spec, tmpState.InputValues, () => { /* fire-and-forget */ });
		}
		this._toast('Launching stack...', 'info', { duration: 2000 });
		this.pict.providers.LabApi.upStack(pHash, tmpState.InputValues, (pErr, pResult) =>
		{
			if (pErr) { this._toastError('Launch failed: ' + pErr.message); return; }
			// Always persist the latest launch result so the editor can
			// surface the full preflight + raw compose output on failure.
			tmpState.LastLaunchResult = { Hash: pHash, Result: pResult || {} };
			if (pResult && pResult.PreflightReport)
			{
				tmpState.LastPreflight = { Hash: pHash, Report: pResult.PreflightReport };
			}
			if (pResult && pResult.Status === 'preflight-blocked')
			{
				this._toastError('Preflight blocked launch — see report below');
				this.pict.views['Lab-Stacks'].render();
				return;
			}
			if (pResult && pResult.Status === 'error')
			{
				let tmpSummary = this._summarizeRawOutput(pResult.RawOutput) || 'see launch output below';
				this._toastError('Launch failed: ' + tmpSummary);
				this.pict.views['Lab-Stacks'].render();
				// Refresh the events list so the matching stack-launch-failed
				// row shows up without the user hitting Refresh.
				this.refreshAll(() => {});
				return;
			}
			this._toastSuccess('Stack ' + (pResult ? pResult.Status : 'launched'));
			this.refreshAll(() => {});
			// Switch to detail view for live status.
			this.openStackDetail(pHash);
		});
	}

	_summarizeRawOutput(pRaw)
	{
		if (!pRaw) return '';
		let tmpLines = String(pRaw).split('\n').map((pL) => pL.trim())
			.filter((pL) => pL.length > 0 && pL !== '[stderr]');
		for (let i = tmpLines.length - 1; i >= 0; i--)
		{
			if (/error/i.test(tmpLines[i])) return tmpLines[i].slice(0, 200);
		}
		return (tmpLines[tmpLines.length - 1] || '').slice(0, 200);
	}

	teardownStack(pHash)
	{
		this._modal().confirm('Tear down this stack? Containers will be removed; bind-mounted folders survive.',
			{ confirmLabel: 'Teardown', dangerous: true })
			.then((pOk) =>
			{
				if (!pOk) return;
				this._toast('Tearing down...', 'info', { duration: 2000 });
				this.pict.providers.LabApi.downStack(pHash, (pErr, pResult) =>
				{
					if (pErr) { this._toastError('Teardown failed: ' + pErr.message); return; }
					this._toastSuccess('Stack ' + (pResult ? pResult.Status : 'stopped'));
					this.openStackDetail(pHash);
				});
			});
	}

	removeStack(pHash)
	{
		this._modal().confirm('Remove this stack from the lab? Will tear down first if running.',
			{ confirmLabel: 'Remove', dangerous: true })
			.then((pOk) =>
			{
				if (!pOk) return;
				this.pict.providers.LabApi.removeStack(pHash, (pErr) =>
				{
					if (pErr) { this._toastError('Remove failed: ' + pErr.message); return; }
					this._toastSuccess('Stack removed');
					this.openStacks();
				});
			});
	}

	refreshStackDetail(pHash)
	{
		this._loadStackStatus(pHash, () => {
			this._loadStackYaml(pHash, () => {
				this.pict.views['Lab-Stacks'].render();
				this._toast('Refreshed', 'info', { duration: 1500 });
			});
		});
	}

	_loadStacks(fCallback)
	{
		this.pict.providers.LabApi.listStacks((pErr, pResult) =>
		{
			if (!pErr && pResult) { this.pict.AppData.Lab.Stacks.Stacks = pResult.Stacks || []; }
			return fCallback();
		});
	}

	_loadPresets(fCallback)
	{
		this.pict.providers.LabApi.listStackPresets((pErr, pResult) =>
		{
			if (!pErr && pResult) { this.pict.AppData.Lab.Stacks.Presets = pResult.Presets || []; }
			return fCallback();
		});
	}

	_loadStackStatus(pHash, fCallback)
	{
		this.pict.providers.LabApi.getStackStatus(pHash, (pErr, pStatus) =>
		{
			if (!pErr && pStatus)
			{
				this.pict.AppData.Lab.Stacks.LastStatus = { Hash: pHash, Status: pStatus };
			}
			return fCallback();
		});
	}

	_loadStackYaml(pHash, fCallback)
	{
		this.pict.providers.LabApi.getStackComposeYaml(pHash, (pErr, pResult) =>
		{
			if (!pErr && pResult)
			{
				this.pict.AppData.Lab.Stacks.LastYaml = {
					Hash: pHash, YAML: pResult.YAML || '', Source: pResult.Source || ''
				};
			}
			return fCallback();
		});
	}

	// Walk the editor's <input data-input-key> nodes and pull current
	// values into AppData.Lab.Stacks.InputValues. Read-on-action style;
	// no per-keystroke listeners.
	_marshalEditorInputs()
	{
		let tmpInputs = document.querySelectorAll('[data-input-key]');
		let tmpState = this.pict.AppData.Lab.Stacks;
		if (!tmpState.InputValues) { tmpState.InputValues = {}; }
		for (let i = 0; i < tmpInputs.length; i++)
		{
			let tmpEl = tmpInputs[i];
			let tmpKey = tmpEl.getAttribute('data-input-key');
			if (!tmpKey) continue;
			let tmpVal = tmpEl.value;
			if (tmpVal !== undefined && tmpVal !== '') { tmpState.InputValues[tmpKey] = tmpVal; }
		}
	}
}

module.exports = LabBrowserApplication;
