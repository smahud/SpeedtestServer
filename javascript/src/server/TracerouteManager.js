/**
 * Traceroute Manager - Performs network traceroute operations
 * Based on reverse engineering of OoklaServer TracerouteManager.cpp
 * JavaScript implementation
 */

const EventEmitter = require('events');
const { spawn } = require('child_process');
const fs = require('fs');
const { Logger } = require('./Logger');

class TracerouteManager extends EventEmitter {
  constructor(config, logger) {
    super();
    this.config = config;
    this.logger = logger;
    this.activeTraces = new Map();
    this.traceCache = new Map();
    this.cacheTTL = 5 * 60 * 1000; // 5 minutes
  }

  async trace(targetIp, options = {}) {
    const traceId = `${targetIp}-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;

    // Check cache first
    const cached = this.traceCache.get(targetIp);
    if (cached && Date.now() - cached.timestamp < this.cacheTTL) {
      this.logger.debug('Returning cached traceroute result', { targetIp });
      return cached.result;
    }

    const traceConfig = { ...this.config, ...options };
    const maxHops = traceConfig.maxHops || 30;
    const timeout = traceConfig.timeout || 5000;
    const protocol = traceConfig.protocol || 'icmp';

    this.logger.debug('Starting traceroute', { traceId, targetIp, maxHops, protocol });

    try {
      let result;

      switch (protocol) {
        case 'icmp':
          result = await this.traceICMP(targetIp, maxHops, timeout, traceId);
          break;
        case 'udp':
          result = await this.traceUDP(targetIp, maxHops, timeout, traceId);
          break;
        case 'tcp':
          result = await this.traceTCP(targetIp, maxHops, timeout, traceId);
          break;
        default:
          result = await this.traceICMP(targetIp, maxHops, timeout, traceId);
      }

      // Cache result
      this.traceCache.set(targetIp, { result, timestamp: Date.now() });

      this.emit('traceCompleted', { traceId, targetIp, result });
      return result;

    } catch (error) {
      this.logger.error('Traceroute failed', { traceId, targetIp, error });
      throw error;
    }
  }

  async traceICMP(targetIp, maxHops, timeout, traceId) {
    const _hops = [];
    const startTime = Date.now();

    return new Promise((resolve, reject) => {
      const args = [
        '-n',                    // Don't resolve hostnames
        '-m', maxHops.toString(), // Max hops
        '-w', (timeout / 1000).toString(), // Timeout in seconds
        '-q', '1',               // Queries per hop
        targetIp,
      ];

      // Try traceroute first, then tracepath
      const command = this.findTracerouteCommand();
      if (!command) {
        reject(new Error('No traceroute command available'));
        return;
      }

      const child = spawn(command, args);
      this.activeTraces.set(traceId, child);

      let output = '';
      let errorOutput = '';

      child.stdout.on('data', (data) => {
        output += data.toString();
      });

      child.stderr.on('data', (data) => {
        errorOutput += data.toString();
      });

      child.on('close', (code) => {
        this.activeTraces.delete(traceId);

        if (code !== 0 && code !== null) {
          // Try tracepath as fallback
          this.traceWithTracepath(targetIp, maxHops, timeout, traceId)
            .then(resolve)
            .catch(() => reject(new Error(`Traceroute failed: ${errorOutput}`)));
          return;
        }

        const parsedHops = this.parseTracerouteOutput(output);
        const result = {
          guid: traceId,
          targetIp,
          hops: parsedHops,
          completed: parsedHops.some(h => h.ip === targetIp || h.hostname === targetIp),
          durationMs: Date.now() - startTime,
          timestamp: startTime,
          startTime: new Date(startTime),
        };

        resolve(result);
      });

      child.on('error', (error) => {
        this.activeTraces.delete(traceId);
        reject(error);
      });

      // Overall timeout
      setTimeout(() => {
        if (this.activeTraces.has(traceId)) {
          child.kill('SIGTERM');
          this.activeTraces.delete(traceId);
          reject(new Error('Traceroute timeout'));
        }
      }, (maxHops + 2) * timeout);
    });
  }

  async traceUDP(targetIp, maxHops, timeout, traceId) {
    // UDP traceroute implementation would go here
    // For now, fall back to ICMP
    return this.traceICMP(targetIp, maxHops, timeout, traceId);
  }

  async traceTCP(targetIp, maxHops, timeout, traceId) {
    // TCP traceroute implementation would go here
    // For now, fall back to ICMP
    return this.traceICMP(targetIp, maxHops, timeout, traceId);
  }

  async traceWithTracepath(targetIp, maxHops, timeout, traceId) {
    const _hops = [];
    const startTime = Date.now();

    return new Promise((resolve, reject) => {
      const child = spawn('tracepath', ['-n', '-m', maxHops.toString(), targetIp]);
      this.activeTraces.set(traceId, child);

      let output = '';

      child.stdout.on('data', (data) => {
        output += data.toString();
      });

      child.on('close', (code) => {
        this.activeTraces.delete(traceId);

        const parsedHops = this.parseTracepathOutput(output);
        const result = {
          guid: traceId,
          targetIp,
          hops: parsedHops,
          completed: parsedHops.some(h => h.ip === targetIp),
          durationMs: Date.now() - startTime,
          timestamp: startTime,
          startTime: new Date(startTime),
        };

        resolve(result);
      });

      child.on('error', (error) => {
        this.activeTraces.delete(traceId);
        reject(error);
      });

      setTimeout(() => {
        if (this.activeTraces.has(traceId)) {
          child.kill('SIGTERM');
          this.activeTraces.delete(traceId);
          reject(new Error('Tracepath timeout'));
        }
      }, (maxHops + 2) * timeout);
    });
  }

  findTracerouteCommand() {
    const commands = ['traceroute', 'traceroute6', '/usr/sbin/traceroute', '/usr/bin/traceroute'];
    for (const cmd of commands) {
      try {
        fs.accessSync(cmd, fs.constants.X_OK);
        return cmd;
      } catch {
        // Not found, try next
      }
    }
    return null;
  }

  parseTracerouteOutput(output) {
    const hops = [];
    const lines = output.trim().split('\n');

    for (const line of lines) {
      // Parse lines like: " 1  192.168.1.1  1.234 ms"
      const match = line.match(/^\s*(\d+)\s+(\S+)\s+([\d.]+)\s*ms/);
      if (match) {
        hops.push({
          hop: parseInt(match[1], 10),
          ip: match[2],
          rttMs: parseFloat(match[3]),
          timeout: false,
        });
      }
    }

    return hops;
  }

  parseTracepathOutput(output) {
    const hops = [];
    const lines = output.trim().split('\n');

    for (const line of lines) {
      // Parse lines like: " 1?: [LOCALHOST]                      pmtu 1500"
      // or " 1:  192.168.1.1                                           1.234ms"
      const match = line.match(/^\s*(\d+)[?:]\s+(\S+)(?:\s+([\d.]+)ms)?/);
      if (match) {
        const ip = match[2].replace(/[\[\]]/g, '');
        if (ip !== 'LOCALHOST' && ip !== 'no' && ip !== 'reply') {
          hops.push({
            hop: parseInt(match[1], 10),
            ip,
            rttMs: match[3] ? parseFloat(match[3]) : 0,
            timeout: false,
          });
        }
      }
    }

    return hops;
  }

  cancelTrace(traceId) {
    const child = this.activeTraces.get(traceId);
    if (child) {
      child.kill('SIGTERM');
      this.activeTraces.delete(traceId);
      return true;
    }
    return false;
  }

  cancelAllTraces() {
    for (const [traceId, child] of this.activeTraces) {
      child.kill('SIGTERM');
    }
    this.activeTraces.clear();
  }

  getActiveTraceCount() {
    return this.activeTraces.size;
  }

  clearCache() {
    this.traceCache.clear();
  }

  updateConfig(config) {
    this.config = { ...this.config, ...config };
  }

  async start() {
    this.logger.debug('TracerouteManager started');
  }

  async stop() {
    this.destroy();
    this.logger.debug('TracerouteManager stopped');
  }

  destroy() {
    this.cancelAllTraces();
    this.traceCache.clear();
    this.removeAllListeners();
  }
}

module.exports = { TracerouteManager };