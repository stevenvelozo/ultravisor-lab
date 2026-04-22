/**
 * Service-BeaconTypeRegistry
 *
 * Discovers and caches the set of beacon types the lab can spawn.  A
 * beacon type is defined by a `retoldBeacon` stanza in an npm package's
 * package.json (or in a lab-local registry entry for modules that don't
 * declare one yet).
 *
 * Stanza shape (embedded in a module's package.json):
 *
 *   {
 *     "retoldBeacon": {
 *       "displayName": "Human label",
 *       "description": "One-line summary",
 *       "category":    "database|media|content|...",     // for grouping in the UI
 *       "mode":        "standalone-service|capability-provider",
 *
 *       // standalone-service: lab supervises a bin the module provides.
 *       "bin":          "./bin/retold-databeacon.js",
 *       "argTemplate":  [ "serve", { "flag": "--config", "fromLabPath": "ConfigPath" } ],
 *       "healthCheck":  { "path": "/beacon/capabilities" },
 *
 *       // capability-provider: lab spawns a generic host that loads a
 *       // ultravisor-beacon CapabilityProvider class from the module.
 *       "providerPath": "./source/Orator-Conversion-BeaconProvider.js",
 *       "capability":   "MediaConversion",
 *
 *       // pict-section-form schema for the per-type configuration panel.
 *       // May be an inline object, or a string path relative to the
 *       // package root (e.g. "./retold-beacon-schema.json").
 *       "configForm":   { ... } | "./retold-beacon-schema.json",
 *
 *       "defaultPort":  8500
 *     }
 *   }
 *
 * Lab-local overrides (for modules without a stanza yet, or for lab-only
 * custom hosts) live at the top of this file in LOCAL_REGISTRY_ENTRIES.
 * Each local entry carries the same shape but resolves paths against the
 * lab module root rather than a third-party package.
 */
'use strict';

const libPath = require('path');
const libFs = require('fs');
const libFableServiceProviderBase = require('fable-serviceproviderbase');

// Modules scanned for a retoldBeacon stanza.  Absence is fine; the module
// just won't contribute a beacon type.  Order here decides UI picker order.
const SCANNED_MODULES =
[
	'retold-databeacon',
	'orator-conversion',
	'retold-facto',
	'retold-content-system',
	'retold-remote'
];

// Lab-local registry entries for capability-provider beacons that ship
// inside the lab rather than as their own published npm package.  The
// provider source lives under `docker/providers/<name>/` as its own
// tiny build context; the lab's docker Dockerfile COPIES it into the
// container image at build time and retold-beacon-host loads it via
// `--provider /app/provider` at container-run time.  These entries carry
// all the stanza fields a published package would, plus:
//
//   LocalProviderDir: path (relative to lab root) to the docker build
//                     context directory.  Becomes the ContextDir passed
//                     to LabDockerManager.ensureImage.
const LOCAL_REGISTRY_ENTRIES =
[
	{
		BeaconType:  'meadow-integration',
		DisplayName: 'Meadow Integration',
		Description: 'Parse / transform / LabWriter capabilities that seed operations dispatch to via the Ultravisor.',
		Category:    'integration',
		Mode:        'capability-provider',
		Capability:  'MeadowIntegration',
		DefaultPort: 54400,
		RequiresUltravisor: true,
		HealthCheck: { Path: '/' },
		ConfigForm:  { Fields: [] },
		LocalProviderDir: 'docker/providers/meadow-integration',
		Docker:
		{
			Image:           'retold-beacon-host-meadow-integration',
			Version:         '0.0.1',  // bump when the provider source changes shape
			Dockerfile:      'retold-beacon-host-meadow-integration.Dockerfile',
			DataMountPath:   '/app/data',
			ConfigMountPath: '/app/data/config.json',
			ExposedPort:     54400,
			HostPackage:     'retold-beacon-host',
			HostVersion:     '',   // resolved dynamically by lookupPackageVersion
			// Data dirs the lab bind-mounts read-only into the container so
			// capability actions (e.g. MeadowIntegration.ParseFile) can read
			// them.  `Source` is relative to the lab root; the container
			// manager resolves it.  These are shared across all beacons of
			// this type -- each beacon gets the same mount at the same
			// container path.
			ExtraMounts:
			[
				{ Source: 'seed_datasets', Target: '/app/seed_datasets', ReadOnly: true }
			]
		}
	}
];

class ServiceBeaconTypeRegistry extends libFableServiceProviderBase
{
	constructor(pFable, pOptions, pServiceHash)
	{
		super(pFable, pOptions, pServiceHash);
		this.serviceType = 'LabBeaconTypeRegistry';

		this._types = null;  // Map<BeaconType, Descriptor>
	}

	/**
	 * Scan + cache on first use.  Subsequent calls return the cached map.
	 * Swapping modules in and out of the tree without a lab restart is a
	 * Phase-2 concern; Phase-1 settles on one scan per process.
	 */
	list()
	{
		if (!this._types) { this._types = this._scan(); }
		let tmpOut = [];
		for (let tmpKey of this._types.keys()) { tmpOut.push(this._types.get(tmpKey)); }
		return tmpOut;
	}

	get(pBeaconType)
	{
		if (!this._types) { this._types = this._scan(); }
		return this._types.get(pBeaconType) || null;
	}

	refresh()
	{
		this._types = this._scan();
	}

	_scan()
	{
		let tmpMap = new Map();

		// Start with the lab-local entries so they're present even if the
		// matching npm module doesn't declare a stanza.  Package-level
		// stanzas override a lab-local entry with the same BeaconType.
		for (let i = 0; i < LOCAL_REGISTRY_ENTRIES.length; i++)
		{
			let tmpEntry = this._normalizeLocal(LOCAL_REGISTRY_ENTRIES[i]);
			if (tmpEntry) { tmpMap.set(tmpEntry.BeaconType, tmpEntry); }
		}

		for (let j = 0; j < SCANNED_MODULES.length; j++)
		{
			let tmpName = SCANNED_MODULES[j];
			let tmpEntry = this._loadFromPackage(tmpName);
			if (tmpEntry) { tmpMap.set(tmpEntry.BeaconType, tmpEntry); }
		}

		this.fable.log.info(`BeaconTypeRegistry: ${tmpMap.size} beacon type(s) registered`);
		return tmpMap;
	}

	_normalizeLocal(pEntry)
	{
		let tmpLabRoot = libPath.resolve(__dirname, '..', '..');
		let tmpResolved = Object.assign({}, pEntry);
		if (pEntry.Bin) { tmpResolved.BinPath = libPath.resolve(tmpLabRoot, pEntry.Bin); }
		if (pEntry.ProviderPath)
		{
			tmpResolved.ProviderPath = libPath.resolve(tmpLabRoot, pEntry.ProviderPath);
		}
		// Lab-local capability-provider entries carry a build-context path
		// the Dockerfile COPYs into /app/provider/.  Resolve it to absolute
		// so the container manager can hand it straight to docker build.
		if (pEntry.LocalProviderDir)
		{
			tmpResolved.LocalProviderDir = libPath.resolve(tmpLabRoot, pEntry.LocalProviderDir);
		}
		tmpResolved.PackageRoot = tmpLabRoot;
		tmpResolved.Source = 'lab-local';
		tmpResolved.ConfigForm = this._resolveConfigForm(tmpLabRoot, pEntry.ConfigForm);
		// Preserve Docker block verbatim (it's already an object in the
		// literal; Object.assign above did the shallow copy).
		return tmpResolved;
	}

	_loadFromPackage(pModuleName)
	{
		// Prefer a sibling checkout under retold/modules/<group>/<name>/ so the
		// lab sees local edits without needing `npm link`.  Fall back to the
		// installed node_modules copy if no sibling exists.
		let tmpPackageJsonPath = this._resolveSiblingPackageJson(pModuleName);
		if (!tmpPackageJsonPath)
		{
			try { tmpPackageJsonPath = require.resolve(`${pModuleName}/package.json`); }
			catch (pErr) { return null; }
		}

		let tmpPackageJson;
		try { tmpPackageJson = JSON.parse(libFs.readFileSync(tmpPackageJsonPath, 'utf8')); }
		catch (pErr)
		{
			this.fable.log.warn(`BeaconTypeRegistry: could not read ${pModuleName}/package.json: ${pErr.message}`);
			return null;
		}

		let tmpStanza = tmpPackageJson.retoldBeacon;
		if (!tmpStanza) { return null; }

		let tmpPackageRoot = libPath.dirname(tmpPackageJsonPath);

		let tmpDescriptor =
		{
			BeaconType:         tmpStanza.beaconType || pModuleName,
			DisplayName:        tmpStanza.displayName || pModuleName,
			Description:        tmpStanza.description || '',
			Category:           tmpStanza.category || 'uncategorized',
			Mode:               tmpStanza.mode || 'standalone-service',
			PackageRoot:        tmpPackageRoot,
			PackageName:        pModuleName,
			PackageVersion:     tmpPackageJson.version || '0.0.0',
			DefaultPort:        tmpStanza.defaultPort || 0,
			RequiresUltravisor: !!tmpStanza.requiresUltravisor,
			HealthCheck:        this._normalizeHealthCheck(tmpStanza.healthCheck),
			ConfigForm:         this._resolveConfigForm(tmpPackageRoot, tmpStanza.configForm),
			ConfigTemplate:     tmpStanza.configTemplate || null,
			Source:             'package'
		};

		if (tmpStanza.bin)
		{
			tmpDescriptor.BinPath = libPath.resolve(tmpPackageRoot, tmpStanza.bin);
		}
		if (Array.isArray(tmpStanza.argTemplate))
		{
			tmpDescriptor.ArgTemplate = tmpStanza.argTemplate;
		}
		if (tmpStanza.providerPath)
		{
			tmpDescriptor.ProviderPath = libPath.resolve(tmpPackageRoot, tmpStanza.providerPath);
		}
		if (tmpStanza.capability)
		{
			tmpDescriptor.Capability = tmpStanza.capability;
		}
		// For capability-provider packages whose class is loaded inside the
		// beacon-host container, we don't need ProviderPath on the host.
		// `providerPackage` in the stanza carries the npm name for the
		// Dockerfile's `npm install` step; default to the package's own
		// name so providers don't have to restate themselves.
		//
		// If `providerPath` is present in the stanza, the class lives at a
		// submodule path of the package -- we compose the in-container
		// require spec as `<package>/<providerPath>` (leading `./` stripped)
		// so node's require() resolves to the right file inside
		// /app/node_modules/<package>/...  This lets published modules whose
		// `main` is something else (e.g. orator-conversion's
		// Orator-File-Translation) still surface the provider class to
		// retold-beacon-host.
		if (tmpStanza.mode === 'capability-provider')
		{
			let tmpBase = tmpStanza.providerPackage || pModuleName;
			if (tmpStanza.providerPath)
			{
				let tmpSub = tmpStanza.providerPath.replace(/^\.\//, '');
				tmpDescriptor.ProviderPackage = `${tmpBase}/${tmpSub}`;
			}
			else
			{
				tmpDescriptor.ProviderPackage = tmpBase;
			}
		}

		// docker block is optional -- types without one run via the host-process
		// path.  When present, BeaconManager routes through LabBeaconContainerManager
		// and the module's published version is baked into the locally-built image.
		if (tmpStanza.docker && typeof tmpStanza.docker === 'object')
		{
			tmpDescriptor.Docker =
				{
					Image:            tmpStanza.docker.image || pModuleName,
					Version:          tmpStanza.docker.version || tmpPackageJson.version || 'latest',
					Dockerfile:       tmpStanza.docker.dockerfile || '',
					DataMountPath:    tmpStanza.docker.dataMountPath || '/app/data',
					ConfigMountPath:  tmpStanza.docker.configMountPath || '/app/data/config.json',
					ContentMountPath: tmpStanza.docker.contentMountPath || '/app/content',
					ExposedPort:      tmpStanza.docker.exposedPort || tmpStanza.defaultPort || 0,
					// Capability-provider mode has a two-package image: the
					// generic beacon-host + the concrete provider.  HostPackage
					// defaults to 'retold-beacon-host'; HostVersion is free for
					// per-type override but usually the caller lets it default.
					HostPackage:      tmpStanza.docker.hostPackage || 'retold-beacon-host',
					HostVersion:      tmpStanza.docker.hostVersion || '',
					// Optional arrays consumed by the container manager:
					//   ExtraMounts   -- type-level mounts relative to lab root
					//                    (e.g. seed_datasets/ for MI beacons)
					//   ConfigMounts  -- per-beacon mounts whose Source is read
					//                    from the beacon's ConfigJSON at run time
					//                    (e.g. HostContentPath for retold-remote)
					ExtraMounts:      Array.isArray(tmpStanza.docker.extraMounts) ? tmpStanza.docker.extraMounts : [],
					ConfigMounts:     Array.isArray(tmpStanza.docker.configMounts) ? tmpStanza.docker.configMounts : []
				};
		}

		return tmpDescriptor;
	}

	/**
	 * Resolve the version of a dependency package the lab references but
	 * doesn't import -- notably `retold-beacon-host`, which is only baked
	 * into container images.  Tries sibling checkout first, then the lab's
	 * node_modules, then `latest` as a last resort.  Containers built with
	 * `latest` will re-pull on every lab version bump, which is fine since
	 * ensureImage skips the build when the tagged image already exists.
	 */
	lookupPackageVersion(pPackageName)
	{
		let tmpPath = this._resolveSiblingPackageJson(pPackageName);
		if (!tmpPath)
		{
			try { tmpPath = require.resolve(`${pPackageName}/package.json`); }
			catch (pErr) { return 'latest'; }
		}
		try
		{
			let tmpPkg = JSON.parse(libFs.readFileSync(tmpPath, 'utf8'));
			return tmpPkg.version || 'latest';
		}
		catch (pErr) { return 'latest'; }
	}

	/**
	 * Walk `retold/modules/*\/<pModuleName>/package.json`, returning the
	 * first hit.  Lets the lab pick up local edits to sibling repos without
	 * requiring an npm-link step during development.
	 */
	_resolveSiblingPackageJson(pModuleName)
	{
		// Lab lives at retold/modules/apps/ultravisor-lab/source/services/
		// so the modules root is four levels up.
		let tmpModulesRoot = libPath.resolve(__dirname, '..', '..', '..', '..');
		let tmpGroups;
		try { tmpGroups = libFs.readdirSync(tmpModulesRoot, { withFileTypes: true }); }
		catch (pErr) { return null; }

		for (let i = 0; i < tmpGroups.length; i++)
		{
			let tmpGroup = tmpGroups[i];
			if (!tmpGroup.isDirectory()) { continue; }
			let tmpCandidate = libPath.join(tmpModulesRoot, tmpGroup.name, pModuleName, 'package.json');
			if (libFs.existsSync(tmpCandidate)) { return tmpCandidate; }
		}
		return null;
	}

	_normalizeHealthCheck(pHealthCheck)
	{
		if (!pHealthCheck) { return { Path: '/' }; }
		return { Path: pHealthCheck.path || pHealthCheck.Path || '/' };
	}

	/**
	 * Accept either an inline form object or a path string.  Strings are
	 * resolved against the package root and JSON-loaded; anything malformed
	 * is swallowed with a warning (the UI falls back to a generic form).
	 */
	_resolveConfigForm(pRoot, pValue)
	{
		if (!pValue) { return null; }
		if (typeof pValue === 'object') { return pValue; }
		if (typeof pValue !== 'string') { return null; }

		let tmpPath = libPath.resolve(pRoot, pValue);
		try
		{
			let tmpText = libFs.readFileSync(tmpPath, 'utf8');
			return JSON.parse(tmpText);
		}
		catch (pErr)
		{
			this.fable.log.warn(`BeaconTypeRegistry: could not load config form ${tmpPath}: ${pErr.message}`);
			return null;
		}
	}

	/**
	 * Plain-JSON descriptor for REST consumers.  Strips internal-only fields
	 * like resolved file paths so the UI doesn't leak server filesystem
	 * details to the browser.
	 */
	publicDescriptor(pEntry)
	{
		if (!pEntry) { return null; }
		return {
			BeaconType:         pEntry.BeaconType,
			DisplayName:        pEntry.DisplayName,
			Description:        pEntry.Description,
			Category:           pEntry.Category,
			Mode:               pEntry.Mode,
			PackageName:        pEntry.PackageName || null,
			PackageVersion:     pEntry.PackageVersion || null,
			DefaultPort:        pEntry.DefaultPort || 0,
			RequiresUltravisor: !!pEntry.RequiresUltravisor,
			Capability:         pEntry.Capability || null,
			ConfigForm:         pEntry.ConfigForm || null,
			Source:             pEntry.Source
		};
	}
}

module.exports = ServiceBeaconTypeRegistry;
