/**
 * TLS Certificate Manager - Handles SSL/TLS certificates for secure connections
 * Based on reverse engineering of OoklaServer TLSCertificateManager.cpp
 */

import { EventEmitter } from 'events';
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { Logger, TLSCertificateConfig, TLSCertificateInfo } from '../types/core';

const DEFAULT_CERT_DIR = '/etc/ooklaserver/certs';
const CERT_FILE_NAME = 'server.pem';
const KEY_FILE_NAME = 'server.key';
const CA_FILE_NAME = 'ca.pem';
const CERT_RENEWAL_DAYS = 30;

export class TLSCertificateManager extends EventEmitter {
  private config: TLSCertificateConfig;
  private logger: Logger;
  private certDir: string;
  private certificate?: TLSCertificateInfo;
  private renewalTimer?: NodeJS.Timeout;
  private certWatcher?: fs.FSWatcher;

  constructor(config: TLSCertificateConfig, logger: Logger) {
    super();
    this.config = config;
    this.logger = logger;
    this.certDir = config.certDirectory || DEFAULT_CERT_DIR;
  }

  /**
   * Initialize certificate manager
   */
  public async initialize(): Promise<void> {
    this.logger.debug('Initializing TLS Certificate Manager', { certDir: this.certDir });

    // Ensure certificate directory exists
    if (!fs.existsSync(this.certDir)) {
      fs.mkdirSync(this.certDir, { recursive: true, mode: 0o755 });
    }

    // Load existing certificate
    await this.loadCertificate();

    // Start certificate watcher for auto-reload
    this.startCertWatcher();

    // Schedule renewal check
    this.scheduleRenewalCheck();

    this.emit('initialized', this.certificate);
  }

  /**
   * Load certificate from disk
   */
  public async loadCertificate(): Promise<TLSCertificateInfo | undefined> {
    const certPath = path.join(this.certDir, CERT_FILE_NAME);
    const keyPath = path.join(this.certDir, KEY_FILE_NAME);
    const caPath = path.join(this.certDir, CA_FILE_NAME);

    try {
      if (!fs.existsSync(certPath) || !fs.existsSync(keyPath)) {
        this.logger.warning('Certificate files not found', { certPath, keyPath });
        return await this.generateSelfSignedCertificate();
      }

      const certPem = fs.readFileSync(certPath, 'utf-8');
      const keyPem = fs.readFileSync(keyPath, 'utf-8');
      const caPem = fs.existsSync(caPath) ? fs.readFileSync(caPath, 'utf-8') : undefined;

      this.certificate = this.parseCertificate(certPem, keyPem, caPem);

      this.logger.info('TLS certificate loaded', {
        subject: this.certificate.subject,
        issuer: this.certificate.issuer,
        expiresAt: this.certificate.expiresAt,
        daysUntilExpiry: this.certificate.daysUntilExpiry,
      });

      this.emit('certificateLoaded', this.certificate);
      return this.certificate;

    } catch (error) {
      this.logger.error('Failed to load TLS certificate', { error });
      throw error;
    }
  }

  /**
   * Generate self-signed certificate for development/testing
   */
  public async generateSelfSignedCertificate(): Promise<TLSCertificateInfo> {
    this.logger.info('Generating self-signed TLS certificate...');

    const certPath = path.join(this.certDir, CERT_FILE_NAME);
    const keyPath = path.join(this.certDir, KEY_FILE_NAME);

    // Generate key pair
    const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', {
      modulusLength: 2048,
      publicKeyEncoding: { type: 'spki', format: 'pem' },
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    });

    // Create self-signed certificate
    const cert = this.createSelfSignedCert(publicKey, privateKey);

    // Write files
    fs.writeFileSync(keyPath, privateKey, { mode: 0o600 });
    fs.writeFileSync(certPath, cert, { mode: 0o644 });

    this.certificate = this.parseCertificate(cert, privateKey);

    this.logger.info('Self-signed certificate generated', {
      subject: this.certificate.subject,
      expiresAt: this.certificate.expiresAt,
    });

    this.emit('certificateGenerated', this.certificate);
    return this.certificate;
  }

  /**
   * Create a self-signed certificate
   */
  private createSelfSignedCert(publicKey: string, privateKey: string): string {
    // Simplified self-signed certificate creation
    // In production, this would use a proper X.509 library
    const subject = `/CN=OoklaServer/O=Ookla/OU=Speedtest`;
    const notBefore = new Date();
    const notAfter = new Date(notBefore.getTime() + 365 * 24 * 60 * 60 * 1000); // 1 year

    // This is a placeholder - real implementation would use forge or similar
    return `-----BEGIN CERTIFICATE-----\nMIID... (self-signed cert placeholder)\n-----END CERTIFICATE-----`;
  }

  /**
   * Parse certificate PEM into info object
   */
  private parseCertificate(certPem: string, keyPem: string, caPem?: string): TLSCertificateInfo {
    // Extract certificate details from PEM
    // In production, use a proper X.509 parser like 'x509' or 'forge'
    const certDer = this.pemToDer(certPem);
    const subject = this.extractSubject(certDer);
    const issuer = this.extractIssuer(certDer);
    const expiresAt = this.extractExpiry(certDer);
    const san = this.extractSAN(certDer);

    const now = Date.now();
    const daysUntilExpiry = Math.ceil((expiresAt - now) / (1000 * 60 * 60 * 24));

    return {
      certPem,
      keyPem,
      caPem,
      subject,
      issuer,
      expiresAt,
      daysUntilExpiry,
      san,
      isSelfSigned: subject === issuer,
      fingerprint: this.computeFingerprint(certDer),
    };
  }

  /**
   * Convert PEM to DER
   */
  private pemToDer(pem: string): Buffer {
    const b64 = pem.replace(/-----(BEGIN|END) CERTIFICATE-----/g, '').replace(/\s/g, '');
    return Buffer.from(b64, 'base64');
  }

  /**
   * Extract subject from certificate DER
   */
  private extractSubject(der: Buffer): string {
    // Simplified - real implementation would parse ASN.1
    return 'CN=OoklaServer,O=Ookla,OU=Speedtest';
  }

  /**
   * Extract issuer from certificate DER
   */
  private extractIssuer(der: Buffer): string {
    // Simplified
    return 'CN=OoklaServer,O=Ookla,OU=Speedtest';
  }

  /**
   * Extract expiry from certificate DER
   */
  private extractExpiry(der: Buffer): number {
    // Simplified - return 1 year from now
    return Date.now() + 365 * 24 * 60 * 60 * 1000;
  }

  /**
   * Extract Subject Alternative Names
   */
  private extractSAN(der: Buffer): string[] {
    return ['localhost', '127.0.0.1', '::1'];
  }

  /**
   * Compute certificate fingerprint
   */
  private computeFingerprint(der: Buffer): string {
    return crypto.createHash('sha256').update(der).digest('hex');
  }

  /**
   * Get current certificate info
   */
  public getCertificate(): TLSCertificateInfo | undefined {
    return this.certificate ? { ...this.certificate } : undefined;
  }

  /**
   * Check if certificate needs renewal
   */
  public needsRenewal(): boolean {
    if (!this.certificate) return true;
    return this.certificate.daysUntilExpiry <= CERT_RENEWAL_DAYS;
  }

  /**
   * Renew certificate (placeholder for ACME/Let's Encrypt integration)
   */
  public async renewCertificate(): Promise<TLSCertificateInfo> {
    this.logger.info('Renewing TLS certificate...');

    // In production, this would integrate with ACME/Let's Encrypt
    // For now, regenerate self-signed
    return this.generateSelfSignedCertificate();
  }

  /**
   * Schedule periodic renewal check
   */
  private scheduleRenewalCheck(): void {
    this.renewalTimer = setInterval(() => {
      if (this.needsRenewal()) {
        this.logger.info('Certificate nearing expiry, initiating renewal');
        this.renewCertificate().catch((error) => {
          this.logger.error('Certificate renewal failed', { error });
        });
      }
    }, 24 * 60 * 60 * 1000); // Check daily
  }

  /**
   * Start file watcher for certificate changes
   */
  private startCertWatcher(): void {
    const certPath = path.join(this.certDir, CERT_FILE_NAME);

    try {
      this.certWatcher = fs.watch(certPath, (eventType) => {
        if (eventType === 'change') {
          this.logger.info('Certificate file changed, reloading...');
          this.loadCertificate().catch((error) => {
            this.logger.error('Failed to reload certificate', { error });
          });
        }
      });
    } catch (error) {
      this.logger.warning('Could not start certificate watcher', { error });
    }
  }

  /**
   * Get TLS credentials for server
   */
  public getCredentials(): { cert: string; key: string; ca?: string } | undefined {
    if (!this.certificate) return undefined;

    return {
      cert: this.certificate.certPem,
      key: this.certificate.keyPem,
      ca: this.certificate.caPem,
    };
  }

  /**
   * Create secure context for TLS server
   */
  public createSecureContext(): crypto.SecureContext | undefined {
    const creds = this.getCredentials();
    if (!creds) return undefined;

    return crypto.createSecureContext({
      cert: creds.cert,
      key: creds.key,
      ca: creds.ca,
    });
  }

  /**
   * Update configuration
   */
  public updateConfig(config: Partial<TLSCertificateConfig>): void {
    this.config = { ...this.config, ...config };
    this.logger.debug('TLSCertificateManager config updated');
  }

  /**
   * Clean up resources
   */
  public destroy(): void {
    if (this.renewalTimer) {
      clearInterval(this.renewalTimer);
    }
    if (this.certWatcher) {
      this.certWatcher.close();
    }
    this.removeAllListeners();
  }
}

export default TLSCertificateManager;