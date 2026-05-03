/**
 * Service-StackResolver (Phase 8 — Pillar 2)
 *
 * Pure-functional substitution + validation of a stack spec. Walks
 * every string in the spec, replaces variable references with resolved
 * values, and reports any reference that didn't resolve.
 *
 * Reference grammar (decided in plan):
 *   ${input.X}          → from the user-supplied input values map
 *                         (falls back to spec.Inputs[X].Default)
 *   ${component.Y.host} → component Y's docker-network hostname
 *                         (= component.Y.Hash; compose service name
 *                         doubles as the network hostname)
 *   ${component.Y.port} → first Container port of component Y
 *   ${env.X}            → from process.env
 *   ${HOME}, ${PWD}     → process.env.HOME, process.cwd()
 *
 * Resolution rules:
 *   - References are NOT recursive. ${input.X} that contains
 *     ${env.HOME} expands once at the input layer (so we resolve
 *     ${env.X} / ${HOME} inside input values too) but ${component.Y.X}
 *     that contains ${input.Z} only resolves the ${input.Z}.
 *   - Unresolvable references are recorded with the JSON-pointer-ish
 *     path where they appear, then left as-is in the output (so the
 *     report can show "Components[2].Environment.UV_URL contains
 *     unresolved reference ${component.broken.host}").
 *   - Numbers and booleans pass through unchanged.
 *
 * Public API:
 *   resolve(pSpec, pInputValues, pEnv?)
 *     → { Spec, Inputs, Components, Unresolved: [{ Path, Reference }] }
 *     pSpec        — the raw stack spec (as stored)
 *     pInputValues — { InputName: value } map; missing entries use Default
 *     pEnv         — optional env map (default: process.env)
 *
 * No side effects; no I/O.
 */

'use strict';

const libFableServiceProviderBase = require('fable-serviceproviderbase');

const REFERENCE_PATTERN = /\$\{([a-zA-Z][a-zA-Z0-9_]*(?:\.[a-zA-Z0-9_-]+)*)\}/g;

class ServiceStackResolver extends libFableServiceProviderBase
{
	constructor(pFable, pOptions, pServiceHash)
	{
		super(pFable, pOptions, pServiceHash);
		this.serviceType = 'LabStackResolver';
	}

	/**
	 * Resolve a stack spec against user-supplied input values.
	 *
	 * Doesn't mutate pSpec. Returns a deep clone with strings substituted.
	 */
	resolve(pSpec, pInputValues, pEnv)
	{
		let tmpEnv = pEnv || process.env || {};
		let tmpInputDefs = (pSpec && pSpec.Inputs) || {};
		let tmpProvided = pInputValues || {};

		// First: resolve the input values themselves. Inputs can carry
		// ${env.X} / ${HOME} references in their values (provided or
		// default). They CANNOT cross-reference each other or
		// components — that would make ordering matter and create
		// fixed-point ambiguity.
		let tmpInputs = {};
		let tmpUnresolved = [];
		let tmpInputKeys = Object.keys(tmpInputDefs);
		for (let i = 0; i < tmpInputKeys.length; i++)
		{
			let tmpKey = tmpInputKeys[i];
			let tmpDef = tmpInputDefs[tmpKey] || {};
			let tmpRaw = (tmpProvided[tmpKey] !== undefined && tmpProvided[tmpKey] !== '')
				? tmpProvided[tmpKey]
				: (tmpDef.Default !== undefined ? tmpDef.Default : '');
			tmpInputs[tmpKey] = (typeof tmpRaw === 'string')
				? this._substituteEnvOnly(tmpRaw, tmpEnv, `Inputs.${tmpKey}.Value`, tmpUnresolved)
				: tmpRaw;
		}

		// Index components for ${component.Y.<attr>} lookups. Compose
		// service names ARE the docker-network hostnames, so component
		// Hash → host is identity.
		let tmpComponents = {};
		let tmpComponentList = Array.isArray(pSpec && pSpec.Components) ? pSpec.Components : [];
		for (let i = 0; i < tmpComponentList.length; i++)
		{
			let tmpC = tmpComponentList[i];
			if (!tmpC || !tmpC.Hash) continue;
			tmpComponents[tmpC.Hash] =
			{
				host:          tmpC.Hash,
				port:          this._firstContainerPort(tmpC),
				containerName: tmpC.Hash  // composer applies the project prefix later
			};
		}

		// Walk the whole spec, substituting strings. We deliberately
		// don't substitute Inputs.* (they're config-shape, not runtime
		// values) — only Components.* and other top-level metadata.
		let tmpClone = JSON.parse(JSON.stringify(pSpec || {}));
		this._walk(tmpClone, '', function (pStr, pPath)
		{
			return this._substitute(pStr, tmpInputs, tmpComponents, tmpEnv, pPath, tmpUnresolved);
		}.bind(this), { skipKeys: new Set(['Inputs']) });

		return {
			Spec:       tmpClone,
			Inputs:     tmpInputs,
			Components: tmpComponents,
			Unresolved: tmpUnresolved
		};
	}

	// ====================================================================
	// Internals
	// ====================================================================

	_firstContainerPort(pComponent)
	{
		if (!pComponent || !Array.isArray(pComponent.Ports) || pComponent.Ports.length === 0) return '';
		let tmpP = pComponent.Ports[0];
		if (tmpP && (tmpP.Container !== undefined && tmpP.Container !== null))
		{
			return String(tmpP.Container);
		}
		return '';
	}

	// Walk the spec tree and apply pTransform to every string. pSkipKeys
	// names top-level keys whose subtrees are NOT walked (e.g. "Inputs"
	// which carries config-shape descriptions, not runtime values).
	_walk(pNode, pPath, pTransform, pOptions)
	{
		let tmpSkipKeys = (pOptions && pOptions.skipKeys) || new Set();
		if (Array.isArray(pNode))
		{
			for (let i = 0; i < pNode.length; i++)
			{
				let tmpChildPath = `${pPath}[${i}]`;
				if (typeof pNode[i] === 'string')
				{
					pNode[i] = pTransform(pNode[i], tmpChildPath);
				}
				else
				{
					this._walk(pNode[i], tmpChildPath, pTransform, pOptions);
				}
			}
			return;
		}
		if (pNode && typeof pNode === 'object')
		{
			let tmpKeys = Object.keys(pNode);
			for (let i = 0; i < tmpKeys.length; i++)
			{
				let tmpK = tmpKeys[i];
				if (pPath === '' && tmpSkipKeys.has(tmpK)) continue;
				let tmpChildPath = pPath ? `${pPath}.${tmpK}` : tmpK;
				if (typeof pNode[tmpK] === 'string')
				{
					pNode[tmpK] = pTransform(pNode[tmpK], tmpChildPath);
				}
				else
				{
					this._walk(pNode[tmpK], tmpChildPath, pTransform, pOptions);
				}
			}
		}
	}

	// Substitute ${...} references in a string. Pattern matches anywhere
	// in the string (a value can be `http://${component.uv.host}:${input.Port}/api`).
	_substitute(pStr, pInputs, pComponents, pEnv, pPath, pUnresolved)
	{
		if (typeof pStr !== 'string' || pStr.indexOf('${') < 0) return pStr;
		return pStr.replace(REFERENCE_PATTERN, function (pMatch, pRef)
		{
			let tmpResolved = this._resolveReference(pRef, pInputs, pComponents, pEnv);
			if (tmpResolved === null)
			{
				pUnresolved.push({ Path: pPath, Reference: pMatch });
				return pMatch;
			}
			return String(tmpResolved);
		}.bind(this));
	}

	// Same shape but only ${env.X} / ${HOME} / ${PWD} resolve. Used for
	// input values, where input-references and component-references
	// don't make sense.
	_substituteEnvOnly(pStr, pEnv, pPath, pUnresolved)
	{
		if (typeof pStr !== 'string' || pStr.indexOf('${') < 0) return pStr;
		return pStr.replace(REFERENCE_PATTERN, function (pMatch, pRef)
		{
			if (pRef === 'HOME')      return pEnv.HOME || '';
			if (pRef === 'PWD')       return process.cwd();
			if (pRef.indexOf('env.') === 0)
			{
				let tmpKey = pRef.slice(4);
				if (tmpKey in pEnv) return pEnv[tmpKey] || '';
				pUnresolved.push({ Path: pPath, Reference: pMatch });
				return pMatch;
			}
			pUnresolved.push({ Path: pPath, Reference: pMatch });
			return pMatch;
		});
	}

	_resolveReference(pRef, pInputs, pComponents, pEnv)
	{
		if (pRef === 'HOME')      return pEnv.HOME || '';
		if (pRef === 'PWD')       return process.cwd();
		if (pRef.indexOf('env.') === 0)
		{
			let tmpKey = pRef.slice(4);
			return (tmpKey in pEnv) ? (pEnv[tmpKey] || '') : null;
		}
		if (pRef.indexOf('input.') === 0)
		{
			let tmpKey = pRef.slice(6);
			return (tmpKey in pInputs) ? (pInputs[tmpKey] !== undefined ? pInputs[tmpKey] : '') : null;
		}
		if (pRef.indexOf('component.') === 0)
		{
			// component.<hash>.<attr>
			let tmpRest = pRef.slice(10);
			let tmpDot = tmpRest.lastIndexOf('.');
			if (tmpDot < 0) return null;
			let tmpHash = tmpRest.slice(0, tmpDot);
			let tmpAttr = tmpRest.slice(tmpDot + 1);
			let tmpC = pComponents[tmpHash];
			if (!tmpC) return null;
			return (tmpAttr in tmpC) ? tmpC[tmpAttr] : null;
		}
		return null;
	}
}

module.exports = ServiceStackResolver;
