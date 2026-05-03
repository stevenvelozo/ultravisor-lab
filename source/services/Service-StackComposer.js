/**
 * Service-StackComposer (Phase 8 — Pillar 3)
 *
 * Renders a resolved stack spec into a docker-compose.yml file written
 * to `${dataDir}/stacks/<Hash>/docker-compose.yml`. The same file the
 * lab launches with is the same file an operator can `cp` to another
 * machine and `docker compose up -d` against — compose YAML IS the
 * canonical executable.
 *
 * Component → service mapping:
 *   docker-service          → image: + ports + volumes + environment + healthcheck
 *   docker-build-from-folder → build: { context, dockerfile } + same fields
 *
 * Project name = `stack-<spec.Hash>`. Compose uses this both as the
 * network name and as the container-name prefix, so two stacks with
 * overlapping service names can coexist.
 *
 * depends_on: when an upstream component has a healthcheck declared,
 * we emit `condition: service_healthy` so compose blocks on health,
 * not just on container start. Without a healthcheck, plain depends_on.
 *
 * Public API:
 *   compose(pResolved)
 *     → { ProjectName, ComposeYAML, ComposePath }
 *     pResolved — output of Service-StackResolver.resolve().
 *     Writes the file as a side effect; returns paths for the caller.
 *
 *   getComposePath(pHash) → absolute path the lifecycle reads.
 *
 *   getProjectName(pHash) → `stack-<hash>`. The lifecycle uses this for `-p`.
 */

'use strict';

const libPath = require('path');
const libFs = require('fs');
const libYaml = require('js-yaml');
const libFableServiceProviderBase = require('fable-serviceproviderbase');

class ServiceStackComposer extends libFableServiceProviderBase
{
	constructor(pFable, pOptions, pServiceHash)
	{
		super(pFable, pOptions, pServiceHash);
		this.serviceType = 'LabStackComposer';

		this._DataDir = (pOptions && pOptions.DataDir)
			|| (this.fable.settings && this.fable.settings.LabDataDir)
			|| libPath.resolve(__dirname, '..', '..', 'data');
		this._StacksDir = libPath.join(this._DataDir, 'stacks');
	}

	getProjectName(pHash)
	{
		return 'stack-' + this._sanitizeHash(pHash);
	}

	getComposeDir(pHash)
	{
		return libPath.join(this._StacksDir, this._sanitizeHash(pHash));
	}

	getComposePath(pHash)
	{
		return libPath.join(this.getComposeDir(pHash), 'docker-compose.yml');
	}

	_sanitizeHash(pHash)
	{
		return String(pHash || '').replace(/[^a-zA-Z0-9_.-]/g, '-').slice(0, 200);
	}

	compose(pResolved)
	{
		if (!pResolved || !pResolved.Spec)
		{
			throw new Error('StackComposer.compose: resolved spec required');
		}
		let tmpSpec = pResolved.Spec;
		let tmpHash = tmpSpec.Hash;
		if (!tmpHash)
		{
			throw new Error('StackComposer.compose: spec.Hash required');
		}

		let tmpServices = {};
		let tmpComponents = Array.isArray(tmpSpec.Components) ? tmpSpec.Components : [];
		// Build a healthcheck-presence map first so depends_on can decide
		// whether to gate on `service_healthy`.
		let tmpHasHealth = {};
		for (let i = 0; i < tmpComponents.length; i++)
		{
			let tmpC = tmpComponents[i];
			if (tmpC && tmpC.Hash) { tmpHasHealth[tmpC.Hash] = !!(tmpC.HealthCheck && tmpC.HealthCheck.Command); }
		}

		for (let i = 0; i < tmpComponents.length; i++)
		{
			let tmpC = tmpComponents[i];
			if (!tmpC || !tmpC.Hash) continue;
			tmpServices[tmpC.Hash] = this._renderService(tmpC, tmpHasHealth);
		}

		// `name:` at the top of compose v3.9+ pins the project name so
		// `docker compose ls` shows our chosen prefix.
		let tmpComposeObj =
		{
			name: this.getProjectName(tmpHash),
			services: tmpServices
		};

		let tmpYaml = libYaml.dump(tmpComposeObj,
			{ indent: 2, lineWidth: 200, noRefs: true, quotingType: '"', forceQuotes: false });

		// Write to disk.
		let tmpDir = this.getComposeDir(tmpHash);
		if (!libFs.existsSync(tmpDir))
		{
			libFs.mkdirSync(tmpDir, { recursive: true });
		}
		let tmpPath = this.getComposePath(tmpHash);
		libFs.writeFileSync(tmpPath, tmpYaml, 'utf8');

		return {
			ProjectName: this.getProjectName(tmpHash),
			ComposeYAML: tmpYaml,
			ComposePath: tmpPath
		};
	}

	_renderService(pComponent, pHasHealth)
	{
		let tmpService = {};

		// Image OR build context — exactly one.
		if (pComponent.Type === 'docker-build-from-folder')
		{
			let tmpBuild = { context: libPath.resolve(pComponent.BuildContext || '.') };
			if (pComponent.Dockerfile) { tmpBuild.dockerfile = pComponent.Dockerfile; }
			tmpService.build = tmpBuild;
			// Tag the built image so `docker images` shows something
			// meaningful and so subsequent runs reuse the image rather
			// than rebuilding silently.
			tmpService.image = pComponent.BuildTag || (pComponent.Hash + ':local');
		}
		else
		{
			// docker-service or implicit (no Type set).
			if (pComponent.Image) { tmpService.image = pComponent.Image; }
		}

		// container_name — pin so `docker logs` / `docker exec` against
		// the bare component name works without compose's auto-suffix.
		// Project name guarantees uniqueness across stacks.
		// (We let compose auto-name if not pinned to keep things simple.)

		// Ports.
		if (Array.isArray(pComponent.Ports) && pComponent.Ports.length > 0)
		{
			tmpService.ports = pComponent.Ports.map(function (pP)
			{
				let tmpHost = pP.Host !== undefined ? String(pP.Host) : '';
				let tmpCont = pP.Container !== undefined ? String(pP.Container) : '';
				return tmpHost ? (tmpHost + ':' + tmpCont) : tmpCont;
			});
		}

		// Volumes.
		if (Array.isArray(pComponent.Volumes) && pComponent.Volumes.length > 0)
		{
			tmpService.volumes = pComponent.Volumes.map(function (pV)
			{
				let tmpHost = libPath.resolve(pV.Host || '.');
				let tmpCont = pV.Container || '/mnt';
				let tmpMode = pV.Mode || 'rw';
				return tmpHost + ':' + tmpCont + ':' + tmpMode;
			});
		}

		// Environment — emit as a map so YAML stays clean.
		if (pComponent.Environment && typeof pComponent.Environment === 'object')
		{
			let tmpEnv = {};
			let tmpKeys = Object.keys(pComponent.Environment);
			for (let k = 0; k < tmpKeys.length; k++)
			{
				let tmpV = pComponent.Environment[tmpKeys[k]];
				tmpEnv[tmpKeys[k]] = (tmpV === undefined || tmpV === null) ? '' : String(tmpV);
			}
			tmpService.environment = tmpEnv;
		}

		// Command override — replaces the image's CMD. Accept either an
		// array of args (preferred — exec form, no shell parsing) or a
		// single string (compose passes through to /bin/sh -c).
		if (Array.isArray(pComponent.Command))
		{
			tmpService.command = pComponent.Command.map(function (pA) { return String(pA); });
		}
		else if (typeof pComponent.Command === 'string' && pComponent.Command.length > 0)
		{
			tmpService.command = pComponent.Command;
		}

		// Entrypoint override — same shape as Command; same rationale.
		if (Array.isArray(pComponent.Entrypoint))
		{
			tmpService.entrypoint = pComponent.Entrypoint.map(function (pA) { return String(pA); });
		}
		else if (typeof pComponent.Entrypoint === 'string' && pComponent.Entrypoint.length > 0)
		{
			tmpService.entrypoint = pComponent.Entrypoint;
		}

		// Healthcheck — compose syntax uses snake_case keys.
		if (pComponent.HealthCheck && pComponent.HealthCheck.Command)
		{
			let tmpHC = pComponent.HealthCheck;
			tmpService.healthcheck =
			{
				test: ['CMD-SHELL', String(tmpHC.Command)],
				interval: (tmpHC.IntervalSec || 5) + 's',
				timeout:  (tmpHC.TimeoutSec  || 3) + 's',
				retries:  tmpHC.RetriesBeforeFail || 6
			};
			if (tmpHC.StartPeriodSec)
			{
				tmpService.healthcheck.start_period = tmpHC.StartPeriodSec + 's';
			}
		}

		// depends_on — gate on service_healthy when upstream has a healthcheck.
		if (Array.isArray(pComponent.DependsOn) && pComponent.DependsOn.length > 0)
		{
			let tmpDep = {};
			for (let i = 0; i < pComponent.DependsOn.length; i++)
			{
				let tmpUpstream = pComponent.DependsOn[i];
				if (pHasHealth[tmpUpstream])
				{
					tmpDep[tmpUpstream] = { condition: 'service_healthy' };
				}
				else
				{
					// Plain "wait for upstream container to start" form.
					// Compose accepts either the long form or a flat
					// list; long form is more consistent.
					tmpDep[tmpUpstream] = { condition: 'service_started' };
				}
			}
			tmpService.depends_on = tmpDep;
		}

		// Restart policy — `unless-stopped` for everything by default.
		// Operator who wants something else writes Component.RestartPolicy.
		tmpService.restart = pComponent.RestartPolicy || 'unless-stopped';

		// Labels — make it obvious in `docker ps` which stack a
		// container belongs to.
		tmpService.labels =
		{
			'lab.stack.hash':      pComponent.Hash || '',
			'lab.stack.component': pComponent.Hash || ''
		};

		return tmpService;
	}
}

module.exports = ServiceStackComposer;
