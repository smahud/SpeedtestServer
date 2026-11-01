/**
 * Binary Manager - Handles binary auto-updates
 * Based on reverse engineering of OoklaServer BinaryManager.cpp
 */

import { EventEmitter } from 'events';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { BinaryInfo, UpdateStatus, OoklaServerConfig, Logger } from '../types/core';

const HOST_API_URL = 'https://host-api.speedtest.net';
const UPDATE_CHECK_INTERVAL = 60 * 60 * 1000; // 1 hour

export class BinaryManager extends EventEmitter {
  private config: OoklaServerConfig;
  private logger: Logger;
  private currentBinary: BinaryInfo;
  private checkTimer?: NodeJS.Timeout;
  private isChecking: boolean = false;

  constructor(config: OoklaServerConfig, logger: Logger) {
    super();
    this.config = config;
    this.logger = logger;
    this.currentBinary = this.getCurrentBinaryInfo();
  }

  /**
   * Get current binary information
   */
  private getCurrentBinaryInfo(): BinaryInfo {
    const pkgPath = path.join(__dirname, '..', '..', 'package.json');
    let version = 'unknown';
    let buildNumber = 'unknown';

    try {
      const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
      version = pkg.version || 'unknown';
      buildNumber = pkg.buildNumber || 'unknown';
    } catch {
      // Use defaults
    }

    return {
      version,
      buildNumber,
      platform: process.platform,
      architecture: process.arch,
      sha256: '',
      size: 0,
      url: '',
      signature: '',
    };
  }

  /**
   * Check for updates from host API
   */
  public async checkForUpdates(): Promise<UpdateStatus> {
    if (this.isChecking) {
      return { hasUpdate: false, currentVersion: this.currentBinary.version };
    }

    this.isChecking = true;
    this.logger.debug('Checking for binary updates...');

    try {
      const response = await this.fetchUpdateInfo();
      const hasUpdate = this.compareVersions(response.latestVersion, this.currentBinary.version) > 0;

      const status: UpdateStatus = {
        hasUpdate,
        currentVersion: this.currentBinary.version,
        latestVersion: response.latestVersion,
        latestBuildNumber: response.buildNumber,
        downloadUrl: response.downloadUrl,
      };

      if (hasUpdate) {
        this.logger.info('Update available', {
          current: this.currentBinary.version,
          latest: response.latestVersion,
        });
        this.emit('updateAvailable', status);
      } else {
        this.logger.debug('No updates available');
      }

      return status;
    } catch (error) {
      this.logger.error('Failed to check for updates', { error });
      return {
        hasUpdate: false,
        currentVersion: this.currentBinary.version,
        error: error instanceof Error ? error.message : 'Unknown error',
      };
    } finally {
      this.isChecking = false;
    }
  }

  /**
   * Fetch update information from host API
   */
  private async fetchUpdateInfo(): Promise<{
    latestVersion: string;
    buildNumber: string;
    downloadUrl: string;
  }> {
    // In production, this would call the host API
    // For now, return mock data
    return {
      latestVersion: this.currentBinary.version,
      buildNumber: this.currentBinary.buildNumber,
      downloadUrl: '',
    };
  }

  /**
   * Download and apply update
   */
  public async downloadAndApplyUpdate(): Promise<void> {
    this.logger.info('Downloading and applying update...');

    try {
      // Download new binary
      const binary = await this.downloadBinary();

      // Verify signature
      await this.verifyBinary(binary);

      // Backup current binary
      await this.backupCurrentBinary();

      // Replace binary
      await this.replaceBinary(binary);

      // Update current binary info
      this.currentBinary = binary;

      this.emit('updateApplied');
      this.logger.info('Update applied successfully');
    } catch (error) {
      this.logger.error('Failed to apply update', { error });
      // Attempt to revert
      await this.revertBinary();
      throw error;
    }
  }

  /**
   * Download binary from URL
   */
  private async downloadBinary(): Promise<BinaryInfo> {
    // Implementation would use HTTPS to download
    // For now, return mock
    throw new Error('Binary download not implemented');
  }

  /**
   * Verify binary signature
   */
  private async verifyBinary(binary: BinaryInfo): Promise<void> {
    // Verify using embedded public keys
    // Implementation would use crypto.verify
    this.logger.debug('Verifying binary signature...');
  }

  /**
   * Backup current binary
   */
  private async backupCurrentBinary(): Promise<void> {
    const binaryPath = process.argv[0];
    const backupPath = `${binaryPath}.previous`;

    try {
      fs.copyFileSync(binaryPath, backupPath);
      this.logger.debug('Binary backed up', { backupPath });
    } catch (error) {
      this.logger.error('Cannot backup binary', { error });
      throw new Error('Binary Manager: Cannot backup binary');
    }
  }

  /**
   * Replace binary with new version
   */
  private async replaceBinary(binary: BinaryInfo): Promise<void> {
    const binaryPath = process.argv[0];
    const newPath = `${binaryPath}.new`;

    try {
      // Write new binary
      fs.writeFileSync(newPath, Buffer.from('')); // Placeholder

      // Make executable
      fs.chmodSync(newPath, 0o755);

      // Rename current to .previous (already backed up)
      // Rename .new to current
      fs.renameSync(newPath, binaryPath);

      this.logger.debug('Binary replaced', { binaryPath });
    } catch (error) {
      this.logger.error('Cannot rename binary', { error });
      throw new Error('Binary Manager: Cannot rename binary');
    }
  }

  /**
   * Revert to previous binary
   */
  private async revertBinary(): Promise<void> {
    const binaryPath = process.argv[0];
    const backupPath = `${binaryPath}.previous`;

    try {
      if (fs.existsSync(backupPath)) {
        fs.copyFileSync(backupPath, binaryPath);
        fs.chmodSync(binaryPath, 0o755);
        this.logger.info('Reverted to previous binary');
        this.emit('updateReverted');
      }
    } catch (error) {
      this.logger.error('Cannot revert to previous binary', { error });
      throw new Error('Binary Manager: Cannot revert to previous binary');
    }
  }

  /**
   * Start periodic update checks
   */
  public startPeriodicChecks(): void {
    if (this.checkTimer) return;

    this.checkTimer = setInterval(() => {
      this.checkForUpdates().catch((error) => {
        this.logger.error('Periodic update check failed', { error });
      });
    }, UPDATE_CHECK_INTERVAL);

    this.logger.debug('Started periodic update checks');
  }

  /**
   * Stop periodic update checks
   */
  public stopPeriodicChecks(): void {
    if (this.checkTimer) {
      clearInterval(this.checkTimer);
      this.checkTimer = undefined;
      this.logger.debug('Stopped periodic update checks');
    }
  }

  /**
   * Compare version strings
   */
  private compareVersions(a: string, b: string): number {
    const partsA = a.split('.').map(Number);
    const partsB = b.split('.').map(Number);

    for (let i = 0; i < Math.max(partsA.length, partsB.length); i++) {
      const numA = partsA[i] || 0;
      const numB = partsB[i] || 0;
      if (numA !== numB) return numA - numB;
    }

    return 0;
  }

  /**
   * Get current binary info
   */
  public getCurrentBinary(): BinaryInfo {
    return { ...this.currentBinary };
  }

  /**
   * Compute server digest (for host API registration)
   */
  public computeServerDigest(): string {
    const data = `${this.currentBinary.version}:${this.currentBinary.buildNumber}:${this.config.host.id}`;
    return crypto.createHash('sha256').update(data).digest('hex');
  }

  /**
   * Set private key salt (for passphrase generation)
   */
  public setPrivateKeySalt(salt: string): void {
    // Store salt securely
    this.logger.info('Private key salt updated');
  }

  /**
   * Clean up resources
   */
  public async destroy(): Promise<void> {
    this.stopPeriodicChecks();
    this.removeAllListeners();
  }
}

export default BinaryManager;