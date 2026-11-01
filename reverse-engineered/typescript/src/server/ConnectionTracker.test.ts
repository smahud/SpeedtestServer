/**
 * ConnectionTracker Tests
 */

import { ConnectionTracker } from './ConnectionTracker';
import { Logger } from './Logger';
import { LogConfig } from '../types/core';

// Mock logger config
const mockLogConfig: LogConfig = {
  loggers: {
    app: {
      name: 'app',
      level: 'information',
      channel: {
        class: 'ConsoleChannel',
        pattern: '%Y-%m-%d %H:%M:%S [%P - %I] [%p] %t',
      },
    },
  },
  defaultLevel: 'information',
  pattern: '%Y-%m-%d %H:%M:%S [%P - %I] [%p] %t',
};

describe('ConnectionTracker', () => {
  let tracker: ConnectionTracker;
  let logger: Logger;

  beforeEach(() => {
    logger = new Logger(mockLogConfig);
    tracker = new ConnectionTracker(logger);
  });

  afterEach(() => {
    tracker.destroy();
    logger.destroy();
  });

  describe('createConnection', () => {
    it('should create a new connection', () => {
      const conn = tracker.createConnection(
        'conn-1',
        '192.168.1.1',
        12345,
        '10.0.0.1',
        8080,
        'tcp'
      );

      expect(conn.id).toBe('conn-1');
      expect(conn.remoteIp).toBe('192.168.1.1');
      expect(conn.remotePort).toBe(12345);
      expect(conn.localIp).toBe('10.0.0.1');
      expect(conn.localPort).toBe(8080);
      expect(conn.protocol).toBe('tcp');
      expect(conn.isExpired).toBe(false);
      expect(conn.bytesSent).toBe(0);
      expect(conn.bytesReceived).toBe(0);
    });

    it('should create connections with different protocols', () => {
      const tcpConn = tracker.createConnection('tcp-1', '1.1.1.1', 1111, '2.2.2.2', 8080, 'tcp');
      const udpConn = tracker.createConnection('udp-1', '1.1.1.1', 2222, '2.2.2.2', 8080, 'udp');
      const wsConn = tracker.createConnection('ws-1', '1.1.1.1', 3333, '2.2.2.2', 8080, 'websocket');

      expect(tcpConn.protocol).toBe('tcp');
      expect(udpConn.protocol).toBe('udp');
      expect(wsConn.protocol).toBe('websocket');
    });

    it('should throw when max connections reached', () => {
      tracker.setMaxConnections(2);
      tracker.createConnection('conn-1', '1.1.1.1', 1111, '2.2.2.2', 8080);
      tracker.createConnection('conn-2', '1.1.1.1', 2222, '2.2.2.2', 8080);

      expect(() => {
        tracker.createConnection('conn-3', '1.1.1.1', 3333, '2.2.2.2', 8080);
      }).toThrow('Maximum connections reached');
    });
  });

  describe('getConnection', () => {
    it('should return connection by id', () => {
      const created = tracker.createConnection('conn-1', '192.168.1.1', 12345, '10.0.0.1', 8080);
      const found = tracker.getConnection('conn-1');

      expect(found).toBe(created);
    });

    it('should return undefined for non-existent connection', () => {
      const found = tracker.getConnection('non-existent');
      expect(found).toBeUndefined();
    });
  });

  describe('getAllConnections', () => {
    it('should return all active connections', () => {
      tracker.createConnection('conn-1', '1.1.1.1', 1111, '2.2.2.2', 8080);
      tracker.createConnection('conn-2', '1.1.1.1', 2222, '2.2.2.2', 8080);
      tracker.createConnection('conn-3', '1.1.1.1', 3333, '2.2.2.2', 8080);

      const connections = tracker.getAllConnections();
      expect(connections).toHaveLength(3);
    });

    it('should not return expired connections', () => {
      tracker.createConnection('conn-1', '1.1.1.1', 1111, '2.2.2.2', 8080);
      tracker.createConnection('conn-2', '1.1.1.1', 2222, '2.2.2.2', 8080);
      tracker.expireConnection('conn-1');

      const connections = tracker.getAllConnections();
      expect(connections).toHaveLength(1);
      expect(connections[0].id).toBe('conn-2');
    });
  });

  describe('updateActivity', () => {
    it('should update connection activity and bytes', () => {
      tracker.createConnection('conn-1', '1.1.1.1', 1111, '2.2.2.2', 8080);
      tracker.updateActivity('conn-1', 1000, 500);

      const conn = tracker.getConnection('conn-1');
      expect(conn?.bytesSent).toBe(1000);
      expect(conn?.bytesReceived).toBe(500);
    });

    it('should handle non-existent connection gracefully', () => {
      expect(() => {
        tracker.updateActivity('non-existent', 100, 100);
      }).not.toThrow();
    });
  });

  describe('setConnectionToken', () => {
    it('should set token on connection', () => {
      tracker.createConnection('conn-1', '1.1.1.1', 1111, '2.2.2.2', 8080);
      tracker.setConnectionToken('conn-1', {
        token: 'test-token',
        expiration: Date.now() / 1000 + 3600,
        guid: 'test-guid',
      });

      const conn = tracker.getConnection('conn-1');
      expect(conn?.token?.token).toBe('test-token');
      expect(conn?.guid).toBe('test-guid');
    });
  });

  describe('expireConnection', () => {
    it('should mark connection as expired', () => {
      tracker.createConnection('conn-1', '1.1.1.1', 1111, '2.2.2.2', 8080);
      tracker.expireConnection('conn-1');

      const conn = tracker.getConnection('conn-1');
      expect(conn?.isExpired).toBe(true);
    });
  });

  describe('closeConnection', () => {
    it('should remove connection and clean up session/stats', () => {
      tracker.createConnection('conn-1', '1.1.1.1', 1111, '2.2.2.2', 8080);
      tracker.createSession('conn-1', 'guid-1', { token: 't', expiration: 0 }, '1.1.1.1', 'ua', 'download');
      tracker.createStatsRecorder('conn-1');

      tracker.closeConnection('conn-1');

      expect(tracker.getConnection('conn-1')).toBeUndefined();
      expect(tracker.getSession('conn-1')).toBeUndefined();
      expect(tracker.getStatsRecorder('conn-1')).toBeUndefined();
    });
  });

  describe('getConnectionCount', () => {
    it('should return correct connection count', () => {
      expect(tracker.getConnectionCount()).toBe(0);

      tracker.createConnection('conn-1', '1.1.1.1', 1111, '2.2.2.2', 8080);
      expect(tracker.getConnectionCount()).toBe(1);

      tracker.createConnection('conn-2', '1.1.1.1', 2222, '2.2.2.2', 8080);
      expect(tracker.getConnectionCount()).toBe(2);
    });
  });

  describe('getConnectionCountByProtocol', () => {
    it('should return counts by protocol', () => {
      tracker.createConnection('tcp-1', '1.1.1.1', 1111, '2.2.2.2', 8080, 'tcp');
      tracker.createConnection('tcp-2', '1.1.1.1', 2222, '2.2.2.2', 8080, 'tcp');
      tracker.createConnection('udp-1', '1.1.1.1', 3333, '2.2.2.2', 8080, 'udp');
      tracker.createConnection('ws-1', '1.1.1.1', 4444, '2.2.2.2', 8080, 'websocket');

      const counts = tracker.getConnectionCountByProtocol();
      expect(counts.tcp).toBe(2);
      expect(counts.udp).toBe(1);
      expect(counts.websocket).toBe(1);
    });
  });

  describe('getConnectionCountByIp', () => {
    it('should return counts by IP', () => {
      tracker.createConnection('conn-1', '1.1.1.1', 1111, '2.2.2.2', 8080);
      tracker.createConnection('conn-2', '1.1.1.1', 2222, '2.2.2.2', 8080);
      tracker.createConnection('conn-3', '2.2.2.2', 3333, '3.3.3.3', 8080);

      const counts = tracker.getConnectionCountByIp();
      expect(counts['1.1.1.1']).toBe(2);
      expect(counts['2.2.2.2']).toBe(1);
    });
  });

  describe('createSession', () => {
    it('should create session with correct properties', () => {
      tracker.createConnection('conn-1', '1.1.1.1', 1111, '2.2.2.2', 8080);
      const session = tracker.createSession(
        'conn-1',
        'test-guid',
        { token: 'test-token', expiration: Date.now() / 1000 + 3600 },
        '1.1.1.1',
        'TestAgent/1.0',
        'download'
      );

      expect(session.connectionId).toBe('conn-1');
      expect(session.guid).toBe('test-guid');
      expect(session.ipAddress).toBe('1.1.1.1');
      expect(session.userAgent).toBe('TestAgent/1.0');
      expect(session.testType).toBe('download');
      expect(session.metadata).toEqual({});
    });
  });

  describe('createStatsRecorder', () => {
    it('should create stats recorder', () => {
      tracker.createConnection('conn-1', '1.1.1.1', 1111, '2.2.2.2', 8080);
      const recorder = tracker.createStatsRecorder('conn-1');

      expect(recorder.connectionId).toBe('conn-1');
      expect(recorder.sentBytes).toBe(0);
      expect(recorder.receivedBytes).toBe(0);
      expect(recorder.congestionControl).toBe('cubic');
      expect(recorder.windowScaling).toBe(true);
    });
  });

  describe('finalizeStatsRecorder', () => {
    it('should finalize stats with duration', () => {
      tracker.createConnection('conn-1', '1.1.1.1', 1111, '2.2.2.2', 8080);
      tracker.createStatsRecorder('conn-1');

      // Wait a bit to ensure duration > 0
      const recorder = tracker.finalizeStatsRecorder('conn-1');
      expect(recorder).toBeDefined();
      expect(recorder?.testDurationMs).toBeGreaterThanOrEqual(0);
      expect(recorder?.endTime).toBeDefined();
    });
  });

  describe('getActiveConnectionInfo', () => {
    it('should return aggregated connection info', () => {
      tracker.createConnection('conn-1', '1.1.1.1', 1111, '2.2.2.2', 8080, 'tcp');
      tracker.createConnection('conn-2', '1.1.1.1', 2222, '2.2.2.2', 8080, 'udp');
      tracker.updateActivity('conn-1', 1000, 500);
      tracker.updateActivity('conn-2', 2000, 1000);

      const info = tracker.getActiveConnectionInfo();
      expect(info.total).toBe(2);
      expect(info.byProtocol.tcp).toBe(1);
      expect(info.byProtocol.udp).toBe(1);
      expect(info.byIp['1.1.1.1']).toBe(2);
      expect(info.totalBytesSent).toBe(3000);
      expect(info.totalBytesReceived).toBe(1500);
    });
  });
});