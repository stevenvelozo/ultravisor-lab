/**
 * Engine-MSSQL
 *
 * Adapter for dockerized Microsoft SQL Server 2022 containers.
 *
 * Notes:
 *   - MSSQL demands a strong SA password (>= 8 chars, with upper/lower/digit
 *     and symbol).  We generate one that always satisfies the rule.
 *   - The 2022 image uses `/opt/mssql-tools18/bin/sqlcmd` and requires the
 *     `-N` (encrypt) + `-C` (trust self-signed cert) switches.
 *   - First boot takes noticeably longer than MySQL/Postgres -- SQL Server
 *     needs ~30s for the databases to come online.
 */
'use strict';

const libCrypto = require('crypto');

const ENGINE_TYPE     = 'mssql';
const DEFAULT_IMAGE   = 'mcr.microsoft.com/mssql/server:2022-latest';
const DEFAULT_PORT    = 1433;
const DEFAULT_USER    = 'sa';

const SQLCMD_PATH = '/opt/mssql-tools18/bin/sqlcmd';

module.exports =
{
	EngineType:                ENGINE_TYPE,
	DisplayName:               'Microsoft SQL Server',
	DefaultImage:              DEFAULT_IMAGE,
	DefaultPort:               DEFAULT_PORT,
	SuggestedHostPort:         31433,
	DefaultUsername:           DEFAULT_USER,
	DatabaseNoun:              'database',
	SupportsMultipleDatabases: true,

	defaultPassword()
	{
		// Guaranteed to satisfy SQL Server's password complexity: has an
		// uppercase, a lowercase, a digit, and a symbol; ~14 chars long.
		return 'Lab' + libCrypto.randomBytes(5).toString('hex') + '#A1';
	},

	validatePassword(pPassword)
	{
		if (!pPassword || pPassword.length < 8)
		{
			return 'MSSQL password must be at least 8 characters.';
		}
		let tmpHasUpper   = /[A-Z]/.test(pPassword);
		let tmpHasLower   = /[a-z]/.test(pPassword);
		let tmpHasDigit   = /[0-9]/.test(pPassword);
		let tmpHasSymbol  = /[^A-Za-z0-9]/.test(pPassword);
		let tmpCategories = [tmpHasUpper, tmpHasLower, tmpHasDigit, tmpHasSymbol].filter(Boolean).length;
		if (tmpCategories < 3)
		{
			return 'MSSQL password needs characters from at least three of: upper / lower / digit / symbol.';
		}
		return null;
	},

	buildEnv(pOptions)
	{
		return {
			ACCEPT_EULA:   'Y',
			MSSQL_PID:     'Developer',
			SA_PASSWORD:   pOptions.RootPassword,
			MSSQL_SA_PASSWORD: pOptions.RootPassword
		};
	},

	buildExtraRunArgs(pOptions)
	{
		return [];
	},

	healthCheckArgs(pOptions)
	{
		return [SQLCMD_PATH, '-S', 'localhost', '-U', DEFAULT_USER, '-P', pOptions.RootPassword, '-Q', 'SELECT 1', '-C', '-N', '-l', '5'];
	},

	createDatabaseArgs(pOptions, pDatabaseName)
	{
		// Escape closing brackets per T-SQL identifier quoting rules.
		let tmpEscaped = String(pDatabaseName).replace(/]/g, ']]');
		return [
			SQLCMD_PATH,
			'-S', 'localhost',
			'-U', DEFAULT_USER,
			'-P', pOptions.RootPassword,
			'-C', '-N',
			'-Q', `IF DB_ID('${tmpEscaped.replace(/'/g, "''")}') IS NULL CREATE DATABASE [${tmpEscaped}]`
		];
	},

	dropDatabaseArgs(pOptions, pDatabaseName)
	{
		let tmpEscaped = String(pDatabaseName).replace(/]/g, ']]');
		let tmpLiteral = tmpEscaped.replace(/'/g, "''");
		return [
			SQLCMD_PATH,
			'-S', 'localhost',
			'-U', DEFAULT_USER,
			'-P', pOptions.RootPassword,
			'-C', '-N',
			'-Q', `IF DB_ID('${tmpLiteral}') IS NOT NULL DROP DATABASE [${tmpEscaped}]`
		];
	},

	listDatabasesArgs(pOptions)
	{
		return [
			SQLCMD_PATH,
			'-S', 'localhost',
			'-U', DEFAULT_USER,
			'-P', pOptions.RootPassword,
			'-C', '-N',
			'-h', '-1',
			'-W',
			'-Q', `SET NOCOUNT ON; SELECT name FROM sys.databases WHERE database_id > 4 ORDER BY name`
		];
	},

	parseDatabaseList(pStdout)
	{
		let tmpSystem = new Set(['master', 'model', 'msdb', 'tempdb']);
		return pStdout
			.split('\n')
			.map((pLine) => pLine.trim())
			.filter((pLine) => pLine.length > 0)
			.filter((pLine) => !pLine.startsWith('---') && !pLine.startsWith('('))
			.filter((pName) => !tmpSystem.has(pName));
	},

	connectionString(pEngine)
	{
		return `sqlserver://${pEngine.RootUsername}:${pEngine.RootPassword}@127.0.0.1:${pEngine.Port}`;
	}
};
