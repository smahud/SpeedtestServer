/**
 * Connection Tracker - Tracks active connections and manages connection lifecycle
 * Based on reverse engineering of OoklaServer ConnectionTracker/ConnectionWrapper
 */

import { EventEmitter } from 'events';
import { ConnectionInfo, ClientSessionContext, UploadStatsRecorder } from '../types/core';
import { Logger } from './Logger';

export class ConnectionTracker extends EventEmitter {
  private logger: Logger;
  private connections: Map<string, ConnectionInfo> = new Map();
  private sessions: Map<string, ClientSessionContext> = new Map();
  private stats: Map<string, UploadStatsRecorder> = new Map();
  private maxConnections: number = 10000;
  private cleanupInterval?: NodeJS.Timeout;
  private connectionTimeout: number = 3600000; // 1 hour default

  constructor(logger: Logger) {
    super();
    this.logger = logger;
    this.startCleanupTimer();
  }

  /**
   * Create a new connection
   */
  public createConnection(
    id: string,
    remoteIp: string,
    remotePort: number,
    localIp: string,
    localPort: number,
    protocol: 'tcp' | 'udp' | 'websocket' = 'tcp'
  ): ConnectionInfo {
    // Check connection limit
    if (this.connections.size >= this.maxConnections) {
      throw new Error('Maximum connections reached');
    }

    const now = new Date();
    const connection: ConnectionInfo = {
      id,
      remoteIp,
      remotePort,
      localIp,
      localPort,
      protocol,
      connectedAt: now,
      lastActivity: now,
      bytesSent: 0,
      bytesReceived: 0,
      isExpired: false,
    };

    this.connections.set(id, connection);
    this.emit('connectionCreated', connection);
    this.logger.debug('Connection created', { id, remoteIp, protocol });

    return connection;
  }

  /**
   * Get connection by ID
   */
  public getConnection(id: string): ConnectionInfo | undefined {
    return this.connections.get(id);
  }

  /**
   * Get all active connections
   */
  public getAllConnections(): ConnectionInfo[] {
    return Array.from(this.connections.values()).filter((c) => !c.isExpired);
  }

  /**
   * Get connections by remote IP
   */
  public getConnectionsByIp(ip: string): ConnectionInfo[] {
    return Array.from(this.connections.values()).filter(
      (c) => c.remoteIp === ip && !c.isExpired
    );
  }

  /**
   * Update connection activity
   */
  public updateActivity(id: string, bytesSent: number = 0, bytesReceived: number = 0): void {
    const connection = this.connections.get(id);
    if (!connection) return;

    connection.lastActivity = new Date();
    connection.bytesSent += bytesSent;
    connection.bytesReceived += bytesReceived;

    // Update stats if exists
    const stat = this.stats.get(id);
    if (stat) {
      stat.sentBytes += bytesSent;
      stat.receivedBytes += bytesReceived;
    }
  }

  /**
   * Set connection token
   */
  public setConnectionToken(id: string, token: { token: string; expiration: number; ip?: string; guid?: string; additionalFields?: Record<string, unknown> }): void {
    const connection = this.connections.get(id);
    if (connection) {
      connection.token = { ...token, additionalFields: token.additionalFields || {} };
      connection.guid = token.guid;
    }
  }

  /**
   * Mark connection as expired
   */
  public expireConnection(id: string): void {
    const connection = this.connections.get(id);
    if (connection) {
      connection.isExpired = true;
      this.emit('connectionExpired', connection);
      this.logger.debug('Connection expired', { id });
    }
  }

  /**
   * Close a connection
   */
  public closeConnection(id: string): void {
    const connection = this.connections.get(id);
    if (!connection) return;

    connection.isExpired = true;
    this.connections.delete(id);

    // Clean up associated session and stats
    this.sessions.delete(id);
    this.stats.delete(id);

    this.emit('connectionClosed', connection);
    this.logger.debug('Connection closed', { id });
  }

  /**
   * Close all connections
   */
  public closeAllConnections(): void {
    for (const [_id, connection] of this.connections) {
      connection.isExpired = true;
      this.emit('connectionClosed', connection);
    }
    this.connections.clear();
    this.sessions.clear();
    this.stats.clear();
    this.logger.info('All connections closed');
  }

  /**
   * Wait for all connections to close (with timeout)
   */
  public async waitForConnections(timeoutMs: number = 30000): Promise<void> {
    const startTime = Date.now();

    while (this.connections.size > 0) {
      if (Date.now() - startTime > timeoutMs) {
        this.logger.warning('Timeout waiting for connections to close', {
          remaining: this.connections.size,
        });
        break;
      }

      // Wait a bit
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }

  /**
   * Create a client session context
   */
  public createSession(
    connectionId: string,
    guid: string,
    token: { token: string; expiration: number; ip?: string; guid?: string; additionalFields?: Record<string, unknown> },
    ipAddress: string,
    userAgent: string,
    testType: 'download' | 'upload' | 'latency' | 'traceroute'
  ): ClientSessionContext {
    const session: ClientSessionContext = {
      connectionId,
      guid,
      token: { ...token, additionalFields: token.additionalFields || {} },
      ipAddress,
      userAgent,
      startTime: new Date(),
      testType,
      metadata: {},
    };

    this.sessions.set(connectionId, session);
    this.logger.debug('Session created', { connectionId, guid, testType });

    return session;
  }

  /**
   * Get session by connection ID
   */
  public getSession(connectionId: string): ClientSessionContext | undefined {
    return this.sessions.get(connectionId);
  }

  /**
   * Create upload stats recorder
   */
  public createStatsRecorder(connectionId: string): UploadStatsRecorder {
    const recorder: UploadStatsRecorder = {
      connectionId,
      sentBytes: 0,
      receivedBytes: 0,
      sentBytesTotal: 0,
      receivedBytesTotal: 0,
      testDurationMs: 0,
      congestionControl: 'cubic',
      windowScaling: true,
      startTime: new Date(),
    };

    this.stats.set(connectionId, recorder);
    return recorder;
  }

  /**
   * Get stats recorder
   */
  public getStatsRecorder(connectionId: string): UploadStatsRecorder | undefined {
    return this.stats.get(connectionId);
  }

  /**
   * Finalize stats recorder
   */
  public finalizeStatsRecorder(connectionId: string): UploadStatsRecorder | undefined {
    const recorder = this.stats.get(connectionId);
    if (recorder) {
      recorder.endTime = new Date();
      recorder.testDurationMs = recorder.endTime.getTime() - recorder.startTime.getTime();
      this.emit('statsFinalized', recorder);
    }
    return recorder;
  }

  /**
   * Get connection count
   */
  public getConnectionCount(): number {
    return this.connections.size;
  }

  /**
   * Get connection count by protocol
   */
  public getConnectionCountByProtocol(): Record<string, number> {
    const counts: Record<string, number> = { tcp: 0, udp: 0, websocket: 0 };

    for (const conn of this.connections.values()) {
      if (!conn.isExpired) {
        counts[conn.protocol]++;
      }
    }

    return counts;
  }

  /**
   * Get connection count by IP
   */
  public getConnectionCountByIp(): Record<string, number> {
    const counts: Record<string, number> = {};

    for (const conn of this.connections.values()) {
      if (!conn.isExpired) {
        counts[conn.remoteIp] = (counts[conn.remoteIp] || 0) + 1;
      }
    }

    return counts;
  }

  /**
   * Set maximum connections
   */
  public setMaxConnections(max: number): void {
    this.maxConnections = max;
  }

  /**
   * Set connection timeout
   */
  public setConnectionTimeout(timeoutMs: number): void {
    this.connectionTimeout = timeoutMs;
  }

  /**
   * Start cleanup timer for expired connections
   */
  private startCleanupTimer(): void {
    this.cleanupInterval = setInterval(() => {
      this.cleanupExpiredConnections();
    }, 60000); // Every minute
  }

  /**
   * Clean up expired connections
   */
  private cleanupExpiredConnections(): void {
    const now = Date.now();
    let cleaned = 0;

    for (const [id, connection] of this.connections) {
      const inactiveTime = now - connection.lastActivity.getTime();
      if (inactiveTime > this.connectionTimeout) {
        this.closeConnection(id);
        cleaned++;
      }
    }

    if (cleaned > 0) {
      this.logger.debug('Cleaned up expired connections', { count: cleaned });
    }
  }

  /**
   * Get active connection info for metrics
   */
  public getActiveConnectionInfo(): {
    total: number;
    byProtocol: Record<string, number>;
    byIp: Record<string, number>;
    totalBytesSent: number;
    totalBytesReceived: number;
  } {
    let totalBytesSent = 0;
    let totalBytesReceived = 0;

    for (const conn of this.connections.values()) {
      if (!conn.isExpired) {
        totalBytesSent += conn.bytesSent;
        totalBytesReceived += conn.bytesReceived;
      }
    }

    return {
      total: this.getConnectionCount(),
      byProtocol: this.getConnectionCountByProtocol(),
      byIp: this.getConnectionCountByIp(),
      totalBytesSent,
      totalBytesReceived,
    };
  }

  /**
   * Clean up resources
   */
  public destroy(): void {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
    }
    this.closeAllConnections();
    this.removeAllListeners();
  }
}

export default ConnectionTracker;