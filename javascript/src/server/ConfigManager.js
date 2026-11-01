/**
 * Configuration Manager - Handles loading and managing server configuration
 * Based on reverse engineering of OoklaServer binary configuration system
 * JavaScript implementation
 */

const EventEmitter = require('events');
const fs = require('fs');
const path = require('path');
const { Logger } = require('./Logger');
const { DEFAULT_DOWNLOAD_SIZES, OoklaServerError, ConfigurationError } = require('../types/core');

const DEFAULT_CONFIG = {
  clientAuthToken: {
    additionalValidationFields: [],
    denyInvalid: true,
  },
  excludeDefaultDomains: false,
  workerThreadPool: {
    capacity: 30000,
    stackSizeBytes: 102400,
  },
  ipTracking: {
    maxConnPerIp: 500,
    gcIntervalMinutes: 5,
    maxIdleAgeMinutes: 35,
    slidingWindowBucketLengthMinutes: 5,
    metricTopIpCount: 5,
    maxConnPerBucketPerIp: 20000,
  },
  maxConnectionSeconds: 3600,
  http: {
    maxHeadersSize: 65536,
  },
  allowedDomains: ['*.speedtest.net', '*.ookla.com', '*.speedtestcustom.com'],
  tcpPorts: [5060, 8080],
  udpPorts: [5060, 8080],
  httpPorts: [8080],
  useIPv6: true,
  addresses: ['0.0.0.0', '::'],
  useIPv4: true,
  host: {
    id: '',
    password: '',
  },
  userAgentFilterEnabled: true,
  performTraceroutes: true,
  binaryAutoUpdate: true,
  enableAutoUpdate: true,
  updateRequestInitialInterval: 300000,
  resultEndpointUrl: 'https://results.speedtest.net/reports/server/',
  sendStatsInterval: 60000,
  hostApiUrl: 'https://host-api.speedtest.net',
  apiUrl: 'https://api.speedtest.net',
  ssl: {
    letsEncryptRetry: 3,
    letsEncryptMaxRetry: 5,
    certificateFile: '',
    privateKeyFile: '',
    verificationMode: 'none',
    minimumTLSProtocol: '1.2',
  },
  websocket: {
    frameSizeLimitBytes: 5242880,
  },
  update: {
    enabled: true,
    requestInitialInterval: 300000,
  },
  api: {
    url: 'https://api.speedtest.net',
    hostUrl: 'https://host-api.speedtest.net',
  },
  traceroute: {
    enabled: true,
    maxHops: 30,
    timeout: 5000,
    maxConcurrent: 10,
  },
};

const CONFIG_FILE_NAMES = ['config.properties', 'config.ini', 'config.xml', 'ooklaserver.json', 'OoklaServer.properties'];
const CONFIG_DIRS = ['/etc/ooklaserver', '/usr/local/etc/ooklaserver', './config', '.'];

class ConfigManager extends EventEmitter {
  constructor(overrides = {}, logger = null) {
    super();
    this.logger = logger || new Logger({ loggers: {}, defaultLevel: 'information', pattern: '' });
    this.config = this.mergeConfig(DEFAULT_CONFIG, overrides);
    this.configFilePath = null;
    this.loadConfig();
  }

  loadConfig() {
    // Check environment variable first
    const envConfig = process.env.OOKLA_SERVER_POCO_CONFIG;
    if (envConfig) {
      try {
        const parsed = JSON.parse(envConfig);
        this.config = this.mergeConfig(this.config, parsed);
        this.logger.info('Loaded configuration from environment variable');
        return;
      } catch (error) {
        this.logger.warning('Failed to parse OOKLA_SERVER_POCO_CONFIG', { error });
      }
    }

    // Check config files
    for (const dir of CONFIG_DIRS) {
      for (const file of CONFIG_FILE_NAMES) {
        const fullPath = path.join(dir, file);
        if (fs.existsSync(fullPath)) {
          try {
            this.loadConfigFile(fullPath);
            this.configFilePath = fullPath;
            this.logger.info(`Loaded configuration from ${fullPath}`);
            return;
          } catch (error) {
            this.logger.warning(`Failed to load config from ${fullPath}`, { error });
          }
        }
      }
    }

    this.logger.info('No config file found; using defaults');
  }

  loadConfigFile(filePath) {
    const ext = path.extname(filePath).toLowerCase();
    const content = fs.readFileSync(filePath, 'utf-8');

    let parsed;

    switch (ext) {
      case '.json':
        parsed = JSON.parse(content);
        break;
      case '.properties':
        parsed = this.parseProperties(content);
        break;
      case '.ini':
        parsed = this.parseIni(content);
        break;
      case '.xml':
        parsed = this.parseXml(content);
        break;
      default:
        throw new Error(`Unsupported config file format: ${ext}`);
    }

    this.config = this.mergeConfig(this.config, parsed);
  }

  parseProperties(content) {
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

      this.setNestedProperty(result, mappedKey, value);
    }

    return result;
  }

  parseIni(content) {
    // Simplified INI parser
    return this.parseProperties(content);
  }

  parseXml(content) {
    // Simplified XML parser
    const result = {};

    const regex = /<(\w+)>([^<]+)<\/\1>/g;
    let match;
    while ((match = regex.exec(content)) !== null) {
      this.setNestedProperty(result, match[1], match[2]);
    }

    return result;
  }

  setNestedProperty(obj, key, value) {
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

  mergeConfig(base, override) {
    const result = { ...base };

    for (const key of Object.keys(override)) {
      const overrideValue = override[key];
      const baseValue = base[key];

      if (overrideValue === undefined) continue;

      if (
        typeof overrideValue === 'object' &&
        overrideValue !== null &&
        !Array.isArray(overrideValue) &&
        typeof baseValue === 'object' &&
        baseValue !== null &&
        !Array.isArray(baseValue)
      ) {
        result[key] = this.mergeConfig(baseValue, overrideValue);
      } else {
        result[key] = overrideValue;
      }
    }

    return result;
  }

  getConfig() {
    return this.config;
  }

  updateConfig(updates) {
    this.config = this.mergeConfig(this.config, updates);
    this.emit('configUpdated', this.config);
  }

  getLogConfig() {
    // Convert our config to logger config format
    const loggers = {};

    // Default app logger
    loggers.app = {
      name: 'app',
      level: 'information',
      channel: {
        class: 'EventLogChannel',
        pattern: '%Y-%m-%d %H:%M:%S [%P - %I] [%p] %t',
      },
    };

    return {
      loggers,
      defaultLevel: 'information',
      pattern: '%Y-%m-%d %H:%M:%S [%P - %I] [%p] %t',
    };
  }

  saveConfig(filePath = null) {
    const targetPath = filePath || this.configFilePath || path.join(process.cwd(), 'ooklaserver.json');
    const dir = path.dirname(targetPath);

    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    fs.writeFileSync(targetPath, JSON.stringify(this.config, null, 2));
    this.logger.info(`Configuration saved to ${targetPath}`);
  }

  get(key) {
    return this.config[key];
  }

  set(key, value) {
    this.config = { ...this.config, [key]: value };
    this.emit('configUpdated', this.config);
  }

  getSSLConfig() {
    return this.config.ssl || {
      letsEncryptRetry: 3,
      letsEncryptMaxRetry: 5,
      certificateFile: '',
      privateKeyFile: '',
      verificationMode: 'none',
      minimumTLSProtocol: '1.2',
    };
  }

  getWebSocketConfig() {
    return this.config.websocket || {
      frameSizeLimitBytes: 5242880,
    };
  }

  getUpdateConfig() {
    return this.config.update || {
      enabled: true,
      requestInitialInterval: 300000,
    };
  }

  getApiConfig() {
    return this.config.api || {
      url: 'https://api.speedtest.net',
      hostUrl: 'https://host-api.speedtest.net',
    };
  }
}

module.exports = { ConfigManager };
