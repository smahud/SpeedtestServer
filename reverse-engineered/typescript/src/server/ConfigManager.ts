/**
 * Configuration Manager - Handles loading and managing server configuration
 * Based on reverse engineering of OoklaServer binary configuration system
 */

import { EventEmitter } from 'events';
import * as fs from 'fs';
import * as path from 'path';
import { DeepPartial, OoklaServerConfig, LogConfig } from '../types/core';
import { Logger } from './Logger';

const DEFAULT_CONFIG: OoklaServerConfig = {
  clientAuthToken: {
    additionalValidationFields: [],
    denyInvalid: false,
  },
  excludeDefaultDomains: false,
  workerThreadPool: {
    capacity: 100,
    stackSizeBytes: 1024 * 1024, // 1MB
  },
  ipTracking: {
    maxConnPerIp: 100,
    gcIntervalMinutes: 5,
    maxIdleAgeMinutes: 30,
    slidingWindowBucketLengthMinutes: 1,
    metricTopIpCount: 100,
    maxConnPerBucketPerIp: 10,
  },
  maxConnectionSeconds: 3600,
  http: {
    maxHeadersSize: 8192,
  },
  allowedDomains: ['*.speedtest.net', '*.ookla.com', '*.speedtestcustom.com'],
  tcpPorts: [5060, 8080],
  udpPorts: [],
  httpPorts: [8080],
  useIPv6: true,
  addresses: ['0.0.0.0', '::'],
  useIPv4: true,
  host: {
    id: '',
  },
  userAgentFilterEnabled: true,
  performTraceroutes: true,
};

const CONFIG_FILE_NAMES = ['config.properties', 'config.ini', 'config.xml', 'ooklaserver.json'];
const CONFIG_DIRS = ['/etc/ooklaserver', '/usr/local/etc/ooklaserver', './config', '.'];

export class ConfigManager extends EventEmitter {
  private config: OoklaServerConfig;
  private logger: Logger;
  private configFilePath?: string;

  constructor(overrides?: DeepPartial<OoklaServerConfig>, logger?: Logger) {
    super();
    this.logger = logger || new Logger({ loggers: {}, defaultLevel: 'information', pattern: '' });
    this.config = this.mergeConfig(DEFAULT_CONFIG, overrides || {});
    this.loadConfig();
  }

  /**
   * Load configuration from file/environment
   */
  private loadConfig(): void {
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

      this.setNestedProperty(result, key, value);
    }

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
   * Set nested property using dot notation
   */
  private setNestedProperty(obj: Record<string, unknown>, key: string, value: string): void {
    const keys = key.split('.');
    let current: Record<string, unknown> = obj;

    for (let i = 0; i < keys.length - 1; i++) {
      const k = keys[i];
      if (!(k in current) || typeof current[k] !== 'object') {
        current[k] = {};
      }
      current = current[k] as Record<string, unknown>;
    }

    // Convert value types
    let convertedValue: unknown = value;
    if (value === 'true') convertedValue = true;
    else if (value === 'false') convertedValue = false;
    else if (/^\d+$/.test(value)) convertedValue = parseInt(value, 10);
    else if (/^\d+\.\d+$/.test(value)) convertedValue = parseFloat(value);
    else if (value.startsWith('[') && value.endsWith(']')) {
      try {
        convertedValue = JSON.parse(value);
      } catch {
        // Keep as string
      }
    }

    current[keys[keys.length - 1]] = convertedValue;
  }

  /**
   * Deep merge two configurations
   */
  private mergeConfig<T>(base: T, override: DeepPartial<T>): T {
    const result = { ...base } as Record<string, unknown>;

    for (const key of Object.keys(override)) {
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
   * Get logging configuration
   */
  public getLogConfig(): LogConfig {
    // Convert our config to logger config format
    const loggers: LogConfig['loggers'] = {};

    // Default app logger
    loggers.app = {
      name: 'app',
      level: 'information',
      channel: {
        class: 'ConsoleChannel',
        pattern: '%Y-%m-%d %H:%M:%S [%P - %I] [%p] %t',
      },
    };

    return {
      loggers,
      defaultLevel: 'information',
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
}

export default ConfigManager;