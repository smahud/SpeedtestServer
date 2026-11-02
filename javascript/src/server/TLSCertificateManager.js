/**
 * TLS Certificate Manager - Handles SSL/TLS certificates for secure connections
 * Based on reverse engineering of OoklaServer TLSCertificateManager.cpp
 * JavaScript implementation with proper certificate generation using node-forge
 */

const EventEmitter = require('events');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const tls = require('tls');
const forge = require('node-forge');
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

  parseCertificate(certPem, keyPem, caPem) {
    const cert = forge.pki.certificateFromPem(certPem);
    const certDer = forge.asn1.toDer(forge.pki.certificateToAsn1(cert)).getBytes();
    const subject = cert.subject.attributes.map(a => `${a.name}=${a.value}`).join(',');
    const issuer = cert.issuer.attributes.map(a => `${a.name}=${a.value}`).join(',');
    const expiresAt = cert.validity.notAfter.getTime();
    const san = cert.getExtension('subjectAltName')?.altNames.map(n => n.value) || ['localhost', '127.0.0.1', '::1'];

    const now = Date.now();
    const daysUntilExpiry = Math.ceil((expiresAt - now) / (1000 * 60 * 60 * 24));
    const validFrom = new Date(cert.validity.notBefore);
    const validTo = new Date(cert.validity.notAfter);

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
      fingerprint: crypto.createHash('sha256').update(certDer).digest('hex'),
    };
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
    }, 24 * 60 * 60 * 1000);
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