/**
 * Instance Locker - Ensures single instance per machine using shared memory
 * Based on reverse engineering of OoklaServer InstanceLocker.cpp
 * JavaScript implementation
 */

const EventEmitter = require('events');
const fs = require('fs');
const path = require('path');

const SHARED_MEMORY_CONFIG = {
  managerMutex: 'OoklaManMu_',
  serverMutex: 'OoklaSerMu_',
  managerShMem: 'OoklaShMemMan_',
  serverShMem: 'OoklaShMemSer_',
  managerShMemMutex: 'OoklaShMemManMu_',
  serverShMemMutex: 'OoklaShMemSerMu_',
};

class InstanceLocker extends EventEmitter {
  constructor(config, logger) {
    super();
    this.config = config || SHARED_MEMORY_CONFIG;
    this.logger = logger;
    this.role = 'standalone';
    this.isLocked = false;
    this.lockFile = null;
    this.pidFile = null;
    this.parentPidFile = null;
  }

  async acquire(role) {
    this.role = role;
    this.logger.debug(`Acquiring instance lock for ${role}...`);

    try {
      const lockDir = '/var/lock/ooklaserver';
      if (!fs.existsSync(lockDir)) {
        fs.mkdirSync(lockDir, { recursive: true, mode: 0o755 });
      }

      const lockFileName = role === 'manager' ? 'manager.lock' : 'server.lock';
      this.lockFile = path.join(lockDir, lockFileName);

      if (fs.existsSync(this.lockFile)) {
        const existingPid = parseInt(fs.readFileSync(this.lockFile, 'utf-8').trim(), 10);
        if (this.isProcessAlive(existingPid)) {
          throw new Error(`${role} instance already running with PID ${existingPid}`);
        } else {
          this.logger.warning(`Stale lock file found for ${role}, removing`, { pid: existingPid });
          fs.unlinkSync(this.lockFile);
        }
      }

      fs.writeFileSync(this.lockFile, process.pid.toString());

      if (this.pidFile) {
        fs.writeFileSync(this.pidFile, process.pid.toString());
      }

      if (this.parentPidFile) {
        fs.writeFileSync(this.parentPidFile, process.ppid.toString());
      }

      await this.createSharedMemory();

      this.isLocked = true;
      this.logger.info(`Instance lock acquired for ${role}`, { pid: process.pid });
      this.emit('lockAcquired', role);

    } catch (error) {
      this.logger.error(`Failed to acquire instance lock for ${role}`, { error });
      throw error;
    }
  }

  async release() {
    if (!this.isLocked) return;

    this.logger.debug(`Releasing instance lock for ${this.role}...`);

    try {
      if (this.lockFile && fs.existsSync(this.lockFile)) {
        fs.unlinkSync(this.lockFile);
      }

      if (this.pidFile && fs.existsSync(this.pidFile)) {
        fs.unlinkSync(this.pidFile);
      }

      if (this.parentPidFile && fs.existsSync(this.parentPidFile)) {
        fs.unlinkSync(this.parentPidFile);
      }

      await this.cleanupSharedMemory();

      this.isLocked = false;
      this.logger.info(`Instance lock released for ${this.role}`);
      this.emit('lockReleased', this.role);

    } catch (error) {
      this.logger.error(`Error releasing instance lock for ${this.role}`, { error });
      throw error;
    }
  }

  async createSharedMemory() {
    const shmDir = '/dev/shm/ooklaserver';
    if (!fs.existsSync(shmDir)) {
      fs.mkdirSync(shmDir, { recursive: true, mode: 0o755 });
    }

    const shmFiles = [
      this.config.managerShMem,
      this.config.serverShMem,
      this.config.managerShMemMutex,
      this.config.serverShMemMutex,
    ];

    for (const shmName of shmFiles) {
      const shmPath = path.join(shmDir, shmName);
      if (!fs.existsSync(shmPath)) {
        fs.writeFileSync(shmPath, '');
      }
    }

    this.logger.debug('Shared memory segments created');
  }

  async cleanupSharedMemory() {
    if (this.role !== 'manager') return;

    const shmDir = '/dev/shm/ooklaserver';
    if (!fs.existsSync(shmDir)) return;

    const shmFiles = [
      this.config.managerShMem,
      this.config.serverShMem,
      this.config.managerShMemMutex,
      this.config.serverShMemMutex,
    ];

    for (const shmName of shmFiles) {
      const shmPath = path.join(shmDir, shmName);
      if (fs.existsSync(shmPath)) {
        try {
          fs.unlinkSync(shmPath);
        } catch {
          // Ignore errors
        }
      }
    }

    try {
      fs.rmdirSync(shmDir);
    } catch {
      // Not empty or other error
    }

    this.logger.debug('Shared memory segments cleaned up');
  }

  isProcessAlive(pid) {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  }

  isManagerRunning() {
    const lockFile = path.join('/var/lock/ooklaserver', 'manager.lock');
    if (!fs.existsSync(lockFile)) return false;

    try {
      const pid = parseInt(fs.readFileSync(lockFile, 'utf-8').trim(), 10);
      return this.isProcessAlive(pid);
    } catch {
      return false;
    }
  }

  async requestCounterpartGracefulExit() {
    this.logger.debug('Requesting counterpart graceful exit...');
    return true;
  }

  needsUpdate() {
    return {
      isManager: this.role === 'manager',
      managerNeedsUpdate: false,
      serverNeedsUpdate: false,
    };
  }

  setPidFile(path) {
    this.pidFile = path;
  }

  setParentPidFile(path) {
    this.parentPidFile = path;
  }

  getLockStatus() {
    return {
      isLocked: this.isLocked,
      role: this.role,
      pid: process.pid,
    };
  }

  async destroy() {
    await this.release();
    this.removeAllListeners();
  }
}

module.exports = { InstanceLocker, SHARED_MEMORY_CONFIG };
