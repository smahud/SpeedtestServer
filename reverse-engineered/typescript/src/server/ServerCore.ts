/**
 * ServerCore — canonical listener architecture for SpeedtestServer.
 *
 * Fixes the P0 defects of the previous implementation:
 *   - ONE listener per TCP port with per-connection protocol multiplexing
 *     (TLS / HTTP / WebSocket / native NetGauge), exactly like the reference
 *     daemon's deployment model. No competing HTTP-vs-HTTPS listeners on the
 *     same port.
 *   - Bind failures are FATAL (fail closed) — TCP *and* UDP. The old code
 *     resolved the EADDRINUSE promise and logged "All servers started
 *     successfully"; UDP bind errors were silently swallowed.
 *   - Runs unprivileged (no /var/lock, /etc/ooklaserver requirements).
 *
 * Transport detection per connection (first bytes):
 *   0x16 0x03 ...          → TLS (then HTTP/WSS or TLS-wrapped NetGauge)
 *   GET/POST/HEAD/... SP   → HTTP (incl. WebSocket upgrade on /ws)
 *   anything else          → native NetGauge (plaintext), including the
 *                            official CLI's encrypted-binary hello which we
 *                            answer with ERROR to trigger its documented
 *                            plaintext fallback.
 *
 * Revision-3 verified behaviors:
 *   - instanceUuid is LOWER-CASE (daemon parity, F-8).
 *   - the download pool is printable ASCII [0x20..0x7F] (daemon charset, F-9).
 *   - per-IP connection limits use exact IP matching (the old prefix string
 *     match counted 1.2.3.45 against the 1.2.3.4 limit).
 *   - the evidence WriteStream is error-watched and fully flushed on stop().
 *   - WebSocket sessions process ONE command per frame and answer QUIT with
 *     ERROR (daemon parity, F-13/F-14).
 */

import * as net from 'node:net';
import * as tls from 'node:tls';
import * as http from 'node:http';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import { Duplex } from 'node:stream';
import { WebSocketServer, WebSocket } from 'ws';
import { NetGaugeEngine, LossRegistry, NetGaugeSessionHooks } from './NetGaugeEngine';
import { UdpLossEngine } from './UdpLossEngine';
import { createRequestHandler, isHttpHead } from './HttpApi';

export interface TlsHostInfo {
  /** Certificate SAN hostnames — the HTTP Host allow-list (F-16). */
  allowedHosts: string[];
  /** Certificate CN — the 307 redirect target host. */
  certPrimaryHost: string;
}

export interface ServerCoreOptions {
  tcpPorts: number[];
  udpPorts: number[];
  versionString: string; // NetGauge/HTTP version banner (interop profile default)
  tls?: { cert: Buffer | string; key: Buffer | string } | null;
  /** Minimum TLS protocol ('TLSv1'|'TLSv1.1'|'TLSv1.2'|'TLSv1.3'); maps
   *  openSSL.server.minimumTLSProtocol (daemon default: 1.2). */
  tlsMinVersion?: tls.SecureVersion;
  crossDomainPorts: string;
  evidenceLogPath?: string;
  maxConnections: number;
  maxConnectionsPerIp: number;
  idleTimeoutMs: number;
  /** OoklaServer.allowedDomains — drives the CSP connect-src header. */
  allowedDomains: string[];
  /** OoklaServer.excludeDefaultDomains. */
  excludeDefaultDomains: boolean;
  /** OoklaServer.userAgentFilterEnabled (daemon default false — verified
   *  F-26: with the key absent the daemon does NOT filter UA strings). */
  userAgentFilterEnabled?: boolean;
  /** OoklaServer.websocket.frameSizeLimitBytes (daemon default 5242880 —
   *  verified F-27). Frames with payload <= limit+1 are processed; a frame
   *  with payload >= limit+2 is answered with NOTHING and the TCP connection
   *  is reset (RST), mirroring the daemon's "Payload too big" path. */
  wsFrameSizeLimitBytes?: number;
  /** OoklaServer.useIPv4 (daemon default true — verified F-29). */
  bindIPv4?: boolean;
  /** OoklaServer.useIPv6 (daemon default true — verified F-29). */
  bindIPv6?: boolean;
  /** OoklaServer.addresses — explicit bind list (verified F-28). Empty list
   *  (daemon default: the official template ships the key absent) means the
   *  wildcard set implied by useIPv4/useIPv6. Non-empty lists the exact
   *  addresses to bind (deviation D-9 documented in CONFIG_MATRIX.md/DECISIONS.md: the
   *  reference daemon's own handling of this key never binds listed IPv4
   *  addresses and drops the IPv4 wildcard — we implement the documented
   *  intent instead — deviation D-9, validation/DECISIONS.md). */
  bindAddresses?: string[];
  /** Independent safety parameter (NOT a daemon-parity key): bounded
   *  graceful-shutdown window in ms (F-35). stop() closes listeners, asks
   *  live sessions to close, and force-destroys whatever remains after this
   *  window — shutdown always completes. Configured via
   *  OoklaServer.shutdownGraceSeconds (default 10 s). */
  shutdownGraceMs?: number;
  /** Independent safety parameter (NOT a daemon-parity key): evidence-log
   *  WriteStream backlog cap in bytes (F-36). When the sink stalls (slow
   *  disk, unread pipe) and the internal buffer exceeds this cap, evidence
   *  logging degrades to OFF — the measurement service keeps serving.
   *  Default 32 MiB. */
  evidenceMaxBacklogBytes?: number;
  onEvent?: (kind: string, detail: Record<string, unknown>) => void;
}

interface ConnStats {
  peer: string;
  peerIp: string;
  openedAt: number;
  transport: 'tcp' | 'tls' | 'ws' | 'wss';
  bytesDown: number;
  bytesUp: number;
  commands: number;
}

/** Parse certificate hostnames for the Host-validation allow-list (F-16). */
export function parseTlsHostInfo(cert: Buffer | string): TlsHostInfo {
  const allowedHosts: string[] = [];
  let certPrimaryHost = 'localhost';
  try {
    const x509 = new crypto.X509Certificate(
      typeof cert === 'string' ? cert : Buffer.from(cert).toString('utf8'),
    );
    // CN from the subject ("CN=x\nO=y" — take the CN entry).
    const cnMatch = x509.subject.match(/(?:^|\n)CN=([^\n]+)/);
    if (cnMatch) certPrimaryHost = cnMatch[1].trim();
    // SANs: Node renders "DNS: a, IP Address: b" (also "IP: b" on some lines).
    const san = x509.subjectAltName || '';
    for (const part of san.split(',')) {
      const entry = part.trim();
      const dns = entry.match(/^DNS:\s*(.+)$/i);
      const ip = entry.match(/^IP(?:\s*Address)?:\s*(.+)$/i);
      if (dns) allowedHosts.push(dns[1].trim());
      else if (ip) allowedHosts.push(ip[1].trim());
    }
  } catch {
    // Unparseable material: fall back to the dev defaults.
  }
  if (allowedHosts.length === 0) allowedHosts.push('localhost', '127.0.0.1');
  return { allowedHosts, certPrimaryHost };
}

/** 2 MiB download pool of printable-ASCII random data [0x20..0x7F]
 *  (daemon charset, verified F-9). */
export function generateAsciiPool(size: number): Buffer {
  const pool = Buffer.allocUnsafe(size);
  for (let i = 0; i < size; i++) {
    pool[i] = 0x20 + (Math.random() * 96) | 0; // 0x20..0x7F inclusive
  }
  return pool;
}

export class ServerCore {
  private opts: ServerCoreOptions;
  /** Current TLS material — swappable at runtime via reloadTls (§9.7). */
  private tlsMaterial: { cert: Buffer | string; key: Buffer | string } | null;
  /** Certificate host info (mutable: refreshed by reloadTls). */
  public readonly hostInfo: TlsHostInfo;
  private loss = new LossRegistry();
  private pool = generateAsciiPool(2 * 1024 * 1024); // 2 MiB ASCII pool (daemon parity)
  private instanceUuid = crypto.randomUUID(); // LOWER-CASE (daemon parity, F-8)
  private startedAt = Date.now();
  private listeners: net.Server[] = [];
  private udp: UdpLossEngine | null = null;
  private httpServer: http.Server;
  private httpsServer: http.Server;
  private wss: WebSocketServer;
  private evidence: fs.WriteStream | null = null;
  private conns = new Map<number, ConnStats>();
  /** Exact per-IP connection counts (fixes the old string-prefix match). */
  private perIp = new Map<string, number>();
  /** Every live raw TCP socket (F-31/F-35): the global connection limit and
   *  force-shutdown act on ALL accepted sockets — pre-protocol, mid-TLS,
   *  mid-upgrade and established alike — not just routed ones. */
  private liveSockets = new Set<net.Socket>();
  /** stream (raw socket or its TLSSocket wrapper) → accept-time connection
   *  id (F-32): lets the WS upgrade path REUSE the TCP connection's
   *  registration instead of creating a second one. */
  private streamIds = new WeakMap<Duplex, number>();
  private connSeq = 0;
  private running = false;
  private stopStarted = false;
  private gcTimer: NodeJS.Timeout | null = null;
  /** Global evidence counters (read by the validation harness). */
  public readonly counters = {
    connectionsTotal: 0,
    netgaugeSessions: 0,
    httpRequests: 0,
    wsSessions: 0,
    udpReceived: 0,
    udpAnswered: 0,
    bytesDown: 0,
    bytesUp: 0,
  };

  constructor(opts: ServerCoreOptions) {
    this.opts = opts;
    this.tlsMaterial = opts.tls ?? null;
    this.hostInfo = parseTlsHostInfo(opts.tls ? opts.tls.cert : 'localhost');
    if (opts.evidenceLogPath) {
      this.evidence = fs.createWriteStream(opts.evidenceLogPath, { flags: 'w' });
      // Fail fast + loudly: an unusable evidence sink must not crash the
      // process mid-run as an unhandled 'error' event (audit channel).
      this.evidence.on('error', (err) => {
        process.stderr.write(
          `evidence log write failed (${opts.evidenceLogPath}): ${err instanceof Error ? err.message : String(err)}\n`,
        );
        this.evidence?.destroy();
        this.evidence = null; // degrade gracefully: keep serving, stop logging
      });
    }
    const handler = createRequestHandler({
      versionString: opts.versionString,
      pool: this.pool,
      crossDomainPorts: opts.crossDomainPorts,
      maxBodyBytes: 512 * 1024 * 1024,
      hostInfo: this.hostInfo, // mutable: reloadTls refreshes the allow-list
      allowedDomains: opts.allowedDomains,
      excludeDefaultDomains: opts.excludeDefaultDomains,
      userAgentFilterEnabled: opts.userAgentFilterEnabled === true,
      onEvent: (k, d) => {
        this.counters.httpRequests++;
        this.ev(k, d);
      },
    });
    this.httpServer = http.createServer(handler);
    this.httpsServer = opts.tls
      ? httpsServerWith(handler, opts.tls)
      : this.httpServer; // no TLS configured: plain only
    // When no TLS material is configured httpsServer IS httpServer; register
    // the upgrade/clientError handlers once per distinct server (registering
    // twice on the same object fired handleUpgrade twice per request —
    // surfaced by the rev-5 WS tests with tls:null).
    const upgradeServers = this.httpsServer === this.httpServer ? [this.httpServer] : [this.httpServer, this.httpsServer];
    for (const srv of upgradeServers) {
      srv.on('upgrade', (req, socket, head) => this.handleUpgrade(req, socket as net.Socket, head));
      srv.on('clientError', (err, socket) => {
        // Daemon parity: parser-level rejections (e.g. a missing Host header
        // on HTTP/1.1) produce the minimal 500, not Node's default 400.
        void err;
        if (socket.writable) socket.write('HTTP/1.1 500 Internal Server Error\r\nConnection: Close\r\n\r\n');
        socket.destroy();
      });
    }
    this.wss = new WebSocketServer({
      noServer: true,
      // F-27 (re-verified with exact-size payloads): accept payload <= limit,
      // reject > limit. ws applies this per MESSAGE; the per-FRAME daemon
      // boundary (silent RST, no close frame) is enforced by the FrameGuard
      // which sees every chunk BEFORE ws's own data listener.
      maxPayload: opts.wsFrameSizeLimitBytes ?? 5242880,
    });
    this.wss.on('connection', (ws, req) => this.handleWsConnection(ws, req));
    this.gcTimer = setInterval(() => this.loss.gc(300000), 60000);
    this.gcTimer.unref();
  }

  private ev(kind: string, detail: Record<string, unknown>): void {
    this.opts.onEvent?.(kind, detail);
    if (this.evidence) {
      this.evidence.write(JSON.stringify({ ts: Date.now(), k: kind, ...detail }) + '\n');
      // F-36: a stalled sink (slow disk, unread pipe, filesystem hiccup)
      // must not buffer without bound — the WriteStream's internal buffer
      // grows linearly with queued records otherwise. Past the cap the
      // stream is destroyed and evidence logging degrades to OFF; the
      // measurement service keeps serving (same policy as the error path).
      const cap = this.opts.evidenceMaxBacklogBytes ?? 32 * 1024 * 1024;
      if (this.evidence.writableLength > cap) {
        const stalled = this.evidence;
        const bytes = stalled.writableLength;
        this.evidence = null;
        try {
          stalled.destroy();
        } catch {
          /* already gone */
        }
        process.stderr.write(
          `evidence log stalled (${bytes} bytes buffered > cap ${cap}); disabling evidence logging (measurement service continues)\n`,
        );
        this.opts.onEvent?.('evidence_backlog_drop', { bytes, cap });
      }
    }
  }

  async start(): Promise<void> {
    if (this.running) throw new Error('ServerCore already running');
    // Listener set from useIPv4/useIPv6/addresses (verified F-28/F-29).
    const targets = this.resolveBindTargets();
    if (targets.length === 0) {
      throw new Error(
        'No listen addresses resolved: OoklaServer.useIPv4 and OoklaServer.useIPv6 are both disabled and OoklaServer.addresses is empty',
      );
    }
    // F-34 (verified 2026-11-05): Promise.all rejected on the FIRST bind
    // failure while other binds completed afterwards — a rejected start()
    // left LIVE orphaned listeners answering on the other ports. Every bind
    // now settles; on ANY failure everything that bound is closed before
    // start() fails closed.
    try {
      const binds: Promise<void>[] = [];
      for (const port of this.opts.tcpPorts) {
        for (const t of targets) {
          binds.push(
            new Promise<void>((resolve, reject) => {
              const srv = net.createServer({ noDelay: true }, (sock) => this.onRawConnection(sock));
              srv.once('error', reject); // fail closed: bind errors are fatal (P0.1 fix)
              // The daemon binds 0.0.0.0 and [::] as SEPARATE sockets; with
              // useIPv4=false its [::] refuses v4 (verified F-29), so the v6
              // wildcard is bound V6ONLY here too.
              srv.listen(
                t.host === '::' ? { port, host: '::', ipv6Only: true } : { port, host: t.host },
                () => {
                  this.ev('listen_tcp', { port, host: t.host, family: t.family });
                  resolve();
                },
              );
              this.listeners.push(srv);
            }),
          );
        }
      }
      const settled = await Promise.allSettled(binds);
      const failure = settled.find((r) => r.status === 'rejected');
      if (failure) throw (failure as PromiseRejectedResult).reason;
      // UDP binds are equally fatal (fail closed — the old code swallowed them).
      this.udp = new UdpLossEngine({
        ports: this.opts.udpPorts,
        bindHosts: targets.map((t) => t.host),
        loss: this.loss,
        maxDatagramBytes: 2048,
        onEvent: (k, d) => this.ev(k, d),
      });
      await this.udp.start();
    } catch (error) {
      await this.abortPartialStartup();
      throw error;
    }
    this.running = true;
    this.ev('started', {
      tcpPorts: this.opts.tcpPorts,
      udpPorts: this.opts.udpPorts,
      bindTargets: targets.map((t) => t.host),
      version: this.opts.versionString,
      instance: this.instanceUuid,
      pid: process.pid,
    });
  }

  /** F-34: close everything a partially-started server may hold — bound
   *  listeners, UDP sockets, accepted-but-unrouted sockets, accounting —
   *  then rethrow from start(). Keeps fail-closed semantics leak-free.
   *  (allSettled upstream means every listener is either listening or dead
   *  here — close() on a dead listener is a harmless no-op.) */
  private async abortPartialStartup(): Promise<void> {
    for (const l of this.listeners) {
      try {
        l.close();
      } catch {
        /* already closed */
      }
    }
    this.listeners = [];
    this.udp?.stop();
    this.udp = null;
    for (const s of this.liveSockets) {
      try {
        s.destroy();
      } catch {
        /* already gone */
      }
    }
    this.liveSockets.clear();
    this.conns.clear();
    this.perIp.clear();
  }

  /** Resolve the listener bind set (verified F-28/F-29):
   *  - OoklaServer.addresses set  → exactly those addresses (documented intent;
   *    deviation D-9 vs the daemon's broken v4 handling — see CONFIG_MATRIX.md)
   *  - otherwise 0.0.0.0 when useIPv4, [::] when useIPv6 (daemon default). */
  private resolveBindTargets(): { host: string; family: 'v4' | 'v6' }[] {
    const explicit = (this.opts.bindAddresses ?? []).map((a) => String(a).trim()).filter((a) => a.length > 0);
    if (explicit.length > 0) {
      return explicit.map((a) => ({ host: a, family: a.includes(':') ? ('v6' as const) : ('v4' as const) }));
    }
    const out: { host: string; family: 'v4' | 'v6' }[] = [];
    if (this.opts.bindIPv4 !== false) out.push({ host: '0.0.0.0', family: 'v4' });
    if (this.opts.bindIPv6 !== false) out.push({ host: '::', family: 'v6' });
    return out;
  }

  /** Bounded graceful shutdown (F-35, verified 2026-11-05: stop() used to
   *  hang indefinitely on in-flight uploads / keep-alive / never-closing WS
   * sessions because http.Server.close() waits for ALL connections).
   *  Semantics now:
   *    1. stop accepting (listeners closed); UDP stopped.
   *    2. grace phase: idle HTTP connections are closed, live WS sessions get
   *       a close handshake, in-flight requests keep running.
   *    3. after shutdownGraceMs (default 10 s, OoklaServer.shutdownGraceSeconds)
   *       everything still open is force-destroyed — shutdown ALWAYS completes
   *       within the bound (plus a short final drain).
   *  The evidence log gets a bounded flush window for the same reason. */
  async stop(): Promise<void> {
    if (this.stopStarted) return;
    this.stopStarted = true;
    this.running = false;
    if (this.gcTimer) {
      clearInterval(this.gcTimer);
      this.gcTimer = null;
    }
    this.udp?.stop();
    // Initiate listener close (stop accepting). The close callbacks join the
    // bounded race below: awaiting them DIRECTLY would block on lingering
    // connections — net.Server.close(cb) waits for all of them (F-35).
    const listenerClosed = this.listeners.map(
      (l) => new Promise<void>((resolve) => l.close(() => resolve())),
    );
    this.listeners = [];

    // Grace phase: shed idle HTTP connections, ask WS sessions to close.
    this.httpServer.closeIdleConnections?.();
    if (this.httpsServer !== this.httpServer) {
      this.httpsServer.closeIdleConnections?.();
    }
    for (const client of this.wss.clients) {
      try {
        client.close(1001, 'server shutdown');
      } catch {
        /* already closing */
      }
    }

    const serversClosed = Promise.all([
      ...listenerClosed,
      new Promise<void>((resolve) => this.httpServer.close(() => resolve())),
      this.httpsServer !== this.httpServer
        ? new Promise<void>((resolve) => this.httpsServer.close(() => resolve()))
        : Promise.resolve(),
      new Promise<void>((resolve) => {
        this.wss.close(() => resolve());
      }),
    ]);
    const graceMs = Math.max(1, this.opts.shutdownGraceMs ?? 10000);
    let forced = false;
    await Promise.race([
      serversClosed.then(() => undefined),
      new Promise<void>((resolve) => {
        const t = setTimeout(() => {
          forced = true;
          resolve();
        }, graceMs);
        t.unref?.();
      }),
    ]);

    if (forced) {
      // Bound exceeded — force-destroy every remaining connection.
      this.httpServer.closeAllConnections?.();
      if (this.httpsServer !== this.httpServer) {
        this.httpsServer.closeAllConnections?.();
      }
      for (const s of this.liveSockets) {
        try {
          s.destroy();
        } catch {
          /* already gone */
        }
      }
      // Short final drain so the close callbacks (and wss 'close') can run.
      await Promise.race([
        serversClosed.then(() => undefined),
        new Promise<void>((resolve) => {
          const t = setTimeout(resolve, 1000);
          t.unref?.();
        }),
      ]);
    }

    this.ev('stopped', { connections: this.counters.connectionsTotal, forced });
    // Bounded evidence flush (F-36-adjacent): end() on a stalled/unopenable
    // sink never calls back — give it a window, then destroy the stream.
    if (this.evidence) {
      const stream = this.evidence;
      this.evidence = null;
      const flushed = new Promise<void>((resolve) => {
        stream.end(() => resolve());
        stream.on('close', () => resolve());
      });
      const done = await Promise.race([
        flushed.then(() => true),
        new Promise<boolean>((resolve) => {
          const t = setTimeout(() => resolve(false), 2000);
          t.unref?.();
        }),
      ]);
      if (!done) {
        try {
          stream.destroy();
        } catch {
          /* already gone */
        }
      }
    }
  }

  /**
   * §9.7 — hot certificate reload. Validates the new pair (createSecureContext)
   * BEFORE swapping; on failure keeps the last valid material (never serves a
   * broken certificate). New connections use the new material; established
   * connections are unaffected. No restart, no port re-bind. The Host
   * validation allow-list is refreshed from the new certificate (F-16).
   */
  reloadTls(cert: Buffer | string, key: Buffer | string): { ok: boolean; error?: string } {
    if (!this.tlsMaterial) {
      return { ok: false, error: 'TLS not enabled on this server' };
    }
    try {
      tls.createSecureContext({ cert: cert.toString(), key: key.toString() });
    } catch (error) {
      const msg = `TLS reload rejected (keeping last valid certificate): ${error instanceof Error ? error.message : String(error)}`;
      this.ev('tls_reload_failed', { error: msg });
      return { ok: false, error: msg };
    }
    this.tlsMaterial = { cert, key };
    const info = parseTlsHostInfo(cert);
    this.hostInfo.allowedHosts.splice(0, this.hostInfo.allowedHosts.length, ...info.allowedHosts);
    this.hostInfo.certPrimaryHost = info.certPrimaryHost;
    this.ev('tls_reloaded', {
      fingerprint: new crypto.X509Certificate(cert.toString()).fingerprint256,
    });
    return { ok: true };
  }

  stats(): Record<string, unknown> {
    return {
      startedAt: new Date(this.startedAt).toISOString(),
      instanceUuid: this.instanceUuid,
      version: this.opts.versionString,
      uptimeSeconds: Math.floor((Date.now() - this.startedAt) / 1000),
      activeConnections: this.conns.size,
      counters: this.counters,
      lossSessions: this.loss.latest() ? 1 : 0,
    };
  }

  /* ---------------- TCP: protocol multiplexing ---------------- */

  private onRawConnection(sock: net.Socket): void {
    const id = ++this.connSeq;
    const peer = `${sock.remoteAddress || '?'}:${sock.remotePort || '?'}`;
    const peerIp = sock.remoteAddress || '?';
    this.counters.connectionsTotal++;
    // F-31 (verified 2026-11-05): the limit used to act on conns.size, which
    // only counted ROUTED connections — sockets that connected but never
    // sent (or drip-fed a header/handshake) were invisible to the global
    // cap (10/10 silent sockets stayed connected with maxConnections=5).
    // Every accepted socket is now registered immediately; transport is
    // refined when the connection is routed. conns.size == live sockets.
    if (this.conns.size >= this.opts.maxConnections) {
      this.ev('conn_rejected_max', { peer });
      sock.destroy();
      return;
    }
    // Exact per-IP accounting (fixes the prefix-string match that counted
    // 1.2.3.45 against the 1.2.3.4 limit).
    const ipKey = peerIp;
    const perIpCount = this.perIp.get(ipKey) ?? 0;
    if (perIpCount >= this.opts.maxConnectionsPerIp) {
      this.ev('conn_rejected_per_ip', { peer, ip: ipKey, count: perIpCount });
      sock.destroy();
      return;
    }
    this.conns.set(id, { peer, peerIp, openedAt: Date.now(), transport: 'tcp', bytesDown: 0, bytesUp: 0, commands: 0 });
    this.liveSockets.add(sock);
    this.streamIds.set(sock, id);
    this.perIp.set(ipKey, perIpCount + 1);
    sock.setNoDelay(true);
    sock.setTimeout(this.opts.idleTimeoutMs, () => {
      this.ev('conn_timeout', { id, peer });
      sock.destroy();
    });
    const onFirst = (chunk: Buffer): void => {
      sock.removeListener('data', onFirst);
      if (this.tlsMaterial && chunk.length > 0 && chunk[0] === 0x16) {
        this.startTls(sock, chunk, id, peer, peerIp);
        return;
      }
      if (isHttpHead(chunk)) {
        this.routeHttp(this.httpServer, sock, chunk, id, peer, peerIp, 'tcp');
        return;
      }
      this.startNetGauge(sock, chunk, id, peer, peerIp, 'tcp');
    };
    sock.once('data', onFirst);
    sock.on('error', () => {
      /* teardown via close */
    });
    sock.on('close', () => {
      this.liveSockets.delete(sock);
      const c = this.conns.get(id);
      this.conns.delete(id);
      const n = this.perIp.get(ipKey) ?? 1;
      if (n <= 1) this.perIp.delete(ipKey);
      else this.perIp.set(ipKey, n - 1);
      this.ev('conn_close', { id, peer, stats: c });
    });
  }

  private startTls(sock: net.Socket, firstChunk: Buffer, id: number, peer: string, peerIp: string): void {
    const tlsSock = new tls.TLSSocket(sock, {
      isServer: true,
      cert: this.tlsMaterial ? this.tlsMaterial.cert : undefined,
      key: this.tlsMaterial ? this.tlsMaterial.key : undefined,
      // daemon parity: openSSL.server.minimumTLSProtocol (default 1.2)
      minVersion: this.opts.tlsMinVersion || ("TLSv1.2" as tls.SecureVersion),
    });
    // F-31/F-32: the TLS-wrapped stream shares the accept-time registration.
    this.streamIds.set(tlsSock, id);
    const entry = this.conns.get(id);
    if (entry) entry.transport = 'tls';
    sock.unshift(firstChunk); // let the TLSSocket consume the ClientHello
    const onPlain = (chunk: Buffer): void => {
      tlsSock.removeListener('data', onPlain);
      if (isHttpHead(chunk)) {
        this.routeHttp(this.httpsServer, tlsSock, chunk, id, peer, peerIp, 'tls');
        return;
      }
      this.startNetGauge(tlsSock, chunk, id, peer, peerIp, 'tls');
    };
    tlsSock.once('data', onPlain);
    tlsSock.on('error', (e) => this.ev('tls_error', { id, peer, error: String(e) }));
  }

  /* ---------------- HTTP routing with Host-header enforcement ---------------- */

  /**
   * Route a detected HTTP connection into the parser — with the daemon's
   * missing-Host rejection (verified F-17). Node's own parser answers a
   * Host-less HTTP/1.1 request with its own 400 BEFORE any handler runs, so
   * the multiplexer buffers until the header block is complete and enforces
   * the daemon's minimal 500 itself.
   */
  private routeHttp(
    server: http.Server,
    sock: Duplex,
    firstChunk: Buffer,
    id: number,
    peer: string,
    peerIp: string,
    transport: 'tcp' | 'tls',
  ): void {
    // F-31/F-32: the connection was registered at accept time — refine the
    // transport label only (no second entry, no counter reset).
    const entry = this.conns.get(id);
    if (entry) entry.transport = transport;
    const chunks: Buffer[] = [firstChunk];
    let total = firstChunk.length;
    const CAP = 65536;
    /** Hand the accumulated bytes to Node's HTTP parser. */
    const route = (): void => {
      sock.unshift(Buffer.concat(chunks));
      server.emit('connection', sock);
      this.ev(transport === 'tcp' ? 'conn_http' : 'conn_https', { id, peer });
    };
    /** Decide whether the header block is complete/valid yet. 'reject'
     *  performs its own minimal-500 write + destroy. */
    const decide = (): 'route' | 'wait' | 'reject' => {
      const buf = Buffer.concat(chunks);
      const end = buf.indexOf('\r\n\r\n');
      if (end === -1) {
        return total > CAP ? 'route' : 'wait'; // let Node enforce its own limits
      }
      const firstLineEnd = buf.indexOf('\r\n');
      const headerRegion = buf.subarray(firstLineEnd + 2, end + 2);
      if (!/^Host:/im.test(headerRegion.toString('latin1'))) {
        this.ev('http_reject', { reason: 'missing_host', id, peer });
        sock.write('HTTP/1.1 500 Internal Server Error\r\nConnection: Close\r\n\r\n');
        sock.destroy();
        return 'reject';
      }
      return 'route';
    };
    const first = decide();
    if (first === 'route') {
      route(); // decided within the FIRST data event — same path as before
      return;
    }
    if (first === 'reject') return;
    // 'wait' — more bytes needed. F-30 (pre-existing rev-4 defect, fixed
    // 2026-11-05): when the decision is later taken from INSIDE a data
    // emission, performing sock.unshift()+emit('connection') right there
    // re-enters the stream mid-emission — rev-4 re-entered its own data
    // handler infinitely (>3.6 GB/s allocations, OOM-killed). Detaching
    // before the call instead left the stream stalled. The hand-off is
    // therefore DEFERRED to a clean stack via setImmediate.
    let done = false;
    const onData = (chunk: Buffer): void => {
      if (done) return;
      done = true;
      sock.removeListener('data', onData);
      chunks.push(chunk);
      total += chunk.length;
      const r = decide();
      if (r === 'wait') {
        done = false;
        sock.on('data', onData);
        return;
      }
      if (r === 'reject') return;
      setImmediate(route);
    };
    sock.on('data', onData);
  }

  /* ---------------- native NetGauge over a byte stream ---------------- */

  private startNetGauge(stream: Duplex, firstChunk: Buffer, id: number, peer: string, peerIp: string, transport: 'tcp' | 'tls'): void {
    this.counters.netgaugeSessions++;
    // F-31/F-32: reuse the accept-time registration (single entry per TCP
    // connection); refine the transport label only.
    let connStats = this.conns.get(id);
    if (!connStats) {
      connStats = { peer, peerIp, openedAt: Date.now(), transport, bytesDown: 0, bytesUp: 0, commands: 0 };
      this.conns.set(id, connStats);
    } else {
      connStats.transport = transport;
    }
    let closed = false;
    const hooks: NetGaugeSessionHooks = {
      write: (data) => {
        connStats.bytesDown += data.length;
        this.counters.bytesDown += data.length;
        return stream.write(data);
      },
      writeLine: (line) => {
        connStats.bytesDown += line.length + 1;
        this.counters.bytesDown += line.length + 1;
        return stream.write(line + '\n');
      },
      peerIp: () => peerIp,
      close: () => stream.end(),
      onEvent: (kind, detail) => this.ev('ng_' + kind, { id, peer, ...detail }),
    };
    const engine = new NetGaugeEngine(hooks, {
      versionString: this.opts.versionString,
      instanceUuid: this.instanceUuid,
      maxLineBytes: 1024 * 1024,
      maxDownloadBytes: 0x7fffffff,
      maxUploadBytes: 0x7fffffff,
      pool: this.pool,
      loss: this.loss,
      startedAt: this.startedAt,
      quitMode: 'close',
      errorStrikeLimit: 3, // verified F-24: TCP "three strikes" closes the connection
    });
    stream.on('data', (c: Buffer) => {
      connStats.bytesUp += c.length;
      this.counters.bytesUp += c.length;
      connStats.commands = engine.counters.commands;
      engine.feed(c);
    });
    stream.on('drain', () => engine.notifyWritable());
    stream.on('close', () => {
      if (!closed) {
        closed = true;
        engine.destroy();
      }
    });
    stream.on('error', () => {
      if (!closed) {
        closed = true;
        engine.destroy();
      }
    });
    this.ev('conn_netgauge', { id, peer, transport });
    engine.feed(firstChunk);
  }

  /* ---------------- WebSocket upgrade ---------------- */

  private handleUpgrade(req: http.IncomingMessage, socket: net.Socket, head: Buffer): void {
    const path = (req.url || '/').split('?')[0];
    if (path === '/ws') {
      // Attach the frame-size guard BEFORE ws installs its own data listener:
      // the guard must see each chunk first so an oversized frame header aborts
      // the connection (RST, no reply — F-27) before ws can process the frame
      // and answer it (ws's own accept boundary is maxPayload+1, which would
      // let a limit+2 frame through and reply to it).
      guardSeed(socket, head, this.opts.wsFrameSizeLimitBytes ?? 5242880, (limit) =>
        this.ev('ws_frame_too_big', { limit, peer: req.socket.remoteAddress }),
      );
      this.wss.handleUpgrade(req, socket, head, (ws) => {
        this.wss.emit('connection', ws, req);
      });
      return;
    }
    // Daemon parity: upgrade attempts on / are answered like a normal GET
    // (200 page); every other path 404s and closes.
    if (path === '/') {
      socket.write(
        'HTTP/1.1 200 OK\r\nContent-Type: text/html\r\nConnection: close\r\n\r\n' +
          '<html><head><title>OoklaServer</title></head><body><h1>OoklaServer</h1><p>It worked!<br /></p></body></html>\n',
      );
      socket.end();
    } else {
      socket.write('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n');
      socket.end();
    }
  }

  private handleWsConnection(ws: WebSocket, req: http.IncomingMessage): void {
    const peer = `${req.socket.remoteAddress || '?'}:${req.socket.remotePort || '?'}`;
    const peerIp = req.socket.remoteAddress || '?';
    const secure = (req.socket as tls.TLSSocket).encrypted === true;
    // F-32 (verified 2026-11-05): the WS upgrade used to mint a SECOND
    // registration (new id + extra connectionsTotal + extra per-IP slot) on
    // top of the TCP connection's entry — one live WS session counted as 2
    // active connections and 2 per-IP slots, halving effective limits. The
    // session now REUSES the accept-time registration: streamIds maps both
    // the raw socket and its TLSSocket wrapper to the same id, so the raw
    // socket's close handler performs the single decrement. The fallback
    // path (injected sockets that never went through onRawConnection) keeps
    // standalone accounting for robustness.
    const priorId = this.streamIds.get(req.socket as Duplex);
    this.counters.wsSessions++;
    let id: number;
    let connStats: ConnStats;
    let ownsAccounting = false;
    if (priorId !== undefined && this.conns.has(priorId)) {
      id = priorId;
      connStats = this.conns.get(priorId) as ConnStats;
      connStats.transport = secure ? 'wss' : 'ws';
    } else {
      id = ++this.connSeq;
      connStats = { peer, peerIp, openedAt: Date.now(), transport: secure ? 'wss' : 'ws', bytesDown: 0, bytesUp: 0, commands: 0 };
      this.conns.set(id, connStats);
      this.counters.connectionsTotal++;
      this.perIp.set(peerIp, (this.perIp.get(peerIp) ?? 0) + 1);
      ownsAccounting = true;
    }
    const send = (data: Buffer | string): boolean => {
      if (ws.readyState !== WebSocket.OPEN) return false;
      ws.send(data, { binary: typeof data !== 'string' });
      return true;
    };
    const hooks: NetGaugeSessionHooks = {
      write: (data) => {
        connStats.bytesDown += data.length;
        this.counters.bytesDown += data.length;
        return send(data);
      },
      writeLine: (line, noNewline) => {
        connStats.bytesDown += line.length + 1;
        this.counters.bytesDown += line.length + 1;
        // Observed daemon quirk (2026-11-03 z.ai capture, re-verified in our
        // lab): over WS the HELLO reply carries no trailing newline; other
        // replies do.
        const payload = line.startsWith('HELLO ') || noNewline ? line : line + '\n';
        return send(payload);
      },
      peerIp: () => peerIp,
      close: () => ws.close(),
      onEvent: (kind, detail) => this.ev('ng_' + kind, { id, peer, ws: true, ...detail }),
    };
    const engine = new NetGaugeEngine(hooks, {
      versionString: this.opts.versionString,
      instanceUuid: this.instanceUuid,
      maxLineBytes: 1024 * 1024,
      maxDownloadBytes: 0x7fffffff,
      maxUploadBytes: 0x7fffffff,
      pool: this.pool,
      loss: this.loss,
      startedAt: this.startedAt,
      quitMode: 'error', // verified F-14: QUIT over WS answers ERROR (no close)
      errorStrikeLimit: 0, // verified F-24: the "three strikes" rule does NOT apply over WebSocket
    });
    ws.on('message', (data: Buffer, isBinary: boolean) => {
      const buf = isBinary ? data : Buffer.from(data.toString('utf8'), 'utf8');
      connStats.bytesUp += buf.length;
      this.counters.bytesUp += buf.length;
      // Verified F-13: the daemon processes (at most) the FIRST command of
      // each WS frame and discards the rest — e.g. a "HI\nGETIP\n" frame
      // yields exactly one HELLO. Upload payload frames are exempt.
      const payload = engine.isIdle ? firstCommandLine(buf) : buf;
      engine.feed(payload);
    });
    ws.on('close', () => {
      engine.destroy();
      if (ownsAccounting) {
        // fallback path only — normally the raw socket's close handler owns
        // the single decrement (see F-32 note above).
        this.conns.delete(id);
        const n = this.perIp.get(peerIp) ?? 1;
        if (n <= 1) this.perIp.delete(peerIp);
        else this.perIp.set(peerIp, n - 1);
        this.ev('conn_close', { id, peer, ws: true, stats: connStats });
      }
      // For reused registrations the raw socket close handler emits
      // conn_close with the FINAL shared stats entry (byte counters included).
    });
    ws.on('error', (e) => {
      // F-27: a message-level maxPayload violation (fragmented frames) or a
      // protocol error — the daemon path is a silent abort; resetAndDestroy
      // sends an RST and suppresses any close handshake.
      this.ev('ws_error', { id, peer, error: String((e as Error & { code?: string }).code ?? e).slice(0, 80) });
      engine.destroy();
      const raw = ws as unknown as { _socket?: net.Socket & { resetAndDestroy?: () => void } };
      const s = raw._socket;
      if (s && typeof s.resetAndDestroy === 'function') {
        try {
          s.resetAndDestroy();
          return;
        } catch {
          /* fall through to terminate */
        }
      }
      ws.terminate();
    });
    this.ev('conn_ws', { id, peer, secure });
  }
}

/** First command line of a WS frame (inclusive newline). Frames with NO
 *  newline are still one complete command (verified F-13: a bare "HI" frame
 *  gets its HELLO), so a newline is synthesized for the line-based engine. */
function firstCommandLine(buf: Buffer): Buffer {
  const nl = buf.indexOf(0x0a);
  if (nl === -1) return Buffer.concat([buf, Buffer.from('\n')]);
  return buf.subarray(0, nl + 1);
}

/**
 * FrameGuard — per-frame WebSocket size enforcement, daemon parity (F-27).
 *
 * The `ws` library enforces `maxPayload` per MESSAGE and answers violations
 * with a close frame; the reference daemon enforces per FRAME, replies
 * NOTHING, and resets the TCP connection (client sees ECONNRESET; daemon logs
 * "WebSocket Exception: Payload too big"). The guard watches the raw
 * client→server byte stream with its own tiny frame-header parser next to
 * ws's own data listener and destroys the socket the moment an oversized
 * frame header is seen — before ws can emit anything or send any close
 * frame. Accepted boundary (re-verified with exact-size payloads): payload
 * <= acceptBytes passes; payload > acceptBytes aborts.
 */
const frameGuards = new WeakMap<net.Socket, (chunk: Buffer) => void>();

export function guardSeed(
  socket: net.Socket,
  head: Buffer,
  acceptBytes: number,
  onViolation: (limit: number) => void,
): void {
  if (frameGuards.has(socket)) return; // one guard per socket
  let dead = false;
  let pending: Buffer = Buffer.alloc(0); // unconsumed prologue bytes
  let stage: 'h' | 'e16' | 'e64' | 'm' | 'p' = 'h';
  let payloadRemaining = 0;

  const abort = (): void => {
    if (dead) return;
    dead = true;
    try {
      onViolation(acceptBytes);
      // RST, not FIN (F-27): the daemon aborts with an unread payload in the
      // kernel buffer; Node already drained the chunk into userspace, so a
      // plain destroy() would FIN. resetAndDestroy() (Node ≥ 18.9) forces the
      // abortive reset; older runtimes fall back to destroy.
      const anySock = socket as net.Socket & { resetAndDestroy?: () => void };
      if (typeof anySock.resetAndDestroy === 'function') anySock.resetAndDestroy();
      else socket.destroy();
    } catch {
      /* socket already gone */
    }
  };

  /** Consume the first `n` bytes of (pending + input); leftovers become the
   *  new `rest`. Returns got.length < n when more bytes are needed (the
   *  remainder is stashed in `pending`). */
  const take = (input: Buffer, n: number): { got: Buffer; rest: Buffer } => {
    const combined = pending.length ? Buffer.concat([pending, input]) : input;
    if (combined.length < n) {
      pending = combined;
      return { got: Buffer.alloc(0), rest: Buffer.alloc(0) };
    }
    pending = Buffer.alloc(0);
    return { got: combined.subarray(0, n), rest: combined.subarray(n) };
  };

  const feed = (chunk: Buffer): void => {
    if (dead) return;
    let rest = chunk;
    while (rest.length > 0 || (stage === 'h' && pending.length >= 2)) {
      if (stage === 'h') {
        const { got, rest: r } = take(rest, 2);
        if (got.length < 2) return;
        rest = r;
        const len7 = got[1] & 0x7f;
        if (len7 < 126) {
          payloadRemaining = len7;
          stage = 'm';
        } else if (len7 === 126) {
          stage = 'e16';
        } else {
          stage = 'e64';
        }
      } else if (stage === 'e16') {
        const { got, rest: r } = take(rest, 2);
        if (got.length < 2) return;
        rest = r;
        payloadRemaining = got.readUInt16BE(0);
        stage = 'm';
      } else if (stage === 'e64') {
        const { got, rest: r } = take(rest, 8);
        if (got.length < 8) return;
        rest = r;
        const big = got.readBigUInt64BE(0);
        if (big > 0xffffffffn) {
          abort(); // absurd length: treat as oversized
          return;
        }
        payloadRemaining = Number(big);
        stage = 'm';
      } else if (stage === 'm') {
        const { got, rest: r } = take(rest, 4);
        if (got.length < 4) return;
        rest = r;
        // Frame header complete — the daemon's decision point (F-27,
        // re-verified with exact-size payloads): accept payload <= limit,
        // abort (RST, no reply) when payload > limit.
        if (payloadRemaining > acceptBytes) {
          abort();
          return;
        }
        stage = 'p';
      } else {
        // 'p': inside the payload of an accepted frame
        const skip = Math.min(rest.length, payloadRemaining);
        payloadRemaining -= skip;
        rest = rest.subarray(skip);
        if (payloadRemaining === 0) stage = 'h';
      }
      if (dead) return;
      if (rest.length === 0 && pending.length === 0 && stage !== 'h') return;
      if (rest.length === 0 && stage === 'h') return;
    }
  };

  frameGuards.set(socket, feed);
  if (head.length > 0) feed(head);
  socket.on('data', feed);
  socket.on('close', () => frameGuards.delete(socket));
}

import { ServerResponse } from 'node:http';
function httpsServerWith(
  handler: (req: http.IncomingMessage, res: ServerResponse) => void,
  tlsOpts: { cert: Buffer | string; key: Buffer | string },
): http.Server {
  // https.Server with the same handler; sockets are injected by the
  // multiplexer after TLS termination, so this server never binds.
  const srv = http.createServer(handler); // plaintext parser; TLS already terminated
  (srv as unknown as { tlsOpts?: unknown }).tlsOpts = tlsOpts;
  return srv;
}
