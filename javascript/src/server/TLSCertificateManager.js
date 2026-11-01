/**
 * TLS Certificate Manager - Handles SSL/TLS certificates for secure connections
 * Based on reverse engineering of OoklaServer TLSCertificateManager.cpp
 * JavaScript implementation
 */

const EventEmitter = require('events');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const tls = require('tls');
const { Logger } = require('./Logger');

const DEFAULT_CERT_DIR = '/etc/ooklaserver/certs';
const CERT_FILE_NAME = 'server.pem';
const KEY_FILE_NAME = 'server.key';
const CA_FILE_NAME = 'ca.pem';
const CERT_RENEWAL_DAYS = 30;

class TLSCertificateManager extends EventEmitter {
  constructor(config, logger) {
    super();
    this.config = config;
    this.logger = logger;
    this.certDir = config.certPath ? path.dirname(config.certPath) : DEFAULT_CERT_DIR;
    this.certificate = null;
    this.renewalTimer = null;
    this.certWatcher = null;
  }

  async initialize() {
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

  async loadCertificate() {
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

  async generateSelfSignedCertificate() {
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

  createSelfSignedCert(_publicKey, _privateKey) {
    // Simplified self-signed certificate creation
    // In production, this would use a proper X.509 library
    const _subject = '/CN=OoklaServer/O=Ookla/OU=Speedtest';
    const _notBefore = new Date();
    const _notAfter = new Date(_notBefore.getTime() + 365 * 24 * 60 * 60 * 1000); // 1 year

    // This is a placeholder - real implementation would use forge or similar
    return `-----BEGIN CERTIFICATE-----\nMIID... (self-signed cert placeholder)\n-----END CERTIFICATE-----`;
  }

  parseCertificate(certPem, keyPem, caPem) {
    // Extract certificate details from PEM
    // In production, use a proper X.509 parser like 'x509' or 'forge'
    const certDer = this.pemToDer(certPem);
    const subject = this.extractSubject(certDer);
    const issuer = this.extractIssuer(certDer);
    const expiresAt = this.extractExpiry(certDer);
    const san = this.extractSAN(certDer);

    const now = Date.now();
    const daysUntilExpiry = Math.ceil((expiresAt - now) / (1000 * 60 * 60 * 24));
    const validFrom = new Date(now);
    const validTo = new Date(expiresAt);

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
      isSelfSigned: subject === issuer,
      fingerprint: this.computeFingerprint(certDer),
    };
  }

  pemToDer(pem) {
    const b64 = pem.replace(/-----(BEGIN|END) CERTIFICATE-----/g, '').replace(/\s/g, '');
    return Buffer.from(b64, 'base64');
  }

  extractSubject(_der) {
    // Simplified - real implementation would parse ASN.1
    return 'CN=OoklaServer,O=Ookla,OU=Speedtest';
  }

  extractIssuer(_der) {
    // Simplified
    return 'CN=OoklaServer,O=Ookla,OU=Speedtest';
  }

  extractExpiry(_der) {
    // Simplified - return 1 year from now
    return Date.now() + 365 * 24 * 60 * 60 * 1000;
  }

  extractSAN(_der) {
    return ['localhost', '127.0.0.1', '::1'];
  }

  computeFingerprint(der) {
    return crypto.createHash('sha256').update(der).digest('hex');
  }

  getCertificate() {
    return this.certificate ? { ...this.certificate } : undefined;
  }

  needsRenewal() {
    const cert = this.certificate;
    if (!cert) return true;
    return (cert.daysUntilExpiry ?? 0) <= CERT_RENEWAL_DAYS;
  }

  async renewCertificate() {
    this.logger.info('Renewing TLS certificate...');

    // In production, this would integrate with ACME/Let's Encrypt
    // For now, regenerate self-signed
    return this.generateSelfSignedCertificate();
  }

  scheduleRenewalCheck() {
    this.renewalTimer = setInterval(() => {
      if (this.needsRenewal()) {
        this.logger.info('Certificate nearing expiry, initiating renewal');
        this.renewCertificate().catch((error) => {
          this.logger.error('Certificate renewal failed', { error });
        });
      }
    }, 24 * 60 * 60 * 1000); // Check daily
  }

  startCertWatcher() {
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

  getCredentials() {
    if (!this.certificate || !this.certificate.certPem || !this.certificate.keyPem) return undefined;

    return {
      cert: this.certificate.certPem,
      key: this.certificate.keyPem,
      ca: this.certificate.caPem,
    };
  }

  createSecureContext() {
    const creds = this.getCredentials();
    if (!creds) return undefined;

    return tls.createSecureContext({
      cert: creds.cert,
      key: creds.key,
      ca: creds.ca,
    });
  }

  updateConfig(config) {
    this.config = { ...this.config, ...config };
    this.logger.debug('TLSCertificateManager config updated');
  }

  async stop() {
    this.destroy();
    this.logger.debug('TLSCertificateManager stopped');
  }

  destroy() {
    if (this.renewalTimer) {
      clearInterval(this.renewalTimer);
    }
    if (this.certWatcher) {
      this.certWatcher.close();
    }
    this.removeAllListeners();
  }
}

module.exports = { TLSCertificateManager };