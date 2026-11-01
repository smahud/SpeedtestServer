/**
 * Instance Locker - Ensures single instance per machine using shared memory
 * Based on reverse engineering of OoklaServer InstanceLocker.cpp
 */

import { EventEmitter } from 'events';
import * as fs from 'fs';
import * as path from 'path';
import { SharedMemoryConfig, Logger, ProcessRole } from '../types/core';

export class InstanceLocker extends EventEmitter {
  private config: SharedMemoryConfig;
  private logger: Logger;
  private role: ProcessRole = 'standalone';
  private isLocked: boolean = false;
  private lockFile?: string;
  private pidFile?: string;
  private parentPidFile?: string;

  constructor(config: SharedMemoryConfig, logger: Logger) {
    super();
    this.config = config;
    this.logger = logger;
  }

  /**
   * Acquire instance lock for the given role
   */
  public async acquire(role: ProcessRole): Promise<void> {
    this.role = role;

    this.logger.debug(`Acquiring instance lock for ${role}...`);

    try {
      // Create lock directory
      const lockDir = '/var/lock/ooklaserver';
      if (!fs.existsSync(lockDir)) {
        fs.mkdirSync(lockDir, { recursive: true, mode: 0o755 });
      }

      // Determine lock file based on role
      const lockFileName = role === 'manager' ? 'manager.lock' : 'server.lock';
      this.lockFile = path.join(lockDir, lockFileName);

      // Check if lock exists and process is alive
      if (fs.existsSync(this.lockFile)) {
        const existingPid = parseInt(fs.readFileSync(this.lockFile, 'utf-8').trim(), 10);
        if (this.isProcessAlive(existingPid)) {
          throw new Error(`${role} instance already running with PID ${existingPid}`);
        } else {
          this.logger.warning(`Stale lock file found for ${role}, removing`, { pid: existingPid });
          fs.unlinkSync(this.lockFile);
        }
      }

      // Write our PID to lock file
      fs.writeFileSync(this.lockFile, process.pid.toString());

      // Write PID file if specified
      if (this.pidFile) {
        fs.writeFileSync(this.pidFile, process.pid.toString());
      }

      // Write parent PID file if specified
      if (this.parentPidFile) {
        fs.writeFileSync(this.parentPidFile, process.ppid.toString());
      }

      // Create shared memory segments (simulated with files)
      await this.createSharedMemory();

      this.isLocked = true;
      this.logger.info(`Instance lock acquired for ${role}`, { pid: process.pid });
      this.emit('lockAcquired', role);

    } catch (error) {
      this.logger.error(`Failed to acquire instance lock for ${role}`, { error });
      throw error;
    }
  }

  /**
   * Release instance lock
   */
  public async release(): Promise<void> {
    if (!this.isLocked) return;

    this.logger.debug(`Releasing instance lock for ${this.role}...`);

    try {
      // Remove lock file
      if (this.lockFile && fs.existsSync(this.lockFile)) {
        fs.unlinkSync(this.lockFile);
      }

      // Remove PID files
      if (this.pidFile && fs.existsSync(this.pidFile)) {
        fs.unlinkSync(this.pidFile);
      }

      if (this.parentPidFile && fs.existsSync(this.parentPidFile)) {
        fs.unlinkSync(this.parentPidFile);
      }

      // Clean up shared memory
      await this.cleanupSharedMemory();

      this.isLocked = false;
      this.logger.info(`Instance lock released for ${this.role}`);
      this.emit('lockReleased', this.role);

    } catch (error) {
      this.logger.error(`Error releasing instance lock for ${this.role}`, { error });
      throw error;
    }
  }

  /**
   * Create shared memory segments
   */
  private async createSharedMemory(): Promise<void> {
    const shmDir = '/dev/shm/ooklaserver';
    if (!fs.existsSync(shmDir)) {
      fs.mkdirSync(shmDir, { recursive: true, mode: 0o755 });
    }

    // Create shared memory files (simulated)
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

  /**
   * Clean up shared memory segments
   */
  private async cleanupSharedMemory(): Promise<void> {
    // Only manager cleans up shared memory
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

    // Remove directory if empty
    try {
      fs.rmdirSync(shmDir);
    } catch {
      // Not empty or other error
    }

    this.logger.debug('Shared memory segments cleaned up');
  }

  /**
   * Check if a process is alive
   */
  private isProcessAlive(pid: number): boolean {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Check if manager is running
   */
  public isManagerRunning(): boolean {
    const lockFile = path.join('/var/lock/ooklaserver', 'manager.lock');
    if (!fs.existsSync(lockFile)) return false;

    try {
      const pid = parseInt(fs.readFileSync(lockFile, 'utf-8').trim(), 10);
      return this.isProcessAlive(pid);
    } catch {
      return false;
    }
  }

  /**
   * Request counterpart graceful exit
   */
  public async requestCounterpartGracefulExit(): Promise<boolean> {
    // Signal the other process to exit gracefully
    // This uses shared memory to communicate
    this.logger.debug('Requesting counterpart graceful exit...');

    // Implementation would write to shared memory
    // For now, return true
    return true;
  }

  /**
   * Check if update is needed
   */
  public needsUpdate(): { isManager: boolean; managerNeedsUpdate: boolean; serverNeedsUpdate: boolean } {
    return {
      isManager: this.role === 'manager',
      managerNeedsUpdate: false,
      serverNeedsUpdate: false,
    };
  }

  /**
   * Set PID file path
   */
  public setPidFile(path: string): void {
    this.pidFile = path;
  }

  /**
   * Set parent PID file path
   */
  public setParentPidFile(path: string): void {
    this.parentPidFile = path;
  }

  /**
   * Get lock status
   */
  public getLockStatus(): { isLocked: boolean; role: ProcessRole; pid: number } {
    return {
      isLocked: this.isLocked,
      role: this.role,
      pid: process.pid,
    };
  }

  /**
   * Clean up resources
   */
  public async destroy(): Promise<void> {
    await this.release();
    this.removeAllListeners();
  }
}

export default InstanceLocker;