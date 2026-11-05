/**
 * Configuration Manager - Handles loading and managing server configuration
 * Based on reverse engineering of OoklaServer binary configuration system
 */

import { EventEmitter } from 'events';
import * as fs from 'fs';
import * as path from 'path';
import { DeepPartial, OoklaServerConfig, LogConfig, LogLevel, ChannelConfig, SSLConfig, WebSocketConfig, UpdateConfig, ApiConfig } from '../types/core';
import { Logger } from './Logger';

/** Poco channel classes honored by the Logger (others map to console). */
const CHANNEL_CLASSES = [
  'ConsoleChannel', 'FileChannel', 'LevelChannel', 'LogJsonFormatter',
  'LogstashChannel', 'JSONChannel', 'SyslogChannel', 'EventLogChannel',
];

/** Properties whose value is ALWAYS a list (comma-separated in the
 *  properties file; a single value is a one-element list, matching the
 *  daemon's "at least one port is required" semantics). §11 parity fix:
 *  single-value entries previously parsed as bare scalars. */
const LIST_FIELDS: Record<string, true> = {
  'tcpPorts': true,
  'udpPorts': true,
  'httpPorts': true,
  'addresses': true,
  'allowedDomains': true,
  'ssl.acme.domains': true,
  'clientAuthToken.additionalValidationFields': true,
};

/** Coerce known list fields to arrays. */
function coerceListFields(obj: Record<string, unknown>, prefix = ''): void {
  for (const [key, value] of Object.entries(obj)) {
    const dotPath = prefix ? `${prefix}.${key}` : key;
    if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
      coerceListFields(value as Record<string, unknown>, dotPath);
      continue;
    }
    if (LIST_FIELDS[dotPath] && !Array.isArray(value)) {
      obj[key] = value === undefined || value === '' ? [] : [value];
    }
  }
}

const DEFAULT_CONFIG: OoklaServerConfig = {
  clientAuthToken: {
    additionalValidationFields: [],
    denyInvalid: true, // Binary default is true based on properties file
  },
  excludeDefaultDomains: false,
  workerThreadPool: {
    capacity: 30000, // Binary default from properties file
    stackSizeBytes: 102400, // 100KB - Binary default from properties file
  },
  ipTracking: {
    maxConnPerIp: 500, // Binary default from properties file
    gcIntervalMinutes: 5, // Binary default from properties file
    maxIdleAgeMinutes: 35, // Binary default from properties file
    slidingWindowBucketLengthMinutes: 5, // Binary default from properties file
    metricTopIpCount: 5, // Binary default from properties file
    maxConnPerBucketPerIp: 20000, // Binary default from properties file
  },
  maxConnectionSeconds: 3600,
  http: {
    maxHeadersSize: 65536, // Binary default from properties file
  },
  allowedDomains: ['*'], // daemon built-in default when the key is absent (verified: CSP connect-src *)
  tcpPorts: [5060, 8080], // Binary default from properties file
  udpPorts: [5060, 8080], // Binary default from properties file
  httpPorts: [8080],
  netgaugeVersionString: '2.11 (2.11.5) 2026-06-04.1737.7d0993d', // compatibility profile (verified 2026-11-04)
  evidenceLogFile: '',
  // Independent safety parameters (NOT daemon-parity keys — F-35/F-36):
  shutdownGraceSeconds: 10, // bounded graceful shutdown (force-destroy after)
  evidenceMaxBacklogBytes: 32 * 1024 * 1024, // evidence WriteStream backlog cap
  useIPv6: true, // Binary default from properties file (verified F-29: independent v4/v6 listener control)
  addresses: [], // daemon default: the official template ships the key ABSENT — empty = wildcard set from useIPv4/useIPv6 (F-28)
  useIPv4: true,
  host: {
    id: '',
    password: '',
  },
  userAgentFilterEnabled: false, // daemon default OFF (F-26): the official template ships the key commented out — verified live (with the key absent, curl/* and all other UA strings are served)
  performTraceroutes: true,
  binaryAutoUpdate: true,
  enableAutoUpdate: true,
  updateRequestInitialInterval: 300000, // 5 minutes default
  resultEndpointUrl: 'https://results.speedtest.net/reports/server/',
  sendStatsInterval: 60000, // 1 minute default
  hostApiUrl: 'https://host-api.speedtest.net',
  apiUrl: 'https://api.speedtest.net',
  ssl: {
    letsEncryptRetry: 3,
    letsEncryptMaxRetry: 5,
    certificateFile: '',
    privateKeyFile: '',
    verificationMode: 'none', // Binary default from properties file
    minimumTLSProtocol: '1.2', // Binary default from properties file
  },
  websocket: {
    frameSizeLimitBytes: 5242880, // 5MB - Binary default from properties file
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

const CONFIG_FILE_NAMES = [
  'config.properties',
  'config.ini',
  'config.xml',
  'ooklaserver.json',
  'OoklaServer.properties',
  'ooklaserver.config.ts',
  'ooklaserver.config.js',
  'ooklaserver.config.json',
];
const CONFIG_DIRS = [
  '/etc/ooklaserver',
  '/usr/local/etc/ooklaserver',
  './config',
  '../config',
  '.',
];

export class ConfigManager extends EventEmitter {
  private config: OoklaServerConfig;
  private logger: Logger;
  private configFilePath?: string;
  /** Constructor overrides (CLI flags / API). Precedence: CLI > env > file
   *  > defaults (§11) — they are re-applied AFTER any config file load. */
  private overrides: DeepPartial<OoklaServerConfig>;

  constructor(overrides?: DeepPartial<OoklaServerConfig>, logger?: Logger) {
    super();
    this.logger = logger || new Logger({ loggers: {}, defaultLevel: 'information', pattern: '' });
    this.overrides = overrides || {};
    this.config = this.mergeConfig(DEFAULT_CONFIG, this.overrides);
    this.loadConfig();
    this.applyOverrides();
  }

  /** Re-apply constructor overrides on top of whatever was loaded (CLI wins). */
  private applyOverrides(): void {
    if (Object.keys(this.overrides).length > 0) {
      this.config = this.mergeConfig(this.config, this.overrides);
    }
  }

  /**
   * Load configuration from file/environment.
   *
   * Fail-closed (fixes A-1): an EXPLICIT config selection (--config /
   * OOKLA_SPEEDTESTSERVER_CONFIG_FILE) that cannot be loaded — file missing,
   * unreadable, unparsable, or an unsupported format — aborts startup by
   * THROWING instead of silently falling back to defaults/search path.
   * The old behavior started the server with wrong ports/TLS while the
   * operator believed their file was active.
   */
  private loadConfig(): void {
    // Explicit config file via --config / OOKLA_SPEEDTESTSERVER_CONFIG_FILE
    const explicitPath = process.env.OOKLA_SPEEDTESTSERVER_CONFIG_FILE;
    if (explicitPath) {
      if (!fs.existsSync(explicitPath)) {
        throw new Error(
          `Explicit configuration file not found: ${explicitPath} (--config). ` +
          'Refusing to fall back to the search path — fix the path or remove --config.',
        );
      }
      // loadConfigFile throws on parse/format errors — propagated as fatal.
      this.loadConfigFile(explicitPath);
      this.configFilePath = explicitPath;
      this.logger.info(`Loaded configuration from ${explicitPath} (--config)`);
      return;
    }
    // Check environment variable next
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

  /**
   * Load configuration from a specific file
   */
  private loadConfigFile(filePath: string): void {
    const ext = path.extname(filePath).toLowerCase();
    const content = fs.readFileSync(filePath, 'utf-8');

    let parsed: Partial<OoklaServerConfig>;

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
      case '.ts':
      case '.js':
        // For TypeScript/JavaScript config files, we need to evaluate them
        // In production, these should be pre-compiled or use a proper module loader
        // For now, we'll use require for .js files (sync) and skip .ts files
        // unless they're compiled to .js
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        if (ext === '.js') {
          try {
            // Clear require cache to allow reloading
            delete require.cache[require.resolve(filePath)];
            // eslint-disable-next-line @typescript-eslint/no-var-requires
            const configModule = require(filePath);
            parsed = configModule.defaultConfig || configModule.default || configModule;
          } catch (error) {
            throw new Error(`Failed to load JS config: ${error}`);
          }
        } else {
          // Fail closed (fixes A-13): a .ts config previously "loaded"
          // successfully with no content, silently blocking the search path.
          throw new Error(
            `TypeScript config files (.ts) are not supported at runtime: ${filePath}. ` +
            'Compile it to .js/.json or use a .properties file.',
          );
        }
        break;
      default:
        throw new Error(`Unsupported config file format: ${ext}`);
    }

    this.config = this.mergeConfig(this.config, parsed);
  }

  /**
   * Parse .properties file format
   */
  private parseProperties(content: string): Partial<OoklaServerConfig> {
    const result: Partial<OoklaServerConfig> = {};
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
      // Map OoklaServer.ssl.* properties (from OoklaServer.properties)
      else if (key.startsWith('OoklaServer.ssl.')) {
        mappedKey = 'ssl.' + key.substring('OoklaServer.ssl.'.length);
      }
      // Map OoklaServer.* properties to root config
      else if (key.startsWith('OoklaServer.')) {
        mappedKey = key.substring('OoklaServer.'.length);
      }

      this.setNestedProperty(result, mappedKey, value);
    }

    coerceListFields(result as Record<string, unknown>);
    return result;
  }

  /**
   * Parse .ini file format
   */
  private parseIni(content: string): Partial<OoklaServerConfig> {
    // Simplified INI parser
    return this.parseProperties(content);
  }

  /**
   * Parse XML config (simplified)
   */
  private parseXml(content: string): Partial<OoklaServerConfig> {
    // Simplified XML parser - would use a proper XML parser in production
    const result: Partial<OoklaServerConfig> = {};

    // Extract key-value pairs from XML
    const regex = /<(\w+)>([^<]+)<\/\1>/g;
    let match;
    while ((match = regex.exec(content)) !== null) {
      this.setNestedProperty(result, match[1], match[2]);
    }

    return result;
  }

  /**
   * Set nested property using dot notation.
   *
   * Hardened against prototype pollution (fixes A-2): `__proto__`,
   * `constructor` and `prototype` key segments are rejected. The old
   * traversal followed `__proto__` straight into Object.prototype, letting a
   * properties line like `__proto__.polluted = true` poison the whole process.
   */
  private setNestedProperty(obj: Record<string, unknown>, key: string, value: string): void {
    const keys = key.split('.');
    for (const k of keys) {
      if (k === '__proto__' || k === 'constructor' || k === 'prototype') {
        this.logger.warning(`Ignored unsafe configuration key segment: ${k}`);
        return;
      }
    }
    let current: Record<string, unknown> = obj;

    for (let i = 0; i < keys.length - 1; i++) {
      const k = keys[i];
      if (!(k in current) || typeof current[k] !== 'object' || current[k] === null) {
        current[k] = {};
      }
      current = current[k] as Record<string, unknown>;
    }

    // Convert value types
    let convertedValue: unknown = value;
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

  /**
   * Deep merge two configurations.
   *
   * Hardened against prototype pollution (fixes A-2): unsafe keys never
   * reach the assignment (a JSON `{"__proto__": {...}}` env override used
   * to trigger the Object.prototype setter during the merge).
   */
  private mergeConfig<T>(base: T, override: DeepPartial<T>): T {
    const result = { ...base } as Record<string, unknown>;

    for (const key of Object.keys(override)) {
      if (key === '__proto__' || key === 'constructor' || key === 'prototype') {
        this.logger.warning(`Ignored unsafe configuration key: ${key}`);
        continue;
      }
      const overrideValue = (override as Record<string, unknown>)[key];
      const baseValue = (base as Record<string, unknown>)[key];

      if (overrideValue === undefined) continue;

      if (
        typeof overrideValue === 'object' &&
        overrideValue !== null &&
        !Array.isArray(overrideValue) &&
        typeof baseValue === 'object' &&
        baseValue !== null &&
        !Array.isArray(baseValue)
      ) {
        result[key] = this.mergeConfig(
          baseValue as Record<string, unknown>,
          overrideValue as Record<string, unknown>
        );
      } else {
        result[key] = overrideValue;
      }
    }

    return result as T;
  }

  /**
   * Get current configuration
   */
  public getConfig(): OoklaServerConfig {
    return this.config;
  }

  /**
   * Update configuration at runtime
   */
  public updateConfig(updates: DeepPartial<OoklaServerConfig>): void {
    this.config = this.mergeConfig(this.config, updates);
    this.emit('configUpdated', this.config);
  }

  /**
   * Get logging configuration.
   *
   * Honors the Poco-style `logging.loggers.<name>.*` properties when present
   * (MASTER PROMPT v6.0 §11: parsed settings must reach their runtime
   * consumer). Mapping:
   *   logging.loggers.<n>.level              → channel level
   *   logging.loggers.<n>.channel.class      → ConsoleChannel | FileChannel | …
   *   logging.loggers.<n>.channel.path       → channelOptions.path
   *   logging.loggers.<n>.channel.rotation   → channelOptions.rotation
   * `EventLogChannel` (the daemon's default) maps to console output — the
   * systemd journal captures it in production (see install.sh unit).
   */
  public getLogConfig(): LogConfig {
    const parsed = ((this.config as unknown as Record<string, unknown>).logging || {}) as
      { loggers?: Record<string, Record<string, unknown>> };

    const loggers: LogConfig['loggers'] = {};
    const parsedLoggers = parsed.loggers || {};
    const hasParsed = Object.keys(parsedLoggers).length > 0;

    if (hasParsed) {
      for (const [name, cfg] of Object.entries(parsedLoggers)) {
        const channel = (cfg.channel || {}) as Record<string, unknown>;
        const channelClass = (
          typeof channel.class === 'string' && CHANNEL_CLASSES.includes(channel.class)
            ? channel.class
            : 'EventLogChannel'
        ) as ChannelConfig['class'];
        loggers[name] = {
          name: typeof cfg.name === 'string' ? cfg.name : name,
          level: typeof cfg.level === 'string' ? (cfg.level as LogLevel) : 'information',
          channel: {
            class: channelClass,
            pattern: typeof channel.pattern === 'string' ? channel.pattern : undefined,
            path: typeof channel.path === 'string' ? channel.path.replace('${application.dir}', process.cwd()) : undefined,
            channelOptions: {
              path: typeof channel.path === 'string' ? channel.path.replace('${application.dir}', process.cwd()) : undefined,
            },
          },
        };
      }
    } else {
      // Default app logger (daemon default: EventLogChannel / information).
      loggers.app = {
        name: 'app',
        level: 'information',
        channel: {
          class: 'EventLogChannel',
          pattern: '%Y-%m-%d %H:%M:%S [%P - %I] [%p] %t',
        },
      };
    }

    const appLevel = loggers.app?.level || 'information';
    return {
      loggers,
      defaultLevel: appLevel,
      pattern: '%Y-%m-%d %H:%M:%S [%P - %I] [%p] %t',
    };
  }

  /**
   * Save configuration to file
   */
  public saveConfig(filePath?: string): void {
    const targetPath = filePath || this.configFilePath || path.join(process.cwd(), 'ooklaserver.json');
    const dir = path.dirname(targetPath);

    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    fs.writeFileSync(targetPath, JSON.stringify(this.config, null, 2));
    this.logger.info(`Configuration saved to ${targetPath}`);
  }

  /**
   * Get a specific config value by dot-notation path
   */
  public get<K extends keyof OoklaServerConfig>(key: K): OoklaServerConfig[K] {
    return this.config[key];
  }

  /**
   * Set a specific config value by dot-notation path
   */
  public set<K extends keyof OoklaServerConfig>(key: K, value: OoklaServerConfig[K]): void {
    this.config = { ...this.config, [key]: value };
    this.emit('configUpdated', this.config);
  }

  /**
   * Get SSL configuration
   */
  public getSSLConfig(): SSLConfig {
    return this.config.ssl || {
      letsEncryptRetry: 3,
      letsEncryptMaxRetry: 5,
      certificateFile: '',
      privateKeyFile: '',
      verificationMode: 'none',
      minimumTLSProtocol: '1.2',
    };
  }

  /**
   * Get WebSocket configuration
   */
  public getWebSocketConfig(): WebSocketConfig {
    return this.config.websocket || {
      frameSizeLimitBytes: 5242880,
    };
  }

  /**
   * Get Update configuration
   */
  public getUpdateConfig(): UpdateConfig {
    return this.config.update || {
      enabled: true,
      requestInitialInterval: 300000,
    };
  }

  /**
   * Get API configuration
   */
  public getApiConfig(): ApiConfig {
    return this.config.api || {
      url: 'https://api.speedtest.net',
      hostUrl: 'https://host-api.speedtest.net',
    };
  }
}

export default ConfigManager;