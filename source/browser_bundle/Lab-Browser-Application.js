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
				Form:      { Name: '', Port: 54321, Error: '' }
			},
			Beacons:
			{
				FormOpen: false,
				Types:    [],
				Beacons:  [],
				Form:     { Name: '', BeaconType: '', Port: 0, IDUltravisorInstance: 0, Config: {}, Error: '' }
			},
			SeedDatasets:
			{
				Datasets:   [],
				Jobs:       [],
				Targets:    { IDUltravisorInstance: 0, IDBeacon: 0, IDDBEngine: 0 }
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
		else if (tmpName === 'Events')       { this.pict.views['Lab-Events'].render(); }
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
	}

	refreshAll(fCallback)
	{
		let tmpApi = this.pict.providers.LabApi;
		let tmpPending = 6;  // status, events, engines, ultravisors, beacons, jobs
		let tmpDone = () =>
		{
			tmpPending--;
			if (tmpPending <= 0)
			{
				this._applySeedTargetDefaults();
				this._refreshActiveList();
				this.pict.views['Lab-Navigation'].render();
				return fCallback();
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
				Config:               tmpConfig
			},
			(pErr) =>
			{
				if (pErr) { tmpForm.Error = pErr.message || 'Create failed.'; this.pict.views['Lab-Beacons'].render('Lab-Beacons-Form'); return; }
				tmpState.FormOpen = false;
				tmpForm.Name = '';
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
		tmpForm.Error = '';

		if (!tmpForm.Name) { tmpForm.Error = 'Name is required.'; this.pict.views['Lab-Ultravisor'].render('Lab-Ultravisor-Form'); return; }
		if (!tmpForm.Port || tmpForm.Port < 1) { tmpForm.Error = 'Port is required.'; this.pict.views['Lab-Ultravisor'].render('Lab-Ultravisor-Form'); return; }

		this.pict.providers.LabApi.createUltravisor({ Name: tmpForm.Name, Port: tmpForm.Port },
			(pErr) =>
			{
				if (pErr) { tmpForm.Error = pErr.message || 'Create failed.'; this.pict.views['Lab-Ultravisor'].render('Lab-Ultravisor-Form'); return; }
				tmpState.FormOpen = false;
				tmpForm.Name = '';
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
}

module.exports = LabBrowserApplication;
