/**
 * IP Statistics Manager - Tracks per-IP connection statistics and enforces rate limits
 * Based on reverse engineering of OoklaServer IpStatsManager.cpp
 * JavaScript implementation
 */

const EventEmitter = require('events');

class IpStatsManager extends EventEmitter {
  constructor(config, logger) {
    super();
    this.config = config;
    this.logger = logger;
    this.ipStats = new Map();
    this.cleanupTimer = null;
    this.gcTimer = null;
    this.startTimers();
  }

  recordConnection(ip) {
    const now = Date.now();
    let stats = this.ipStats.get(ip);

    if (!stats) {
      stats = this.createInitialStats(ip, now);
      this.ipStats.set(ip, stats);
    }

    this.cleanupOldBuckets(stats, now);

    if (stats.totalConnections >= this.config.maxConnPerIp) {
      this.emit('ipBlocked', { ip, reason: 'max_connections_exceeded', count: stats.totalConnections });
      return { allowed: false, reason: 'max_connections_exceeded', currentCount: stats.totalConnections };
    }

    const currentBucket = this.getCurrentBucket(stats, now);
    if (currentBucket.count >= this.config.maxConnPerBucketPerIp) {
      this.emit('ipBlocked', { ip, reason: 'rate_limit_exceeded', count: currentBucket.count });
      return { allowed: false, reason: 'rate_limit_exceeded', currentCount: currentBucket.count };
    }

    stats.totalConnections++;
    currentBucket.count++;
    stats.lastActivity = now;

    this.emit('connectionRecorded', { ip, stats });
    return { allowed: true, currentCount: stats.totalConnections };
  }

  recordClose(ip) {
    const stats = this.ipStats.get(ip);
    if (stats) {
      stats.totalConnections = Math.max(0, stats.totalConnections - 1);
      stats.lastActivity = Date.now();

      if (stats.totalConnections === 0) {
        this.emit('ipIdle', { ip });
      }
    }
  }

  recordTransfer(ip, bytesSent, bytesReceived) {
    const stats = this.ipStats.get(ip);
    if (stats) {
      stats.bytesSent += bytesSent;
      stats.bytesReceived += bytesReceived;
      stats.lastActivity = Date.now();
    }
  }

  isAllowed(ip) {
    const stats = this.ipStats.get(ip);
    if (!stats) return { allowed: true };

    const now = Date.now();
    this.cleanupOldBuckets(stats, now);

    if (stats.totalConnections >= this.config.maxConnPerIp) {
      return { allowed: false, reason: 'max_connections_exceeded' };
    }

    const currentBucket = this.getCurrentBucket(stats, now);
    if (currentBucket.count >= this.config.maxConnPerBucketPerIp) {
      return { allowed: false, reason: 'rate_limit_exceeded' };
    }

    return { allowed: true };
  }

  getIpStats(ip) {
    return this.ipStats.get(ip);
  }

  getTopIps(count = this.config.metricTopIpCount) {
    return Array.from(this.ipStats.values())
      .filter(s => s.totalConnections > 0)
      .sort((a, b) => b.totalConnections - a.totalConnections)
      .slice(0, count);
  }

  getAllIpStats() {
    return Array.from(this.ipStats.values());
  }

  getMetricsData() {
    const allStats = Array.from(this.ipStats.values());
    const activeStats = allStats.filter(s => s.totalConnections > 0);
    const blockedStats = allStats.filter(s => s.isBlocked);

    return {
      totalTrackedIps: allStats.length,
      activeIps: activeStats.length,
      blockedIps: blockedStats.length,
      topIps: activeStats
        .sort((a, b) => b.totalConnections - a.totalConnections)
        .slice(0, this.config.metricTopIpCount)
        .map(s => ({
          ip: s.ip,
          connections: s.totalConnections,
          bytesSent: s.bytesSent,
          bytesReceived: s.bytesReceived,
        })),
    };
  }

  blockIp(ip, reason = 'manual') {
    let stats = this.ipStats.get(ip);
    if (!stats) {
      stats = this.createInitialStats(ip, Date.now());
      this.ipStats.set(ip, stats);
    }
    stats.isBlocked = true;
    stats.blockReason = reason;
    this.emit('ipBlocked', { ip, reason, manual: true });
    this.logger.warning('IP manually blocked', { ip, reason });
  }

  unblockIp(ip) {
    const stats = this.ipStats.get(ip);
    if (stats) {
      stats.isBlocked = false;
      stats.blockReason = undefined;
      this.emit('ipUnblocked', { ip });
      this.logger.info('IP unblocked', { ip });
    }
  }

  updateConfig(config) {
    this.config = { ...this.config, ...config };
    this.logger.debug('IpStatsManager config updated', { ...this.config });
  }

  createInitialStats(ip, now) {
    const bucketLengthMs = this.config.slidingWindowBucketLengthMinutes * 60 * 1000;
    const bucketIndex = Math.floor(now / bucketLengthMs);

    return {
      ip,
      totalConnections: 0,
      bytesSent: 0,
      bytesReceived: 0,
      buckets: new Map([[bucketIndex, { index: bucketIndex, count: 0, startTime: now }]]),
      lastActivity: now,
      createdAt: now,
      isBlocked: false,
    };
  }

  getCurrentBucket(stats, now) {
    const bucketLengthMs = this.config.slidingWindowBucketLengthMinutes * 60 * 1000;
    const bucketIndex = Math.floor(now / bucketLengthMs);

    let bucket = stats.buckets.get(bucketIndex);
    if (!bucket) {
      bucket = { index: bucketIndex, count: 0, startTime: now };
      stats.buckets.set(bucketIndex, bucket);
    }
    return bucket;
  }

  cleanupOldBuckets(stats, now) {
    const windowMs = this.config.maxIdleAgeMinutes * 60 * 1000;
    const cutoffTime = now - windowMs;
    const bucketLengthMs = this.config.slidingWindowBucketLengthMinutes * 60 * 1000;
    const cutoffIndex = Math.floor(cutoffTime / bucketLengthMs);

    for (const [index] of stats.buckets) {
      if (index < cutoffIndex) {
        stats.buckets.delete(index);
      }
    }
  }

  startTimers() {
    this.gcTimer = setInterval(() => {
      this.garbageCollect();
    }, this.config.gcIntervalMinutes * 60 * 1000);

    this.cleanupTimer = setInterval(() => {
      this.cleanupAllBuckets();
    }, 60000); // Every minute
  }

  garbageCollect() {
    const now = Date.now();
    const maxIdleMs = this.config.maxIdleAgeMinutes * 60 * 1000;
    let cleaned = 0;

    for (const [ip, stats] of this.ipStats) {
      if (stats.totalConnections === 0 && now - stats.lastActivity > maxIdleMs) {
        this.ipStats.delete(ip);
        cleaned++;
      }
    }

    if (cleaned > 0) {
      this.logger.debug('Garbage collected idle IPs', { count: cleaned });
    }
  }

  cleanupAllBuckets() {
    const now = Date.now();
    for (const stats of this.ipStats.values()) {
      this.cleanupOldBuckets(stats, now);
    }
  }

  getConfig() {
    return { ...this.config };
  }

  async start() {
    this.logger.debug('IpStatsManager started');
  }

  async stop() {
    this.destroy();
    this.logger.debug('IpStatsManager stopped');
  }

  destroy() {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
    }
    if (this.gcTimer) {
      clearInterval(this.gcTimer);
    }
    this.ipStats.clear();
    this.removeAllListeners();
  }
}

module.exports = { IpStatsManager };
