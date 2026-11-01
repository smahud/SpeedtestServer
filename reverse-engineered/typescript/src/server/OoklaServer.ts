/**
 * Main OoklaServer class - TypeScript port of the C++ OoklaServer
 * Based on reverse engineering of OoklaServer-linux-x86_64 binary
 */

import { EventEmitter } from 'events';
import {
  OoklaServerConfig,
  ServerToken,
  ClientAuthTokenValidationResult,
  TokenValidationFields,
  ConnectionInfo,
  ClientSessionContext,
  UploadStatsRecorder,
  IpStatsEntry,
  IpStatsConfig,
  ServerMetrics,
  MetricsUploadConfig,
  LogConfig,
  LogEntry,
  LogLevel,
  OoklaRequest,
  OoklaResponse,
  CrossDomainPolicy,
  DownloadTestFile,
  DEFAULT_DOWNLOAD_SIZES,
  BinaryInfo,
  UpdateStatus,
  TracerouteRequest,
  TracerouteResult,
  ProcessRole,
  ProcessInfo,
  SharedMemoryConfig,
  SystemInfo,
  NetworkInterface,
  OoklaServerError,
  AuthenticationError,
  RateLimitError,
  BinaryUpdateError,
  ConfigurationError,
  DeepPartial,
} from '../types/core';

import { ConfigManager } from './ConfigManager';
import { BinaryManager } from './BinaryManager';
import { InstanceLocker } from './InstanceLocker';
import { ClientAuthTokenValidator } from './ClientAuthTokenValidator';
import { ConnectionTracker } from './ConnectionTracker';
import { IpStatsManager } from './IpStatsManager';
import { MetricsUploader } from './MetricsUploader';
import { TLSCertificateManager } from './TLSCertificateManager';
import { OoklaRequestHandler } from './OoklaRequestHandler';
import { OoklaDownloader } from './OoklaDownloader';
import { Logger } from './Logger';
import { TracerouteManager } from './TracerouteManager';

export class OoklaServer extends EventEmitter {
  private config: OoklaServerConfig;
  private configManager: ConfigManager;
  private binaryManager: BinaryManager;
  private instanceLocker: InstanceLocker;
  private authValidator: ClientAuthTokenValidator;
  private connectionTracker: ConnectionTracker;
  private ipStatsManager: IpStatsManager;
  private metricsUploader: MetricsUploader;
  private tlsManager: TLSCertificateManager;
  private requestHandler: OoklaRequestHandler;
  private downloader: OoklaDownloader;
  private logger: Logger;
  private tracerouteManager: TracerouteManager;

  private role: ProcessRole = 'standalone';
  private pid: number = process.pid;
  private startTime: Date = new Date();
  private isRunning: boolean = false;
  private shutdownRequested: boolean = false;

  // Shared memory names (from binary strings)
  private static readonly SHARED_MEMORY_CONFIG: SharedMemoryConfig = {
    managerMutex: 'OoklaManMu_',
    serverMutex: 'OoklaSerMu_',
    managerShMem: 'OoklaShMemMan_',
    serverShMem: 'OoklaShMemSer_',
    managerShMemMutex: 'OoklaShMemManMu_',
    serverShMemMutex: 'OoklaShMemSerMu_',
  };

  constructor(config?: DeepPartial<OoklaServerConfig>) {
    super();
    this.configManager = new ConfigManager(config);
    this.config = this.configManager.getConfig();

    // Initialize logger first
    this.logger = new Logger(this.configManager.getLogConfig());

    // Initialize core components
    this.binaryManager = new BinaryManager(this.config, this.logger);
    this.instanceLocker = new InstanceLocker(OoklaServer.SHARED_MEMORY_CONFIG, this.logger);
    this.authValidator = new ClientAuthTokenValidator(this.config.clientAuthToken, this.logger);
    this.connectionTracker = new ConnectionTracker(this.logger);
    this.ipStatsManager = new IpStatsManager(this.config.ipTracking, this.logger);
    this.metricsUploader = new MetricsUploader(this.getMetricsUploadConfig(), this.logger);
    this.tlsManager = new TLSCertificateManager(this.config, this.logger);
    this.requestHandler = new OoklaRequestHandler(this, this.logger);
    this.downloader = new OoklaDownloader(this.config, this.logger);
    this.tracerouteManager = new TracerouteManager(this.config, this.logger);

    this.setupEventHandlers();
  }

  private setupEventHandlers(): void {
    // Binary manager events
    this.binaryManager.on('updateAvailable', (update: UpdateStatus) => {
      this.emit('updateAvailable', update);
      this.logger.info('Update available', { version: update.latestVersion });
    });

    this.binaryManager.on('updateDownloaded', (binary: BinaryInfo) => {
      this.emit('updateDownloaded', binary);
      this.logger.info('Update downloaded', { version: binary.version });
    });

    this.binaryManager.on('updateApplied', () => {
      this.emit('updateApplied');
      this.logger.info('Update applied, restarting...');
      this.scheduleRestart();
    });

    // Connection tracker events
    this.connectionTracker.on('connectionCreated', (conn: ConnectionInfo) => {
      this.emit('connectionCreated', conn);
    });

    this.connectionTracker.on('connectionClosed', (conn: ConnectionInfo) => {
      this.emit('connectionClosed', conn);
    });

    // IP stats events
    this.ipStatsManager.on('ipBlocked', (ip: string, reason: string) => {
      this.emit('ipBlocked', ip, reason);
      this.logger.warning('IP blocked', { ip, reason });
    });

    // Metrics events
    this.metricsUploader.on('metricsUploaded', (metrics: ServerMetrics) => {
      this.emit('metricsUploaded', metrics);
    });

    this.metricsUploader.on('metricsUploadFailed', (error: Error) => {
      this.emit('metricsUploadFailed', error);
      this.logger.error('Metrics upload failed', { error: error.message });
    });

    // TLS events
    this.tlsManager.on('certificateRenewed', () => {
      this.emit('certificateRenewed');
      this.logger.info('TLS certificate renewed');
    });

    // Traceroute events
    this.tracerouteManager.on('tracerouteCompleted', (result: TracerouteResult) => {
      this.emit('tracerouteCompleted', result);
    });
  }

  /**
   * Start the server
   */
  public async start(role: ProcessRole = 'standalone'): Promise<void> {
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
  public async stop(): Promise<void> {
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
  public async forceStop(): Promise<void> {
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
  private scheduleRestart(): void {
    setTimeout(() => {
      this.emit('restart');
      // In a real implementation, this would trigger a process restart
    }, 1000);
  }

  /**
   * Validate client authentication token
   */
  public validateToken(token: string, clientIp: string, clientGuid: string): ClientAuthTokenValidationResult {
    return this.authValidator.validate(token, clientIp, clientGuid);
  }

  /**
   * Create a new server token
   */
  public createToken(expiration: number, ip?: string, guid?: string, additionalFields?: TokenValidationFields): ServerToken {
    return this.authValidator.createToken(expiration, ip, guid, additionalFields);
  }

  /**
   * Get connection info
   */
  public getConnection(connectionId: string): ConnectionInfo | undefined {
    return this.connectionTracker.getConnection(connectionId);
  }

  /**
   * Get all active connections
   */
  public getAllConnections(): ConnectionInfo[] {
    return this.connectionTracker.getAllConnections();
  }

  /**
   * Get IP stats for an IP
   */
  public getIpStats(ip: string): IpStatsEntry | undefined {
    return this.ipStatsManager.getIpStats(ip);
  }

  /**
   * Block an IP address
   */
  public blockIp(ip: string, reason: string, durationMs?: number): void {
    this.ipStatsManager.blockIp(ip, reason, durationMs);
  }

  /**
   * Unblock an IP address
   */
  public unblockIp(ip: string): void {
    this.ipStatsManager.unblockIp(ip);
  }

  /**
   * Get current server metrics
   */
  public getMetrics(): ServerMetrics {
    return this.metricsUploader.collectMetrics();
  }

  /**
   * Force metrics upload
   */
  public async uploadMetrics(): Promise<void> {
    await this.metricsUploader.uploadNow();
  }

  /**
   * Initiate a traceroute
   */
  public async startTraceroute(request: TracerouteRequest): Promise<TracerouteResult> {
    return this.tracerouteManager.startTraceroute(request);
  }

  /**
   * Check for binary updates
   */
  public async checkForUpdates(): Promise<UpdateStatus> {
    return this.binaryManager.checkForUpdates();
  }

  /**
   * Download and apply update
   */
  public async applyUpdate(): Promise<void> {
    await this.binaryManager.downloadAndApplyUpdate();
  }

  /**
   * Get server configuration
   */
  public getConfig(): Readonly<OoklaServerConfig> {
    return this.config;
  }

  /**
   * Update server configuration (runtime)
   */
  public updateConfig(updates: DeepPartial<OoklaServerConfig>): void {
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
  public getServerInfo(): ProcessInfo {
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
  public getSystemInfo(): SystemInfo {
    // This would be implemented with actual system calls
    return {
      cpuModelName: 'Unknown',
      loadAverage: 0,
      runningProcesses: 0,
      totalProcesses: 0,
      cpus: require('os').cpus().length,
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
  public generateDownloadFile(width: number, height: number): DownloadTestFile {
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
  public getCrossDomainPolicy(): CrossDomainPolicy {
    return {
      domains: this.config.allowedDomains,
      ports: ['5060', '8080', '80', '443'],
    };
  }

  /**
   * Check if server is running
   */
  public isServerRunning(): boolean {
    return this.isRunning && !this.shutdownRequested;
  }

  /**
   * Get uptime in seconds
   */
  public getUptime(): number {
    return Math.floor((Date.now() - this.startTime.getTime()) / 1000);
  }

  /**
   * Log a message
   */
  public log(level: LogLevel, message: string, metadata?: Record<string, unknown>): void {
    this.logger.log(level, message, metadata);
  }
}

export default OoklaServer;