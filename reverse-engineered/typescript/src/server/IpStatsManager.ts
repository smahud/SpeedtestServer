/**
 * IP Statistics Manager - Tracks per-IP connection statistics and enforces rate limits
 * Based on reverse engineering of OoklaServer IpStatsManager.cpp
 */

import { EventEmitter } from 'events';
import { IpTrackingConfig, IpStatsInternal, IpBucketInternal } from '../types/core';
import { Logger } from './Logger';

export class IpStatsManager extends EventEmitter {
  private config: IpTrackingConfig;
  private logger: Logger;
  private ipStats: Map<string, IpStatsInternal> = new Map();
  private cleanupTimer?: NodeJS.Timeout;
  private gcTimer?: NodeJS.Timeout;

  constructor(config: IpTrackingConfig, logger: Logger) {
    super();
    this.config = config;
    this.logger = logger;
    this.startTimers();
  }

  /**
   * Record a new connection for an IP
   */
  public recordConnection(ip: string): { allowed: boolean; reason?: string; currentCount: number } {
    const now = Date.now();
    let stats = this.ipStats.get(ip);

    if (!stats) {
      stats = this.createInitialStats(ip, now);
      this.ipStats.set(ip, stats);
    }

    // Clean up old buckets
    this.cleanupOldBuckets(stats, now);

    // Check max connections per IP
    if (stats.totalConnections >= this.config.maxConnPerIp) {
      this.emit('ipBlocked', { ip, reason: 'max_connections_exceeded', count: stats.totalConnections });
      return { allowed: false, reason: 'max_connections_exceeded', currentCount: stats.totalConnections };
    }

    // Check sliding window rate limit
    const currentBucket = this.getCurrentBucket(stats, now);
    if (currentBucket.count >= this.config.maxConnPerBucketPerIp) {
      this.emit('ipBlocked', { ip, reason: 'rate_limit_exceeded', count: currentBucket.count });
      return { allowed: false, reason: 'rate_limit_exceeded', currentCount: currentBucket.count };
    }

    // Increment counters
    stats.totalConnections++;
    currentBucket.count++;
    stats.lastActivity = now;

    this.emit('connectionRecorded', { ip, stats });
    return { allowed: true, currentCount: stats.totalConnections };
  }

  /**
   * Record connection close for an IP
   */
  public recordClose(ip: string): void {
    const stats = this.ipStats.get(ip);
    if (stats) {
      stats.totalConnections = Math.max(0, stats.totalConnections - 1);
      stats.lastActivity = Date.now();

      if (stats.totalConnections === 0) {
        this.emit('ipIdle', { ip });
      }
    }
  }

  /**
   * Record bytes transferred for an IP
   */
  public recordTransfer(ip: string, bytesSent: number, bytesReceived: number): void {
    const stats = this.ipStats.get(ip);
    if (stats) {
      stats.bytesSent += bytesSent;
      stats.bytesReceived += bytesReceived;
      stats.lastActivity = Date.now();
    }
  }

  /**
   * Check if an IP is allowed to connect
   */
  public isAllowed(ip: string): { allowed: boolean; reason?: string } {
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

  /**
   * Get statistics for a specific IP
   */
  public getIpStats(ip: string): IpStatsInternal | undefined {
    return this.ipStats.get(ip);
  }

  /**
   * Get top IPs by connection count
   */
  public getTopIps(count: number = this.config.metricTopIpCount): IpStatsInternal[] {
    return Array.from(this.ipStats.values())
      .filter(s => s.totalConnections > 0)
      .sort((a, b) => b.totalConnections - a.totalConnections)
      .slice(0, count);
  }

  /**
   * Get all IP statistics
   */
  public getAllIpStats(): IpStatsInternal[] {
    return Array.from(this.ipStats.values());
  }

  /**
   * Get IP statistics for metrics
   */
  public getMetricsData(): {
    totalTrackedIps: number;
    activeIps: number;
    blockedIps: number;
    topIps: Array<{ ip: string; connections: number; bytesSent: number; bytesReceived: number }>;
  } {
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

  /**
   * Block an IP manually
   */
  public blockIp(ip: string, reason: string = 'manual'): void {
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

  /**
   * Unblock an IP
   */
  public unblockIp(ip: string): void {
    const stats = this.ipStats.get(ip);
    if (stats) {
      stats.isBlocked = false;
      stats.blockReason = undefined;
      this.emit('ipUnblocked', { ip });
      this.logger.info('IP unblocked', { ip });
    }
  }

  /**
   * Update configuration
   */
  public updateConfig(config: Partial<IpTrackingConfig>): void {
    this.config = { ...this.config, ...config };
    this.logger.debug('IpStatsManager config updated', { ...this.config });
  }

  /**
   * Create initial stats for an IP
   */
  private createInitialStats(ip: string, now: number): IpStatsInternal {
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

  /**
   * Get or create current bucket
   */
  private getCurrentBucket(stats: IpStatsInternal, now: number): IpBucketInternal {
    const bucketLengthMs = this.config.slidingWindowBucketLengthMinutes * 60 * 1000;
    const bucketIndex = Math.floor(now / bucketLengthMs);

    let bucket = stats.buckets.get(bucketIndex);
    if (!bucket) {
      bucket = { index: bucketIndex, count: 0, startTime: now };
      stats.buckets.set(bucketIndex, bucket);
    }
    return bucket;
  }

  /**
   * Clean up old buckets outside the sliding window
   */
  private cleanupOldBuckets(stats: IpStatsInternal, now: number): void {
    const windowMs = this.config.maxIdleAgeMinutes * 60 * 1000;
    const cutoffTime = now - windowMs;
    const bucketLengthMs = this.config.slidingWindowBucketLengthMinutes * 60 * 1000;
    const cutoffIndex = Math.floor(cutoffTime / bucketLengthMs);

    for (const [index, _bucket] of stats.buckets) {
      if (index < cutoffIndex) {
        stats.buckets.delete(index);
      }
    }
  }

  /**
   * Start cleanup timers
   */
  private startTimers(): void {
    // Garbage collection for idle IPs
    this.gcTimer = setInterval(() => {
      this.garbageCollect();
    }, this.config.gcIntervalMinutes * 60 * 1000);

    // Periodic bucket cleanup
    this.cleanupTimer = setInterval(() => {
      this.cleanupAllBuckets();
    }, 60000); // Every minute
  }

  /**
   * Garbage collect idle IPs
   */
  private garbageCollect(): void {
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

  /**
   * Cleanup old buckets for all IPs
   */
  private cleanupAllBuckets(): void {
    const now = Date.now();
    for (const stats of this.ipStats.values()) {
      this.cleanupOldBuckets(stats, now);
    }
  }

  /**
   * Get current configuration
   */
  public getConfig(): IpTrackingConfig {
    return { ...this.config };
  }

  /**
   * Start the IP stats manager (timers are started in constructor)
   */
  public async start(): Promise<void> {
    // Timers are already started in constructor
    this.logger.debug('IpStatsManager started');
  }

  /**
   * Stop the IP stats manager
   */
  public async stop(): Promise<void> {
    this.destroy();
    this.logger.debug('IpStatsManager stopped');
  }

  /**
   * Clean up resources
   */
  public destroy(): void {
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

export default IpStatsManager;