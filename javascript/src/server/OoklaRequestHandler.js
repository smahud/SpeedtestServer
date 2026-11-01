/**
 * Ookla Request Handler - Handles HTTP/REST and WebSocket requests for speed tests
 * Based on reverse engineering of OoklaServer RequestHandler.cpp
 * JavaScript implementation
 */

const EventEmitter = require('events');
const crypto = require('crypto');
const { Logger } = require('./Logger');
const { ClientAuthTokenValidator } = require('./ClientAuthTokenValidator');
const { ConnectionTracker } = require('./ConnectionTracker');
const { IpStatsManager } = require('./IpStatsManager');

class OoklaRequestHandler extends EventEmitter {
  constructor(config, logger, tokenValidator, connectionTracker, ipStatsManager) {
    super();
    this.config = config;
    this.logger = logger;
    this.tokenValidator = tokenValidator;
    this.connectionTracker = connectionTracker;
    this.ipStatsManager = ipStatsManager;
    this.routes = new Map();
    this.wsRoutes = new Map();

    this.registerRoutes();
  }

  async handleRequest(context) {
    const startTime = Date.now();

    try {
      // Check IP rate limits
      const ipCheck = this.ipStatsManager.isAllowed(context.ip);
      if (!ipCheck.allowed) {
        return this.createResponse(429, { 'Content-Type': 'application/json' }, {
          error: 'Rate limit exceeded',
          reason: ipCheck.reason,
        });
      }

      // Record connection
      this.ipStatsManager.recordConnection(context.ip);

      // Find matching route
      const routeKey = `${context.method}:${this.normalizePath(context.url)}`;
      const handler = this.routes.get(routeKey);

      if (!handler) {
        return this.createResponse(404, { 'Content-Type': 'application/json' }, {
          error: 'Not found',
        });
      }

      // Execute handler
      const response = await handler(context);

      // Record metrics
      const duration = Date.now() - startTime;
      this.emit('requestCompleted', {
        method: context.method,
        url: context.url,
        statusCode: response.statusCode,
        duration,
        ip: context.ip,
      });

      return response;

    } catch (error) {
      this.logger.error('Request handling error', { error, url: context.url });
      return this.createResponse(500, { 'Content-Type': 'application/json' }, {
        error: 'Internal server error',
      });
    }
  }

  async handleWebSocketUpgrade(context) {
    const routeKey = `WS:${this.normalizePath(context.url)}`;
    const handler = this.wsRoutes.get(routeKey);

    if (!handler) {
      return { accepted: false };
    }

    try {
      const response = await handler(context);
      return { accepted: response.statusCode === 101, response };
    } catch (error) {
      this.logger.error('WebSocket upgrade error', { error });
      return { accepted: false };
    }
  }

  registerRoutes() {
    // Health check
    this.registerRoute('GET', '/health', this.handleHealth.bind(this));
    this.registerRoute('GET', '/ping', this.handlePing.bind(this));

    // Configuration
    this.registerRoute('GET', '/config', this.handleConfig.bind(this));
    this.registerRoute('GET', '/settings', this.handleSettings.bind(this));

    // Token validation
    this.registerRoute('POST', '/auth/token', this.handleTokenValidation.bind(this));

    // Download test
    this.registerRoute('GET', '/download', this.handleDownload.bind(this));
    this.registerRoute('GET', '/download/:size', this.handleDownloadSize.bind(this));

    // Upload test
    this.registerRoute('POST', '/upload', this.handleUpload.bind(this));
    this.registerRoute('POST', '/upload/:size', this.handleUploadSize.bind(this));

    // Latency test
    this.registerRoute('GET', '/latency', this.handleLatency.bind(this));

    // Traceroute
    this.registerRoute('GET', '/traceroute', this.handleTraceroute.bind(this));

    // Metrics
    this.registerRoute('POST', '/metrics', this.handleMetrics.bind(this));

    // WebSocket routes
    this.registerWsRoute('WS', '/ws', this.handleWebSocket.bind(this));
    this.registerWsRoute('WS', '/ws/download', this.handleWsDownload.bind(this));
    this.registerWsRoute('WS', '/ws/upload', this.handleWsUpload.bind(this));
    this.registerWsRoute('WS', '/ws/latency', this.handleWsLatency.bind(this));
  }

  registerRoute(method, path, handler) {
    this.routes.set(`${method}:${this.normalizePath(path)}`, handler);
  }

  registerWsRoute(method, path, handler) {
    this.wsRoutes.set(`${method}:${this.normalizePath(path)}`, handler);
  }

  normalizePath(url) {
    const path = url.split('?')[0];
    // Replace parameterized segments
    return path.replace(/\/[^/]+(?=\/|$)/g, (match) => {
      if (match.startsWith('/:')) return match;
      return match;
    });
  }

  createResponse(statusCode, headers, body) {
    const bodyBuffer = Buffer.isBuffer(body) ? body : Buffer.from(JSON.stringify(body));
    return {
      statusCode,
      headers: {
        'Content-Length': bodyBuffer.length.toString(),
        ...headers,
      },
      body: bodyBuffer,
    };
  }

  // Route handlers

  async handleHealth(_context) {
    return this.createResponse(200, { 'Content-Type': 'application/json' }, {
      status: 'ok',
      version: '1.0.0',
      uptime: process.uptime(),
    });
  }

  async handlePing(_context) {
    return this.createResponse(200, { 'Content-Type': 'text/plain' }, 'pong');
  }

  async handleConfig(_context) {
    return this.createResponse(200, { 'Content-Type': 'application/json' }, {
      server: {
        id: this.config.host.id,
        version: '1.0.0',
      },
      client: {
        authToken: {
          enabled: true,
        },
        ipTracking: this.config.ipTracking,
      },
      test: {
        download: { enabled: true },
        upload: { enabled: true },
        latency: { enabled: true },
        traceroute: { enabled: this.config.performTraceroutes },
      },
    });
  }

  async handleSettings(_context) {
    return this.createResponse(200, { 'Content-Type': 'application/json' }, {
      allowedDomains: this.config.allowedDomains,
      tcpPorts: this.config.tcpPorts,
      udpPorts: this.config.udpPorts,
      httpPorts: this.config.httpPorts,
      useIPv6: this.config.useIPv6,
      useIPv4: this.config.useIPv4,
    });
  }

  async handleTokenValidation(context) {
    const token = context.headers['x-auth-token'] || context.query.token;
    const guid = context.headers['x-client-guid'] || context.query.guid;

    if (!token || !guid) {
      return this.createResponse(400, { 'Content-Type': 'application/json' }, {
        error: 'Missing token or GUID',
      });
    }

    const result = this.tokenValidator.validate(token, context.ip, guid);

    if (!result.isValid) {
      return this.createResponse(401, { 'Content-Type': 'application/json' }, {
        error: 'Invalid token',
        reason: result.reason,
      });
    }

    // Create session
    const connectionId = context.connectionId;
    this.connectionTracker.createSession(
      connectionId,
      guid,
      { token, expiration: Date.now() / 1000 + 3600 },
      context.ip,
      context.headers['user-agent'] || 'unknown',
      'download' // default
    );

    return this.createResponse(200, { 'Content-Type': 'application/json' }, {
      valid: true,
      sessionId: connectionId,
      fields: result.fields,
    });
  }

  async handleDownload(context) {
    const size = parseInt(context.query.size || '1048576', 10); // 1MB default
    const data = crypto.randomBytes(Math.min(size, 100 * 1024 * 1024)); // Max 100MB

    return this.createResponse(200, {
      'Content-Type': 'application/octet-stream',
      'Content-Length': data.length.toString(),
      'Cache-Control': 'no-cache, no-store, must-revalidate',
    }, data);
  }

  async handleDownloadSize(context) {
    return this.handleDownload(context);
  }

  async handleUpload(context) {
    const bytesReceived = context.body?.length || 0;

    // Update connection stats
    this.connectionTracker.updateActivity(context.connectionId, 0, bytesReceived);

    return this.createResponse(200, { 'Content-Type': 'application/json' }, {
      received: bytesReceived,
      status: 'ok',
    });
  }

  async handleUploadSize(context) {
    return this.handleUpload(context);
  }

  async handleLatency(context) {
    const timestamp = parseInt(context.query.ts || '0', 10);
    const now = Date.now();

    return this.createResponse(200, { 'Content-Type': 'application/json' }, {
      timestamp: now,
      clientTimestamp: timestamp,
      latency: timestamp ? now - timestamp : 0,
    });
  }

  async handleTraceroute(context) {
    if (!this.config.performTraceroutes) {
      return this.createResponse(403, { 'Content-Type': 'application/json' }, {
        error: 'Traceroute not enabled',
      });
    }

    const target = context.query.target || context.ip;

    // In production, this would perform actual traceroute
    return this.createResponse(200, { 'Content-Type': 'application/json' }, {
      target,
      hops: [
        { hop: 1, ip: '192.168.1.1', rtt: 1.2 },
        { hop: 2, ip: '10.0.0.1', rtt: 5.4 },
        { hop: 3, ip: target, rtt: 12.7 },
      ],
    });
  }

  async handleMetrics(_context) {
    // Accept metrics from clients
    return this.createResponse(200, { 'Content-Type': 'application/json' }, {
      status: 'received',
    });
  }

  async handleWebSocket(context) {
    return this.createResponse(101, {
      'Upgrade': 'websocket',
      'Connection': 'Upgrade',
      'Sec-WebSocket-Accept': this.computeWsAccept(context.headers['sec-websocket-key'] || ''),
    }, '');
  }

  async handleWsDownload(context) {
    return this.handleWebSocket(context);
  }

  async handleWsUpload(context) {
    return this.handleWebSocket(context);
  }

  async handleWsLatency(context) {
    return this.handleWebSocket(context);
  }

  computeWsAccept(key) {
    const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
    return crypto.createHash('sha1').update(key + GUID).digest('base64');
  }

  updateConfig(config) {
    this.config = { ...this.config, ...config };
  }

  async start() {
    this.logger.debug('OoklaRequestHandler started');
  }

  async stop() {
    this.destroy();
    this.logger.debug('OoklaRequestHandler stopped');
  }

  async forceStop() {
    this.destroy();
    this.logger.debug('OoklaRequestHandler force stopped');
  }

  getRoutes() {
    return Array.from(this.routes.keys()).concat(Array.from(this.wsRoutes.keys()));
  }

  destroy() {
    this.routes.clear();
    this.wsRoutes.clear();
    this.removeAllListeners();
  }
}

module.exports = { OoklaRequestHandler };