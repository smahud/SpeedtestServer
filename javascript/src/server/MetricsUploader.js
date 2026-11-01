/**
 * Metrics Uploader - Collects and uploads server metrics to host API
 * Based on reverse engineering of OoklaServer MetricsUploader.cpp
 * JavaScript implementation
 */

const EventEmitter = require('events');

const HOST_API_URL = 'https://host-api.speedtest.net';
const METRICS_UPLOAD_INTERVAL = 60 * 1000; // 1 minute
const METRICS_RETENTION_MS = 24 * 60 * 60 * 1000; // 24 hours

class MetricsUploader extends EventEmitter {
  constructor(config, logger, binaryInfo) {
    super();
    this.config = config;
    this.logger = logger;
    this.uploadTimer = null;
    this.isUploading = false;
    this.metricsBuffer = [];
    this.lastUploadTime = 0;
    this.binaryInfo = binaryInfo;
  }

  start() {
    if (this.uploadTimer) return;

    this.uploadTimer = setInterval(() => {
      this.uploadMetrics().catch((error) => {
        this.logger.error('Periodic metrics upload failed', { error });
      });
    }, METRICS_UPLOAD_INTERVAL);

    this.logger.debug('Metrics uploader started');
    this.emit('started');
  }

  stop() {
    if (this.uploadTimer) {
      clearInterval(this.uploadTimer);
      this.uploadTimer = null;
      this.logger.debug('Metrics uploader stopped');
      this.emit('stopped');
    }
  }

  recordMetrics(metrics) {
    metrics.timestamp = new Date();
    this.metricsBuffer.push(metrics);

    if (this.metricsBuffer.length > 1000) {
      this.metricsBuffer = this.metricsBuffer.slice(-500);
    }

    const cutoff = Date.now() - METRICS_RETENTION_MS;
    this.metricsBuffer = this.metricsBuffer.filter(m => m.timestamp.getTime() > cutoff);
  }

  async forceUpload() {
    await this.uploadMetrics();
  }

  async uploadMetrics() {
    if (this.isUploading || this.metricsBuffer.length === 0) {
      return;
    }

    this.isUploading = true;
    const metricsToUpload = [...this.metricsBuffer];
    this.metricsBuffer = [];

    try {
      const payload = this.buildPayload(metricsToUpload);

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
      this.metricsBuffer.unshift(...metricsToUpload);
      this.emit('uploadFailed', { error });
    } finally {
      this.isUploading = false;
    }
  }

  buildPayload(metrics) {
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

  async postToHostApi(payload) {
    this.logger.debug('Would post metrics to host API', {
      url: `${HOST_API_URL}/metrics`,
      payloadSize: JSON.stringify(payload).length
    });
  }

  getStatus() {
    return {
      isRunning: !!this.uploadTimer,
      isUploading: this.isUploading,
      bufferSize: this.metricsBuffer.length,
      lastUploadTime: this.lastUploadTime,
      nextUploadIn: this.uploadTimer ? METRICS_UPLOAD_INTERVAL - (Date.now() - this.lastUploadTime) : 0,
    };
  }

  updateConfig(config) {
    this.config = { ...this.config, ...config };
    this.logger.debug('MetricsUploader config updated');
  }

  updateBinaryInfo(binaryInfo) {
    this.binaryInfo = binaryInfo;
  }

  collectMetrics() {
    if (this.metricsBuffer.length > 0) {
      return this.metricsBuffer[this.metricsBuffer.length - 1];
    }
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

  async uploadNow() {
    await this.forceUpload();
  }

  destroy() {
    this.stop();
    this.metricsBuffer = [];
    this.removeAllListeners();
  }
}

module.exports = { MetricsUploader };
