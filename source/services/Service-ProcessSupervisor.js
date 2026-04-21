/**
 * Service-ProcessSupervisor
 *
 * Spawns, tracks, and checks the liveness of standalone child processes
 * (databeacons, ultravisor, facto).  Every supervised process is detached
 * from the lab: we set `detached: true`, redirect stdout/stderr to log
 * files, and `unref()` so shutting down lab does not kill its children.
 *
 * The PID is persisted in two places:
 *   1. The owning state-store row (Databeacon.PID, etc.)
 *   2. A PID file at data/pids/<entity>-<id>.pid
 *
 * The file is what lets a fresh lab process adopt a running child on boot.
 */
'use strict';

const libPath = require('path');
const libFs = require('fs');
const libChildProcess = require('child_process');
const libFableServiceProviderBase = require('fable-serviceproviderbase');

class ServiceProcessSupervisor extends libFableServiceProviderBase
{
	constructor(pFable, pOptions, pServiceHash)
	{
		super(pFable, pOptions, pServiceHash);

		this.serviceType = 'LabProcessSupervisor';

		this.dataDir  = (pOptions && pOptions.DataDir)  ? pOptions.DataDir  : libPath.resolve(__dirname, '..', '..', 'data');
		this.pidDir   = libPath.join(this.dataDir, 'pids');
		this.logDir   = libPath.join(this.dataDir, 'logs');
	}

	initialize(fCallback)
	{
		try
		{
			libFs.mkdirSync(this.pidDir, { recursive: true });
			libFs.mkdirSync(this.logDir, { recursive: true });
		}
		catch (pErr)
		{
			return fCallback(pErr);
		}
		return fCallback(null);
	}

	_pidPath(pEntityType, pID)
	{
		return libPath.join(this.pidDir, `${pEntityType}-${pID}.pid`);
	}

	_logPath(pEntityType, pID)
	{
		return libPath.join(this.logDir, `${pEntityType}-${pID}.log`);
	}

	/**
	 * Spawn a detached child process for an entity.  Returns the PID or
	 * throws if spawn fails.
	 *
	 * pSpawn = { Command, Args, Cwd, Env }
	 */
	spawn(pEntityType, pID, pSpawn)
	{
		let tmpLogPath = this._logPath(pEntityType, pID);
		let tmpOut = libFs.openSync(tmpLogPath, 'a');
		let tmpErr = libFs.openSync(tmpLogPath, 'a');

		let tmpOptions =
		{
			cwd:       pSpawn.Cwd || process.cwd(),
			env:       pSpawn.Env || process.env,
			detached:  true,
			stdio:     ['ignore', tmpOut, tmpErr]
		};

		let tmpChild = libChildProcess.spawn(pSpawn.Command, pSpawn.Args || [], tmpOptions);

		if (!tmpChild.pid)
		{
			throw new Error(`ProcessSupervisor: spawn returned no PID for ${pEntityType}-${pID}`);
		}

		libFs.writeFileSync(this._pidPath(pEntityType, pID), String(tmpChild.pid));

		// Detach the parent/child relationship so `lab` exiting doesn't signal the child.
		tmpChild.unref();

		return tmpChild.pid;
	}

	/**
	 * Read the PID file if present.  Returns null when the file is missing
	 * or malformed.
	 */
	readPidFile(pEntityType, pID)
	{
		let tmpPath = this._pidPath(pEntityType, pID);
		if (!libFs.existsSync(tmpPath)) { return null; }
		try
		{
			let tmpText = libFs.readFileSync(tmpPath, 'utf8').trim();
			let tmpPid = parseInt(tmpText, 10);
			if (!Number.isFinite(tmpPid) || tmpPid <= 0) { return null; }
			return tmpPid;
		}
		catch (pErr)
		{
			return null;
		}
	}

	/**
	 * Check whether a PID is alive on this host.  Uses `kill -0` semantics
	 * (signal 0 probes for existence without sending anything).
	 */
	isAlive(pPid)
	{
		if (!pPid || pPid <= 0) { return false; }
		try
		{
			process.kill(pPid, 0);
			return true;
		}
		catch (pErr)
		{
			// ESRCH = no such process; EPERM = exists but not ours (still alive).
			return pErr.code === 'EPERM';
		}
	}

	/**
	 * Stop a supervised process.  Escalates SIGTERM -> SIGKILL after 5s.
	 * Safe to call even if the PID is already gone.
	 */
	stop(pEntityType, pID, fCallback)
	{
		let tmpPid = this.readPidFile(pEntityType, pID);
		if (!tmpPid || !this.isAlive(tmpPid))
		{
			this._removePidFile(pEntityType, pID);
			return fCallback(null, { Stopped: true, WasRunning: false });
		}

		try { process.kill(tmpPid, 'SIGTERM'); } catch (pErr) { /* ignore */ }

		setTimeout(() =>
			{
				if (this.isAlive(tmpPid))
				{
					try { process.kill(tmpPid, 'SIGKILL'); } catch (pErr) { /* ignore */ }
				}
				this._removePidFile(pEntityType, pID);
				return fCallback(null, { Stopped: true, WasRunning: true });
			}, 5000);
	}

	_removePidFile(pEntityType, pID)
	{
		let tmpPath = this._pidPath(pEntityType, pID);
		if (libFs.existsSync(tmpPath))
		{
			try { libFs.unlinkSync(tmpPath); } catch (pErr) { /* ignore */ }
		}
	}

	logFilePath(pEntityType, pID)
	{
		return this._logPath(pEntityType, pID);
	}

	/**
	 * Return the last N lines of a process's log file, or [] if missing.
	 */
	tailLog(pEntityType, pID, pLines)
	{
		let tmpPath = this._logPath(pEntityType, pID);
		if (!libFs.existsSync(tmpPath)) { return []; }
		let tmpLimit = (pLines && pLines > 0) ? pLines : 200;
		try
		{
			let tmpContent = libFs.readFileSync(tmpPath, 'utf8');
			let tmpLines = tmpContent.split('\n');
			if (tmpLines.length > tmpLimit)
			{
				tmpLines = tmpLines.slice(tmpLines.length - tmpLimit);
			}
			return tmpLines;
		}
		catch (pErr)
		{
			return [];
		}
	}
}

module.exports = ServiceProcessSupervisor;
