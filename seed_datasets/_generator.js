#!/usr/bin/env node
/**
 * Seed dataset generator.
 *
 * Produces per-dataset fixture files under seed_datasets/<name>/:
 *   manifest.json       -- metadata + entity list + operation pointers
 *   <Entity>.json       -- array of records per entity
 *   operation.json      -- Ultravisor operation template (with {TARGET_BEACON} placeholder)
 *
 * Data for weather_stations / demographics / transit_systems follows the
 * retold-data-mapper test harness convention: a shared CITIES array drives
 * all three, with intentionally-mismatched correlation keys across sources
 * so the ETL exercise mimics real-world cleanup.
 *
 * Run:  node seed_datasets/_generator.js
 */
'use strict';

const libFs = require('fs');
const libPath = require('path');

const ROOT = __dirname;

// ──────────────────────────────────────────────────────────────────────────
//  Source data
// ──────────────────────────────────────────────────────────────────────────

const CITIES =
[
	{ weather: 'New York, NY',   demo: 'New York',     transit: 'NYC',         lat: 40.7128,  lon: -74.0060,   tz: 'America/New_York',        pop: 8336817, area: 302.6, age: 37.2, income: 70663, founded: 1624, region: 'Northeast' },
	{ weather: 'Los Angeles, CA',demo: 'Los Angeles',  transit: 'LA Metro',    lat: 34.0522,  lon: -118.2437,  tz: 'America/Los_Angeles',     pop: 3979576, area: 468.7, age: 35.9, income: 62142, founded: 1781, region: 'West' },
	{ weather: 'Chicago, IL',    demo: 'Chicago',      transit: 'CTA',         lat: 41.8781,  lon: -87.6298,   tz: 'America/Chicago',         pop: 2693976, area: 227.3, age: 34.8, income: 58247, founded: 1833, region: 'Midwest' },
	{ weather: 'Houston, TX',    demo: 'Houston',      transit: 'METRO',       lat: 29.7604,  lon: -95.3698,   tz: 'America/Chicago',         pop: 2320268, area: 637.5, age: 33.4, income: 52338, founded: 1836, region: 'South' },
	{ weather: 'Phoenix, AZ',    demo: 'Phoenix',      transit: 'Valley Metro',lat: 33.4484,  lon: -112.0740,  tz: 'America/Phoenix',         pop: 1680992, area: 517.9, age: 34.1, income: 57957, founded: 1868, region: 'West' },
	{ weather: 'Philadelphia, PA', demo: 'Philadelphia', transit: 'SEPTA',     lat: 39.9526,  lon: -75.1652,   tz: 'America/New_York',        pop: 1584064, area: 134.2, age: 34.5, income: 46116, founded: 1682, region: 'Northeast' },
	{ weather: 'San Antonio, TX',demo: 'San Antonio',  transit: 'VIA',         lat: 29.4241,  lon: -98.4936,   tz: 'America/Chicago',         pop: 1547253, area: 460.9, age: 33.2, income: 52455, founded: 1718, region: 'South' },
	{ weather: 'San Diego, CA',  demo: 'San Diego',    transit: 'MTS',         lat: 32.7157,  lon: -117.1611,  tz: 'America/Los_Angeles',     pop: 1423851, area: 325.2, age: 35.6, income: 79673, founded: 1769, region: 'West' },
	{ weather: 'Dallas, TX',     demo: 'Dallas',       transit: 'DART',        lat: 32.7767,  lon: -96.7970,   tz: 'America/Chicago',         pop: 1343573, area: 340.5, age: 33.4, income: 54747, founded: 1841, region: 'South' },
	{ weather: 'San Jose, CA',   demo: 'San Jose',     transit: 'VTA',         lat: 37.3382,  lon: -121.8863,  tz: 'America/Los_Angeles',     pop: 1021795, area: 178.3, age: 37.0, income: 109593, founded: 1777, region: 'West' },
	{ weather: 'Austin, TX',     demo: 'Austin',       transit: 'CapMetro',    lat: 30.2672,  lon: -97.7431,   tz: 'America/Chicago',         pop: 978908,  area: 297.9, age: 33.4, income: 75413, founded: 1839, region: 'South' },
	{ weather: 'Jacksonville, FL',demo: 'Jacksonville',transit: 'JTA',         lat: 30.3322,  lon: -81.6557,   tz: 'America/New_York',        pop: 911507,  area: 747.4, age: 35.9, income: 54701, founded: 1791, region: 'South' },
	{ weather: 'Fort Worth, TX', demo: 'Fort Worth',   transit: 'Trinity Metro',lat: 32.7555, lon: -97.3308,   tz: 'America/Chicago',         pop: 909585,  area: 342.9, age: 32.7, income: 62187, founded: 1849, region: 'South' },
	{ weather: 'Columbus, OH',   demo: 'Columbus',     transit: 'COTA',        lat: 39.9612,  lon: -82.9988,   tz: 'America/New_York',        pop: 898553,  area: 223.1, age: 32.2, income: 53745, founded: 1812, region: 'Midwest' },
	{ weather: 'Indianapolis, IN',demo: 'Indianapolis',transit: 'IndyGo',      lat: 39.7684,  lon: -86.1581,   tz: 'America/New_York',        pop: 876384,  area: 361.5, age: 34.3, income: 48198, founded: 1821, region: 'Midwest' },
	{ weather: 'Charlotte, NC',  demo: 'Charlotte',    transit: 'CATS',        lat: 35.2271,  lon: -80.8431,   tz: 'America/New_York',        pop: 885708,  area: 297.7, age: 34.3, income: 62817, founded: 1768, region: 'South' },
	{ weather: 'San Francisco, CA',demo: 'San Francisco',transit: 'Muni',      lat: 37.7749,  lon: -122.4194,  tz: 'America/Los_Angeles',     pop: 873965,  area: 46.9,  age: 38.2, income: 112449, founded: 1776, region: 'West' },
	{ weather: 'Seattle, WA',    demo: 'Seattle',      transit: 'Sound Transit',lat: 47.6062, lon: -122.3321,  tz: 'America/Los_Angeles',     pop: 753675,  area: 83.9,  age: 35.4, income: 97185, founded: 1851, region: 'West' },
	{ weather: 'Denver, CO',     demo: 'Denver',       transit: 'RTD',         lat: 39.7392,  lon: -104.9903,  tz: 'America/Denver',          pop: 727211,  area: 153.3, age: 34.5, income: 68592, founded: 1858, region: 'West' },
	{ weather: 'Washington, DC', demo: 'Washington',   transit: 'WMATA',       lat: 38.9072,  lon: -77.0369,   tz: 'America/New_York',        pop: 705749,  area: 61.1,  age: 34.0, income: 86420, founded: 1790, region: 'Northeast' },
	{ weather: 'Boston, MA',     demo: 'Boston',       transit: 'MBTA',        lat: 42.3601,  lon: -71.0589,   tz: 'America/New_York',        pop: 692600,  area: 48.3,  age: 32.4, income: 71834, founded: 1630, region: 'Northeast' },
	{ weather: 'Nashville, TN',  demo: 'Nashville',    transit: 'WeGo',        lat: 36.1627,  lon: -86.7816,   tz: 'America/Chicago',         pop: 670820,  area: 475.1, age: 34.2, income: 59828, founded: 1779, region: 'South' },
	{ weather: 'Portland, OR',   demo: 'Portland',     transit: 'TriMet',      lat: 45.5152,  lon: -122.6784,  tz: 'America/Los_Angeles',     pop: 652503,  area: 133.4, age: 37.5, income: 73097, founded: 1845, region: 'West' },
	{ weather: 'Las Vegas, NV',  demo: 'Las Vegas',    transit: 'RTC',         lat: 36.1699,  lon: -115.1398,  tz: 'America/Los_Angeles',     pop: 651319,  area: 141.8, age: 37.9, income: 56354, founded: 1905, region: 'West' },
	{ weather: 'Detroit, MI',    demo: 'Detroit',      transit: 'DDOT',        lat: 42.3314,  lon: -83.0458,   tz: 'America/Detroit',         pop: 670031,  area: 138.8, age: 34.7, income: 32498, founded: 1701, region: 'Midwest' }
];

// ──────────────────────────────────────────────────────────────────────────
//  Helpers
// ──────────────────────────────────────────────────────────────────────────

function writeFixture(pDatasetDir, pFileName, pObject)
{
	libFs.mkdirSync(pDatasetDir, { recursive: true });
	libFs.writeFileSync(libPath.join(pDatasetDir, pFileName), JSON.stringify(pObject, null, 2));
}

function operationTemplate(pDatasetHash, pDatasetDisplayName, pEntities)
{
	// Ultravisor operation format: Graph.Nodes + Graph.Connections with ports.
	// For each entity:
	//   parse-<entity>   beacon-meadowintegration-parsefile  { FilePath }
	//   insert-<entity>  beacon-labwriter-bulkinsertviabeacon { BeaconURL, EntityName, Records }
	// The nodes are chained linearly, Error ports all route to a shared
	// error-message node, end node closes the graph.
	let tmpNodes = [];
	let tmpConnections = [];
	let tmpY = 200;
	let tmpX = 50;

	tmpNodes.push(
		{
			Hash: 'start', Type: 'start',
			X: tmpX, Y: tmpY, Width: 140, Height: 80, Title: 'Start',
			Ports: [{ Hash: 'start-out', Direction: 'output', Side: 'right-bottom', Label: 'Out' }],
			Data: {}
		});

	let tmpPrevHash = 'start';
	let tmpPrevPort = 'start-out';

	for (let i = 0; i < pEntities.length; i++)
	{
		let tmpEntity = pEntities[i];
		let tmpParseHash  = `parse-${tmpEntity.Name}`;
		let tmpInsertHash = `insert-${tmpEntity.Name}`;

		tmpX += 250;
		tmpNodes.push(
			{
				Hash: tmpParseHash, Type: 'beacon-meadowintegration-parsefile',
				X: tmpX, Y: tmpY, Width: 220, Height: 120, Title: `Parse ${tmpEntity.Name}`,
				Ports:
				[
					{ Hash: `${tmpParseHash}-Trigger`,  Direction: 'input',  Side: 'left-bottom',  Label: 'Trigger' },
					{ Hash: `${tmpParseHash}-Complete`, Direction: 'output', Side: 'right-bottom', Label: 'Complete' },
					{ Hash: `${tmpParseHash}-Error`,    Direction: 'output', Side: 'bottom',       Label: 'Error' },
					{ Hash: `${tmpParseHash}-Result`,   Direction: 'output', Side: 'right-top',    Label: 'Result' }
				],
				Data: { FilePath: '{LAB_SEED_PATH}/' + tmpEntity.FileName, Format: 'json' }
			});
		tmpConnections.push(
			{
				SourceNodeHash: tmpPrevHash, SourcePortHash: tmpPrevPort,
				TargetNodeHash: tmpParseHash, TargetPortHash: `${tmpParseHash}-Trigger`
			});
		tmpConnections.push(
			{
				SourceNodeHash: tmpParseHash, SourcePortHash: `${tmpParseHash}-Error`,
				TargetNodeHash: 'error-handler', TargetPortHash: 'error-handler-Execute'
			});

		tmpX += 250;
		tmpNodes.push(
			{
				Hash: tmpInsertHash, Type: 'beacon-labwriter-bulkinsertviabeacon',
				X: tmpX, Y: tmpY, Width: 220, Height: 120, Title: `Insert ${tmpEntity.Name}`,
				Ports:
				[
					{ Hash: `${tmpInsertHash}-Trigger`,  Direction: 'input',  Side: 'left-bottom',  Label: 'Trigger' },
					{ Hash: `${tmpInsertHash}-Complete`, Direction: 'output', Side: 'right-bottom', Label: 'Complete' },
					{ Hash: `${tmpInsertHash}-Error`,    Direction: 'output', Side: 'bottom',       Label: 'Error' },
					{ Hash: `${tmpInsertHash}-Result`,   Direction: 'output', Side: 'right-top',    Label: 'Result' }
				],
				Data:
				{
					BeaconURL:  '{TARGET_BEACON_URL}',
					EntityName: tmpEntity.Name,
					Records:    `{~D:Record.TaskOutput.${tmpParseHash}.Records~}`
				}
			});
		tmpConnections.push(
			{
				SourceNodeHash: tmpParseHash, SourcePortHash: `${tmpParseHash}-Complete`,
				TargetNodeHash: tmpInsertHash, TargetPortHash: `${tmpInsertHash}-Trigger`
			});
		tmpConnections.push(
			{
				SourceNodeHash: tmpInsertHash, SourcePortHash: `${tmpInsertHash}-Error`,
				TargetNodeHash: 'error-handler', TargetPortHash: 'error-handler-Execute'
			});

		tmpPrevHash = tmpInsertHash;
		tmpPrevPort = `${tmpInsertHash}-Complete`;
	}

	tmpX += 250;
	tmpNodes.push(
		{
			Hash: 'end', Type: 'end',
			X: tmpX, Y: tmpY, Width: 140, Height: 80, Title: 'End',
			Ports: [{ Hash: 'end-in', Direction: 'input', Side: 'left-bottom', Label: 'In' }],
			Data: {}
		});
	tmpConnections.push(
		{ SourceNodeHash: tmpPrevHash, SourcePortHash: tmpPrevPort, TargetNodeHash: 'end', TargetPortHash: 'end-in' });

	tmpNodes.push(
		{
			Hash: 'error-handler', Type: 'error-message',
			X: 700, Y: tmpY + 250, Width: 220, Height: 80, Title: 'Error Handler',
			Ports:
			[
				{ Hash: 'error-handler-Execute',  Direction: 'input',  Side: 'left-bottom', Label: 'Execute' },
				{ Hash: 'error-handler-Complete', Direction: 'output', Side: 'right-bottom', Label: 'Complete' }
			],
			Data: { Message: `Seed '${pDatasetDisplayName}' encountered an error.` }
		});
	tmpConnections.push(
		{ SourceNodeHash: 'error-handler', SourcePortHash: 'error-handler-Complete', TargetNodeHash: 'end', TargetPortHash: 'end-in' });

	return {
		Hash:        pDatasetHash,
		Name:        `Seed ${pDatasetDisplayName}`,
		Description: `Parses and inserts the ${pDatasetDisplayName} seed dataset via the lab's meadow-integration beacon.`,
		Tags:        ['lab', 'seed'],
		Version:     '1.0.0',
		Graph:       { Nodes: tmpNodes, Connections: tmpConnections },
		ViewState:   { X: 0, Y: 0, Scale: 1 }
	};
}

// ──────────────────────────────────────────────────────────────────────────
//  Dataset: weather_stations
// ──────────────────────────────────────────────────────────────────────────

function genWeatherStations()
{
	let tmpDir = libPath.join(ROOT, 'weather_stations');
	let tmpStations = [];
	let tmpReadings = [];

	for (let i = 0; i < CITIES.length; i++)
	{
		let tmpCity = CITIES[i];
		let tmpStationID = i + 1;
		tmpStations.push(
			{
				IDWeatherStation: tmpStationID,
				StationCode:      'WS' + String(tmpStationID).padStart(3, '0'),
				CityName:         tmpCity.weather,
				Latitude:         tmpCity.lat,
				Longitude:        tmpCity.lon,
				Timezone:         tmpCity.tz,
				Active:           1
			});

		for (let m = 1; m <= 12; m++)
		{
			let tmpSeason = (m >= 6 && m <= 8) ? 'summer' : (m >= 12 || m <= 2) ? 'winter' : 'shoulder';
			let tmpBaseTemp = tmpSeason === 'summer' ? 78 : tmpSeason === 'winter' ? 38 : 58;
			let tmpTempVar = ((tmpCity.lat - 35) * -1.5) + (Math.random() * 6);
			let tmpAvg = Math.round(tmpBaseTemp + tmpTempVar);

			tmpReadings.push(
				{
					IDWeatherReading:   tmpReadings.length + 1,
					IDWeatherStation:   tmpStationID,
					ReadingDate:        `2025-${String(m).padStart(2, '0')}-15`,
					AvgTemperatureF:    tmpAvg,
					HighTemperatureF:   tmpAvg + 12 + Math.floor(Math.random() * 5),
					LowTemperatureF:    tmpAvg - 15 - Math.floor(Math.random() * 5),
					PrecipitationInches: Number((Math.random() * 6).toFixed(2)),
					HumidityPercent:    40 + Math.floor(Math.random() * 50),
					WindSpeedMPH:       Math.floor(Math.random() * 20)
				});
		}
	}

	writeFixture(tmpDir, 'WeatherStation.json', tmpStations);
	writeFixture(tmpDir, 'WeatherReading.json', tmpReadings);

	let tmpManifest =
	{
		Hash:        'weather-stations',
		Name:        'Weather Stations',
		Description: '50 city weather stations + 12 monthly readings each (~600 readings).  Used by retold-data-mapper to exercise ETL against MySQL.',
		Entities:
		[
			{ Name: 'WeatherStation', FileName: 'WeatherStation.json', RowCount: tmpStations.length, Schema: weatherStationSchema() },
			{ Name: 'WeatherReading', FileName: 'WeatherReading.json', RowCount: tmpReadings.length, Schema: weatherReadingSchema() }
		],
		OperationHash: 'seed-weather-stations',
		Correlation:   'CityName (e.g. "New York, NY")'
	};
	writeFixture(tmpDir, 'manifest.json', tmpManifest);
	writeFixture(tmpDir, 'operation.json', operationTemplate(tmpManifest.OperationHash, tmpManifest.Name, tmpManifest.Entities));
}

function weatherStationSchema()
{
	return {
		Columns:
		[
			{ Name: 'IDWeatherStation', Type: 'AutoIdentity' },
			{ Name: 'StationCode',      Type: 'String',  Size: 16 },
			{ Name: 'CityName',         Type: 'String',  Size: 128 },
			{ Name: 'Latitude',         Type: 'Decimal', Precision: 10, Scale: 6 },
			{ Name: 'Longitude',        Type: 'Decimal', Precision: 10, Scale: 6 },
			{ Name: 'Timezone',         Type: 'String',  Size: 64 },
			{ Name: 'Active',           Type: 'Integer' }
		]
	};
}

function weatherReadingSchema()
{
	return {
		Columns:
		[
			{ Name: 'IDWeatherReading',    Type: 'AutoIdentity' },
			{ Name: 'IDWeatherStation',    Type: 'Integer' },
			{ Name: 'ReadingDate',         Type: 'String', Size: 32 },
			{ Name: 'AvgTemperatureF',     Type: 'Integer' },
			{ Name: 'HighTemperatureF',    Type: 'Integer' },
			{ Name: 'LowTemperatureF',     Type: 'Integer' },
			{ Name: 'PrecipitationInches', Type: 'Decimal', Precision: 6, Scale: 2 },
			{ Name: 'HumidityPercent',     Type: 'Integer' },
			{ Name: 'WindSpeedMPH',        Type: 'Integer' }
		]
	};
}

// ──────────────────────────────────────────────────────────────────────────
//  Dataset: demographics
// ──────────────────────────────────────────────────────────────────────────

function genDemographics()
{
	let tmpDir = libPath.join(ROOT, 'demographics');
	let tmpRows = [];
	for (let i = 0; i < CITIES.length; i++)
	{
		let tmpCity = CITIES[i];
		tmpRows.push(
			{
				IDCityProfile:       i + 1,
				CityName:            tmpCity.demo,
				Population:          tmpCity.pop,
				AreaSqMiles:         tmpCity.area,
				PopulationDensity:   Math.round(tmpCity.pop / tmpCity.area),
				MedianAge:           tmpCity.age,
				MedianIncome:        tmpCity.income,
				FoundedYear:         tmpCity.founded,
				Region:              tmpCity.region
			});
	}
	writeFixture(tmpDir, 'CityProfile.json', tmpRows);

	let tmpManifest =
	{
		Hash:        'demographics',
		Name:        'City Demographics',
		Description: '50-city demographic profile: population, density, median age/income, region.  Correlates with weather_stations and transit_systems on CityName (mangled form).',
		Entities:
		[
			{ Name: 'CityProfile', FileName: 'CityProfile.json', RowCount: tmpRows.length, Schema: cityProfileSchema() }
		],
		OperationHash: 'seed-demographics',
		Correlation:   'CityName (e.g. "New York")'
	};
	writeFixture(tmpDir, 'manifest.json', tmpManifest);
	writeFixture(tmpDir, 'operation.json', operationTemplate(tmpManifest.OperationHash, tmpManifest.Name, tmpManifest.Entities));
}

function cityProfileSchema()
{
	return {
		Columns:
		[
			{ Name: 'IDCityProfile',     Type: 'AutoIdentity' },
			{ Name: 'CityName',          Type: 'String',  Size: 128 },
			{ Name: 'Population',        Type: 'Integer' },
			{ Name: 'AreaSqMiles',       Type: 'Decimal', Precision: 10, Scale: 2 },
			{ Name: 'PopulationDensity', Type: 'Integer' },
			{ Name: 'MedianAge',         Type: 'Decimal', Precision: 4, Scale: 1 },
			{ Name: 'MedianIncome',      Type: 'Integer' },
			{ Name: 'FoundedYear',       Type: 'Integer' },
			{ Name: 'Region',            Type: 'String',  Size: 32 }
		]
	};
}

// ──────────────────────────────────────────────────────────────────────────
//  Dataset: transit_systems
// ──────────────────────────────────────────────────────────────────────────

function genTransitSystems()
{
	let tmpDir = libPath.join(ROOT, 'transit_systems');
	let tmpSystems = [];
	let tmpRoutes = [];
	let tmpRouteTypes = ['Bus', 'LightRail', 'HeavyRail', 'Commuter', 'Ferry'];

	for (let i = 0; i < CITIES.length; i++)
	{
		let tmpCity = CITIES[i];
		let tmpSystemID = i + 1;
		let tmpRouteCount = 3 + Math.floor(Math.random() * 3);

		tmpSystems.push(
			{
				IDTransitSystem:        tmpSystemID,
				SystemName:             tmpCity.transit,
				CityServed:             tmpCity.transit,
				SystemType:             tmpRouteCount > 4 ? 'Multimodal' : 'Bus',
				TotalRoutes:            tmpRouteCount,
				DailyRidership:         Math.floor(tmpCity.pop * (0.05 + Math.random() * 0.15)),
				AnnualBudgetMillions:   Math.round((tmpCity.pop / 10000) * (1 + Math.random() * 1.5))
			});

		for (let r = 0; r < tmpRouteCount; r++)
		{
			tmpRoutes.push(
				{
					IDTransitRoute: tmpRoutes.length + 1,
					IDTransitSystem: tmpSystemID,
					RouteName:       `${tmpCity.transit}-${String(r + 1).padStart(2, '0')}`,
					RouteType:       tmpRouteTypes[Math.floor(Math.random() * tmpRouteTypes.length)],
					DailyRiders:     Math.floor(1000 + Math.random() * 12000),
					LengthMiles:     Number((4 + Math.random() * 16).toFixed(1)),
					StopsCount:      5 + Math.floor(Math.random() * 30)
				});
		}
	}

	writeFixture(tmpDir, 'TransitSystem.json', tmpSystems);
	writeFixture(tmpDir, 'TransitRoute.json', tmpRoutes);

	let tmpManifest =
	{
		Hash:        'transit-systems',
		Name:        'Transit Systems',
		Description: '50 transit agencies with 3-5 routes each.  Correlates with demographics and weather_stations via a mangled city-name key.',
		Entities:
		[
			{ Name: 'TransitSystem', FileName: 'TransitSystem.json', RowCount: tmpSystems.length, Schema: transitSystemSchema() },
			{ Name: 'TransitRoute',  FileName: 'TransitRoute.json',  RowCount: tmpRoutes.length,  Schema: transitRouteSchema() }
		],
		OperationHash: 'seed-transit-systems',
		Correlation:   'CityServed / SystemName (abbrev, e.g. "NYC")'
	};
	writeFixture(tmpDir, 'manifest.json', tmpManifest);
	writeFixture(tmpDir, 'operation.json', operationTemplate(tmpManifest.OperationHash, tmpManifest.Name, tmpManifest.Entities));
}

function transitSystemSchema()
{
	return {
		Columns:
		[
			{ Name: 'IDTransitSystem',      Type: 'AutoIdentity' },
			{ Name: 'SystemName',           Type: 'String', Size: 128 },
			{ Name: 'CityServed',           Type: 'String', Size: 128 },
			{ Name: 'SystemType',           Type: 'String', Size: 64 },
			{ Name: 'TotalRoutes',          Type: 'Integer' },
			{ Name: 'DailyRidership',       Type: 'Integer' },
			{ Name: 'AnnualBudgetMillions', Type: 'Integer' }
		]
	};
}

function transitRouteSchema()
{
	return {
		Columns:
		[
			{ Name: 'IDTransitRoute',  Type: 'AutoIdentity' },
			{ Name: 'IDTransitSystem', Type: 'Integer' },
			{ Name: 'RouteName',       Type: 'String', Size: 64 },
			{ Name: 'RouteType',       Type: 'String', Size: 32 },
			{ Name: 'DailyRiders',     Type: 'Integer' },
			{ Name: 'LengthMiles',     Type: 'Decimal', Precision: 6, Scale: 1 },
			{ Name: 'StopsCount',      Type: 'Integer' }
		]
	};
}

// ──────────────────────────────────────────────────────────────────────────
//  Dataset: city_dashboard (schema-only, no seed data)
// ──────────────────────────────────────────────────────────────────────────

function genCityDashboard()
{
	let tmpDir = libPath.join(ROOT, 'city_dashboard');
	writeFixture(tmpDir, 'CityRecord.json', []); // empty -- this is a TARGET

	let tmpManifest =
	{
		Hash:        'city-dashboard',
		Name:        'City Dashboard (target)',
		Description: 'Empty target entity.  Exists so users have an ETL destination for the correlated city data produced by a retold-data-mapper run.',
		Entities:
		[
			{ Name: 'CityRecord', FileName: 'CityRecord.json', RowCount: 0, Schema: cityRecordSchema() }
		],
		OperationHash: 'seed-city-dashboard',
		Correlation:   'n/a (target)'
	};
	writeFixture(tmpDir, 'manifest.json', tmpManifest);
	writeFixture(tmpDir, 'operation.json', operationTemplate(tmpManifest.OperationHash, tmpManifest.Name, tmpManifest.Entities));
}

function cityRecordSchema()
{
	return {
		Columns:
		[
			{ Name: 'IDCityRecord',        Type: 'AutoIdentity' },
			{ Name: 'CityName',            Type: 'String', Size: 128 },
			{ Name: 'CanonicalCityName',   Type: 'String', Size: 128 },
			{ Name: 'Population',          Type: 'Integer' },
			{ Name: 'MedianIncome',        Type: 'Integer' },
			{ Name: 'AvgYearRoundTempF',   Type: 'Integer' },
			{ Name: 'TransitDailyRiders',  Type: 'Integer' },
			{ Name: 'Region',              Type: 'String', Size: 32 }
		]
	};
}

// ──────────────────────────────────────────────────────────────────────────
//  Dataset: books (extra)
// ──────────────────────────────────────────────────────────────────────────

function genBooks()
{
	let tmpDir = libPath.join(ROOT, 'books');

	let tmpAuthors =
	[
		{ IDAuthor: 1, FullName: 'Ursula K. Le Guin',    BirthYear: 1929, Nationality: 'American' },
		{ IDAuthor: 2, FullName: 'Octavia Butler',       BirthYear: 1947, Nationality: 'American' },
		{ IDAuthor: 3, FullName: 'N. K. Jemisin',        BirthYear: 1972, Nationality: 'American' },
		{ IDAuthor: 4, FullName: 'Terry Pratchett',      BirthYear: 1948, Nationality: 'British'  },
		{ IDAuthor: 5, FullName: 'Iain M. Banks',        BirthYear: 1954, Nationality: 'British'  },
		{ IDAuthor: 6, FullName: 'Becky Chambers',       BirthYear: 1985, Nationality: 'American' },
		{ IDAuthor: 7, FullName: 'Ann Leckie',           BirthYear: 1966, Nationality: 'American' },
		{ IDAuthor: 8, FullName: 'Martha Wells',         BirthYear: 1964, Nationality: 'American' }
	];
	let tmpBooks =
	[
		{ IDBook: 1, IDAuthor: 1, Title: 'The Left Hand of Darkness', Year: 1969, Pages: 304 },
		{ IDBook: 2, IDAuthor: 1, Title: 'The Dispossessed',          Year: 1974, Pages: 387 },
		{ IDBook: 3, IDAuthor: 2, Title: 'Kindred',                   Year: 1979, Pages: 287 },
		{ IDBook: 4, IDAuthor: 2, Title: 'Parable of the Sower',      Year: 1993, Pages: 299 },
		{ IDBook: 5, IDAuthor: 3, Title: 'The Fifth Season',          Year: 2015, Pages: 512 },
		{ IDBook: 6, IDAuthor: 4, Title: 'Small Gods',                Year: 1992, Pages: 388 },
		{ IDBook: 7, IDAuthor: 4, Title: 'Night Watch',               Year: 2002, Pages: 480 },
		{ IDBook: 8, IDAuthor: 5, Title: 'The Player of Games',       Year: 1988, Pages: 307 },
		{ IDBook: 9, IDAuthor: 5, Title: 'Use of Weapons',            Year: 1990, Pages: 411 },
		{ IDBook:10, IDAuthor: 6, Title: 'The Long Way to a Small, Angry Planet', Year: 2014, Pages: 441 },
		{ IDBook:11, IDAuthor: 7, Title: 'Ancillary Justice',         Year: 2013, Pages: 386 },
		{ IDBook:12, IDAuthor: 8, Title: 'All Systems Red',           Year: 2017, Pages: 149 }
	];

	writeFixture(tmpDir, 'Author.json', tmpAuthors);
	writeFixture(tmpDir, 'Book.json',   tmpBooks);

	let tmpManifest =
	{
		Hash:        'books',
		Name:        'Books & Authors',
		Description: 'Small literary catalog -- 8 authors and 12 books linked by IDAuthor.  Minimal two-entity fixture for learning multi-table ETL.',
		Entities:
		[
			{ Name: 'Author', FileName: 'Author.json', RowCount: tmpAuthors.length, Schema: authorSchema() },
			{ Name: 'Book',   FileName: 'Book.json',   RowCount: tmpBooks.length,   Schema: bookSchema() }
		],
		OperationHash: 'seed-books',
		Correlation:   'IDAuthor'
	};
	writeFixture(tmpDir, 'manifest.json', tmpManifest);
	writeFixture(tmpDir, 'operation.json', operationTemplate(tmpManifest.OperationHash, tmpManifest.Name, tmpManifest.Entities));
}

function authorSchema()
{
	return {
		Columns:
		[
			{ Name: 'IDAuthor',    Type: 'AutoIdentity' },
			{ Name: 'FullName',    Type: 'String', Size: 128 },
			{ Name: 'BirthYear',   Type: 'Integer' },
			{ Name: 'Nationality', Type: 'String', Size: 64 }
		]
	};
}

function bookSchema()
{
	return {
		Columns:
		[
			{ Name: 'IDBook',   Type: 'AutoIdentity' },
			{ Name: 'IDAuthor', Type: 'Integer' },
			{ Name: 'Title',    Type: 'String', Size: 256 },
			{ Name: 'Year',     Type: 'Integer' },
			{ Name: 'Pages',    Type: 'Integer' }
		]
	};
}

// ──────────────────────────────────────────────────────────────────────────
//  Dataset: people (extra)
// ──────────────────────────────────────────────────────────────────────────

function genPeople()
{
	let tmpDir = libPath.join(ROOT, 'people');
	let tmpFirstNames = ['Alex', 'Jordan', 'Taylor', 'Sam', 'Morgan', 'Casey', 'Riley', 'Avery', 'Quinn', 'Rowan', 'Skyler', 'Cameron', 'Finley', 'Harper', 'Parker', 'Reese', 'Sage', 'Drew', 'Hayden', 'Peyton'];
	let tmpLastNames  = ['Brooks', 'Chen', 'Diaz', 'Edwards', 'Fischer', 'Garcia', 'Hill', 'Ito', 'Jones', 'Khan', 'Lopez', 'Müller', 'Nakamura', 'O\'Brien', 'Patel', 'Quinn', 'Rosen', 'Singh', 'Tanaka', 'Ueda'];
	let tmpRoles      = ['Engineer', 'Designer', 'Analyst', 'Manager', 'Advisor', 'Architect', 'Researcher'];

	let tmpPeople = [];
	for (let i = 1; i <= 60; i++)
	{
		let tmpF = tmpFirstNames[i % tmpFirstNames.length];
		let tmpL = tmpLastNames[(i * 3) % tmpLastNames.length];
		tmpPeople.push(
			{
				IDPerson:    i,
				FirstName:   tmpF,
				LastName:    tmpL,
				Email:       `${tmpF}.${tmpL}`.toLowerCase().replace(/'/g, '') + `@example.com`,
				Role:        tmpRoles[i % tmpRoles.length],
				HireYear:    2015 + (i % 10),
				Active:      (i % 7 === 0) ? 0 : 1
			});
	}
	writeFixture(tmpDir, 'Person.json', tmpPeople);

	let tmpManifest =
	{
		Hash:        'people',
		Name:        'People',
		Description: 'Flat 60-person directory.  Simplest possible fixture -- one entity, no foreign keys.  Good smoke-test target.',
		Entities:
		[
			{ Name: 'Person', FileName: 'Person.json', RowCount: tmpPeople.length, Schema: personSchema() }
		],
		OperationHash: 'seed-people',
		Correlation:   'n/a'
	};
	writeFixture(tmpDir, 'manifest.json', tmpManifest);
	writeFixture(tmpDir, 'operation.json', operationTemplate(tmpManifest.OperationHash, tmpManifest.Name, tmpManifest.Entities));
}

function personSchema()
{
	return {
		Columns:
		[
			{ Name: 'IDPerson',  Type: 'AutoIdentity' },
			{ Name: 'FirstName', Type: 'String', Size: 64 },
			{ Name: 'LastName',  Type: 'String', Size: 64 },
			{ Name: 'Email',     Type: 'String', Size: 128 },
			{ Name: 'Role',      Type: 'String', Size: 64 },
			{ Name: 'HireYear',  Type: 'Integer' },
			{ Name: 'Active',    Type: 'Integer' }
		]
	};
}

// ──────────────────────────────────────────────────────────────────────────
//  Run
// ──────────────────────────────────────────────────────────────────────────

genWeatherStations();
genDemographics();
genTransitSystems();
genCityDashboard();
genBooks();
genPeople();

console.log('Seed dataset fixtures generated.');
