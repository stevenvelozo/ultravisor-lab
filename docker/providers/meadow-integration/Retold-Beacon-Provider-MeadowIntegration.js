/**
 * Retold-Beacon-Provider-MeadowIntegration  (lab-local, baked into image)
 *
 * ultravisor-beacon CapabilityProvider wrapping meadow-integration's
 * FileParser + TabularTransform services, plus a small LabWriter action
 * that posts records to a databeacon's dynamic /1.0/<Entity> endpoint.
 *
 * Not published to npm -- this file lives inside ultravisor-lab and is
 * COPY'd into a container image at build time by
 * docker/retold-beacon-host-meadow-integration.Dockerfile.  The generic
 * retold-beacon-host (published separately) loads it via `--provider
 * /app/provider` at container runtime.
 *
 * Exposes two capabilities so a single beacon host process can serve both
 * the parse/transform pipeline (`MeadowIntegration`) and the writer shim
 * (`LabWriter`) that seed / ETL operations target:
 *
 *   MeadowIntegration.ParseContent     raw content (CSV/JSON/XML) -> records
 *   MeadowIntegration.ParseFile        JSON file on disk -> records
 *   MeadowIntegration.TransformRecords apply a MappingConfiguration
 *   LabWriter.BulkInsertViaBeacon      POST records to a beacon endpoint
 *
 * Constructor expects `(pProviderConfig, pPict)`.  pPict is the
 * retold-beacon-host's pict instance -- meadow-integration's services
 * register through its serviceManager and we grab the instances off
 * the pict.
 */
'use strict';

const libFS = require('fs');

const libMeadowIntegrationFileParser = require('meadow-integration/source/services/parser/Service-FileParser.js');
const libMeadowIntegrationTabularTransform = require('meadow-integration/source/services/tabular/Service-TabularTransform.js');

class RetoldBeaconProviderMeadowIntegration
{
	/**
	 * pProviderConfig is the user's saved config blob (empty object is fine
	 * for this provider).  pPict is the beacon-host's pict instance;
	 * meadow-integration's services register through its serviceManager
	 * and we grab the instances off the pict.
	 */
	constructor(pProviderConfig, pPict)
	{
		this._Config = pProviderConfig || {};

		if (!pPict)
		{
			throw new Error('retold-beacon-provider-meadow-integration requires the host pict instance.');
		}

		pPict.serviceManager.addServiceType('MeadowIntegrationFileParser', libMeadowIntegrationFileParser);
		pPict.serviceManager.instantiateServiceProvider('MeadowIntegrationFileParser');
		pPict.serviceManager.addServiceType('TabularTransform', libMeadowIntegrationTabularTransform);
		pPict.serviceManager.instantiateServiceProvider('TabularTransform');

		this._parser    = pPict.MeadowIntegrationFileParser;
		this._transform = pPict.TabularTransform;
	}

	/**
	 * Called by lab-beacon-host.  Registers both capabilities on the given
	 * ultravisor-beacon.  Using the explicit register() hook (rather than
	 * the `Capability` + `actions` pair the base class convention expects)
	 * so a single provider module can contribute more than one capability.
	 */
	register(pBeacon)
	{
		pBeacon.registerCapability(
			{
				Capability: 'LabWriter',
				Name:       'LabWriterProvider',
				actions:
				{
					BulkInsertViaBeacon: this._buildBulkInsertAction()
				}
			});

		pBeacon.registerCapability(
			{
				Capability: 'MeadowIntegration',
				Name:       'MeadowIntegrationProvider',
				actions:
				{
					ParseContent:     this._buildParseContentAction(),
					ParseFile:        this._buildParseFileAction(),
					TransformRecords: this._buildTransformRecordsAction()
				}
			});
	}

	// ── LabWriter actions ──────────────────────────────────────────────────

	_buildBulkInsertAction()
	{
		return {
			Description: 'POSTs records to a target beacon\'s /1.0/<Entity> endpoint',
			SettingsSchema:
			[
				{ Name: 'BeaconURL',  DataType: 'String', Required: true },
				{ Name: 'EntityName', DataType: 'String', Required: true },
				{ Name: 'Records',    DataType: 'Array',  Required: true }
			],
			Handler: (pWorkItem, pContext, fCallback) =>
			{
				try
				{
					let tmpSettings  = pWorkItem.Settings || {};
					let tmpBeaconURL = tmpSettings.BeaconURL;
					let tmpEntity    = tmpSettings.EntityName;
					let tmpRecords   = tmpSettings.Records || [];
					if (!tmpBeaconURL) { return fCallback(new Error('BeaconURL is required.')); }
					if (!tmpEntity)    { return fCallback(new Error('EntityName is required.')); }

					let tmpURL    = new URL(tmpBeaconURL);
					let tmpHttp   = tmpURL.protocol === 'https:' ? require('https') : require('http');
					let tmpBase   = (tmpURL.pathname || '').replace(/\/$/, '');

					let tmpInserted = 0;
					let tmpFailed   = 0;
					let tmpIdx      = 0;
					let tmpLastErr  = '';

					let tmpNext = () =>
					{
						if (tmpIdx >= tmpRecords.length)
						{
							return fCallback(null,
								{
									Outputs:
									{
										InsertedCount: tmpInserted,
										FailedCount:   tmpFailed,
										TotalCount:    tmpRecords.length,
										LastError:     tmpLastErr
									},
									Log: []
								});
						}
						let tmpRec  = tmpRecords[tmpIdx++];
						let tmpBody = JSON.stringify(tmpRec);
						let tmpReq  = tmpHttp.request(
							{
								host:    tmpURL.hostname,
								port:    tmpURL.port,
								path:    `${tmpBase}/${tmpEntity}`,
								method:  'POST',
								headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(tmpBody) },
								timeout: 15000
							},
							(pRes) =>
							{
								let tmpChunks = [];
								pRes.on('data', (c) => tmpChunks.push(c));
								pRes.on('end', () =>
									{
										if (pRes.statusCode >= 400)
										{
											tmpFailed++;
											tmpLastErr = `HTTP ${pRes.statusCode}: ` + Buffer.concat(tmpChunks).toString('utf8').slice(0, 200);
										}
										else { tmpInserted++; }
										setImmediate(tmpNext);
									});
							});
						tmpReq.on('error',   (pErr) => { tmpFailed++; tmpLastErr = pErr.message; setImmediate(tmpNext); });
						tmpReq.on('timeout', () => { tmpReq.destroy(); tmpFailed++; tmpLastErr = 'timeout'; setImmediate(tmpNext); });
						tmpReq.write(tmpBody);
						tmpReq.end();
					};
					tmpNext();
				}
				catch (pEx) { return fCallback(pEx); }
			}
		};
	}

	// ── MeadowIntegration actions ──────────────────────────────────────────

	_buildParseContentAction()
	{
		return {
			Description: 'Parse raw content (CSV/JSON/XML) into records',
			SettingsSchema:
			[
				{ Name: 'Content', DataType: 'String', Required: true },
				{ Name: 'Format',  DataType: 'String', Required: false }
			],
			Handler: (pWorkItem, pContext, fCallback) =>
			{
				try
				{
					let tmpSettings = pWorkItem.Settings || {};
					this._parser.parseContent(tmpSettings.Content || '',
						{ format: tmpSettings.Format || 'auto' },
						(pErr, pResult) =>
						{
							if (pErr) { return fCallback(pErr); }
							let tmpRecords = Array.isArray(pResult) ? pResult : (pResult && pResult.Records) || [];
							return fCallback(null, { Outputs: { Records: tmpRecords, Count: tmpRecords.length }, Log: [] });
						});
				}
				catch (pEx) { return fCallback(pEx); }
			}
		};
	}

	_buildParseFileAction()
	{
		return {
			Description: 'Parse a file from disk into records',
			SettingsSchema:
			[
				{ Name: 'FilePath', DataType: 'String', Required: true },
				{ Name: 'Format',   DataType: 'String', Required: false }
			],
			Handler: (pWorkItem, pContext, fCallback) =>
			{
				try
				{
					let tmpSettings = pWorkItem.Settings || {};
					if (!tmpSettings.FilePath) { return fCallback(new Error('FilePath is required.')); }

					// Seed fixtures are small JSON files; simplest reliable
					// path is to load + parse directly rather than stream.
					let tmpContent;
					try { tmpContent = libFS.readFileSync(tmpSettings.FilePath, 'utf8'); }
					catch (pReadErr) { return fCallback(pReadErr); }

					let tmpRecords;
					try { tmpRecords = JSON.parse(tmpContent); }
					catch (pParseErr) { return fCallback(pParseErr); }
					if (!Array.isArray(tmpRecords)) { tmpRecords = [tmpRecords]; }

					return fCallback(null, { Outputs: { Records: tmpRecords, Count: tmpRecords.length }, Log: [] });
				}
				catch (pEx) { return fCallback(pEx); }
			}
		};
	}

	_buildTransformRecordsAction()
	{
		return {
			Description: 'Apply a MappingConfiguration to records via TabularTransform',
			SettingsSchema:
			[
				{ Name: 'Records',              DataType: 'Array',  Required: true },
				{ Name: 'MappingConfiguration', DataType: 'Object', Required: true },
				{ Name: 'EntityName',           DataType: 'String', Required: false }
			],
			Handler: (pWorkItem, pContext, fCallback) =>
			{
				try
				{
					let tmpSettings = pWorkItem.Settings || {};
					let tmpRecords  = tmpSettings.Records || [];
					let tmpMapping  = tmpSettings.MappingConfiguration || {};
					let tmpEntity   = tmpSettings.EntityName || (tmpMapping && tmpMapping.Entity) || 'Record';
					this._transform.transform(tmpRecords, tmpMapping,
						(pErr, pResult) =>
						{
							if (pErr) { return fCallback(pErr); }
							let tmpOut = (pResult && pResult.Records) ? pResult : { Records: pResult || [] };
							return fCallback(null,
								{
									Outputs:
									{
										Records:     tmpOut.Records || [],
										Count:       (tmpOut.Records || []).length,
										ParsedCount: tmpRecords.length,
										BadRecords:  tmpOut.BadRecords || [],
										Entity:      tmpEntity
									},
									Log: []
								});
						});
				}
				catch (pEx) { return fCallback(pEx); }
			}
		};
	}
}

module.exports = RetoldBeaconProviderMeadowIntegration;
