/**
 * TLS Certificate Manager - Handles SSL/TLS certificates for secure connections
 * Based on reverse engineering of OoklaServer TLSCertificateManager.cpp
 * TypeScript implementation with proper certificate generation using node-forge
 */

import { EventEmitter } from 'events';
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import * as tls from 'tls';
import * as forge from 'node-forge';
import { TLSCertificateConfig, TLSCertificateInfo } from '../types/core';
import { Logger } from './Logger';

const DEFAULT_CERT_DIR = '/etc/ooklaserver/certs';
const CERT_FILE_NAME = 'server.pem';
const KEY_FILE_NAME = 'server.key';
const CA_FILE_NAME = 'ca.pem';
const CERT_RENEWAL_DAYS = 30;

export class TLSCertificateManager extends EventEmitter {
  private config: TLSCertificateConfig;
  private logger: Logger;
  private certDir: string;
  private certFile: string | null;
  private keyFile: string | null;
  private caFile: string | null;
  private certificate?: TLSCertificateInfo;
  private renewalTimer?: NodeJS.Timeout;
  private certWatcher?: fs.FSWatcher;

  constructor(config: TLSCertificateConfig, logger: Logger) {
    super();
    this.config = config;
    this.logger = logger;
    // Use custom cert/key paths if provided, otherwise use default directory
    this.certFile = config.certificateFile || null;
    this.keyFile = config.privateKeyFile || null;
    this.caFile = config.caFile || null;
    this.certDir = config.certPath ? path.dirname(config.certPath) : DEFAULT_CERT_DIR;
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
    // Use custom cert/key paths if provided
    const certPath = this.certFile || path.join(this.certDir, CERT_FILE_NAME);
    const keyPath = this.keyFile || path.join(this.certDir, KEY_FILE_NAME);
    const caPath = this.caFile || path.join(this.certDir, CA_FILE_NAME);

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
      this.logger.error('Failed to load TLS certificate', { error: error instanceof Error ? error.message : String(error) });
      throw error;
    }
  }

  /**
   * Generate self-signed certificate for development/testing using node-forge
   */
  public async generateSelfSignedCertificate(): Promise<TLSCertificateInfo> {
    this.logger.info('Generating self-signed TLS certificate...');

    const certPath = path.join(this.certDir, CERT_FILE_NAME);
    const keyPath = path.join(this.certDir, KEY_FILE_NAME);

    // Generate key pair using forge
    const keys = forge.pki.rsa.generateKeyPair(2048);

    // Create self-signed certificate
    const cert = forge.pki.createCertificate();
    cert.publicKey = keys.publicKey;
    cert.serialNumber = '01';
    cert.validity.notBefore = new Date();
    cert.validity.notAfter = new Date();
    cert.validity.notAfter.setFullYear(cert.validity.notBefore.getFullYear() + 1);

    const attrs = [{
      name: 'commonName',
      value: 'OoklaServer'
    }, {
      name: 'organizationName',
      value: 'Ookla'
    }, {
      name: 'organizationalUnitName',
      value: 'Speedtest'
    }, {
      name: 'countryName',
      value: 'US'
    }];

    cert.setSubject(attrs);
    cert.setIssuer(attrs);

    // Add extensions
    cert.setExtensions([{
      name: 'basicConstraints',
      cA: true
    }, {
      name: 'keyUsage',
      keyCertSign: true,
      digitalSignature: true,
      nonRepudiation: true,
      keyEncipherment: true,
      dataEncipherment: true
    }, {
      name: 'extKeyUsage',
      serverAuth: true,
      clientAuth: true
    }, {
      name: 'subjectAltName',
      altNames: [{
        type: 2, // DNS
        value: 'localhost'
      }, {
        type: 2,
        value: '127.0.0.1'
      }, {
        type: 2,
        value: '::1'
      }]
    }]);

    // Sign certificate
    cert.sign(keys.privateKey, forge.md.sha256.create());

    // Convert to PEM
    const certPem = forge.pki.certificateToPem(cert);
    const keyPem = forge.pki.privateKeyToPem(keys.privateKey);

    // Write files
    fs.writeFileSync(keyPath, keyPem, { mode: 0o600 });
    fs.writeFileSync(certPath, certPem, { mode: 0o644 });

    this.certificate = this.parseCertificate(certPem, keyPem);

    this.logger.info('Self-signed certificate generated', {
      subject: this.certificate.subject,
      issuer: this.certificate.issuer,
      expiresAt: this.certificate.expiresAt,
      daysUntilExpiry: this.certificate.daysUntilExpiry,
    });

    this.emit('certificateGenerated', this.certificate);
    return this.certificate;
  }

  /**
   * Parse certificate PEM into info object using Node.js X509Certificate (supports RSA and ECDSA)
   */
  private parseCertificate(certPem: string, keyPem: string, caPem?: string): TLSCertificateInfo {
    // Use Node.js X509Certificate for parsing (supports both RSA and ECDSA)
    const { X509Certificate } = require('crypto');
    const cert = new X509Certificate(certPem);

    // Extract SAN from certificate
    let san: string[] = ['localhost', '127.0.0.1', '::1'];
    try {
      const sanExt = cert.subjectAltName;
      if (sanExt) {
        san = sanExt.split(', ').map((s: string) => s.replace('DNS:', '').trim());
      }
    } catch {
      // SAN not available or error
    }

    const expiresAt = new Date(cert.validTo).getTime();
    const now = Date.now();
    const daysUntilExpiry = Math.ceil((expiresAt - now) / (1000 * 60 * 60 * 24));
    const validFrom = new Date(cert.validFrom);
    const validTo = new Date(cert.validTo);
    const subject = cert.subject;
    const issuer = cert.issuer;
    const fingerprint = cert.fingerprint256.replace(/:/g, '').toLowerCase();
    const isSelfSigned = subject === issuer;

    return {
      certPem,
      keyPem,
      caPem,
      subject,
      issuer,
      validFrom,
      validTo,
      expiresAt,
      daysUntilExpiry,
      san,
      isSelfSigned,
      fingerprint,
    };
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
    const cert = this.certificate;
    if (!cert) return true;
    return (cert.daysUntilExpiry ?? 0) <= CERT_RENEWAL_DAYS;
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
          this.logger.error('Certificate renewal failed', { error: error instanceof Error ? error.message : String(error) });
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
            this.logger.error('Failed to reload certificate', { error: error instanceof Error ? error.message : String(error) });
          });
        }
      });
    } catch (error) {
      this.logger.warning('Could not start certificate watcher', { error: error instanceof Error ? error.message : String(error) });
    }
  }

  /**
   * Get TLS credentials for server
   */
  public getCredentials(): { cert: string; key: string; ca?: string } | undefined {
    if (!this.certificate || !this.certificate.certPem || !this.certificate.keyPem) return undefined;

    return {
      cert: this.certificate.certPem,
      key: this.certificate.keyPem,
      ca: this.certificate.caPem,
    };
  }

  /**
   * Create secure context for TLS server
   */
  public createSecureContext(): tls.SecureContext | undefined {
    const creds = this.getCredentials();
    if (!creds) return undefined;

    return tls.createSecureContext({
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
   * Stop the certificate manager
   */
  public async stop(): Promise<void> {
    this.destroy();
    this.logger.debug('TLSCertificateManager stopped');
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