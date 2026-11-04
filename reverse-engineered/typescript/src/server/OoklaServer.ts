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
 * TLS material is resolved by CertificateManager (MASTER PROMPT v6.0 §9):
 * custom pair precedence, incomplete-pair/incomplete-ACME = fatal, automatic
 * issuance only via standard ACME, self-signed only as explicit development
 * mode, plus hot reload of renewed custom certificates (§9.7).
 *
 * Decommissioned from the startup path (kept in the repo for history):
 * BinaryManager (mock), MetricsUploader (no-op), TracerouteManager (fake
 * data), InstanceLocker (required /var/lock), legacy OoklaRequestHandler,
 * legacy TLSCertificateManager. See validation/DECISIONS.md.
 */

import { EventEmitter } from 'events';
import * as fs from 'fs';
import * as path from 'path';
import { DeepPartial, OoklaServerConfig, ProcessRole, UpdateStatus, BinaryInfo, ServerMetrics, TracerouteRequest, TracerouteResult, TlsResolution } from '../types/core';
import { ConfigManager } from './ConfigManager';
import { Logger } from './Logger';
import { ServerCore } from './ServerCore';
import { CertificateManager } from './CertificateManager';
import { AcmeProvisioner } from './AcmeProvisioner';

/** Compatibility-profile version banner (verified against OoklaServer
 *  2.11.5.2 build 2026-06-04.1737.7d0993d on 2026-11-04). Override with
 *  OoklaServer.netgaugeVersionString in the properties file. */
export const DEFAULT_VERSION_STRING = '2.11 (2.11.5) 2026-06-04.1737.7d0993d';

/** openSSL.server.minimumTLSProtocol → tls.TLSSocket minVersion. */
export function minimumTlsProtocolToMinVersion(value: string | undefined): import('tls').SecureVersion {
  switch ((value || '1.2').trim()) {
    case '1.0': return 'TLSv1';
    case '1.1': return 'TLSv1.1';
    case '1.2': return 'TLSv1.2';
    case '1.3': return 'TLSv1.3';
    default: return 'TLSv1.2';
  }
}

export class OoklaServer extends EventEmitter {
  private config: OoklaServerConfig;
  private configManager: ConfigManager;
  private logger: Logger;
  private core: ServerCore | null = null;
  private role: ProcessRole = 'standalone';
  private isRunning = false;
  private certWatcher: fs.FSWatcher | null = null;
  private acmeRenewalTimer: NodeJS.Timeout | null = null;
  /** Pending certificate-reload debounce timer (cleared on stop — fixes A-11). */
  private certReloadTimer: NodeJS.Timeout | null = null;
  private acmeProvisioner: AcmeProvisioner | null = null;
  private tlsResolution: TlsResolution | null = null;

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

    // ---- TLS material resolution (fail closed; §9.2–§9.6) ----------------
    if (this.config.ssl?.useLetsEncrypt && !this.config.ssl.certificateFile && !this.config.ssl.privateKeyFile && this.config.ssl.acme) {
      this.acmeProvisioner = new AcmeProvisioner(this.config.ssl.acme);
      // Reuse a still-valid issued certificate; only hit the ACME server when
      // there is none or it is near expiry (§9.7 renewal behavior).
      const stored = this.acmeProvisioner.loadStored();
      if (stored && !this.acmeProvisioner.needsRenewal(stored)) {
        this.tlsResolution = {
          mode: 'acme',
          cert: stored.certPem,
          key: stored.keyPem,
          effectiveUseLetsEncrypt: true,
          source: `ACME stored certificate (${this.acmeProvisioner.storageDir})`,
          warnings: [],
        };
      }
    }
    const certManager = new CertificateManager(this.config.ssl, { logger: this.logger, acme: this.acmeProvisioner || undefined });
    if (!this.tlsResolution) {
      this.tlsResolution = await certManager.resolve();
    }
    const tls = this.tlsResolution;
    for (const w of tls.warnings) this.logger.warning(w);
    this.logger.info(`TLS material resolved`, {
      mode: tls.mode,
      source: tls.source,
      effectiveUseLetsEncrypt: tls.effectiveUseLetsEncrypt,
    });

    this.core = new ServerCore({
      tcpPorts,
      udpPorts,
      versionString,
      tls: { cert: Buffer.from(tls.cert), key: Buffer.from(tls.key) },
      tlsMinVersion: minimumTlsProtocolToMinVersion(this.config.ssl?.minimumTLSProtocol) as import('tls').SecureVersion,
      crossDomainPorts: String(tcpPorts[0] ?? 8080),
      evidenceLogPath: this.config.evidenceLogFile || undefined,
      maxConnections: 4096,
      maxConnectionsPerIp: this.config.ipTracking?.maxConnPerIp || 500,
      idleTimeoutMs: Math.min((this.config.maxConnectionSeconds || 3600) * 1000, 3600_000),
      // Verified F-22: the daemon's CSP connect-src reflects allowedDomains
      // (built-in default "*" when the key is absent).
      allowedDomains: this.config.allowedDomains && this.config.allowedDomains.length > 0
        ? this.config.allowedDomains
        : ['*'],
      excludeDefaultDomains: this.config.excludeDefaultDomains === true,
      onEvent: (kind, detail) => {
        if (kind.startsWith('conn_') || kind === 'listen_tcp' || kind === 'listen_udp' || kind === 'started' || kind === 'stopped'
          || kind.startsWith('tls_')) {
          this.logger.info(`[net] ${kind}`, detail as Record<string, unknown>);
        }
      },
    });

    await this.core.start();

    // ---- §9.7 activation & renewal ---------------------------------------
    if (tls.mode === 'custom') {
      this.watchCustomCertificate();
    } else if (tls.mode === 'acme' && this.acmeProvisioner) {
      this.scheduleAcmeRenewal();
    }

    this.isRunning = true;
    this.logger.info('SpeedtestServer started (canonical ServerCore)', {
      tcpPorts,
      udpPorts,
      version: versionString,
      tlsMode: tls.mode,
      effectiveUseLetsEncrypt: tls.effectiveUseLetsEncrypt,
      tlsMinimumProtocol: this.config.ssl?.minimumTLSProtocol || '1.2',
      role: this.role,
    });
    this.emit('started');
  }

  /** Effective TLS state for readiness reporting (installer / probes). */
  tlsStatus(): Record<string, unknown> {
    return this.tlsResolution
      ? {
        mode: this.tlsResolution.mode,
        source: this.tlsResolution.source,
        effectiveUseLetsEncrypt: this.tlsResolution.effectiveUseLetsEncrypt,
        publiclyTrusted: this.tlsResolution.mode !== 'dev-self-signed' && !this.tlsResolution.warnings.some((w) => w.includes('self-signed') || w.includes('EXPIRED')),
      }
      : { mode: 'not-started' };
  }

  /** §9.7 — watch the configured custom certificate files and hot-reload. */
  private watchCustomCertificate(): void {
    const certFile = this.config.ssl?.certificateFile;
    if (!certFile || !this.core) return;
    const watchPath = path.resolve(certFile.replace('${application.dir}', process.cwd()));
    let reloadTimer: NodeJS.Timeout | null = null;
    try {
      this.certWatcher = fs.watch(path.dirname(watchPath), (event, filename) => {
        // Only events for the configured certificate file (dir watchers fire
        // for every file in the directory).
        if (!filename || path.resolve(path.dirname(watchPath), String(filename)) !== watchPath) return;
        if (event !== 'change' && event !== 'rename') return;
        // Debounce: editors often fire several events per save.
        if (reloadTimer) clearTimeout(reloadTimer);
        reloadTimer = setTimeout(() => {
          // Guard (fixes A-11): stop() may have cleared this.core while the
          // debounce timer was still pending.
          if (!this.isRunning || !this.core) return;
          const cm = new CertificateManager(this.config.ssl, { logger: this.logger });
          try {
            const pair = cm.reloadCustomPair();
            const res = this.core!.reloadTls(Buffer.from(pair.cert), Buffer.from(pair.key));
            if (res.ok) {
              this.logger.info('Custom certificate reloaded (hot activation, no restart)', { file: watchPath });
            } else {
              this.logger.error(res.error || 'TLS reload failed');
            }
          } catch (error) {
            // §9.7: preserve the LAST VALID certificate; never serve a broken one.
            this.logger.error(
              `Certificate reload failed (keeping last valid certificate): ${error instanceof Error ? error.message : String(error)}`,
            );
          }
        }, 250);
        this.certReloadTimer = reloadTimer;
      });
      this.logger.info('Watching custom certificate for changes (hot reload)', { file: watchPath });
    } catch (error) {
      this.logger.warning('Could not watch custom certificate path', {
        file: watchPath,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /** §9.7 — daily ACME renewal check; keep last valid certificate on failure. */
  private scheduleAcmeRenewal(): void {
    if (!this.acmeProvisioner) return;
    const check = async (): Promise<void> => {
      if (!this.isRunning || !this.core) return;
      const stored = this.acmeProvisioner!.loadStored();
      if (!this.acmeProvisioner!.needsRenewal(stored)) return;
      this.logger.info('ACME certificate near expiry — renewing');
      try {
        const renewed = await this.acmeProvisioner!.provision();
        const res = this.core.reloadTls(Buffer.from(renewed.certPem), Buffer.from(renewed.keyPem));
        if (res.ok) {
          this.logger.info('ACME certificate renewed and hot-activated');
        } else {
          this.logger.error(res.error || 'ACME renewal reload failed');
        }
      } catch (error) {
        this.logger.error(
          `ACME renewal FAILED (continuing with the last valid certificate): ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    };
    this.acmeRenewalTimer = setInterval(() => void check(), 24 * 60 * 60 * 1000);
    this.acmeRenewalTimer.unref();
  }

  async stop(): Promise<void> {
    if (!this.isRunning) return;
    this.isRunning = false;
    this.certWatcher?.close();
    this.certWatcher = null;
    if (this.certReloadTimer) {
      clearTimeout(this.certReloadTimer);
      this.certReloadTimer = null;
    }
    if (this.acmeRenewalTimer) {
      clearInterval(this.acmeRenewalTimer);
      this.acmeRenewalTimer = null;
    }
    await this.core?.stop();
    this.core = null;
    this.logger.info('SpeedtestServer stopped');
    this.emit('stopped');
  }

  stats(): Record<string, unknown> {
    return this.core ? { ...this.core.stats(), tls: this.tlsStatus() } : { running: false };
  }

  get running(): boolean {
    return this.isRunning;
  }

  /** Legacy event stubs (kept so old consumers compile; not emitted by ServerCore). */
  onLegacyUpdate(_cb: (u: UpdateStatus) => void): void { /* binary auto-update decommissioned */ }
  getBinaryInfo(): BinaryInfo { return { version: 'independent', buildNumber: '', platform: process.platform, architecture: process.arch, sha256: '', size: 0, url: '', signature: '' }; }
  getMetrics(): ServerMetrics { return this.core ? (this.core.stats() as unknown as ServerMetrics) : ({} as ServerMetrics); }
  performTraceroute(_req: TracerouteRequest): Promise<TracerouteResult> {
    return Promise.reject(new Error('Traceroute decommissioned (see validation/DECISIONS.md)'));
  }
}
