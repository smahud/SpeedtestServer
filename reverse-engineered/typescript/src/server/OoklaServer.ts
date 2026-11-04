/**
 * OoklaServer — top-level server facade (canonical implementation).
 *
 * This revision replaces the previous listener architecture (which had P0
 * defects: competing HTTP/HTTPS listeners on the same port, swallowed
 * EADDRINUSE, no native NetGauge engine, root-only paths) with ServerCore:
 * a single multiplexed listener per port speaking the full OoklaServer
 * compatibility profile — native NetGauge (TCP + TLS-wrapped), HTTP/legacy
 * endpoints, WebSocket (/ws), and the UDP packet-loss protocol.
 *
 * Decommissioned from the startup path (kept in the repo for history):
 * BinaryManager (mock), MetricsUploader (no-op), TracerouteManager (fake
 * data), InstanceLocker (required /var/lock), legacy OoklaRequestHandler.
 * See validation/DECISIONS.md.
 */

import { EventEmitter } from 'events';
import * as fs from 'fs';
import * as path from 'path';
import * as forge from 'node-forge';
import { DeepPartial, OoklaServerConfig, ProcessRole, UpdateStatus, BinaryInfo, ServerMetrics, TracerouteRequest, TracerouteResult } from '../types/core';
import { ConfigManager } from './ConfigManager';
import { Logger } from './Logger';
import { ServerCore } from './ServerCore';

/** Compatibility-profile version banner (verified against OoklaServer
 *  2.11.5.2 build 2026-06-04.1737.7d0993d on 2026-11-04). Override with
 *  OoklaServer.netgaugeVersionString in the properties file. */
export const DEFAULT_VERSION_STRING = '2.11 (2.11.5) 2026-06-04.1737.7d0993d';

export class OoklaServer extends EventEmitter {
  private config: OoklaServerConfig;
  private configManager: ConfigManager;
  private logger: Logger;
  private core: ServerCore | null = null;
  private role: ProcessRole = 'standalone';
  private isRunning = false;

  constructor(config?: DeepPartial<OoklaServerConfig>) {
    super();
    this.configManager = new ConfigManager(config);
    this.config = this.configManager.getConfig();
    this.logger = new Logger(this.configManager.getLogConfig());
  }

  async start(role: ProcessRole = 'standalone'): Promise<void> {
    if (this.isRunning) throw new Error('Server already running');
    this.role = role;

    const versionString = this.config.netgaugeVersionString || DEFAULT_VERSION_STRING;
    const tcpPorts = this.config.tcpPorts && this.config.tcpPorts.length ? this.config.tcpPorts : [8080, 5060];
    const udpPorts = this.config.udpPorts && this.config.udpPorts.length ? this.config.udpPorts : [8080, 5060];

    // TLS material: explicit files, or an ephemeral self-signed pair written
    // to a WRITABLE location (no /etc/ooklaserver requirement).
    let tlsOpts: { cert: Buffer; key: Buffer } | null = null;
    if (this.config.ssl?.certificateFile && this.config.ssl?.privateKeyFile) {
      tlsOpts = {
        cert: fs.readFileSync(this.expandPath(this.config.ssl.certificateFile)),
        key: fs.readFileSync(this.expandPath(this.config.ssl.privateKeyFile)),
      };
      this.logger.info('TLS enabled with configured certificate', { cert: this.config.ssl.certificateFile });
    } else {
      const { cert, key } = this.generateSelfSigned();
      const dir = path.join(process.cwd(), 'certs');
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'server.pem'), cert);
      fs.writeFileSync(path.join(dir, 'server.key'), key);
      tlsOpts = { cert: Buffer.from(cert), key: Buffer.from(key) };
      this.logger.info('TLS enabled with generated self-signed certificate', { dir });
    }

    this.core = new ServerCore({
      tcpPorts,
      udpPorts,
      versionString,
      tls: tlsOpts,
      crossDomainPorts: String(tcpPorts[0] ?? 8080),
      evidenceLogPath: this.config.evidenceLogFile || undefined,
      maxConnections: 4096,
      maxConnectionsPerIp: this.config.ipTracking?.maxConnPerIp || 500,
      idleTimeoutMs: Math.min((this.config.maxConnectionSeconds || 3600) * 1000, 3600_000),
      onEvent: (kind, detail) => {
        if (kind.startsWith('conn_') || kind === 'listen_tcp' || kind === 'listen_udp' || kind === 'started' || kind === 'stopped') {
          this.logger.info(`[net] ${kind}`, detail as Record<string, unknown>);
        }
      },
    });

    this.core.start = this.core.start.bind(this.core);
    await this.core.start();
    this.isRunning = true;
    this.logger.info('SpeedtestServer started (canonical ServerCore)', {
      tcpPorts,
      udpPorts,
      version: versionString,
      role: this.role,
    });
    this.emit('started');
  }

  async stop(): Promise<void> {
    if (!this.isRunning) return;
    this.isRunning = false;
    await this.core?.stop();
    this.core = null;
    this.logger.info('SpeedtestServer stopped');
    this.emit('stopped');
  }

  stats(): Record<string, unknown> {
    return this.core ? this.core.stats() : { running: false };
  }

  get running(): boolean {
    return this.isRunning;
  }

  private expandPath(p: string): string {
    return p.replace('${application.dir}', process.cwd());
  }

  private generateSelfSigned(): { cert: string; key: string } {
    const keys = forge.pki.rsa.generateKeyPair(2048);
    const cert = forge.pki.createCertificate();
    cert.publicKey = keys.publicKey;
    cert.serialNumber = String(Date.now());
    cert.validity.notBefore = new Date();
    cert.validity.notAfter = new Date();
    cert.validity.notAfter.setFullYear(cert.validity.notBefore.getFullYear() + 2);
    const attrs = [
      { name: 'commonName', value: 'localhost' },
      { name: 'organizationName', value: 'SpeedtestServer (independent implementation)' },
    ];
    cert.setSubject(attrs);
    cert.setIssuer(attrs);
    cert.setExtensions([
      { name: 'subjectAltName', altNames: [
        { type: 2, value: 'localhost' }, // DNS
        { type: 2, value: 'lab.ookla.test' },
        { type: 7, ip: '127.0.0.1' }, // IP
        { type: 7, ip: '::1' },
      ] },
      { name: 'basicConstraints', cA: false },
      { name: 'keyUsage', digitalSignature: true, keyEncipherment: true },
      { name: 'extKeyUsage', serverAuth: true },
    ]);
    cert.sign(keys.privateKey, forge.md.sha256.create());
    return {
      cert: forge.pki.certificateToPem(cert),
      key: forge.pki.privateKeyToPem(keys.privateKey),
    };
  }

  /** Legacy event stubs (kept so old consumers compile; not emitted by ServerCore). */
  onLegacyUpdate(_cb: (u: UpdateStatus) => void): void { /* binary auto-update decommissioned */ }
  getBinaryInfo(): BinaryInfo { return { version: 'independent', buildNumber: '', platform: process.platform, architecture: process.arch, sha256: '', size: 0, url: '', signature: '' }; }
  getMetrics(): ServerMetrics { return this.core ? (this.core.stats() as unknown as ServerMetrics) : ({} as ServerMetrics); }
  performTraceroute(_req: TracerouteRequest): Promise<TracerouteResult> {
    return Promise.reject(new Error('Traceroute decommissioned (see validation/DECISIONS.md)'));
  }
}
