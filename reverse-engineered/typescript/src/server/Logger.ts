/**
 * Logger - Multi-channel structured logging system
 * Based on reverse engineering of OoklaServer Logger.cpp
 */

import { EventEmitter } from 'events';
import * as fs from 'fs';
import * as path from 'path';
import { Logger as LoggerInterface, LogConfig, LogChannel, LogLevel } from '../types/core';

const LOG_LEVELS: Record<LogLevel, number> = {
  trace: 0,
  debug: 10,
  information: 20,
  notice: 25,
  warning: 30,
  error: 40,
  critical: 50,
  fatal: 60,
};

const LEVEL_NAMES: Record<number, LogLevel> = {
  0: 'trace',
  10: 'debug',
  20: 'information',
  25: 'notice',
  30: 'warning',
  40: 'error',
  50: 'critical',
  60: 'fatal',
};

export class Logger extends EventEmitter implements LoggerInterface {
  private config: LogConfig;
  private channels: Map<string, LogChannel> = new Map();
  private defaultLevel: LogLevel = 'information';
  private pattern: string = '%Y-%m-%d %H:%M:%S [%P - %I] [%p] %t';
  private pid: number = process.pid;

  constructor(config: LogConfig) {
    super();
    this.config = config;
    this.defaultLevel = config.defaultLevel || 'information';
    this.pattern = config.pattern || this.pattern;

    this.initializeChannels();
  }

  /**
   * Initialize log channels from config
   */
  private initializeChannels(): void {
    for (const [name, channelConfig] of Object.entries(this.config.loggers || {})) {
      this.addChannel(name, channelConfig);
    }
  }

  /**
   * Add a log channel
   */
  public addChannel(name: string, channel: LogChannel): void {
    this.channels.set(name, channel);
    this.emit('channelAdded', { name, channel });
  }

  /**
   * Remove a log channel
   */
  public removeChannel(name: string): void {
    const channel = this.channels.get(name);
    if (channel) {
      this.closeChannel(channel);
      this.channels.delete(name);
      this.emit('channelRemoved', { name });
    }
  }

  /**
   * Log at trace level
   */
  public trace(message: string, meta?: Record<string, unknown>): void {
    this.log('trace', message, meta);
  }

  /**
   * Log at debug level
   */
  public debug(message: string, meta?: Record<string, unknown>): void {
    this.log('debug', message, meta);
  }

  /**
   * Log at information level
   */
  public info(message: string, meta?: Record<string, unknown>): void {
    this.log('information', message, meta);
  }

  /**
   * Log at notice level
   */
  public notice(message: string, meta?: Record<string, unknown>): void {
    this.log('notice', message, meta);
  }

  /**
   * Log at warning level
   */
  public warning(message: string, meta?: Record<string, unknown>): void {
    this.log('warning', message, meta);
  }

  /**
   * Log at error level
   */
  public error(message: string, meta?: Record<string, unknown>): void {
    this.log('error', message, meta);
  }

  /**
   * Log at critical level
   */
  public critical(message: string, meta?: Record<string, unknown>): void {
    this.log('critical', message, meta);
  }

  /**
   * Log at fatal level
   */
  public fatal(message: string, meta?: Record<string, unknown>): void {
    this.log('fatal', message, meta);
  }

  /**
   * Generic log method
   */
  public log(level: LogLevel, message: string, meta?: Record<string, unknown>): void {
    const levelValue = LOG_LEVELS[level];
    const defaultLevelValue = LOG_LEVELS[this.defaultLevel];

    if (levelValue < defaultLevelValue) {
      return;
    }

    const timestamp = new Date();
    const logEntry = this.formatLogEntry(level, message, meta, timestamp);

    for (const channel of this.channels.values()) {
      const channelLevel = LOG_LEVELS[channel.level || this.defaultLevel];
      if (levelValue >= channelLevel) {
        this.writeToChannel(channel, logEntry);
      }
    }

    this.emit('log', { level, message, meta, timestamp });
  }

  /**
   * Format log entry according to pattern
   */
  private formatLogEntry(level: LogLevel, message: string, meta: Record<string, unknown> | undefined, timestamp: Date): string {
    let formatted = this.pattern;

    formatted = formatted.replace(/%Y/g, timestamp.getFullYear().toString());
    formatted = formatted.replace(/%m/g, (timestamp.getMonth() + 1).toString().padStart(2, '0'));
    formatted = formatted.replace(/%d/g, timestamp.getDate().toString().padStart(2, '0'));
    formatted = formatted.replace(/%H/g, timestamp.getHours().toString().padStart(2, '0'));
    formatted = formatted.replace(/%M/g, timestamp.getMinutes().toString().padStart(2, '0'));
    formatted = formatted.replace(/%S/g, timestamp.getSeconds().toString().padStart(2, '0'));
    formatted = formatted.replace(/%P/g, this.pid.toString());
    formatted = formatted.replace(/%I/g, process.ppid.toString());
    formatted = formatted.replace(/%p/g, level.toUpperCase());
    formatted = formatted.replace(/%t/g, message);

    if (meta) {
      formatted += ' ' + JSON.stringify(meta);
    }

    return formatted;
  }

  /**
   * Write log entry to channel
   */
  private writeToChannel(channel: LogChannel, entry: string): void {
    try {
      switch (channel.class) {
        case 'ConsoleChannel':
          this.writeToConsole(channel, entry);
          break;
        case 'FileChannel':
          this.writeToFile(channel, entry);
          break;
        case 'JSONChannel':
          this.writeToJSON(channel, entry);
          break;
        case 'LogstashChannel':
          this.writeToLogstash(channel, entry);
          break;
        case 'SyslogChannel':
          this.writeToSyslog(channel, entry);
          break;
        default:
          this.writeToConsole(channel, entry);
      }
    } catch (error) {
      // Fallback to console
      console.error(`Logger error writing to ${channel.class}:`, error);
      console.log(entry);
    }
  }

  /**
   * Write to console
   */
  private writeToConsole(channel: LogChannel, entry: string): void {
    const stream = channel.channelOptions?.stderr ? process.stderr : process.stdout;
    stream.write(entry + '\n');
  }

  /**
   * Write to file
   */
  private writeToFile(channel: LogChannel, entry: string): void {
    const filePath = channel.channelOptions?.path || '/var/log/ooklaserver/app.log';
    const dir = path.dirname(filePath);

    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true, mode: 0o755 });
    }

    fs.appendFileSync(filePath, entry + '\n', { mode: 0o644 });

    // Handle rotation
    this.rotateIfNeeded(channel, filePath);
  }

  /**
   * Write as JSON
   */
  private writeToJSON(channel: LogChannel, entry: string): void {
    const filePath = channel.channelOptions?.path || '/var/log/ooklaserver/app.json.log';
    const dir = path.dirname(filePath);

    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true, mode: 0o755 });
    }

    // Parse the formatted entry back to structured data
    const logObj = this.parseLogEntry(entry);
    fs.appendFileSync(filePath, JSON.stringify(logObj) + '\n', { mode: 0o644 });

    this.rotateIfNeeded(channel, filePath);
  }

  /**
   * Write to Logstash format
   */
  private writeToLogstash(channel: LogChannel, entry: string): void {
    const filePath = channel.channelOptions?.path || '/var/log/ooklaserver/logstash.json.log';
    const dir = path.dirname(filePath);

    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true, mode: 0o755 });
    }

    const logObj = this.parseLogEntry(entry);
    const logstashEntry = {
      '@timestamp': new Date().toISOString(),
      '@version': '1',
      message: logObj.message,
      level: logObj.level,
      logger: logObj.logger,
      pid: this.pid,
      ...logObj.meta,
    };

    fs.appendFileSync(filePath, JSON.stringify(logstashEntry) + '\n', { mode: 0o644 });

    this.rotateIfNeeded(channel, filePath);
  }

  /**
   * Write to syslog (simplified)
   */
  private writeToSyslog(channel: LogChannel, entry: string): void {
    // In production, would use a syslog client
    this.writeToConsole(channel, `[SYSLOG] ${entry}`);
  }

  /**
   * Parse formatted log entry back to object
   */
  private parseLogEntry(entry: string): { message: string; level: string; logger: string; meta?: Record<string, unknown> } {
    // Simple parsing - in production would be more robust
    const parts = entry.split(' ');
    const level = parts[3]?.replace(/[\[\]]/g, '') || 'INFO';
    const message = parts.slice(4).join(' ');

    return { message, level, logger: 'app' };
  }

  /**
   * Rotate log file if needed
   */
  private rotateIfNeeded(channel: LogChannel, filePath: string): void {
    const maxSize = channel.channelOptions?.maxSize || 100 * 1024 * 1024; // 100MB
    const maxFiles = channel.channelOptions?.maxFiles || 10;

    try {
      const stats = fs.statSync(filePath);
      if (stats.size > maxSize) {
        this.rotateFile(filePath, maxFiles);
      }
    } catch {
      // File doesn't exist or other error
    }
  }

  /**
   * Rotate log file
   */
  private rotateFile(filePath: string, maxFiles: number): void {
    // Remove oldest
    const oldest = `${filePath}.${maxFiles}`;
    if (fs.existsSync(oldest)) {
      fs.unlinkSync(oldest);
    }

    // Rotate existing
    for (let i = maxFiles - 1; i >= 1; i--) {
      const current = i === 1 ? filePath : `${filePath}.${i}`;
      const next = `${filePath}.${i + 1}`;
      if (fs.existsSync(current)) {
        fs.renameSync(current, next);
      }
    }
  }

  /**
   * Close channel
   */
  private closeChannel(channel: LogChannel): void {
    // Close any open file handles
  }

  /**
   * Create child logger with additional context
   */
  public child(meta: Record<string, unknown>): LoggerInterface {
    const childLogger = new Logger(this.config);
    const originalLog = childLogger.log.bind(childLogger);

    childLogger.log = (level: LogLevel, message: string, childMeta?: Record<string, unknown>) => {
      originalLog(level, message, { ...meta, ...childMeta });
    };

    return childLogger;
  }

  /**
   * Set default log level
   */
  public setLevel(level: LogLevel): void {
    this.defaultLevel = level;
  }

  /**
   * Get current log level
   */
  public getLevel(): LogLevel {
    return this.defaultLevel;
  }

  /**
   * Flush all channels
   */
  public flush(): void {
    // In production, would flush async writers
  }

  /**
   * Clean up resources
   */
  public destroy(): void {
    for (const [name, channel] of this.channels) {
      this.closeChannel(channel);
    }
    this.channels.clear();
    this.removeAllListeners();
  }
}

export default Logger;