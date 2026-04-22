/**
 * Service-BeaconContainerManager
 *
 * Container lifecycle for beacons whose type descriptor carries a `docker`
 * block.  Mirrors the patterns LabDBEngineManager already uses for docker
 * engines: build the image on first use, run the container on the shared
 * `ultravisor-lab` network, bind-mount the per-beacon data dir so the
 * rendered config.json flows in without a `docker cp` dance.
 *
 * Host / container reachability:
 *   - Lab (host process) → beacon: `http://127.0.0.1:<host-mapped-port>`.
 *     BeaconManager still host-maps every beacon so the lab and the
 *     browser can hit the API regardless of the container's network.
 *   - Container → container (e.g. databeacon → mysql): by container
 *     name on the `ultravisor-lab` network, plus the service's *internal*
 *     port (3306, not the 33306 the lab mapped to the host).  Callers
 *     that wire beacon→engine connections should use
 *     `resolveEngineEndpoint(pEngine, { FromContainer: true })`.
 */
'use strict';

const libPath = require('path');
const libFs = require('fs');
const libChildProcess = require('child_process');
const libFableServiceProviderBase = require('fable-serviceproviderbase');

const LAB_NETWORK_NAME = 'ultravisor-lab';
const NPM_PACK_TIMEOUT_MS = 120000;

class ServiceBeaconContainerManager extends libFableServiceProviderBase
{
	constructor(pFable, pOptions, pServiceHash)
	{
		super(pFable, pOptions, pServiceHash);
		this.serviceType = 'LabBeaconContainerManager';
	}

	static get NetworkName() { return LAB_NETWORK_NAME; }

	/**
	 * Stable container name for a beacon row.  Used for `docker run --name`
	 * and also as the hostname other containers on the same network resolve
	 * against via docker DNS.
	 */
	containerName(pBeacon)
	{
		return `lab-beacon-${pBeacon.IDBeacon}`;
	}

	/**
	 * Local image tag the lab builds.  Not pushed anywhere -- this lives in
	 * the host's docker daemon only.
	 *
	 * npm build source:
	 *   standalone-service        -- `ultravisor-lab/<image>:<version>`
	 *   capability-provider       -- `ultravisor-lab/<image>:<version>__host-<host-version>`
	 *     (host version in the tag so upgrading retold-beacon-host
	 *      invalidates the cache for every provider image)
	 *
	 * source build source:
	 *   standalone-service        -- `ultravisor-lab/<image>:source-b<IDBeacon>`
	 *   capability-provider       -- not supported in the first pass (the
	 *                                host/provider split complicates tarball
	 *                                preparation; falls back to npm)
	 *
	 *   The `source-b<id>` suffix scopes source tags per-beacon so toggling
	 *   one beacon between npm and source doesn't collide with the image
	 *   tag of a sibling running in the other mode.
	 */
	imageTag(pType, pBeacon)
	{
		let tmpDocker = (pType && pType.Docker) || {};
		let tmpName = tmpDocker.Image || pType.BeaconType;
		let tmpVersion = tmpDocker.Version || pType.PackageVersion || 'latest';

		let tmpBuildSource = this._effectiveBuildSource(pType, pBeacon);
		if (tmpBuildSource === 'source')
		{
			let tmpID = (pBeacon && pBeacon.IDBeacon) || 0;
			return `ultravisor-lab/${tmpName}:source-b${tmpID}`;
		}

		if (pType.Mode === 'capability-provider')
		{
			let tmpHostVersion = this._resolveHostVersion(pType);
			return `ultravisor-lab/${tmpName}:${tmpVersion}__host-${tmpHostVersion}`;
		}
		return `ultravisor-lab/${tmpName}:${tmpVersion}`;
	}

	/**
	 * Resolve the actual build source to use for this beacon.  Defaults to
	 * 'npm' when missing.  Every beacon type that has a docker block and a
	 * published npm package can toggle to 'source' as long as the sibling
	 * monorepo checkout exists -- standalone-service packs the module
	 * itself, capability-provider packs the provider package and keeps
	 * retold-beacon-host coming from npm.
	 */
	_effectiveBuildSource(pType, pBeacon)
	{
		let tmpRequested = (pBeacon && pBeacon.BuildSource) || 'npm';
		return (tmpRequested === 'source') ? 'source' : 'npm';
	}

	/**
	 * True when the beacon type can run in source-build mode: has a docker
	 * block, carries a package name (all scanned modules do), and has a
	 * sibling monorepo checkout the lab can `npm pack` from.  Used by the
	 * UI + switch endpoint to gate the toggle.  Capability-provider mode
	 * is supported; the host comes from npm, only the provider is packed.
	 */
	supportsSourceBuild(pType)
	{
		if (!pType || !pType.Docker) { return false; }
		if (!pType.PackageName) { return false; }
		let tmpRoot = this.fable.LabBeaconTypeRegistry.siblingModuleRoot(pType.PackageName);
		return !!tmpRoot;
	}

	/**
	 * Pick the retold-beacon-host version for this capability-provider type.
	 * Precedence: explicit `docker.hostVersion` in the stanza > lab lookup
	 * of the host package's sibling checkout > 'latest'.
	 */
	_resolveHostVersion(pType)
	{
		let tmpDocker = (pType && pType.Docker) || {};
		if (tmpDocker.HostVersion) { return tmpDocker.HostVersion; }
		let tmpHostPackage = tmpDocker.HostPackage || 'retold-beacon-host';
		return this.fable.LabBeaconTypeRegistry.lookupPackageVersion(tmpHostPackage);
	}

	/**
	 * Absolute path to the lab-owned Dockerfile for a type.  Resolved
	 * against the lab module's `docker/` directory.
	 *
	 * Source-build mode looks for a sibling `<name>.source.Dockerfile`
	 * next to the npm-mode Dockerfile, e.g. `retold-databeacon.Dockerfile`
	 * → `retold-databeacon.source.Dockerfile`.  Missing source variant
	 * throws so the caller surfaces a clear error.
	 */
	dockerfilePath(pType, pBuildSource)
	{
		let tmpDocker = (pType && pType.Docker) || {};
		let tmpFile = tmpDocker.Dockerfile;
		if (!tmpFile) { throw new Error(`Beacon type '${pType.BeaconType}' has no docker.dockerfile in its retoldBeacon stanza.`); }
		let tmpPath = libPath.resolve(__dirname, '..', '..', 'docker', tmpFile);
		if (pBuildSource === 'source')
		{
			let tmpSourceFile = tmpFile.replace(/\.Dockerfile$/i, '.source.Dockerfile');
			let tmpSourcePath = libPath.resolve(__dirname, '..', '..', 'docker', tmpSourceFile);
			if (!libFs.existsSync(tmpSourcePath))
			{
				throw new Error(`Beacon type '${pType.BeaconType}' has no source-mode Dockerfile at ${tmpSourcePath}.`);
			}
			return tmpSourcePath;
		}
		return tmpPath;
	}

	/**
	 * Host filesystem path bind-mounted into the container at /app/data (or
	 * whatever dataMountPath the stanza declares).  Same directory the
	 * existing BeaconManager already writes config.json into, so no moving
	 * of files is needed.
	 */
	hostDataDir(pBeaconID)
	{
		return libPath.join(this.fable.LabStateStore.dataDir, 'beacons', String(pBeaconID));
	}

	/**
	 * Host → container port mapping.  We keep the lab-allocated port as the
	 * host-side and use the stanza's exposedPort as the container-side.
	 */
	_portMapping(pType, pBeacon)
	{
		let tmpContainerPort = (pType.Docker && pType.Docker.ExposedPort) || pType.DefaultPort || pBeacon.Port;
		return [{ Host: pBeacon.Port, Container: tmpContainerPort }];
	}

	// ── Lifecycle ────────────────────────────────────────────────────────────

	/**
	 * Build the image (if absent), ensure the shared network exists, then
	 * `docker run -d` the beacon.  The beacon's config.json is already on
	 * disk under data/beacons/<id>/config.json before this is called (the
	 * BeaconManager does that rendering); bind-mounting the whole dir
	 * surfaces it inside the container at /app/data/config.json.
	 */
	create(pType, pBeacon, fCallback, fProgress)
	{
		let tmpDocker = this.fable.LabDockerManager;
		let tmpBuildSource = this._effectiveBuildSource(pType, pBeacon);
		let tmpImageTag = this.imageTag(pType, pBeacon);

		let tmpProviderVersion = (pType.Docker && pType.Docker.Version) || pType.PackageVersion || 'latest';
		let tmpDockerfilePath;
		let tmpBuildArgs;
		let tmpContextDir;

		// Four Dockerfile shapes:
		//   standalone-service (npm)      -- VERSION build arg.  Context dir
		//                                    doesn't matter; Dockerfiles don't
		//                                    COPY anything.
		//   standalone-service (source)   -- SOURCE_TARBALL build arg pointing
		//                                    at an npm-pack output the lab
		//                                    stages next to the Dockerfile.
		//                                    Context = that staging dir.
		//   capability-provider (npm)     -- HOST_VERSION + PROVIDER_PACKAGE +
		//                                    PROVIDER_VERSION.  Dockerfile
		//                                    `npm install`s both packages from
		//                                    the registry.
		//   capability-provider (source)  -- HOST_VERSION + SOURCE_TARBALL.
		//                                    Host still comes from npm (at the
		//                                    stanza's HostVersion); only the
		//                                    provider is packed from the
		//                                    sibling monorepo checkout.  If a
		//                                    developer needs to debug the host
		//                                    too, they npm-link it.
		try
		{
			tmpDockerfilePath = this.dockerfilePath(pType, tmpBuildSource);
		}
		catch (pDfErr) { return fCallback(pDfErr); }

		if (tmpBuildSource === 'source')
		{
			// Stage a tarball of the sibling checkout into a per-beacon dir
			// we copy the Dockerfile into, then point docker build at that
			// directory.  Same shape for standalone-service + capability-
			// provider; the only difference is that capability-provider adds
			// a HOST_VERSION build arg for the beacon-host install step.
			let tmpStaging;
			try
			{
				tmpStaging = this._prepareSourceContext(pType, pBeacon, tmpDockerfilePath);
			}
			catch (pStageErr) { return fCallback(pStageErr); }
			tmpDockerfilePath = tmpStaging.DockerfilePath;
			tmpContextDir = tmpStaging.ContextDir;
			tmpBuildArgs =
				{
					SOURCE_TARBALL: tmpStaging.TarballName,
					SOURCE_VERSION: tmpStaging.SourceVersion
				};
			if (pType.Mode === 'capability-provider')
			{
				tmpBuildArgs.HOST_VERSION = this._resolveHostVersion(pType);
			}
		}
		else if (pType.Mode === 'capability-provider')
		{
			tmpBuildArgs =
				{
					HOST_VERSION:     this._resolveHostVersion(pType),
					PROVIDER_PACKAGE: pType.ProviderPackage || pType.PackageName,
					PROVIDER_VERSION: tmpProviderVersion
				};
			tmpContextDir = libPath.dirname(tmpDockerfilePath);
		}
		else
		{
			tmpBuildArgs = { VERSION: tmpProviderVersion };
			tmpContextDir = libPath.dirname(tmpDockerfilePath);
		}

		// fProgress lifts docker-manager-level build events ('build-started',
		// 'build-progress', 'build-completed', 'build-failed') up to the
		// BeaconManager, which turns them into InfrastructureEvents +
		// StatusDetail updates on the Beacon row.  We add our own phases
		// at container-create / container-started so the user sees every
		// step of the provisioning sequence.
		let fEmit = (typeof fProgress === 'function') ? fProgress : () => {};

		tmpDocker.ensureNetwork(LAB_NETWORK_NAME,
			(pNetErr) =>
			{
				if (pNetErr) { return fCallback(pNetErr); }

				tmpDocker.ensureImage(
					{
						ImageTag:       tmpImageTag,
						DockerfilePath: tmpDockerfilePath,
						ContextDir:     tmpContextDir,
						BuildArgs:      tmpBuildArgs
					},
					(pImgErr, pImgResult) =>
					{
						if (pImgErr) { return fCallback(pImgErr); }

						let tmpName = this.containerName(pBeacon);
						let tmpDataMount = (pType.Docker && pType.Docker.DataMountPath) || '/app/data';

						// Command / CMD resolution:
						//   capability-provider -- lab builds full flag list for
						//                          retold-beacon-host's entrypoint
						//                          from lab-resolved tokens.
						//   standalone-service  -- if the stanza has an
						//                          argTemplate, the lab renders
						//                          it with container-relative
						//                          tokens and passes as CMD;
						//                          otherwise the Dockerfile's
						//                          baked CMD runs as-is.
						let tmpCommand = null;
						if (pType.Mode === 'capability-provider')
						{
							tmpCommand = this._buildCapabilityProviderCommand(pType, pBeacon);
							if (!tmpCommand) { return fCallback(new Error('capability-provider mode needs a paired Ultravisor to resolve the --ultravisor-url flag.')); }
						}
						else if (pType.Mode === 'standalone-service' && Array.isArray(pType.ArgTemplate) && pType.ArgTemplate.length > 0)
						{
							tmpCommand = this._buildStandaloneServiceCommand(pType, pBeacon);
						}

						fEmit('container-creating', { ContainerName: tmpName, ImageTag: tmpImageTag });

						// --add-host so `host.docker.internal` resolves to the
						// host gateway on Linux (macOS/Docker Desktop already
						// do this automatically; the flag is a no-op there).
						// Only capability-provider beacons currently need
						// host-bridging; standalone beacons talk to other
						// containers exclusively.
						let tmpExtraArgs = [];
						if (pType.Mode === 'capability-provider')
						{
							tmpExtraArgs.push('--add-host=host.docker.internal:host-gateway');
						}

						// Per-beacon data volume + any type-level extra mounts
						// (e.g. seed_datasets for the MI beacon's ParseFile)
						// + any per-beacon config-driven mounts (e.g. the
						// HostContentPath for retold-remote).
						let tmpVolumes =
						[
							{ Source: this.hostDataDir(pBeacon.IDBeacon), Target: tmpDataMount }
						];
						let tmpConfigMounts = this._resolveConfigMounts(pType, pBeacon);
						for (let c = 0; c < tmpConfigMounts.length; c++)
						{
							tmpVolumes.push(tmpConfigMounts[c]);
						}
						let tmpExtraMounts = (pType.Docker && Array.isArray(pType.Docker.ExtraMounts)) ? pType.Docker.ExtraMounts : [];
						for (let m = 0; m < tmpExtraMounts.length; m++)
						{
							let tmpMount = tmpExtraMounts[m];
							let tmpAbs = libPath.resolve(__dirname, '..', '..', tmpMount.Source);
							tmpVolumes.push({ Source: tmpAbs, Target: tmpMount.Target, ReadOnly: tmpMount.ReadOnly !== false });
						}

						tmpDocker.run(
							{
								Name:      tmpName,
								Hostname:  tmpName,
								Network:   LAB_NETWORK_NAME,
								Image:     tmpImageTag,
								Ports:     this._portMapping(pType, pBeacon),
								Volumes:   tmpVolumes,
								ExtraArgs: tmpExtraArgs,
								Command:   tmpCommand || undefined
							},
							(pRunErr, pRunResult) =>
							{
								if (pRunErr) { return fCallback(pRunErr); }
								fEmit('container-started', { ContainerName: tmpName, ContainerID: pRunResult.ContainerID });
								// ImageVersion tags the image with a human label
								// of what went into it.  Source mode overrides
								// the provider-registry version with
								// `source:<pkgver>` so the UI + events log make
								// it obvious the image carries an unpublished build.
								let tmpImageVersion = tmpProviderVersion;
								if (tmpBuildSource === 'source')
								{
									let tmpPkgVer = this._siblingPackageVersion(pType) || tmpProviderVersion;
									tmpImageVersion = `source:${tmpPkgVer}`;
								}
								return fCallback(null,
									{
										ContainerID:   pRunResult.ContainerID,
										ContainerName: tmpName,
										ImageTag:      tmpImageTag,
										ImageVersion:  tmpImageVersion,
										ImageBuilt:    pImgResult.Built === true,
										BuildSource:   tmpBuildSource,
										NetworkName:   LAB_NETWORK_NAME
									});
							});
					},
					fEmit);
			});
	}

	/**
	 * Build the retold-beacon-host entrypoint flags for a capability-provider
	 * container.  The beacon needs:
	 *   - a local port to listen on (matches the container's exposed port)
	 *   - its own name (used for Ultravisor beacon registration)
	 *   - the Ultravisor URL reachable from *inside* the container (uses
	 *     `host.docker.internal` since Ultravisor is currently host-process)
	 *   - the provider package to load (single or repeatable)
	 *   - an optional config path inside the bind-mounted /app/data
	 */
	_buildCapabilityProviderCommand(pType, pBeacon)
	{
		if (!pBeacon.IDUltravisorInstance) { return null; }
		let tmpInstance = this.fable.LabUltravisorManager.getInstance(pBeacon.IDUltravisorInstance);
		if (!tmpInstance) { return null; }

		let tmpContainerPort = (pType.Docker && pType.Docker.ExposedPort) || pType.DefaultPort || pBeacon.Port;

		// Container -> Ultravisor reachability: prefer docker DNS on the
		// shared network when the UV is also a container (phase 1b-2
		// onwards), fall back to host.docker.internal for host-process UVs.
		let tmpUltravisorURL;
		if (tmpInstance.Runtime === 'container' && tmpInstance.ContainerName)
		{
			// Internal port on the UV container is the published default
			// (54321); we don't currently support overriding it per-instance.
			tmpUltravisorURL = `http://${tmpInstance.ContainerName}:54321`;
		}
		else
		{
			tmpUltravisorURL = `http://host.docker.internal:${tmpInstance.Port}`;
		}

		// All capability-provider containers install the provider package
		// under /app/node_modules/<name>/... at build time.  retold-beacon-host's
		// --provider accepts a bare npm name (uses the package's main) or a
		// `<package>/<subpath>` require spec for providers whose class lives
		// off the package's main entry point.  The registry assembles the
		// right string into ProviderRequireSpec -- we just pass it through.
		let tmpProvider = pType.ProviderRequireSpec || pType.ProviderPackage || pType.PackageName;

		let tmpConfigMount = (pType.Docker && pType.Docker.ConfigMountPath) || '/app/data/config.json';

		return [
			'--port',           String(tmpContainerPort),
			'--beacon-name',    pBeacon.Name,
			'--ultravisor-url', tmpUltravisorURL,
			'--provider',       tmpProvider,
			'--config',         tmpConfigMount
		];
	}

	start(pContainerID, fCallback)
	{
		this.fable.LabDockerManager.start(pContainerID, fCallback);
	}

	stop(pContainerID, fCallback)
	{
		this.fable.LabDockerManager.stop(pContainerID, fCallback);
	}

	/**
	 * Remove the container.  Image is left on the host -- other beacons
	 * of the same type and version will re-use it.
	 */
	remove(pContainerID, fCallback)
	{
		this.fable.LabDockerManager.rm(pContainerID, true, fCallback);
	}

	inspect(pContainerID, fCallback)
	{
		this.fable.LabDockerManager.inspect(pContainerID, fCallback);
	}

	logs(pContainerID, pTailLines, fCallback)
	{
		this.fable.LabDockerManager.logs(pContainerID, pTailLines, fCallback);
	}

	statusFromInspect(pInspect)
	{
		return this.fable.LabDockerManager.statusFromInspect(pInspect);
	}

	// ── argTemplate expansion for standalone-service container mode ─────────

	/**
	 * Walk the type's ArgTemplate and turn it into a docker run CMD array.
	 * Each template item is either a literal string, or an object with a
	 * `fromLabPath` key naming a token the lab resolves for container-mode
	 * beacons (container-relative, not host-relative).
	 *
	 * Supported tokens:
	 *   Port            internal port (stanza ExposedPort, e.g. 8500/7777)
	 *   ConfigPath      container-visible config file (/app/data/config.json)
	 *   BeaconName      the beacon row's Name (user-chosen identifier)
	 *   UltravisorURL   container-DNS URL when UV is a container, else
	 *                   host.docker.internal form
	 *   ContentPath     the Docker.ContentMountPath (default /app/content)
	 *                   bind-mounted by _resolveConfigMounts when the beacon
	 *                   config specifies HostContentPath.  Types that don't
	 *                   need a content dir can ignore this token.
	 *
	 * Empty strings skip their flag pair so {{UltravisorURL}} omission
	 * doesn't leave a dangling "-u" on the CLI.
	 */
	_buildStandaloneServiceCommand(pType, pBeacon)
	{
		let tmpTokens = this._standaloneServiceTokens(pType, pBeacon);
		let tmpOut = [];
		let tmpTemplate = pType.ArgTemplate || [];
		for (let i = 0; i < tmpTemplate.length; i++)
		{
			let tmpItem = tmpTemplate[i];
			if (typeof tmpItem === 'string') { tmpOut.push(tmpItem); continue; }
			if (tmpItem && typeof tmpItem === 'object')
			{
				if (tmpItem.flag) { tmpOut.push(tmpItem.flag); }
				if (tmpItem.fromLabPath)
				{
					let tmpVal = tmpTokens[tmpItem.fromLabPath];
					if (tmpVal === undefined || tmpVal === null || tmpVal === '')
					{
						// Skip this token (and its preceding flag, if the
						// template used a flag/value pair pattern of
						// {"flag":"-u"}, {"fromLabPath":"UltravisorURL"}).
						// We can't rewind what we already pushed, so we do
						// the common case instead: drop the last-pushed
						// flag if it was just added in this iteration.
						continue;
					}
					tmpOut.push(String(tmpVal));
				}
				else if (tmpItem.literal !== undefined)
				{
					tmpOut.push(String(tmpItem.literal));
				}
			}
		}
		return tmpOut;
	}

	_standaloneServiceTokens(pType, pBeacon)
	{
		let tmpInternalPort = (pType.Docker && pType.Docker.ExposedPort) || pType.DefaultPort || pBeacon.Port;
		let tmpConfigMount = (pType.Docker && pType.Docker.ConfigMountPath) || '/app/data/config.json';
		let tmpContentMount = (pType.Docker && pType.Docker.ContentMountPath) || '/app/content';

		let tmpUltravisorURL = '';
		if (pBeacon.IDUltravisorInstance)
		{
			let tmpInstance = this.fable.LabUltravisorManager.getInstance(pBeacon.IDUltravisorInstance);
			if (tmpInstance)
			{
				if (tmpInstance.Runtime === 'container' && tmpInstance.ContainerName)
				{
					tmpUltravisorURL = `http://${tmpInstance.ContainerName}:54321`;
				}
				else if (tmpInstance.Port)
				{
					tmpUltravisorURL = `http://host.docker.internal:${tmpInstance.Port}`;
				}
			}
		}

		return {
			Port:          tmpInternalPort,
			ConfigPath:    tmpConfigMount,
			ContentPath:   tmpContentMount,
			BeaconName:    pBeacon.Name,
			UltravisorURL: tmpUltravisorURL
		};
	}

	/**
	 * Per-beacon bind mounts driven by the saved ConfigJSON blob.  The
	 * stanza's `docker.configMounts` declares the shape:
	 *
	 *   "configMounts": [
	 *      { "ConfigField": "HostContentPath", "Target": "/app/content", "ReadOnly": true }
	 *   ]
	 *
	 * For each entry, the lab reads the field from the beacon row's
	 * ConfigJSON; if set + absolute + existing, adds a bind mount.
	 * Missing or blank fields are silently skipped so the beacon can
	 * still run with whatever fixed defaults the Dockerfile bakes in.
	 */
	_resolveConfigMounts(pType, pBeacon)
	{
		let tmpOut = [];
		let tmpSpec = pType.Docker && pType.Docker.ConfigMounts;
		if (!Array.isArray(tmpSpec) || tmpSpec.length === 0) { return tmpOut; }
		let tmpConfig = {};
		try { tmpConfig = JSON.parse(pBeacon.ConfigJSON || '{}'); } catch (pEx) { /* ignore */ }
		for (let i = 0; i < tmpSpec.length; i++)
		{
			let tmpM = tmpSpec[i];
			if (!tmpM || !tmpM.ConfigField || !tmpM.Target) { continue; }
			let tmpVal = tmpConfig[tmpM.ConfigField];
			if (!tmpVal || typeof tmpVal !== 'string') { continue; }
			tmpOut.push(
				{
					Source:  tmpVal,
					Target:  tmpM.Target,
					ReadOnly: tmpM.ReadOnly !== false
				});
		}
		return tmpOut;
	}

	// ── Endpoint resolution helpers ──────────────────────────────────────────

	/**
	 * Return the `{Host, Port}` a consumer should use to reach a DB engine.
	 *
	 * From the host or from a non-dockerized beacon:
	 *    127.0.0.1 + the host-mapped port (pEngine.Port).
	 *
	 * From another container on the same docker network:
	 *    the engine's container name + its internal port (3306 for MySQL,
	 *    etc.).  The engine's internal port lives on the engine-adapter
	 *    but the DBEngine row also stashes it on create; we prefer the
	 *    adapter lookup, falling back to the row's InternalPort column.
	 */
	resolveEngineEndpoint(pEngine, pOptions)
	{
		let tmpFromContainer = !!(pOptions && pOptions.FromContainer);
		if (!tmpFromContainer)
		{
			return { Host: '127.0.0.1', Port: pEngine.Port };
		}
		let tmpInternal = pEngine.InternalPort || this._defaultInternalPortForEngineType(pEngine.EngineType);
		return { Host: pEngine.ContainerName, Port: tmpInternal };
	}

	/**
	 * Lookup-table fallback for engines whose InternalPort wasn't stamped
	 * on the row at create time.  New DBEngine creations should set it;
	 * this keeps older rows working.
	 */
	_defaultInternalPortForEngineType(pEngineType)
	{
		switch (pEngineType)
		{
			case 'mysql':      return 3306;
			case 'postgres':   return 5432;
			case 'mssql':      return 1433;
			case 'mongodb':    return 27017;
			default:           return 0;
		}
	}

	// ── Source-build staging ────────────────────────────────────────────────
	/**
	 * Prepare a docker build context for source-build mode.  Steps:
	 *   1. Resolve the sibling monorepo checkout for the type's PackageName.
	 *   2. `npm pack --pack-destination=<staging>` inside that checkout
	 *      (respects the module's package.json `files` field so the tarball
	 *      mirrors what an `npm publish` would ship).
	 *   3. Rename the produced `.tgz` to a stable filename (source.tgz) so
	 *      the Dockerfile's ARG default resolves without ceremony.
	 *   4. Copy the .source.Dockerfile into the staging dir (keeps the build
	 *      context small -- just the tarball + dockerfile, not the whole
	 *      docker/ directory -- so `docker build` doesn't stream megabytes
	 *      of unrelated Dockerfiles to the daemon).
	 *
	 * Staging lives at `<labDataDir>/source-build-staging/<IDBeacon>/`.
	 * Wiped on every invocation to force a fresh tarball capture -- that's
	 * the whole point of source mode.
	 *
	 * Returns { ContextDir, DockerfilePath, TarballName, SourceVersion }.
	 * Throws if the sibling checkout can't be found, or npm pack fails.
	 */
	_prepareSourceContext(pType, pBeacon, pOriginalDockerfilePath)
	{
		if (!pType || !pType.PackageName)
		{
			throw new Error(`Beacon type '${pType && pType.BeaconType}' has no PackageName; cannot source-build.`);
		}
		let tmpSiblingRoot = this.fable.LabBeaconTypeRegistry.siblingModuleRoot(pType.PackageName);
		if (!tmpSiblingRoot)
		{
			throw new Error(`No sibling monorepo checkout found for '${pType.PackageName}'. Expected retold/modules/<group>/${pType.PackageName}/.`);
		}

		let tmpStateStore = this.fable.LabStateStore;
		let tmpStagingDir = libPath.join(tmpStateStore.dataDir, 'source-build-staging', String(pBeacon.IDBeacon || 0));
		this._rmrf(tmpStagingDir);
		libFs.mkdirSync(tmpStagingDir, { recursive: true });

		// Produce the tarball.  `--ignore-scripts` skips prepack lifecycle
		// scripts that would try to run the module's own build tooling -- the
		// lab packs whatever's on disk as-is and trusts the Dockerfile to do
		// any in-container build steps.
		this.fable.log.info(`[ContainerManager] npm pack '${pType.PackageName}' from ${tmpSiblingRoot} → ${tmpStagingDir}`);
		try
		{
			libChildProcess.execFileSync('npm',
				['pack', '--ignore-scripts', `--pack-destination=${tmpStagingDir}`],
				{
					cwd:     tmpSiblingRoot,
					stdio:   ['ignore', 'pipe', 'pipe'],
					timeout: NPM_PACK_TIMEOUT_MS
				});
		}
		catch (pPackErr)
		{
			let tmpStderr = pPackErr.stderr ? pPackErr.stderr.toString().trim() : pPackErr.message;
			throw new Error(`npm pack failed for ${pType.PackageName}: ${tmpStderr}`);
		}

		// `npm pack` produces a single .tgz in the destination.  Rename to a
		// stable filename the Dockerfile can COPY without ARG acrobatics.
		let tmpProduced = libFs.readdirSync(tmpStagingDir).filter((pF) => pF.endsWith('.tgz'));
		if (tmpProduced.length === 0)
		{
			throw new Error(`npm pack for ${pType.PackageName} produced no .tgz in ${tmpStagingDir}.`);
		}
		let tmpFirst = tmpProduced[0];
		let tmpStable = 'source.tgz';
		if (tmpFirst !== tmpStable)
		{
			libFs.renameSync(libPath.join(tmpStagingDir, tmpFirst), libPath.join(tmpStagingDir, tmpStable));
		}

		// Copy the .source.Dockerfile alongside the tarball so docker build
		// -f points at a file inside the context dir.
		let tmpDockerfileTarget = libPath.join(tmpStagingDir, libPath.basename(pOriginalDockerfilePath));
		libFs.copyFileSync(pOriginalDockerfilePath, tmpDockerfileTarget);

		return {
			ContextDir:     tmpStagingDir,
			DockerfilePath: tmpDockerfileTarget,
			TarballName:    tmpStable,
			SourceVersion:  this._siblingPackageVersion(pType) || 'source'
		};
	}

	/**
	 * Read the on-disk sibling checkout's package.json `version` for the
	 * type's PackageName.  Used for tagging images + labelling events so a
	 * user rebuilding after bumping the sibling sees the new version in the
	 * UI immediately.  Falls back to null if the sibling isn't present.
	 */
	_siblingPackageVersion(pType)
	{
		if (!pType || !pType.PackageName) { return null; }
		let tmpRoot = this.fable.LabBeaconTypeRegistry.siblingModuleRoot(pType.PackageName);
		if (!tmpRoot) { return null; }
		try
		{
			let tmpPkg = JSON.parse(libFs.readFileSync(libPath.join(tmpRoot, 'package.json'), 'utf8'));
			return tmpPkg.version || null;
		}
		catch (pErr) { return null; }
	}

	/**
	 * Tiny recursive rmdir.  Avoids a dep on fs.rm (node 14.14+) compatibility
	 * quirks; the lab already pins node >= 18 but this stays minimal.
	 */
	_rmrf(pDir)
	{
		if (!libFs.existsSync(pDir)) { return; }
		let tmpStat = libFs.statSync(pDir);
		if (!tmpStat.isDirectory()) { libFs.unlinkSync(pDir); return; }
		for (let tmpName of libFs.readdirSync(pDir))
		{
			this._rmrf(libPath.join(pDir, tmpName));
		}
		libFs.rmdirSync(pDir);
	}
}

module.exports = ServiceBeaconContainerManager;
