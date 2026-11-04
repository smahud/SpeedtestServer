/**
 * Core TypeScript types for OoklaServer reverse engineering
 * Based on binary analysis of OoklaServer-linux-x86_64
 */

// ============================================================================
// Configuration Types
// ============================================================================

export interface OoklaServerConfig {
  clientAuthToken: ClientAuthTokenConfig;
  excludeDefaultDomains: boolean;
  workerThreadPool: WorkerThreadPoolConfig;
  ipTracking: IpTrackingConfig;
  maxConnectionSeconds: number;
  http: HttpConfig;
  allowedDomains: string[];
  tcpPorts: number[];
  udpPorts: number[];
  httpPorts: number[];
  /** NetGauge/HTTP version banner (compatibility profile). */
  netgaugeVersionString: string;
  /** Optional JSONL evidence log path (connections, commands, byte counters). */
  evidenceLogFile: string;
  useIPv6: boolean;
  addresses: string[];
  useIPv4: boolean;
  host: HostConfig;
  userAgentFilterEnabled: boolean;
  performTraceroutes: boolean;
  binaryAutoUpdate?: boolean;
  sharedMemory?: SharedMemoryConfig;
  tls?: TLSCertificateConfig;
  traceroute?: TracerouteConfig;
  ssl?: SSLConfig;
  websocket?: WebSocketConfig;
  update?: UpdateConfig;
  api?: ApiConfig;
  resultEndpointUrl?: string;
  sendStatsInterval?: number;
  hostApiUrl?: string;
  apiUrl?: string;
  enableAutoUpdate?: boolean;
  updateRequestInitialInterval?: number;
}

export interface ClientAuthTokenConfig {
  additionalValidationFields: string[];
  denyInvalid: boolean;
}

export interface WorkerThreadPoolConfig {
  capacity: number;
  stackSizeBytes: number;
}

export interface IpTrackingConfig {
  maxConnPerIp: number;
  gcIntervalMinutes: number;
  maxIdleAgeMinutes: number;
  slidingWindowBucketLengthMinutes: number;
  metricTopIpCount: number;
  maxConnPerBucketPerIp: number;
}

export interface HttpConfig {
  maxHeadersSize: number;
}

export interface HostConfig {
  id: string;
  password?: string;
}

export interface SSLConfig {
  letsEncryptRetry?: number;
  letsEncryptMaxRetry?: number;
  certificateFile?: string;
  privateKeyFile?: string;
  verificationMode?: string;
  minimumTLSProtocol?: string;
  caFile?: string;
}

export interface WebSocketConfig {
  frameSizeLimitBytes?: number;
}

export interface UpdateConfig {
  enabled?: boolean;
  requestInitialInterval?: number;
}

export interface ApiConfig {
  url?: string;
  hostUrl?: string;
}

// ============================================================================
// Authentication & Token Types
// ============================================================================

export interface ServerToken {
  token: string;
  expiration: number; // Unix timestamp
  ip?: string;
  guid?: string;
  additionalFields: Record<string, unknown>;
}

export interface ClientAuthTokenValidationResult {
  isValid: boolean;
  reason?: string;
  fields?: Record<string, unknown>;
}

export interface TokenValidationFields {
  deviceId?: string;
  model?: string;
  guid?: string;
  isValid?: boolean;
  'ip-strict'?: boolean;
  [key: string]: unknown;
}

// ============================================================================
// Connection & Session Types
// ============================================================================

export interface ConnectionInfo {
  id: string;
  remoteIp: string;
  remotePort: number;
  localIp: string;
  localPort: number;
  protocol: 'tcp' | 'udp' | 'websocket';
  connectedAt: Date;
  lastActivity: Date;
  bytesSent: number;
  bytesReceived: number;
  isExpired: boolean;
  guid?: string;
  token?: ServerToken;
}

export interface ClientSessionContext {
  connectionId: string;
  guid: string;
  token: ServerToken;
  ipAddress: string;
  userAgent: string;
  startTime: Date;
  testType: 'download' | 'upload' | 'latency' | 'traceroute';
  metadata: Record<string, unknown>;
}

export interface UploadStatsRecorder {
  connectionId: string;
  sentBytes: number;
  receivedBytes: number;
  sentBytesTotal: number;
  receivedBytesTotal: number;
  testDurationMs: number;
  congestionControl: string;
  windowScaling: boolean;
  startTime: Date;
  endTime?: Date;
}

// ============================================================================
// IP Statistics Types
// ============================================================================

export interface IpStatsEntry {
  ip: string;
  connections: IpConnectionStats;
  blocked: boolean;
  blockedUntil?: Date;
  firstSeen: Date;
  lastSeen: Date;
  totalConnections: number;
}

export interface IpConnectionStats {
  current: number;
  queued: number;
  blocked: number;
  queueFull: number;
  concurrent: number;
  currentThreads: number;
  uptime: number; // seconds
  totalCurrent: number;
  totalQueued: number;
  totalBlocked: number;
  totalQueueFull: number;
  totalConcurrent: number;
  totalCurrentThreads: number;
}

export interface IpStatsConfig {
  maxConnPerIp: number;
  gcIntervalMinutes: number;
  maxIdleAgeMinutes: number;
  slidingWindowBucketLengthMinutes: number;
  metricTopIpCount: number;
  maxConnPerBucketPerIp: number;
}

export interface IpStats {
  entries: IpStatsEntry[];
  totalIps: number;
  blockedIps: number;
}

export interface IpBucket {
  ip: string;
  count: number;
  timestamp: number;
}

// Internal types for IpStatsManager
export interface IpStatsInternal {
  ip: string;
  totalConnections: number;
  bytesSent: number;
  bytesReceived: number;
  buckets: Map<number, IpBucketInternal>;
  lastActivity: number;
  createdAt: number;
  isBlocked: boolean;
  blockReason?: string;
}

export interface IpBucketInternal {
  index: number;
  count: number;
  startTime: number;
}

// ============================================================================
// Metrics Types
// ============================================================================

export interface ServerMetrics {
  uniqueTests: number;
  unidentifiedTests: number;
  sentBytes: number;
  receivedBytes: number;
  sentBytesTotal: number;
  receivedBytesTotal: number;
  congestionControl: string;
  availableCongestionControl: string[];
  windowScaling: boolean;
  numFiles: number;
  disabled: number;
  established: number;
  blocked: number;
  connectionSeconds: number;
  maxConcurrent: number;
  listeningAddresses: string[];
  exceededMaxDuration: number;
  cpuModelName: string;
  loadAverage10Mins: number;
  runningProcesses: number;
  totalProcesses: number;
  cpus: number;
  fdSize: number;
  numThreads: number;
  vmSize: number;
  vmRss: number;
  timestamp: Date;
  connections?: number;
  bandwidth?: {
    upload: number;
    download: number;
  };
  latency?: {
    min: number;
    max: number;
    avg: number;
  };
  tests?: {
    total: number;
    completed: number;
    failed: number;
  };
  errors?: number;
  system?: {
    cpu: number;
    memory: number;
    network: number;
  };
}

export interface MetricsUploadConfig {
  url: string;
  intervalMinutes: number;
  enabled: boolean;
}

// ============================================================================
// Logging Types
// ============================================================================

export type LogLevel = 'fatal' | 'critical' | 'error' | 'warning' | 'notice' | 'information' | 'debug' | 'trace';

export interface LogEntry {
  level: LogLevel;
  timestamp: Date;
  message: string;
  logger: string;
  threadId?: number;
  processId?: number;
  metadata?: Record<string, unknown>;
}

export interface LogConfig {
  loggers: Record<string, LoggerConfig>;
  defaultLevel: LogLevel;
  pattern: string;
}

export interface LoggerConfig {
  name: string;
  level: LogLevel;
  channel: ChannelConfig;
}

export interface ChannelConfig {
  class: 'ConsoleChannel' | 'FileChannel' | 'LevelChannel' | 'LogJsonFormatter' | 'LogstashChannel' | 'JSONChannel' | 'SyslogChannel' | 'EventLogChannel';
  pattern?: string;
  rotation?: RotationConfig;
  path?: string;
  archive?: string;
  compress?: boolean;
  purgeCount?: number;
  maxSize?: number;
  maxFiles?: number;
  channelOptions?: {
    stderr?: boolean;
    path?: string;
    maxSize?: number;
    maxFiles?: number;
  };
}

export interface RotationConfig {
  type: 'timestamp' | 'size';
  interval?: string;
  maxSize?: string;
}

export interface LogChannel {
  name: string;
  level: LogLevel;
  class: string;
  channelOptions?: ChannelConfig['channelOptions'];
}

// ============================================================================
// HTTP Request/Response Types
// ============================================================================

export interface OoklaRequest {
  method: 'GET' | 'POST' | 'HEAD' | 'OPTIONS';
  path: string;
  headers: Record<string, string>;
  query: Record<string, string>;
  body?: Buffer | string;
  remoteIp: string;
  remotePort: number;
  userAgent: string;
  token?: ServerToken;
}

export interface OoklaResponse {
  statusCode: number;
  headers: Record<string, string>;
  body: Buffer | string;
  contentType: string;
}

export interface CrossDomainPolicy {
  domains: string[];
  ports: string[];
}

// ============================================================================
// Download Test Types
// ============================================================================

export interface DownloadTestFile {
  width: number;
  height: number;
  size: number;
  data: Buffer;
}

export const DEFAULT_DOWNLOAD_SIZES: DownloadTestFile[] = [
  { width: 250, height: 250, size: 0, data: Buffer.alloc(0) },
  { width: 350, height: 350, size: 0, data: Buffer.alloc(0) },
  { width: 500, height: 500, size: 0, data: Buffer.alloc(0) },
  { width: 750, height: 750, size: 0, data: Buffer.alloc(0) },
  { width: 1000, height: 1000, size: 0, data: Buffer.alloc(0) },
  { width: 1500, height: 1500, size: 0, data: Buffer.alloc(0) },
  { width: 2000, height: 2000, size: 0, data: Buffer.alloc(0) },
  { width: 2500, height: 2500, size: 0, data: Buffer.alloc(0) },
  { width: 3000, height: 3000, size: 0, data: Buffer.alloc(0) },
  { width: 3500, height: 3500, size: 0, data: Buffer.alloc(0) },
  { width: 4000, height: 4000, size: 0, data: Buffer.alloc(0) },
  { width: 5000, height: 5000, size: 0, data: Buffer.alloc(0) },
  { width: 6000, height: 6000, size: 0, data: Buffer.alloc(0) },
  { width: 7000, height: 7000, size: 0, data: Buffer.alloc(0) },
];

// ============================================================================
// Binary Update Types
// ============================================================================

export interface BinaryInfo {
  version: string;
  buildNumber: string;
  platform: string;
  architecture: string;
  sha256: string;
  size: number;
  url: string;
  signature: string;
}

export interface UpdateStatus {
  hasUpdate: boolean;
  currentVersion: string;
  latestVersion?: string;
  latestBuildNumber?: string;
  downloadUrl?: string;
  error?: string;
}

// ============================================================================
// Traceroute Types
// ============================================================================

export interface TracerouteRequest {
  guid: string;
  targetIp: string;
  maxHops?: number;
  timeout?: number;
}

export interface TracerouteResult {
  guid: string;
  targetIp: string;
  hops: TracerouteHop[];
  completed: boolean;
  error?: string;
  startTime: Date;
  endTime?: Date;
  durationMs?: number;
  timestamp?: number;
}

export interface TracerouteHop {
  hop: number;
  ip?: string;
  hostname?: string;
  rttMs?: number;
  rtt?: number;
  timeout: boolean;
}

export interface TracerouteConfig {
  enabled: boolean;
  maxHops: number;
  timeout: number;
  timeoutMs?: number;
  maxConcurrent: number;
  protocol?: 'icmp' | 'udp' | 'tcp';
}

// ============================================================================
// Process Management Types
// ============================================================================

export type ProcessRole = 'manager' | 'ward' | 'standalone';

export interface ProcessInfo {
  role: ProcessRole;
  pid: number;
  parentPid?: number;
  startTime: Date;
  isHealthy: boolean;
  wards?: ProcessInfo[];
}

export interface SharedMemoryConfig {
  managerMutex: string;
  serverMutex: string;
  managerShMem: string;
  serverShMem: string;
  managerShMemMutex: string;
  serverShMemMutex: string;
}

// ============================================================================
// TLS Certificate Types
// ============================================================================

export interface TLSCertificateConfig {
  enabled: boolean;
  certPath?: string;
  keyPath?: string;
  caPath?: string;
  autoGenerate?: boolean;
  acme?: {
    enabled: boolean;
    // Ookla Host API settings for Let's Encrypt
    hostApiUrl?: string;
    serverId?: string;
    serverPassword?: string;
    domains?: string[];
    // Legacy ACME settings (for direct ACME integration)
    email?: string;
    staging?: boolean;
  };
  publicKey?: string;
  // Custom certificate file paths (from SSL config / openSSL.server.* properties)
  certificateFile?: string;
  privateKeyFile?: string;
  caFile?: string;
}

export interface TLSCertificateInfo {
  subject: string;
  issuer: string;
  validFrom: Date;
  validTo: Date;
  fingerprint: string;
  san: string[];
  certPem?: string;
  keyPem?: string;
  caPem?: string;
  expiresAt?: number;
  daysUntilExpiry?: number;
  isSelfSigned?: boolean;
}

// ============================================================================
// System Information Types
// ============================================================================

export interface SystemInfo {
  cpuModelName: string;
  loadAverage: number;
  runningProcesses: number;
  totalProcesses: number;
  cpus: number;
  fdSize: number;
  numThreads: number;
  vmSize: number;
  vmRss: number;
  networkInterfaces: NetworkInterface[];
  tcpCongestionControl: string;
  availableCongestionControl: string[];
  tcpWindowScaling: boolean;
}

export interface NetworkInterface {
  name: string;
  address: string;
  family: 'IPv4' | 'IPv6';
  internal: boolean;
}

// ============================================================================
// Error Types
// ============================================================================

export class OoklaServerError extends Error {
  constructor(
    message: string,
    public code: string,
    public statusCode: number = 500,
    public details?: Record<string, unknown>
  ) {
    super(message);
    this.name = 'OoklaServerError';
  }
}

export class AuthenticationError extends OoklaServerError {
  constructor(message: string, details?: Record<string, unknown>) {
    super(message, 'AUTHENTICATION_FAILED', 401, details);
    this.name = 'AuthenticationError';
  }
}

export class RateLimitError extends OoklaServerError {
  constructor(message: string, public retryAfter?: number, details?: Record<string, unknown>) {
    super(message, 'RATE_LIMIT_EXCEEDED', 429, details);
    this.name = 'RateLimitError';
  }
}

export class BinaryUpdateError extends OoklaServerError {
  constructor(message: string, details?: Record<string, unknown>) {
    super(message, 'BINARY_UPDATE_FAILED', 500, details);
    this.name = 'BinaryUpdateError';
  }
}

export class ConfigurationError extends OoklaServerError {
  constructor(message: string, details?: Record<string, unknown>) {
    super(message, 'CONFIGURATION_ERROR', 500, details);
    this.name = 'ConfigurationError';
  }
}

// ============================================================================
// Utility Types
// ============================================================================

export type DeepPartial<T> = {
  [P in keyof T]?: T[P] extends object ? DeepPartial<T[P]> : T[P];
};

export type RequiredKeys<T, K extends keyof T> = T & Required<Pick<T, K>>;

export type OptionalKeys<T, K extends keyof T> = Omit<T, K> & Partial<Pick<T, K>>;

// ============================================================================
// Logger Interface
// ============================================================================

export interface Logger {
  trace(message: string, meta?: Record<string, unknown>): void;
  debug(message: string, meta?: Record<string, unknown>): void;
  info(message: string, meta?: Record<string, unknown>): void;
  notice(message: string, meta?: Record<string, unknown>): void;
  warning(message: string, meta?: Record<string, unknown>): void;
  error(message: string, meta?: Record<string, unknown>): void;
  critical(message: string, meta?: Record<string, unknown>): void;
  fatal(message: string, meta?: Record<string, unknown>): void;
  log(level: LogLevel, message: string, meta?: Record<string, unknown>): void;
  setLevel(level: LogLevel): void;
  getLevel(): LogLevel;
  child(meta: Record<string, unknown>): Logger;
  destroy(): void;
  flush(): void;
}