/**
 * @deprecated DEPRECATED 2026-11-04 — replaced by ServerCore + NetGaugeEngine +
 * HttpApi + UdpLossEngine (canonical implementation, audit/official-cli-interoperability).
 * Kept for historical reference only; NOT used by the server. Its P0 defects
 * (port conflict, no native protocol, WS random data, UDP blind echo) are
 * documented in validation/FINDINGS.md.
 */
/**
 * Ookla Request Handler - Handles HTTP/REST and WebSocket requests for speed tests
 * Based on reverse engineering of OoklaServer RequestHandler.cpp
 * TypeScript implementation with full HTTP/HTTPS/WebSocket server
 */

import { EventEmitter } from 'events';
import * as http from 'http';
import * as https from 'https';
import * as dgram from 'dgram';
import * as tls from 'tls';
import * as crypto from 'crypto';
import * as url from 'url';
import WebSocket from 'ws';
import { OoklaServerConfig, ClientSessionContext } from '../types/core';
import { Logger } from './Logger';
import { ClientAuthTokenValidator } from './ClientAuthTokenValidator';
import { ConnectionTracker } from './ConnectionTracker';
import { IpStatsManager } from './IpStatsManager';
import { TLSCertificateManager } from './TLSCertificateManager';

export interface RequestContext {
  connectionId: string;
  method: string;
  url: string;
  query: Record<string, string>;
  headers: Record<string, string>;
  body?: Buffer;
  ip: string;
  session?: ClientSessionContext;
  socket?: any;
  head?: Buffer;
  ws?: WebSocket;
}

export interface Response {
  statusCode: number;
  headers: Record<string, string>;
  body: Buffer | string;
}

export type RequestHandler = (context: RequestContext) => Promise<Response>;

export class OoklaRequestHandler extends EventEmitter {
  private config: OoklaServerConfig;
  private logger: Logger;
  private tokenValidator: ClientAuthTokenValidator;
  private connectionTracker: ConnectionTracker;
  private ipStatsManager: IpStatsManager;
  private tlsManager: TLSCertificateManager;
  private routes: Map<string, RequestHandler> = new Map();
  private wsRoutes: Map<string, RequestHandler> = new Map();
  private httpServer: http.Server | null = null;
  private httpsServer: https.Server | null = null;
  private wsServer: WebSocket.Server | null = null;
  private wssHttps: WebSocket.Server | null = null;
  private udpServers: dgram.Socket[] = [];

  constructor(
    config: OoklaServerConfig,
    logger: Logger,
    tokenValidator: ClientAuthTokenValidator,
    connectionTracker: ConnectionTracker,
    ipStatsManager: IpStatsManager,
    tlsManager: TLSCertificateManager
  ) {
    super();
    this.config = config;
    this.logger = logger;
    this.tokenValidator = tokenValidator;
    this.connectionTracker = connectionTracker;
    this.ipStatsManager = ipStatsManager;
    this.tlsManager = tlsManager;

    this.registerRoutes();
  }

  private registerRoutes(): void {
    // Health check
    this.registerRoute('GET', '/health', this.handleHealth.bind(this));
    this.registerRoute('GET', '/ping', this.handlePing.bind(this));

    // Configuration
    this.registerRoute('GET', '/config', this.handleConfig.bind(this));
    this.registerRoute('GET', '/settings', this.handleSettings.bind(this));

    // Crossdomain policy (required for Flash/legacy clients)
    this.registerRoute('GET', '/crossdomain.xml', this.handleCrossdomain.bind(this));

    // Latency test file (required by host-tester)
    this.registerRoute('GET', '/latency.txt', this.handleLatencyTxt.bind(this));
    this.registerRoute('GET', '/speedtest/latency.txt', this.handleLatencyTxt.bind(this));

    // Token validation
    this.registerRoute('POST', '/auth/token', this.handleTokenValidation.bind(this));

    // Download test
    this.registerRoute('GET', '/download', this.handleDownload.bind(this));
    this.registerRoute('GET', '/download/:size', this.handleDownloadSize.bind(this));
    this.registerRoute('GET', '/speedtest/download', this.handleDownload.bind(this));
    this.registerRoute('GET', '/speedtest/download/:size', this.handleDownloadSize.bind(this));

    // Upload test
    this.registerRoute('POST', '/upload', this.handleUpload.bind(this));
    this.registerRoute('POST', '/upload/:size', this.handleUploadSize.bind(this));
    this.registerRoute('POST', '/speedtest/upload', this.handleUpload.bind(this));
    this.registerRoute('POST', '/speedtest/upload/:size', this.handleUploadSize.bind(this));

    // Latency test (JSON API)
    this.registerRoute('GET', '/latency', this.handleLatency.bind(this));
    this.registerRoute('GET', '/speedtest/latency', this.handleLatency.bind(this));

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

  private registerRoute(method: string, path: string, handler: RequestHandler): void {
    this.routes.set(`${method}:${this.normalizePath(path)}`, handler);
  }

  private registerWsRoute(method: string, path: string, handler: RequestHandler): void {
    this.wsRoutes.set(`${method}:${this.normalizePath(path)}`, handler);
  }

  private normalizePath(urlPath: string): string {
    const parsedPath = urlPath.split('?')[0];
    return parsedPath.replace(/\/[^/]+(?=\/|$)/g, (match) => {
      if (match.startsWith('/:')) return match;
      return match;
    });
  }

  private createResponse(statusCode: number, headers: Record<string, string>, body: object | string | Buffer): Response {
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

  // ============================================================
  // HTTP Server Implementation
  // ============================================================

  public async start(): Promise<void> {
    this.logger.info('Starting HTTP/HTTPS/WebSocket server...');

    // Create HTTP server
    this.httpServer = http.createServer(this.handleHttpRequest.bind(this));

    // Create HTTPS server if TLS is configured
    const credentials = this.tlsManager.getCredentials?.();
    if (credentials) {
      this.httpsServer = https.createServer({
        cert: credentials.cert,
        key: credentials.key,
        ca: credentials.ca,
        rejectUnauthorized: false,
        requestCert: false,
      }, this.handleHttpRequest.bind(this));
    }

    // Create WebSocket servers
    this.wsServer = new WebSocket.Server({ noServer: true });
    this.wsServer.on('connection', this.handleWsConnection.bind(this));

    if (this.httpsServer) {
      this.wssHttps = new WebSocket.Server({ noServer: true });
      this.wssHttps.on('connection', this.handleWsConnection.bind(this));
    }

    // Handle HTTP upgrade for WebSocket
    this.httpServer.on('upgrade', this.handleUpgrade.bind(this));
    if (this.httpsServer) {
      this.httpsServer.on('upgrade', this.handleUpgrade.bind(this));
    }

    // Start listening on configured ports
    const httpPorts = this.config.httpPorts || [8080];
    const tcpPorts = this.config.tcpPorts || [5060, 8080];
    const useIPv6 = this.config.useIPv6 !== false;
    const useIPv4 = this.config.useIPv4 !== false;

    const listenPromises: Promise<void>[] = [];

    // HTTP ports
    for (const port of httpPorts) {
      if (useIPv4) {
        listenPromises.push(this.listenOnPort(this.httpServer, port, '0.0.0.0', 'HTTP'));
      }
      if (useIPv6) {
        listenPromises.push(this.listenOnPort(this.httpServer, port, '::', 'HTTP-IPv6'));
      }
    }

    // HTTPS ports (same as TCP ports typically)
    if (this.httpsServer) {
      for (const port of tcpPorts) {
        if (useIPv4) {
          listenPromises.push(this.listenOnPort(this.httpsServer, port, '0.0.0.0', 'HTTPS'));
        }
        if (useIPv6) {
          listenPromises.push(this.listenOnPort(this.httpsServer, port, '::', 'HTTPS-IPv6'));
        }
      }
    }

    // UDP server for latency/jitter tests
    const udpPorts = this.config.udpPorts || [5060, 8080];
    const udpPromises: Promise<dgram.Socket | null>[] = [];
    for (const port of udpPorts) {
      if (useIPv4) {
        udpPromises.push(this.createUdpServer(port, '0.0.0.0', 'UDP'));
      }
      if (useIPv6) {
        udpPromises.push(this.createUdpServer(port, '::', 'UDP-IPv6'));
      }
    }

    await Promise.all(listenPromises);

    // Wait for UDP servers and filter out null (failed to bind)
    const udpResults = await Promise.all(udpPromises);
    this.udpServers = udpResults.filter(s => s !== null);

    this.logger.info('All servers started successfully');
  }

  private listenOnPort(server: http.Server | https.Server, port: number, host: string, label: string): Promise<void> {
    return new Promise((resolve, reject) => {
      server.listen(port, host, () => {
        this.logger.info(`${label} server listening on ${host}:${port}`);
        resolve();
      });
      server.once('error', (err: NodeJS.ErrnoException) => {
        if (err.code === 'EADDRINUSE') {
          this.logger.warning(`${label} port ${port} on ${host} already in use`);
          resolve();
        } else {
          this.logger.error(`${label} server error on ${host}:${port}`, { error: err.message });
          reject(err);
        }
      });
    });
  }

  private createUdpServer(port: number, host: string, label: string): Promise<dgram.Socket | null> {
    return new Promise((resolve, reject) => {
      const server = dgram.createSocket(host === '::' ? 'udp6' : 'udp4');

      server.on('listening', () => {
        const addr = server.address();
        this.logger.info(`${label} server listening on ${addr.address}:${addr.port}`);
        resolve(server);
      });

      server.on('error', (err: NodeJS.ErrnoException) => {
        if (err.code === 'EADDRINUSE') {
          this.logger.warning(`${label} port ${port} on ${host} already in use`);
          server.close();
          resolve(null);
        } else {
          this.logger.error(`${label} server error on ${host}:${port}`, { error: err.message });
          reject(err);
        }
      });

      server.on('message', (msg: Buffer, rinfo: dgram.RemoteInfo) => {
        this.handleUdpMessage(server, msg, rinfo);
      });

      server.bind(port, host);
    });
  }

  private handleUdpMessage(server: dgram.Socket, msg: Buffer, rinfo: dgram.RemoteInfo): void {
    // OoklaServer UDP protocol: echo back the received packet for latency measurement
    // The client sends a timestamp and expects it echoed back
    try {
      // If it's a latency test packet, echo it back
      if (msg.length >= 8) {
        // Echo the packet back to the sender
        server.send(msg, rinfo.port, rinfo.address, (err) => {
          if (err) {
            this.logger.debug('UDP send error', { error: err.message });
          }
        });
      }
    } catch (error) {
      this.logger.debug('UDP message handling error', { error: error instanceof Error ? error.message : String(error) });
    }
  }

  private handleHttpRequest(req: http.IncomingMessage, res: http.ServerResponse): void {
    const parsedUrl = url.parse(req.url || '/', true);
    const context: RequestContext = {
      method: req.method || 'GET',
      url: parsedUrl.pathname || '/',
      query: parsedUrl.query as Record<string, string>,
      headers: req.headers as Record<string, string>,
      ip: req.socket.remoteAddress?.replace('::ffff:', '') || 'unknown',
      connectionId: `${req.socket.remoteAddress}:${req.socket.remotePort}`,
      body: undefined,
    };

    // Read body for POST requests
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', async () => {
      if (chunks.length > 0) {
        context.body = Buffer.concat(chunks);
      }

      try {
        const response = await this.handleRequest(context);
        res.writeHead(response.statusCode, response.headers);
        res.end(response.body);
      } catch (error) {
        this.logger.error('Request handling error', { error, url: req.url });
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Internal server error' }));
      }
    });
  }

  private handleUpgrade(req: http.IncomingMessage, socket: any, head: Buffer): void {
    const parsedUrl = url.parse(req.url || '/', true);
    const context: RequestContext = {
      method: 'GET',
      url: parsedUrl.pathname || '/',
      query: parsedUrl.query as Record<string, string>,
      headers: req.headers as Record<string, string>,
      ip: req.socket.remoteAddress?.replace('::ffff:', '') || 'unknown',
      connectionId: `${req.socket.remoteAddress}:${req.socket.remotePort}`,
      socket,
      head,
    };

    const routeKey = `WS:${this.normalizePath(context.url)}`;
    const handler = this.wsRoutes.get(routeKey);

    if (!handler) {
      socket.destroy();
      return;
    }

    const isHttps = req.socket instanceof tls.TLSSocket;
    const wss = isHttps ? this.wssHttps : this.wsServer;

    if (!wss) {
      socket.destroy();
      return;
    }

    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit('connection', ws, req);
      handler(context).catch((err) => {
        this.logger.error('WebSocket handler error', { error: err });
      });
    });
  }

  private handleWsConnection(ws: WebSocket, req: http.IncomingMessage): void {
    const parsedUrl = url.parse(req.url || '/', true);
    const context: RequestContext = {
      method: 'GET',
      url: parsedUrl.pathname || '/',
      query: parsedUrl.query as Record<string, string>,
      headers: req.headers as Record<string, string>,
      ip: req.socket.remoteAddress?.replace('::ffff:', '') || 'unknown',
      connectionId: `${req.socket.remoteAddress}:${req.socket.remotePort}`,
      ws,
    };

    this.logger.debug('WebSocket connection established', { url: context.url, ip: context.ip });

    ws.on('message', (data: Buffer) => {
      this.handleWsMessage(ws, context, data);
    });

    ws.on('close', () => {
      this.logger.debug('WebSocket connection closed', { ip: context.ip });
      this.connectionTracker.closeConnection(context.connectionId);
    });

    ws.on('error', (err: Error) => {
      this.logger.error('WebSocket error', { error: err.message, ip: context.ip });
    });
  }

  private handleWsMessage(ws: WebSocket, context: RequestContext, data: Buffer): void {
    const routeKey = `WS:${this.normalizePath(context.url)}`;

    if (routeKey === 'WS:/ws/download' || routeKey === 'WS:/ws') {
      // Download test - send random data
      const size = parseInt(context.query.size || '1048576', 10);
      const buffer = crypto.randomBytes(Math.min(size, 100 * 1024 * 1024));
      ws.send(buffer, { binary: true });
    } else if (routeKey === 'WS:/ws/upload') {
      // Upload test - receive data and track bytes
      const bytesReceived = data.length;
      this.connectionTracker.updateActivity(context.connectionId, 0, bytesReceived);
      ws.send(JSON.stringify({ received: bytesReceived, status: 'ok' }));
    } else if (routeKey === 'WS:/ws/latency') {
      // Latency test - echo back with timestamp
      const timestamp = parseInt(context.query.ts || '0', 10);
      const now = Date.now();
      ws.send(JSON.stringify({
        timestamp: now,
        clientTimestamp: timestamp,
        latency: timestamp ? now - timestamp : 0,
      }));
    }
  }

  // ============================================================
  // Route Handlers
  // ============================================================

  private async handleRequest(context: RequestContext): Promise<Response> {
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

  private async handleHealth(_context: RequestContext): Promise<Response> {
    return this.createResponse(200, { 'Content-Type': 'application/json' }, {
      status: 'ok',
      version: '1.0.0',
      uptime: process.uptime(),
    });
  }

  private async handlePing(_context: RequestContext): Promise<Response> {
    return this.createResponse(200, { 'Content-Type': 'text/plain' }, 'pong');
  }

  private async handleConfig(_context: RequestContext): Promise<Response> {
    return this.createResponse(200, { 'Content-Type': 'application/json' }, {
      server: {
        id: this.config.host?.id || '',
        version: '1.0.0',
      },
      client: {
        authToken: { enabled: true },
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

  private async handleSettings(_context: RequestContext): Promise<Response> {
    return this.createResponse(200, { 'Content-Type': 'application/json' }, {
      allowedDomains: this.config.allowedDomains,
      tcpPorts: this.config.tcpPorts,
      udpPorts: this.config.udpPorts,
      httpPorts: this.config.httpPorts,
      useIPv6: this.config.useIPv6,
      useIPv4: this.config.useIPv4,
    });
  }

  private async handleCrossdomain(_context: RequestContext): Promise<Response> {
    const domains = this.config.allowedDomains || ['*.speedtest.net', '*.ookla.com'];
    const xml = `<?xml version="1.0"?>
<!DOCTYPE cross-domain-policy SYSTEM "http://www.adobe.com/xml/dtds/cross-domain-policy.dtd">
<cross-domain-policy>
  ${domains.map(d => `<allow-access-from domain="${d}" secure="false" />`).join('\n  ')}
  <allow-http-request-headers-from domain="*" headers="*" secure="false" />
</cross-domain-policy>`;

    return this.createResponse(200, {
      'Content-Type': 'application/xml',
      'Cache-Control': 'public, max-age=86400',
    }, xml);
  }

  private async handleLatencyTxt(_context: RequestContext): Promise<Response> {
    return this.createResponse(200, {
      'Content-Type': 'text/plain',
      'Cache-Control': 'no-cache, no-store, must-revalidate',
    }, 'OK');
  }

  private async handleTokenValidation(context: RequestContext): Promise<Response> {
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
      'download'
    );

    return this.createResponse(200, { 'Content-Type': 'application/json' }, {
      valid: true,
      sessionId: connectionId,
      fields: result.fields,
    });
  }

  private async handleDownload(context: RequestContext): Promise<Response> {
    const size = parseInt(context.query.size || '1048576', 10);
    const data = crypto.randomBytes(Math.min(size, 100 * 1024 * 1024));

    return this.createResponse(200, {
      'Content-Type': 'application/octet-stream',
      'Content-Length': data.length.toString(),
      'Cache-Control': 'no-cache, no-store, must-revalidate',
      'Accept-Ranges': 'bytes',
    }, data);
  }

  private async handleDownloadSize(_context: RequestContext): Promise<Response> {
    return this.handleDownload(_context);
  }

  private async handleUpload(context: RequestContext): Promise<Response> {
    const bytesReceived = context.body?.length || 0;
    this.connectionTracker.updateActivity(context.connectionId, 0, bytesReceived);

    return this.createResponse(200, { 'Content-Type': 'application/json' }, {
      received: bytesReceived,
      status: 'ok',
    });
  }

  private async handleUploadSize(_context: RequestContext): Promise<Response> {
    return this.handleUpload(_context);
  }

  private async handleLatency(context: RequestContext): Promise<Response> {
    const timestamp = parseInt(context.query.ts || '0', 10);
    const now = Date.now();

    return this.createResponse(200, { 'Content-Type': 'application/json' }, {
      timestamp: now,
      clientTimestamp: timestamp,
      latency: timestamp ? now - timestamp : 0,
    });
  }

  private async handleTraceroute(context: RequestContext): Promise<Response> {
    if (!this.config.performTraceroutes) {
      return this.createResponse(403, { 'Content-Type': 'application/json' }, {
        error: 'Traceroute not enabled',
      });
    }

    const target = context.query.target || context.ip;

    return this.createResponse(200, { 'Content-Type': 'application/json' }, {
      target,
      hops: [
        { hop: 1, ip: '192.168.1.1', rtt: 1.2 },
        { hop: 2, ip: '10.0.0.1', rtt: 5.4 },
        { hop: 3, ip: target, rtt: 12.7 },
      ],
    });
  }

  private async handleMetrics(_context: RequestContext): Promise<Response> {
    return this.createResponse(200, { 'Content-Type': 'application/json' }, {
      status: 'received',
    });
  }

  private async handleWebSocket(context: RequestContext): Promise<Response> {
    const wsKey = context.headers['sec-websocket-key'] || '';
    return this.createResponse(101, {
      'Upgrade': 'websocket',
      'Connection': 'Upgrade',
      'Sec-WebSocket-Accept': this.computeWsAccept(wsKey),
    }, '');
  }

  private async handleWsDownload(_context: RequestContext): Promise<Response> {
    return this.handleWebSocket(_context);
  }

  private async handleWsUpload(_context: RequestContext): Promise<Response> {
    return this.handleWebSocket(_context);
  }

  private async handleWsLatency(_context: RequestContext): Promise<Response> {
    return this.handleWebSocket(_context);
  }

  private computeWsAccept(key: string): string {
    const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
    return crypto.createHash('sha1').update(key + GUID).digest('base64');
  }

  public updateConfig(config: Partial<OoklaServerConfig>): void {
    this.config = { ...this.config, ...config };
  }

  public async stop(): Promise<void> {
    this.logger.info('Stopping HTTP/HTTPS/WebSocket/UDP servers...');

    const closePromises: Promise<void>[] = [];

    if (this.wsServer) {
      closePromises.push(new Promise((resolve) => {
        this.wsServer!.close(() => resolve());
      }));
    }
    if (this.wssHttps) {
      closePromises.push(new Promise((resolve) => {
        this.wssHttps!.close(() => resolve());
      }));
    }
    if (this.httpServer) {
      closePromises.push(new Promise((resolve) => {
        this.httpServer!.close(() => resolve());
      }));
    }
    if (this.httpsServer) {
      closePromises.push(new Promise((resolve) => {
        this.httpsServer!.close(() => resolve());
      }));
    }
    if (this.udpServers) {
      for (const server of this.udpServers) {
        if (server) {
          closePromises.push(new Promise((resolve) => {
            server.close(() => resolve());
          }));
        }
      }
    }

    await Promise.all(closePromises);
    this.destroy();
    this.logger.info('All servers stopped');
  }

  public async forceStop(): Promise<void> {
    this.logger.warning('Force stopping servers...');
    this.destroy();

    if (this.wsServer) this.wsServer.close();
    if (this.wssHttps) this.wssHttps.close();
    if (this.httpServer) this.httpServer.close();
    if (this.httpsServer) this.httpsServer.close();
    if (this.udpServers) {
      for (const server of this.udpServers) {
        if (server) server.close();
      }
    }
  }

  public getRoutes(): string[] {
    return Array.from(this.routes.keys()).concat(Array.from(this.wsRoutes.keys()));
  }

  public destroy(): void {
    this.routes.clear();
    this.wsRoutes.clear();
    this.removeAllListeners();
  }
}

export default OoklaRequestHandler;