/**
 * Connection Tracker - Tracks active connections and manages connection lifecycle
 * Based on reverse engineering of OoklaServer ConnectionTracker/ConnectionWrapper
 * JavaScript implementation
 */

const EventEmitter = require('events');

class ConnectionTracker extends EventEmitter {
  constructor(logger) {
    super();
    this.logger = logger;
    this.connections = new Map();
    this.sessions = new Map();
    this.stats = new Map();
    this.maxConnections = 10000;
    this.cleanupInterval = null;
    this.connectionTimeout = 3600000; // 1 hour default
    this.startCleanupTimer();
  }

  createConnection(id, remoteIp, remotePort, localIp, localPort, protocol = 'tcp') {
    if (this.connections.size >= this.maxConnections) {
      throw new Error('Maximum connections reached');
    }

    const now = new Date();
    const connection = {
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

  getConnection(id) {
    return this.connections.get(id);
  }

  getAllConnections() {
    return Array.from(this.connections.values()).filter(c => !c.isExpired);
  }

  getConnectionsByIp(ip) {
    return Array.from(this.connections.values()).filter(c => c.remoteIp === ip && !c.isExpired);
  }

  updateActivity(id, bytesSent = 0, bytesReceived = 0) {
    const connection = this.connections.get(id);
    if (!connection) return;

    connection.lastActivity = new Date();
    connection.bytesSent += bytesSent;
    connection.bytesReceived += bytesReceived;

    const stat = this.stats.get(id);
    if (stat) {
      stat.sentBytes += bytesSent;
      stat.receivedBytes += bytesReceived;
    }
  }

  setConnectionToken(id, token) {
    const connection = this.connections.get(id);
    if (connection) {
      connection.token = { ...token, additionalFields: token.additionalFields || {} };
      connection.guid = token.guid;
    }
  }

  expireConnection(id) {
    const connection = this.connections.get(id);
    if (connection) {
      connection.isExpired = true;
      this.emit('connectionExpired', connection);
      this.logger.debug('Connection expired', { id });
    }
  }

  closeConnection(id) {
    const connection = this.connections.get(id);
    if (!connection) return;

    connection.isExpired = true;
    this.connections.delete(id);

    this.sessions.delete(id);
    this.stats.delete(id);

    this.emit('connectionClosed', connection);
    this.logger.debug('Connection closed', { id });
  }

  closeAllConnections() {
    for (const [id, connection] of this.connections) {
      connection.isExpired = true;
      this.emit('connectionClosed', connection);
    }
    this.connections.clear();
    this.sessions.clear();
    this.stats.clear();
    this.logger.info('All connections closed');
  }

  async waitForConnections(timeoutMs = 30000) {
    const startTime = Date.now();

    while (this.connections.size > 0) {
      if (Date.now() - startTime > timeoutMs) {
        this.logger.warning('Timeout waiting for connections to close', {
          remaining: this.connections.size,
        });
        break;
      }

      await new Promise(resolve => setTimeout(resolve, 100));
    }
  }

  createSession(connectionId, guid, token, ipAddress, userAgent, testType) {
    const session = {
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

  getSession(connectionId) {
    return this.sessions.get(connectionId);
  }

  createStatsRecorder(connectionId) {
    const recorder = {
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

  getStatsRecorder(connectionId) {
    return this.stats.get(connectionId);
  }

  finalizeStatsRecorder(connectionId) {
    const recorder = this.stats.get(connectionId);
    if (recorder) {
      recorder.endTime = new Date();
      recorder.testDurationMs = recorder.endTime.getTime() - recorder.startTime.getTime();
      this.emit('statsFinalized', recorder);
    }
    return recorder;
  }

  getConnectionCount() {
    return this.connections.size;
  }

  getConnectionCountByProtocol() {
    const counts = { tcp: 0, udp: 0, websocket: 0 };

    for (const conn of this.connections.values()) {
      if (!conn.isExpired) {
        counts[conn.protocol]++;
      }
    }

    return counts;
  }

  getConnectionCountByIp() {
    const counts = {};

    for (const conn of this.connections.values()) {
      if (!conn.isExpired) {
        counts[conn.remoteIp] = (counts[conn.remoteIp] || 0) + 1;
      }
    }

    return counts;
  }

  setMaxConnections(max) {
    this.maxConnections = max;
  }

  setConnectionTimeout(timeoutMs) {
    this.connectionTimeout = timeoutMs;
  }

  startCleanupTimer() {
    this.cleanupInterval = setInterval(() => {
      this.cleanupExpiredConnections();
    }, 60000); // Every minute
  }

  cleanupExpiredConnections() {
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

  getActiveConnectionInfo() {
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

  destroy() {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
    }
    this.closeAllConnections();
    this.removeAllListeners();
  }
}

module.exports = { ConnectionTracker };
