/**
 * Logger - Multi-channel structured logging system
 * Based on reverse engineering of OoklaServer Logger.cpp
 * JavaScript implementation
 */

const EventEmitter = require('events');
const fs = require('fs');
const path = require('path');

const LOG_LEVELS = {
  trace: 0,
  debug: 10,
  information: 20,
  notice: 25,
  warning: 30,
  error: 40,
  critical: 50,
  fatal: 60,
};

class Logger extends EventEmitter {
  constructor(config) {
    super();
    this.config = config;
    this.channels = new Map();
    this.defaultLevel = config.defaultLevel || 'information';
    this.pattern = config.pattern || '%Y-%m-%d %H:%M:%S [%P - %I] [%p] %t';
    this.pid = process.pid;

    this.initializeChannels();
  }

  initializeChannels() {
    for (const [name, channelConfig] of Object.entries(this.config.loggers || {})) {
      this.addChannel(name, channelConfig);
    }
  }

  addChannel(name, channelConfig) {
    const channel = {
      name,
      level: channelConfig.level,
      class: channelConfig.channel.class,
      channelOptions: channelConfig.channel.channelOptions,
    };
    this.channels.set(name, channel);
    this.emit('channelAdded', { name, channel });
  }

  removeChannel(name) {
    const channel = this.channels.get(name);
    if (channel) {
      this.closeChannel(channel);
      this.channels.delete(name);
      this.emit('channelRemoved', { name });
    }
  }

  trace(message, meta) {
    this.log('trace', message, meta);
  }

  debug(message, meta) {
    this.log('debug', message, meta);
  }

  info(message, meta) {
    this.log('information', message, meta);
  }

  notice(message, meta) {
    this.log('notice', message, meta);
  }

  warning(message, meta) {
    this.log('warning', message, meta);
  }

  error(message, meta) {
    this.log('error', message, meta);
  }

  critical(message, meta) {
    this.log('critical', message, meta);
  }

  fatal(message, meta) {
    this.log('fatal', message, meta);
  }

  log(level, message, meta) {
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

  formatLogEntry(level, message, meta, timestamp) {
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

  writeToChannel(channel, entry) {
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

  writeToConsole(channel, entry) {
    const stream = channel.channelOptions?.stderr ? process.stderr : process.stdout;
    stream.write(entry + '\n');
  }

  writeToFile(channel, entry) {
    const filePath = channel.channelOptions?.path || '/var/log/ooklaserver/app.log';
    const dir = path.dirname(filePath);

    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true, mode: 0o755 });
    }

    fs.appendFileSync(filePath, entry + '\n', { mode: 0o644 });

    this.rotateIfNeeded(channel, filePath);
  }

  writeToJSON(channel, entry) {
    const filePath = channel.channelOptions?.path || '/var/log/ooklaserver/app.json.log';
    const dir = path.dirname(filePath);

    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true, mode: 0o755 });
    }

    const logObj = this.parseLogEntry(entry);
    fs.appendFileSync(filePath, JSON.stringify(logObj) + '\n', { mode: 0o644 });

    this.rotateIfNeeded(channel, filePath);
  }

  writeToLogstash(channel, entry) {
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

  writeToSyslog(channel, entry) {
    // In production, would use a syslog client
    this.writeToConsole(channel, `[SYSLOG] ${entry}`);
  }

  parseLogEntry(entry) {
    const parts = entry.split(' ');
    const level = parts[3]?.replace(/[\[\]]/g, '') || 'INFO';
    const message = parts.slice(4).join(' ');

    return { message, level, logger: 'app' };
  }

  rotateIfNeeded(channel, filePath) {
    const maxSize = channel.channelOptions?.maxSize || 100 * 1024 * 1024;
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

  rotateFile(filePath, maxFiles) {
    const oldest = `${filePath}.${maxFiles}`;
    if (fs.existsSync(oldest)) {
      fs.unlinkSync(oldest);
    }

    for (let i = maxFiles - 1; i >= 1; i--) {
      const current = i === 1 ? filePath : `${filePath}.${i}`;
      const next = `${filePath}.${i + 1}`;
      if (fs.existsSync(current)) {
        fs.renameSync(current, next);
      }
    }
  }

  closeChannel(channel) {
    // Close any open file handles
  }

  child(meta) {
    const childLogger = new Logger(this.config);
    const originalLog = childLogger.log.bind(childLogger);

    childLogger.log = (level, message, childMeta) => {
      originalLog(level, message, { ...meta, ...childMeta });
    };

    return childLogger;
  }

  setLevel(level) {
    this.defaultLevel = level;
  }

  getLevel() {
    return this.defaultLevel;
  }

  flush() {
    // In production, would flush async writers
  }

  destroy() {
    for (const [name, channel] of this.channels) {
      this.closeChannel(channel);
    }
    this.channels.clear();
    this.removeAllListeners();
  }
}

module.exports = { Logger };
