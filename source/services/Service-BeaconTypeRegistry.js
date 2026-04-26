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
 * There are no lab-local overrides: every beacon type (standalone-service
 * or capability-provider) is a published npm package whose own stanza
 * drives discovery, Dockerfile selection, and image tagging.  Add a new
 * beacon type by (1) publishing its module with a retoldBeacon stanza and
 * (2) listing its name in SCANNED_MODULES.
 */
'use strict';

const libPath = require('path');
const libFs = require('fs');
const libFableServiceProviderBase = require('fable-serviceproviderbase');

// Modules scanned for a retoldBeacon stanza.  Absence is fine; the module
// just won't contribute a beacon type.  Order here decides UI picker order.
// Every containerized beacon type -- standalone-service or capability-
// provider -- lives in its own published npm package with a retoldBeacon
// stanza.  No lab-local shims: the lab finds providers the same way it
// finds bins, via the package's own stanza.
const SCANNED_MODULES =
[
	'retold-databeacon',
	'meadow-integration',
	'orator-conversion',
	'retold-facto',
	'retold-content-system',
	'retold-remote',
	'ultravisor-auth-beacon',
	'ultravisor-queue-beacon',
	'ultravisor-manifest-beacon'
];

// Beacon types that are marked deprecated in the lab UI. They still
// work — the modules ship as the reference Provider implementation
// for embedded deployments — but the lab's recommended path for
// queue / manifest persistence is `retold-databeacon` plus the
// "Persistence" assignment on the UV detail view. See the
// persistence-via-databeacon design doc for the rationale.
const DEPRECATED_BEACON_TYPES = new Set(
[
	'ultravisor-queue-beacon',
	'ultravisor-manifest-beacon'
]);

// Operator-facing message shown in the beacon-create form when one
// of the DEPRECATED_BEACON_TYPES is picked. Mirrors the rationale
// captured in the design doc and the Session 4 plan.
const LEGACY_TOOLTIP =
	'Legacy type. New deployments should use `retold-databeacon` + the lab\'s ' +
	'Persistence assignment on the UV detail view for queue / manifest persistence.';

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

		for (let j = 0; j < SCANNED_MODULES.length; j++)
		{
			let tmpName = SCANNED_MODULES[j];
			let tmpEntry = this._loadFromPackage(tmpName);
			if (tmpEntry) { tmpMap.set(tmpEntry.BeaconType, tmpEntry); }
		}

		this.fable.log.info(`BeaconTypeRegistry: ${tmpMap.size} beacon type(s) registered`);
		return tmpMap;
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

		let tmpBeaconType = tmpStanza.beaconType || pModuleName;
		let tmpDisplayName = tmpStanza.displayName || pModuleName;
		let tmpDeprecated = DEPRECATED_BEACON_TYPES.has(tmpBeaconType) || !!tmpStanza.deprecated;
		if (tmpDeprecated && tmpDisplayName.indexOf('(legacy)') < 0)
		{
			tmpDisplayName = tmpDisplayName + ' (legacy)';
		}

		let tmpDescriptor =
		{
			BeaconType:         tmpBeaconType,
			DisplayName:        tmpDisplayName,
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
			Source:             'package',
			Deprecated:         tmpDeprecated,
			DeprecationNote:    tmpDeprecated ? LEGACY_TOOLTIP : ''
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
		// Capability-provider lookup feeds two different consumers:
		//
		//   ProviderPackage     -- bare npm name, used by the Dockerfile's
		//                          `npm install` step (PROVIDER_PACKAGE build
		//                          arg).  Defaults to the module's own name.
		//   ProviderRequireSpec -- full in-container require spec passed to
		//                          retold-beacon-host as `--provider`.  When
		//                          the stanza declares `providerPath`, this
		//                          is `<package>/<providerPath>` (leading
		//                          `./` stripped) so node's require resolves
		//                          the class off /app/node_modules/<package>/...
		//                          even when the package's `main` is something
		//                          else (e.g. orator-conversion's main is
		//                          Orator-File-Translation).
		if (tmpStanza.mode === 'capability-provider')
		{
			let tmpBase = tmpStanza.providerPackage || pModuleName;
			tmpDescriptor.ProviderPackage = tmpBase;
			if (tmpStanza.providerPath)
			{
				let tmpSub = tmpStanza.providerPath.replace(/^\.\//, '');
				tmpDescriptor.ProviderRequireSpec = `${tmpBase}/${tmpSub}`;
			}
			else
			{
				tmpDescriptor.ProviderRequireSpec = tmpBase;
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
	 * Public: return the sibling checkout directory for a module, or null if
	 * none is found.  Used by the container manager's source-mode build so
	 * `npm pack` can run against the user's working copy.
	 */
	siblingModuleRoot(pModuleName)
	{
		let tmpPath = this._resolveSiblingPackageJson(pModuleName);
		if (!tmpPath) { return null; }
		return libPath.dirname(tmpPath);
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
			Source:             pEntry.Source,
			Deprecated:         !!pEntry.Deprecated,
			DeprecationNote:    pEntry.DeprecationNote || ''
		};
	}
}

module.exports = ServiceBeaconTypeRegistry;
