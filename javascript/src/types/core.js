/**
 * Core JavaScript types for OoklaServer reverse engineering
 * Based on binary analysis of OoklaServer-linux-x86_64
 * Converted from TypeScript implementation
 */

// ============================================================================
// Configuration Types
// ============================================================================

/**
 * @typedef {Object} ClientAuthTokenConfig
 * @property {string[]} additionalValidationFields
 * @property {boolean} denyInvalid
 */

/**
 * @typedef {Object} WorkerThreadPoolConfig
 * @property {number} capacity
 * @property {number} stackSizeBytes
 */

/**
 * @typedef {Object} IpTrackingConfig
 * @property {number} maxConnPerIp
 * @property {number} gcIntervalMinutes
 * @property {number} maxIdleAgeMinutes
 * @property {number} slidingWindowBucketLengthMinutes
 * @property {number} metricTopIpCount
 * @property {number} maxConnPerBucketPerIp
 */

/**
 * @typedef {Object} HttpConfig
 * @property {number} maxHeadersSize
 */

/**
 * @typedef {Object} HostConfig
 * @property {string} id
 * @property {string} [password]
 */

/**
 * @typedef {Object} SSLConfig
 * @property {number} [letsEncryptRetry]
 * @property {number} [letsEncryptMaxRetry]
 * @property {string} [certificateFile]
 * @property {string} [privateKeyFile]
 * @property {string} [verificationMode]
 * @property {string} [minimumTLSProtocol]
 */

/**
 * @typedef {Object} WebSocketConfig
 * @property {number} [frameSizeLimitBytes]
 */

/**
 * @typedef {Object} UpdateConfig
 * @property {boolean} [enabled]
 * @property {number} [requestInitialInterval]
 */

/**
 * @typedef {Object} ApiConfig
 * @property {string} [url]
 * @property {string} [hostUrl]
 */

/**
 * @typedef {Object} OoklaServerConfig
 * @property {ClientAuthTokenConfig} clientAuthToken
 * @property {boolean} excludeDefaultDomains
 * @property {WorkerThreadPoolConfig} workerThreadPool
 * @property {IpTrackingConfig} ipTracking
 * @property {number} maxConnectionSeconds
 * @property {HttpConfig} http
 * @property {string[]} allowedDomains
 * @property {number[]} tcpPorts
 * @property {number[]} udpPorts
 * @property {number[]} httpPorts
 * @property {boolean} useIPv6
 * @property {string[]} addresses
 * @property {boolean} useIPv4
 * @property {HostConfig} host
 * @property {boolean} userAgentFilterEnabled
 * @property {boolean} performTraceroutes
 * @property {boolean} [binaryAutoUpdate]
 * @property {SharedMemoryConfig} [sharedMemory]
 * @property {TLSCertificateConfig} [tls]
 * @property {TracerouteConfig} [traceroute]
 * @property {SSLConfig} [ssl]
 * @property {WebSocketConfig} [websocket]
 * @property {UpdateConfig} [update]
 * @property {ApiConfig} [api]
 * @property {string} [resultEndpointUrl]
 * @property {number} [sendStatsInterval]
 * @property {string} [hostApiUrl]
 * @property {string} [apiUrl]
 * @property {boolean} [enableAutoUpdate]
 * @property {number} [updateRequestInitialInterval]
 */

// ============================================================================
// Authentication & Token Types
// ============================================================================

/**
 * @typedef {Object} ServerToken
 * @property {string} token
 * @property {number} expiration - Unix timestamp
 * @property {string} [ip]
 * @property {string} [guid]
 * @property {Record<string, unknown>} additionalFields
 */

/**
 * @typedef {Object} ClientAuthTokenValidationResult
 * @property {boolean} isValid
 * @property {string} [reason]
 * @property {Record<string, unknown>} [fields]
 */

/**
 * @typedef {Object} TokenValidationFields
 * @property {string} [deviceId]
 * @property {string} [model]
 * @property {string} [guid]
 * @property {boolean} [isValid]
 * @property {boolean} ['ip-strict']
 * @property {Record<string, unknown>} [key]
 */

// ============================================================================
// Connection & Session Types
// ============================================================================

/**
 * @typedef {Object} ConnectionInfo
 * @property {string} id
 * @property {string} remoteIp
 * @property {number} remotePort
 * @property {string} localIp
 * @property {number} localPort
 * @property {'tcp'|'udp'|'websocket'} protocol
 * @property {Date} connectedAt
 * @property {Date} lastActivity
 * @property {number} bytesSent
 * @property {number} bytesReceived
 * @property {boolean} isExpired
 * @property {string} [guid]
 * @property {ServerToken} [token]
 */

/**
 * @typedef {Object} ClientSessionContext
 * @property {string} connectionId
 * @property {string} guid
 * @property {ServerToken} token
 * @property {string} ipAddress
 * @property {string} userAgent
 * @property {Date} startTime
 * @property {'download'|'upload'|'latency'|'traceroute'} testType
 * @property {Record<string, unknown>} metadata
 */

/**
 * @typedef {Object} UploadStatsRecorder
 * @property {string} connectionId
 * @property {number} sentBytes
 * @property {number} receivedBytes
 * @property {number} sentBytesTotal
 * @property {number} receivedBytesTotal
 * @property {number} testDurationMs
 * @property {string} congestionControl
 * @property {boolean} windowScaling
 * @property {Date} startTime
 * @property {Date} [endTime]
 */

// ============================================================================
// IP Statistics Types
// ============================================================================

/**
 * @typedef {Object} IpConnectionStats
 * @property {number} current
 * @property {number} queued
 * @property {number} blocked
 * @property {number} queueFull
 * @property {number} concurrent
 * @property {number} currentThreads
 * @property {number} uptime
 * @property {number} totalCurrent
 * @property {number} totalQueued
 * @property {number} totalBlocked
 * @property {number} totalQueueFull
 * @property {number} totalConcurrent
 * @property {number} totalCurrentThreads
 */

/**
 * @typedef {Object} IpStatsEntry
 * @property {string} ip
 * @property {IpConnectionStats} connections
 * @property {boolean} blocked
 * @property {Date} [blockedUntil]
 * @property {Date} firstSeen
 * @property {Date} lastSeen
 * @property {number} totalConnections
 */

/**
 * @typedef {Object} IpStatsConfig
 * @property {number} maxConnPerIp
 * @property {number} gcIntervalMinutes
 * @property {number} maxIdleAgeMinutes
 * @property {number} slidingWindowBucketLengthMinutes
 * @property {number} metricTopIpCount
 * @property {number} maxConnPerBucketPerIp
 */

/**
 * @typedef {Object} IpStats
 * @property {IpStatsEntry[]} entries
 * @property {number} totalIps
 * @property {number} blockedIps
 */

/**
 * @typedef {Object} IpBucket
 * @property {string} ip
 * @property {number} count
 * @property {number} timestamp
 */

// Internal types for IpStatsManager
/**
 * @typedef {Object} IpBucketInternal
 * @property {number} index
 * @property {number} count
 * @property {number} startTime
 */

/**
 * @typedef {Object} IpStatsInternal
 * @property {string} ip
 * @property {number} totalConnections
 * @property {number} bytesSent
 * @property {number} bytesReceived
 * @property {Map<number, IpBucketInternal>} buckets
 * @property {number} lastActivity
 * @property {number} createdAt
 * @property {boolean} isBlocked
 * @property {string} [blockReason]
 */

// ============================================================================
// Metrics Types
// ============================================================================

/**
 * @typedef {Object} ServerMetrics
 * @property {number} uniqueTests
 * @property {number} unidentifiedTests
 * @property {number} sentBytes
 * @property {number} receivedBytes
 * @property {number} sentBytesTotal
 * @property {number} receivedBytesTotal
 * @property {string} congestionControl
 * @property {string[]} availableCongestionControl
 * @property {boolean} windowScaling
 * @property {number} numFiles
 * @property {number} disabled
 * @property {number} established
 * @property {number} blocked
 * @property {number} connectionSeconds
 * @property {number} maxConcurrent
 * @property {string[]} listeningAddresses
 * @property {number} exceededMaxDuration
 * @property {string} cpuModelName
 * @property {number} loadAverage10Mins
 * @property {number} runningProcesses
 * @property {number} totalProcesses
 * @property {number} cpus
 * @property {number} fdSize
 * @property {number} numThreads
 * @property {number} vmSize
 * @property {number} vmRss
 * @property {Date} timestamp
 * @property {number} [connections]
 * @property {Object} [bandwidth]
 * @property {Object} [latency]
 * @property {Object} [tests]
 * @property {number} [errors]
 * @property {Object} [system]
 */

// ============================================================================
// Logging Types
// ============================================================================

/**
 * @typedef {'fatal'|'critical'|'error'|'warning'|'notice'|'information'|'debug'|'trace'} LogLevel
 */

/**
 * @typedef {Object} LogEntry
 * @property {LogLevel} level
 * @property {Date} timestamp
 * @property {string} message
 * @property {string} logger
 * @property {number} [threadId]
 * @property {number} [processId]
 * @property {Record<string, unknown>} [metadata]
 */

/**
 * @typedef {Object} LogConfig
 * @property {Record<string, LoggerConfig>} loggers
 * @property {LogLevel} defaultLevel
 * @property {string} pattern
 */

/**
 * @typedef {Object} LoggerConfig
 * @property {string} name
 * @property {LogLevel} level
 * @property {ChannelConfig} channel
 */

/**
 * @typedef {Object} ChannelConfig
 * @property {'ConsoleChannel'|'FileChannel'|'LevelChannel'|'LogJsonFormatter'|'LogstashChannel'|'JSONChannel'|'SyslogChannel'|'EventLogChannel'} class
 * @property {string} [pattern]
 * @property {RotationConfig} [rotation]
 * @property {string} [path]
 * @property {string} [archive]
 * @property {boolean} [compress]
 * @property {number} [purgeCount]
 * @property {number} [maxSize]
 * @property {number} [maxFiles]
 * @property {Object} [channelOptions]
 */

/**
 * @typedef {Object} RotationConfig
 * @property {'timestamp'|'size'} type
 * @property {string} [interval]
 * @property {string} [maxSize]
 */

/**
 * @typedef {Object} LogChannel
 * @property {string} name
 * @property {LogLevel} level
 * @property {string} class
 * @property {ChannelConfig['channelOptions']} [channelOptions]
 */

// ============================================================================
// HTTP Request/Response Types
// ============================================================================

/**
 * @typedef {Object} OoklaRequest
 * @property {'GET'|'POST'|'HEAD'|'OPTIONS'} method
 * @property {string} path
 * @property {Record<string, string>} headers
 * @property {Record<string, string>} query
 * @property {Buffer|string} [body]
 * @property {string} remoteIp
 * @property {number} remotePort
 * @property {string} userAgent
 * @property {ServerToken} [token]
 */

/**
 * @typedef {Object} OoklaResponse
 * @property {number} statusCode
 * @property {Record<string, string>} headers
 * @property {Buffer|string} body
 * @property {string} contentType
 */

/**
 * @typedef {Object} CrossDomainPolicy
 * @property {string[]} domains
 * @property {string[]} ports
 */

// ============================================================================
// Download Test Types
// ============================================================================

/**
 * @typedef {Object} DownloadTestFile
 * @property {number} width
 * @property {number} height
 * @property {number} size
 * @property {Buffer} data
 */

/**
 * @type {DownloadTestFile[]}
 */
const DEFAULT_DOWNLOAD_SIZES = [
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

/**
 * @typedef {Object} BinaryInfo
 * @property {string} version
 * @property {string} buildNumber
 * @property {string} platform
 * @property {string} architecture
 * @property {string} sha256
 * @property {number} size
 * @property {string} url
 * @property {string} signature
 */

/**
 * @typedef {Object} UpdateStatus
 * @property {boolean} hasUpdate
 * @property {string} currentVersion
 * @property {string} [latestVersion]
 * @property {string} [latestBuildNumber]
 * @property {string} [downloadUrl]
 * @property {string} [error]
 */

// ============================================================================
// Traceroute Types
// ============================================================================

/**
 * @typedef {Object} TracerouteRequest
 * @property {string} guid
 * @property {string} targetIp
 * @property {number} [maxHops]
 * @property {number} [timeout]
 */

/**
 * @typedef {Object} TracerouteResult
 * @property {string} guid
 * @property {string} targetIp
 * @property {TracerouteHop[]} hops
 * @property {boolean} completed
 * @property {string} [error]
 * @property {Date} startTime
 * @property {Date} [endTime]
 * @property {number} [durationMs]
 * @property {number} [timestamp]
 */

/**
 * @typedef {Object} TracerouteHop
 * @property {number} hop
 * @property {string} [ip]
 * @property {string} [hostname]
 * @property {number} [rttMs]
 * @property {number} [rtt]
 * @property {boolean} timeout
 */

/**
 * @typedef {Object} TracerouteConfig
 * @property {boolean} enabled
 * @property {number} maxHops
 * @property {number} timeout
 * @property {number} [timeoutMs]
 * @property {number} maxConcurrent
 * @property {'icmp'|'udp'|'tcp'} [protocol]
 */

// ============================================================================
// Process Management Types
// ============================================================================

/**
 * @typedef {'manager'|'ward'|'standalone'} ProcessRole
 */

/**
 * @typedef {Object} ProcessInfo
 * @property {ProcessRole} role
 * @property {number} pid
 * @property {number} [parentPid]
 * @property {Date} startTime
 * @property {boolean} isHealthy
 * @property {ProcessInfo[]} [wards]
 */

/**
 * @typedef {Object} SharedMemoryConfig
 * @property {string} managerMutex
 * @property {string} serverMutex
 * @property {string} managerShMem
 * @property {string} serverShMem
 * @property {string} managerShMemMutex
 * @property {string} serverShMemMutex
 */

// ============================================================================
// TLS Certificate Types
// ============================================================================

/**
 * @typedef {Object} TLSCertificateConfig
 * @property {boolean} enabled
 * @property {string} [certPath]
 * @property {string} [keyPath]
 * @property {string} [caPath]
 * @property {boolean} [autoGenerate]
 * @property {Object} [acme]
 * @property {string} [publicKey]
 */

/**
 * @typedef {Object} TLSCertificateInfo
 * @property {string} subject
 * @property {string} issuer
 * @property {Date} validFrom
 * @property {Date} validTo
 * @property {string} fingerprint
 * @property {string[]} san
 * @property {string} [certPem]
 * @property {string} [keyPem]
 * @property {string} [caPem]
 * @property {number} [expiresAt]
 * @property {number} [daysUntilExpiry]
 * @property {boolean} [isSelfSigned]
 */

// ============================================================================
// System Information Types
// ============================================================================

/**
 * @typedef {Object} NetworkInterface
 * @property {string} name
 * @property {string} address
 * @property {'IPv4'|'IPv6'} family
 * @property {boolean} internal
 */

/**
 * @typedef {Object} SystemInfo
 * @property {string} cpuModelName
 * @property {number} loadAverage
 * @property {number} runningProcesses
 * @property {number} totalProcesses
 * @property {number} cpus
 * @property {number} fdSize
 * @property {number} numThreads
 * @property {number} vmSize
 * @property {number} vmRss
 * @property {NetworkInterface[]} networkInterfaces
 * @property {string} tcpCongestionControl
 * @property {string[]} availableCongestionControl
 * @property {boolean} tcpWindowScaling
 */

// ============================================================================
// Error Types
// ============================================================================

class OoklaServerError extends Error {
  /**
   * @param {string} message
   * @param {string} code
   * @param {number} [statusCode]
   * @param {Record<string, unknown>} [details]
   */
  constructor(message, code, statusCode = 500, details) {
    super(message);
    this.name = 'OoklaServerError';
    this.code = code;
    this.statusCode = statusCode;
    this.details = details;
  }
}

class AuthenticationError extends OoklaServerError {
  /**
   * @param {string} message
   * @param {Record<string, unknown>} [details]
   */
  constructor(message, details) {
    super(message, 'AUTHENTICATION_FAILED', 401, details);
    this.name = 'AuthenticationError';
  }
}

class RateLimitError extends OoklaServerError {
  /**
   * @param {string} message
   * @param {number} [retryAfter]
   * @param {Record<string, unknown>} [details]
   */
  constructor(message, retryAfter, details) {
    super(message, 'RATE_LIMIT_EXCEEDED', 429, details);
    this.name = 'RateLimitError';
    this.retryAfter = retryAfter;
  }
}

class BinaryUpdateError extends OoklaServerError {
  /**
   * @param {string} message
   * @param {Record<string, unknown>} [details]
   */
  constructor(message, details) {
    super(message, 'BINARY_UPDATE_FAILED', 500, details);
    this.name = 'BinaryUpdateError';
  }
}

class ConfigurationError extends OoklaServerError {
  /**
   * @param {string} message
   * @param {Record<string, unknown>} [details]
   */
  constructor(message, details) {
    super(message, 'CONFIGURATION_ERROR', 500, details);
    this.name = 'ConfigurationError';
  }
}

// ============================================================================
// Logger Interface
// ============================================================================

/**
 * @interface Logger
 * @property {(message: string, meta?: Record<string, unknown>) => void} trace
 * @property {(message: string, meta?: Record<string, unknown>) => void} debug
 * @property {(message: string, meta?: Record<string, unknown>) => void} info
 * @property {(message: string, meta?: Record<string, unknown>) => void} notice
 * @property {(message: string, meta?: Record<string, unknown>) => void} warning
 * @property {(message: string, meta?: Record<string, unknown>) => void} error
 * @property {(message: string, meta?: Record<string, unknown>) => void} critical
 * @property {(message: string, meta?: Record<string, unknown>) => void} fatal
 * @property {(level: LogLevel, message: string, meta?: Record<string, unknown>) => void} log
 * @property {(level: LogLevel) => void} setLevel
 * @property {() => LogLevel} getLevel
 * @property {(meta: Record<string, unknown>) => Logger} child
 * @property {() => void} destroy
 * @property {() => void} flush
 */

// Export all types and classes
module.exports = {
  // Configuration
  DEFAULT_DOWNLOAD_SIZES,
  // Errors
  OoklaServerError,
  AuthenticationError,
  RateLimitError,
  BinaryUpdateError,
  ConfigurationError,
};
