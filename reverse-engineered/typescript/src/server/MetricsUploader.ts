/**
 * Metrics Uploader - Collects and uploads server metrics to host API
 * Based on reverse engineering of OoklaServer MetricsUploader.cpp
 */

import { EventEmitter } from 'events';
import { OoklaServerConfig, ServerMetrics, BinaryInfo } from '../types/core';
import { Logger } from './Logger';

const HOST_API_URL = 'https://host-api.speedtest.net';
const METRICS_UPLOAD_INTERVAL = 60 * 1000; // 1 minute
const METRICS_RETENTION_MS = 24 * 60 * 60 * 1000; // 24 hours

export class MetricsUploader extends EventEmitter {
  private config: OoklaServerConfig;
  private logger: Logger;
  private uploadTimer?: NodeJS.Timeout;
  private isUploading: boolean = false;
  private metricsBuffer: ServerMetrics[] = [];
  private lastUploadTime: number = 0;
  private binaryInfo: BinaryInfo;

  constructor(config: OoklaServerConfig, logger: Logger, binaryInfo: BinaryInfo) {
    super();
    this.config = config;
    this.logger = logger;
    this.binaryInfo = binaryInfo;
  }

  /**
   * Start periodic metrics upload
   */
  public start(): void {
    if (this.uploadTimer) return;

    this.uploadTimer = setInterval(() => {
      this.uploadMetrics().catch((error) => {
        this.logger.error('Periodic metrics upload failed', { error });
      });
    }, METRICS_UPLOAD_INTERVAL);

    this.logger.debug('Metrics uploader started');
    this.emit('started');
  }

  /**
   * Stop periodic metrics upload
   */
  public stop(): void {
    if (this.uploadTimer) {
      clearInterval(this.uploadTimer);
      this.uploadTimer = undefined;
      this.logger.debug('Metrics uploader stopped');
      this.emit('stopped');
    }
  }

  /**
   * Record metrics snapshot
   */
  public recordMetrics(metrics: ServerMetrics): void {
    metrics.timestamp = new Date();
    this.metricsBuffer.push(metrics);

    // Keep buffer size manageable
    if (this.metricsBuffer.length > 1000) {
      this.metricsBuffer = this.metricsBuffer.slice(-500);
    }

    // Clean old metrics
    const cutoff = Date.now() - METRICS_RETENTION_MS;
    this.metricsBuffer = this.metricsBuffer.filter(m => m.timestamp.getTime() > cutoff);
  }

  /**
   * Force immediate metrics upload
   */
  public async forceUpload(): Promise<void> {
    await this.uploadMetrics();
  }

  /**
   * Upload metrics to host API
   */
  private async uploadMetrics(): Promise<void> {
    if (this.isUploading || this.metricsBuffer.length === 0) {
      return;
    }

    this.isUploading = true;
    const metricsToUpload = [...this.metricsBuffer];
    this.metricsBuffer = [];

    try {
      const _payload = this.buildPayload(metricsToUpload);

      // In production, this would POST to the host API
      // await this.postToHostApi(payload);

      this.logger.debug('Metrics uploaded', {
        count: metricsToUpload.length,
        hostId: this.config.host.id
      });

      this.lastUploadTime = Date.now();
      this.emit('uploaded', { count: metricsToUpload.length });

    } catch (error) {
      this.logger.error('Failed to upload metrics', { error });
      // Re-add metrics to buffer for retry
      this.metricsBuffer.unshift(...metricsToUpload);
      this.emit('uploadFailed', { error });
    } finally {
      this.isUploading = false;
    }
  }

  /**
   * Build payload for host API
   */
  private buildPayload(metrics: ServerMetrics[]): object {
    const latest = metrics[metrics.length - 1];

    return {
      server: {
        id: this.config.host.id,
        version: this.binaryInfo.version,
        build: this.binaryInfo.buildNumber,
        platform: this.binaryInfo.platform,
        arch: this.binaryInfo.architecture,
      },
      metrics: metrics.map(m => ({
        timestamp: m.timestamp.getTime(),
        connections: m.connections,
        bandwidth: m.bandwidth,
        latency: m.latency,
        tests: m.tests,
        errors: m.errors,
      })),
      system: {
        cpu: latest.system?.cpu,
        memory: latest.system?.memory,
        network: latest.system?.network,
        uptime: process.uptime(),
      },
    };
  }

  /**
   * Post metrics to host API (placeholder)
   */
  private async postToHostApi(payload: object): Promise<void> {
    // Implementation would use fetch/axios to POST to HOST_API_URL
    // For now, simulate success
    this.logger.debug('Would post metrics to host API', {
      url: `${HOST_API_URL}/metrics`,
      payloadSize: JSON.stringify(payload).length
    });
  }

  /**
   * Get upload status
   */
  public getStatus(): {
    isRunning: boolean;
    isUploading: boolean;
    bufferSize: number;
    lastUploadTime: number;
    nextUploadIn: number;
  } {
    return {
      isRunning: !!this.uploadTimer,
      isUploading: this.isUploading,
      bufferSize: this.metricsBuffer.length,
      lastUploadTime: this.lastUploadTime,
      nextUploadIn: this.uploadTimer ? METRICS_UPLOAD_INTERVAL - (Date.now() - this.lastUploadTime) : 0,
    };
  }

  /**
   * Update configuration
   */
  public updateConfig(config: Partial<OoklaServerConfig>): void {
    this.config = { ...this.config, ...config };
    this.logger.debug('MetricsUploader config updated');
  }

  /**
   * Update binary info
   */
  public updateBinaryInfo(binaryInfo: BinaryInfo): void {
    this.binaryInfo = binaryInfo;
  }

  /**
   * Collect current metrics
   */
  public collectMetrics(): ServerMetrics {
    // Return the latest metrics or create a new one
    if (this.metricsBuffer.length > 0) {
      return this.metricsBuffer[this.metricsBuffer.length - 1];
    }
    // Return empty metrics
    return {
      uniqueTests: 0,
      unidentifiedTests: 0,
      sentBytes: 0,
      receivedBytes: 0,
      sentBytesTotal: 0,
      receivedBytesTotal: 0,
      congestionControl: 'cubic',
      availableCongestionControl: ['cubic', 'reno'],
      windowScaling: true,
      numFiles: 0,
      disabled: 0,
      established: 0,
      blocked: 0,
      connectionSeconds: 0,
      maxConcurrent: 0,
      listeningAddresses: [],
      exceededMaxDuration: 0,
      cpuModelName: '',
      loadAverage10Mins: 0,
      runningProcesses: 0,
      totalProcesses: 0,
      cpus: 0,
      fdSize: 0,
      numThreads: 0,
      vmSize: 0,
      vmRss: 0,
      timestamp: new Date(),
    };
  }

  /**
   * Upload metrics now
   */
  public async uploadNow(): Promise<void> {
    await this.forceUpload();
  }

  /**
   * Clean up resources
   */
  public destroy(): void {
    this.stop();
    this.metricsBuffer = [];
    this.removeAllListeners();
  }
}

export default MetricsUploader;