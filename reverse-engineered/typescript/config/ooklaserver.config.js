/**
 * OoklaServer Configuration
 * JavaScript configuration file - easy to read and modify
 *
 * This file mirrors the OoklaServer.properties format but in JavaScript for
 * easier programmatic access.
 *
 * Based on reverse engineering of OoklaServer binaries for all architectures:
 * - Linux x86_64
 * - Linux ARM64 (aarch64)
 * - macOS (universal x86_64 + arm64)
 * - Windows x86_64
 *
 * All binaries share the same configuration options.
 * Windows has one additional option: adminPassword
 */

const defaultConfig = {
  // Network configuration
  tcpPorts: [5060, 8080],
  udpPorts: [5060, 8080],
  httpPorts: [8080],
  useIPv6: true,
  useIPv4: true,
  addresses: ['0.0.0.0', '::'],

  // CORS / Domain restrictions
  allowedDomains: ['*.speedtest.net', '*.ookla.com', '*.speedtestcustom.com'],
  excludeDefaultDomains: false,

  // User agent filtering
  userAgentFilterEnabled: true,

  // Worker thread pool
  workerThreadPool: {
    capacity: 30000,
    stackSizeBytes: 102400,
  },

  // Auto updates
  enableAutoUpdate: true,
  binaryAutoUpdate: true,

  // IP Tracking / Rate limiting
  ipTracking: {
    gcIntervalMinutes: 5,
    maxIdleAgeMinutes: 35,
    slidingWindowBucketLengthMinutes: 5,
    metricTopIpCount: 5,
    maxConnPerIp: 500,
    maxConnPerBucketPerIp: 20000,
  },

  // Connection limits
  maxConnectionSeconds: 3600,

  // HTTP limits
  http: {
    maxHeadersSize: 65536,
  },

  // Client authentication
  clientAuthToken: {
    denyInvalid: true,
    additionalValidationFields: [],
  },

  // WebSocket
  websocket: {
    frameSizeLimitBytes: 5242880,
  },

  // SSL/TLS
  ssl: {
    letsEncryptRetry: 3,
    letsEncryptMaxRetry: 5,
    certificateFile: '',
    privateKeyFile: '',
    verificationMode: 'none',
    minimumTLSProtocol: '1.2',
  },

  // Logging
  // Note: Logging is configured via POCO config files or environment variable

  // Server identification
  host: {
    id: '',
    password: '',
  },

  // Windows-specific
  adminPassword: '',

  // API endpoints
  resultEndpointUrl: 'https://results.speedtest.net/reports/server/',
  hostApiUrl: 'https://host-api.speedtest.net',
  apiUrl: 'https://api.speedtest.net',

  // Metrics
  sendStatsInterval: 60000,

  // Traceroute
  performTraceroutes: true,
  traceroute: {
    enabled: true,
    maxHops: 30,
    timeout: 5000,
    maxConcurrent: 10,
  },
};

/**
 * Configuration for different environments
 */
const environmentConfigs = {
  development: {
    // Development overrides
    host: {
      id: 'dev-server',
      password: '',
    },
    ssl: {
      letsEncryptRetry: 3,
      letsEncryptMaxRetry: 5,
      certificateFile: '',
      privateKeyFile: '',
      verificationMode: 'none',
      minimumTLSProtocol: '1.2',
    },
    // Disable auto-update in development
    enableAutoUpdate: false,
    binaryAutoUpdate: false,
    // More verbose logging
    // logging configuration would go here
  },

  production: {
    // Production overrides - configure these!
    host: {
      id: 'your-server-id-from-ookla',
      password: 'your-server-password',
    },
    // Use proper certificates in production
    ssl: {
      letsEncryptRetry: 3,
      letsEncryptMaxRetry: 5,
      certificateFile: '/etc/ooklaserver/cert.pem',
      privateKeyFile: '/etc/ooklaserver/key.pem',
      verificationMode: 'none',
      minimumTLSProtocol: '1.2',
    },
    enableAutoUpdate: true,
    binaryAutoUpdate: true,
  },

  testing: {
    // Testing overrides
    host: {
      id: 'test-server',
      password: '',
    },
    tcpPorts: [15060, 18080],
    udpPorts: [15060, 18080],
    httpPorts: [18080],
    enableAutoUpdate: false,
    binaryAutoUpdate: false,
    workerThreadPool: {
      capacity: 1000,
      stackSizeBytes: 102400,
    },
  },
};

/**
 * Get configuration for a specific environment
 * @param {string} env - Environment name (development, production, testing)
 * @returns {Object} Merged configuration
 */
function getConfigForEnvironment(env = 'development') {
  const envConfig = environmentConfigs[env] || {};
  return deepMerge(defaultConfig, envConfig);
}

/**
 * Deep merge two objects
 * @param {Object} target - Target object
 * @param {Object} source - Source object
 * @returns {Object} Merged object
 */
function deepMerge(target, source) {
  const result = { ...target };

  for (const key of Object.keys(source)) {
    const sourceValue = source[key];
    const targetValue = target[key];

    if (
      sourceValue !== undefined &&
      typeof sourceValue === 'object' &&
      sourceValue !== null &&
      !Array.isArray(sourceValue) &&
      typeof targetValue === 'object' &&
      targetValue !== null &&
      !Array.isArray(targetValue)
    ) {
      result[key] = deepMerge(targetValue, sourceValue);
    } else if (sourceValue !== undefined) {
      result[key] = sourceValue;
    }
  }

  return result;
}

/**
 * Load configuration from a .properties file
 * This is a simple parser for the OoklaServer.properties format
 * @param {string} content - File content
 * @returns {Object} Parsed configuration
 */
function parsePropertiesFile(content) {
  const result = {};
  const lines = content.split('\n');

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith('!')) continue;

    const eqIndex = trimmed.indexOf('=');
    if (eqIndex === -1) continue;

    const key = trimmed.substring(0, eqIndex).trim();
    const value = trimmed.substring(eqIndex + 1).trim();

    // Map openSSL.server.* properties to ssl.* config
    let mappedKey = key;
    if (key.startsWith('openSSL.server.')) {
      mappedKey = 'ssl.' + key.substring('openSSL.server.'.length);
    }

    setNestedProperty(result, mappedKey, value);
  }

  return result;
}

/**
 * Set nested property using dot notation
 * @param {Object} obj - Target object
 * @param {string} key - Dot-notation key
 * @param {string} value - Value to set
 */
function setNestedProperty(obj, key, value) {
  const keys = key.split('.');
  let current = obj;

  for (let i = 0; i < keys.length - 1; i++) {
    const k = keys[i];
    if (!(k in current) || typeof current[k] !== 'object') {
      current[k] = {};
    }
    current = current[k];
  }

  // Convert value types
  let convertedValue = value;
  const lastKey = keys[keys.length - 1];

  // Special handling for version strings that look like floats but should remain strings
  const isVersionString = lastKey === 'minimumTLSProtocol' || lastKey === 'tlsVersion' || lastKey === 'sslVersion';

  if (value === 'true') convertedValue = true;
  else if (value === 'false') convertedValue = false;
  else if (/^\d+$/.test(value)) convertedValue = parseInt(value, 10);
  else if (/^\d+\.\d+$/.test(value) && !isVersionString) convertedValue = parseFloat(value);
  else if (value.includes(',')) {
    // Handle comma-separated values (arrays)
    const parts = value.split(',').map(v => v.trim());
    // Try to parse as numbers
    if (parts.every(p => /^\d+$/.test(p))) {
      convertedValue = parts.map(p => parseInt(p, 10));
    } else {
      convertedValue = parts;
    }
  } else if (value.startsWith('[') && value.endsWith(']')) {
    try {
      convertedValue = JSON.parse(value);
    } catch {
      // Keep as string
    }
  }

  current[lastKey] = convertedValue;
}

module.exports = {
  defaultConfig,
  environmentConfigs,
  getConfigForEnvironment,
  parsePropertiesFile,
  deepMerge,
};