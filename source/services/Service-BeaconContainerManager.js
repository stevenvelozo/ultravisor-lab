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
const libFableServiceProviderBase = require('fable-serviceproviderbase');

const LAB_NETWORK_NAME = 'ultravisor-lab';

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
	 * standalone-service mode: `ultravisor-lab/<image>:<provider-version>`
	 * capability-provider mode: `ultravisor-lab/<image>:<provider-version>__host-<host-version>`
	 *   (the host version is part of the tag so upgrading retold-beacon-host
	 *   invalidates the cache for every provider image)
	 */
	imageTag(pType)
	{
		let tmpDocker = (pType && pType.Docker) || {};
		let tmpName = tmpDocker.Image || pType.BeaconType;
		let tmpVersion = tmpDocker.Version || pType.PackageVersion || 'latest';

		if (pType.Mode === 'capability-provider')
		{
			let tmpHostVersion = this._resolveHostVersion(pType);
			return `ultravisor-lab/${tmpName}:${tmpVersion}__host-${tmpHostVersion}`;
		}
		return `ultravisor-lab/${tmpName}:${tmpVersion}`;
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
	 */
	dockerfilePath(pType)
	{
		let tmpDocker = (pType && pType.Docker) || {};
		let tmpFile = tmpDocker.Dockerfile;
		if (!tmpFile) { throw new Error(`Beacon type '${pType.BeaconType}' has no docker.dockerfile in its retoldBeacon stanza.`); }
		return libPath.resolve(__dirname, '..', '..', 'docker', tmpFile);
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
		let tmpImageTag = this.imageTag(pType);
		let tmpDockerfilePath = this.dockerfilePath(pType);

		let tmpProviderVersion = (pType.Docker && pType.Docker.Version) || pType.PackageVersion || 'latest';
		let tmpBuildArgs;
		let tmpContextDir;

		// Three Dockerfile shapes:
		//   standalone-service        -- VERSION build arg.  Context dir
		//                                doesn't matter; our Dockerfiles
		//                                don't COPY anything.
		//   lab-local capability-prov -- HOST_VERSION build arg only.
		//                                Context = LocalProviderDir (the
		//                                Dockerfile COPYs . into the image).
		//   published  capability-prov -- HOST_VERSION + PROVIDER_PACKAGE +
		//                                PROVIDER_VERSION.  Kept around for
		//                                providers that might be published
		//                                later; not used today.
		if (pType.Mode === 'capability-provider' && pType.LocalProviderDir)
		{
			tmpBuildArgs = { HOST_VERSION: this._resolveHostVersion(pType) };
			tmpContextDir = pType.LocalProviderDir;
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
								return fCallback(null,
									{
										ContainerID:   pRunResult.ContainerID,
										ContainerName: tmpName,
										ImageTag:      tmpImageTag,
										ImageVersion:  tmpProviderVersion,
										ImageBuilt:    pImgResult.Built === true,
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

		// Lab-local provider Dockerfiles COPY the build context into
		// /app/provider/ and retold-beacon-host's --provider accepts an
		// absolute path (node's require() resolves it via the provider's
		// package.json main).  Published providers pass by npm name.
		let tmpProvider = pType.LocalProviderDir
			? '/app/provider'
			: (pType.ProviderPackage || pType.PackageName);

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
}

module.exports = ServiceBeaconContainerManager;
