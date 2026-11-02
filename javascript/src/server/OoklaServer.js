/**
 * Main OoklaServer class - JavaScript port of the C++ OoklaServer
 * Based on reverse engineering of OoklaServer-linux-x86_64 binary
 */

const EventEmitter = require('events');
const os = require('os');
const path = require('path');
const {
  // Configuration
  // Types are documented in core.js using JSDoc
  // Errors
  ConfigurationError,
} = require('../types/core');
const { ConfigManager } = require('./ConfigManager');
const { BinaryManager } = require('./BinaryManager');
const { InstanceLocker, SHARED_MEMORY_CONFIG } = require('./InstanceLocker');
const { ClientAuthTokenValidator } = require('./ClientAuthTokenValidator');
const { ConnectionTracker } = require('./ConnectionTracker');
const { IpStatsManager } = require('./IpStatsManager');
const { MetricsUploader } = require('./MetricsUploader');
const { TLSCertificateManager } = require('./TLSCertificateManager');
const { OoklaRequestHandler } = require('./OoklaRequestHandler');
const { OoklaDownloader } = require('./OoklaDownloader');
const { Logger } = require('./Logger');
const { TracerouteManager } = require('./TracerouteManager');

class OoklaServer extends EventEmitter {
  constructor(config) {
    super();
    this.configManager = new ConfigManager(config);
    this.config = this.configManager.getConfig();

    // Initialize logger first
    this.logger = new Logger(this.configManager.getLogConfig());

    // Initialize core components
    this.binaryManager = new BinaryManager(this.config, this.logger);
    this.instanceLocker = new InstanceLocker(SHARED_MEMORY_CONFIG, this.logger);
    this.authValidator = new ClientAuthTokenValidator(this.config.clientAuthToken, this.logger);
    this.connectionTracker = new ConnectionTracker(this.logger);
    this.ipStatsManager = new IpStatsManager(this.config.ipTracking, this.logger);
    this.metricsUploader = new MetricsUploader(this.config, this.logger, this.binaryManager.getCurrentBinary());
    this.tlsManager = new TLSCertificateManager(this.config.tls || { enabled: false, certPath: '', keyPath: '' }, this.logger);
    this.requestHandler = new OoklaRequestHandler(
      this.config,
      this.logger,
      this.authValidator,
      this.connectionTracker,
      this.ipStatsManager,
      this.tlsManager
    );
    this.downloader = new OoklaDownloader(this.config, this.logger);
    this.tracerouteManager = new TracerouteManager(
      this.config.traceroute || {
        enabled: this.config.performTraceroutes,
        maxHops: 30,
        timeout: 5000,
        maxConcurrent: 10,
      },
      this.logger
    );

    this.role = 'standalone';
    this.pid = process.pid;
    this.startTime = new Date();
    this.isRunning = false;
    this.shutdownRequested = false;

    this.setupEventHandlers();
  }

  setupEventHandlers() {
    // Binary manager events
    this.binaryManager.on('updateAvailable', (update) => {
      this.emit('updateAvailable', update);
      this.logger.info('Update available', { version: update.latestVersion });
    });

    this.binaryManager.on('updateDownloaded', (binary) => {
      this.emit('updateDownloaded', binary);
      this.logger.info('Update downloaded', { version: binary.version });
    });

    this.binaryManager.on('updateApplied', () => {
      this.emit('updateApplied');
      this.logger.info('Update applied, restarting...');
      this.scheduleRestart();
    });

    // Connection tracker events
    this.connectionTracker.on('connectionCreated', (conn) => {
      this.emit('connectionCreated', conn);
    });

    this.connectionTracker.on('connectionClosed', (conn) => {
      this.emit('connectionClosed', conn);
    });

    // IP stats events
    this.ipStatsManager.on('ipBlocked', (ip, reason) => {
      this.emit('ipBlocked', ip, reason);
      this.logger.warning('IP blocked', { ip, reason });
    });

    // Metrics events
    this.metricsUploader.on('metricsUploaded', (metrics) => {
      this.emit('metricsUploaded', metrics);
    });

    this.metricsUploader.on('metricsUploadFailed', (error) => {
      this.emit('metricsUploadFailed', error);
      this.logger.error('Metrics upload failed', { error: error.message });
    });

    // TLS events
    this.tlsManager.on('certificateRenewed', () => {
      this.emit('certificateRenewed');
      this.logger.info('TLS certificate renewed');
    });

    // Traceroute events
    this.tracerouteManager.on('traceCompleted', (data) => {
      this.emit('tracerouteCompleted', data);
    });
  }

  /**
   * Start the server
   */
  async start(role = 'standalone') {
    if (this.isRunning) {
      throw new ConfigurationError('Server is already running');
    }

    this.role = role;
    this.logger.info(`Starting OoklaServer in ${role} mode`, { pid: this.pid });

    try {
      // Acquire instance lock
      await this.instanceLocker.acquire(role);

      // Initialize TLS certificates
      await this.tlsManager.initialize();

      // Start IP stats manager
      await this.ipStatsManager.start();

      // Start metrics uploader
      await this.metricsUploader.start();

      // Start traceroute manager
      await this.tracerouteManager.start();

      // Check for updates (if manager role)
      if (role === 'manager') {
        await this.binaryManager.checkForUpdates();
      }

      // Start HTTP server
      await this.requestHandler.start();

      this.isRunning = true;
      this.emit('started');
      this.logger.info('OoklaServer started successfully');

    } catch (error) {
      this.logger.error('Failed to start server', { error });
      await this.stop();
      throw error;
    }
  }

  /**
   * Stop the server gracefully
   */
  async stop() {
    if (!this.isRunning && !this.shutdownRequested) {
      return;
    }

    this.shutdownRequested = true;
    this.logger.info('Shutting down OoklaServer...');

    try {
      // Stop accepting new connections
      await this.requestHandler.stop();

      // Wait for active connections to complete (with timeout)
      await this.connectionTracker.waitForConnections(30000);

      // Stop background services
      await this.tracerouteManager.stop();
      await this.metricsUploader.stop();
      await this.ipStatsManager.stop();
      await this.tlsManager.stop();

      // Release instance lock
      await this.instanceLocker.release();

      this.isRunning = false;
      this.emit('stopped');
      this.logger.info('OoklaServer stopped');

    } catch (error) {
      this.logger.error('Error during shutdown', { error });
      throw error;
    }
  }

  /**
   * Force stop the server immediately
   */
  async forceStop() {
    this.shutdownRequested = true;
    this.logger.warning('Force stopping OoklaServer...');

    await this.requestHandler.forceStop();
    await this.connectionTracker.closeAllConnections();
    await this.instanceLocker.release();

    this.isRunning = false;
    this.emit('forceStopped');
  }

  /**
   * Schedule a restart (for updates)
   */
  scheduleRestart() {
    setTimeout(() => {
      this.emit('restart');
      // In a real implementation, this would trigger a process restart
    }, 1000);
  }

  /**
   * Validate client authentication token
   */
  validateToken(token, clientIp, clientGuid) {
    return this.authValidator.validate(token, clientIp, clientGuid);
  }

  /**
   * Create a new server token
   */
  createToken(expiration, ip, guid, additionalFields) {
    return this.authValidator.createToken(expiration, ip, guid, additionalFields);
  }

  /**
   * Get connection info
   */
  getConnection(connectionId) {
    return this.connectionTracker.getConnection(connectionId);
  }

  /**
   * Get all active connections
   */
  getAllConnections() {
    return this.connectionTracker.getAllConnections();
  }

  /**
   * Get IP stats for an IP
   */
  getIpStats(ip) {
    return this.ipStatsManager.getIpStats(ip);
  }

  /**
   * Block an IP address
   */
  blockIp(ip, reason) {
    this.ipStatsManager.blockIp(ip, reason);
  }

  /**
   * Unblock an IP address
   */
  unblockIp(ip) {
    this.ipStatsManager.unblockIp(ip);
  }

  /**
   * Get current server metrics
   */
  getMetrics() {
    return this.metricsUploader.collectMetrics();
  }

  /**
   * Force metrics upload
   */
  async uploadMetrics() {
    await this.metricsUploader.uploadNow();
  }

  /**
   * Initiate a traceroute
   */
  async startTraceroute(request) {
    return this.tracerouteManager.trace(request.targetIp, {
      maxHops: request.maxHops,
      timeout: request.timeout,
    });
  }

  /**
   * Check for binary updates
   */
  async checkForUpdates() {
    return this.binaryManager.checkForUpdates();
  }

  /**
   * Download and apply update
   */
  async applyUpdate() {
    await this.binaryManager.downloadAndApplyUpdate();
  }

  /**
   * Get server configuration
   */
  getConfig() {
    return this.config;
  }

  /**
   * Update server configuration (runtime)
   */
  updateConfig(updates) {
    this.configManager.updateConfig(updates);
    this.config = this.configManager.getConfig();

    // Propagate config changes to components
    this.ipStatsManager.updateConfig(this.config.ipTracking);
    this.authValidator.updateConfig(this.config.clientAuthToken);
    this.requestHandler.updateConfig(this.config);

    this.emit('configUpdated', this.config);
    this.logger.info('Configuration updated');
  }

  /**
   * Get server info
   */
  getServerInfo() {
    return {
      role: this.role,
      pid: this.pid,
      startTime: this.startTime,
      isHealthy: this.isRunning && !this.shutdownRequested,
    };
  }

  /**
   * Get system information
   */
  getSystemInfo() {
    // This would be implemented with actual system calls
    return {
      cpuModelName: 'Unknown',
      loadAverage: 0,
      runningProcesses: 0,
      totalProcesses: 0,
      cpus: os.cpus().length,
      fdSize: 0,
      numThreads: 0,
      vmSize: 0,
      vmRss: 0,
      networkInterfaces: [],
      tcpCongestionControl: 'cubic',
      availableCongestionControl: ['cubic', 'reno'],
      tcpWindowScaling: true,
    };
  }

  /**
   * Generate download test file
   */
  generateDownloadFile(width, height) {
    const size = width * height * 3; // Approximate JPEG size
    const data = Buffer.alloc(size);
    // Fill with random data (simplified)
    for (let i = 0; i < size; i++) {
      data[i] = Math.floor(Math.random() * 256);
    }
    return { width, height, size, data };
  }

  /**
   * Get cross-domain policy
   */
  getCrossDomainPolicy() {
    return {
      domains: this.config.allowedDomains,
      ports: ['5060', '8080', '80', '443'],
    };
  }

  /**
   * Check if server is running
   */
  isServerRunning() {
    return this.isRunning && !this.shutdownRequested;
  }

  /**
   * Get uptime in seconds
   */
  getUptime() {
    return Math.floor((Date.now() - this.startTime.getTime()) / 1000);
  }

  /**
   * Log a message
   */
  log(level, message, metadata) {
    this.logger.log(level, message, metadata);
  }
}

module.exports = { OoklaServer };