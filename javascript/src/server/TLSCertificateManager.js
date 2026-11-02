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
const https = require('https');
const forge = require('node-forge');
const { Logger } = require('./Logger');

const DEFAULT_CERT_DIR = '/etc/ooklaserver/certs';
const CERT_FILE_NAME = 'server.pem';
const KEY_FILE_NAME = 'server.key';
const CA_FILE_NAME = 'ca.pem';
const CERT_RENEWAL_DAYS = 30;

// Ookla Host API endpoints for Let's Encrypt
const HOST_API_URL = 'https://host-api.speedtest.net';
const LE_CERT_ENDPOINT = '/api/le/certificate';
const LE_CERT_RENEW_ENDPOINT = '/api/le/renew';

class TLSCertificateManager extends EventEmitter {
  constructor(config, logger) {
    super();
    this.config = config;
    this.logger = logger;
    // Use custom cert/key paths if provided, otherwise use default directory
    this.certFile = config.certificateFile || null;
    this.keyFile = config.privateKeyFile || null;
    this.caFile = config.caFile || null;
    this.certDir = config.certPath ? path.dirname(config.certPath) : DEFAULT_CERT_DIR;
    this.hostApiUrl = config.acme?.hostApiUrl || HOST_API_URL;
    this.serverId = config.acme?.serverId || '';
    this.serverPassword = config.acme?.serverPassword || '';
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
    // Use custom cert/key paths if provided
    const certPath = this.certFile || path.join(this.certDir, CERT_FILE_NAME);
    const keyPath = this.keyFile || path.join(this.certDir, KEY_FILE_NAME);
    const caPath = this.caFile || path.join(this.certDir, CA_FILE_NAME);

    try {
      if (!fs.existsSync(certPath) || !fs.existsSync(keyPath)) {
        this.logger.warning('Certificate files not found', { certPath, keyPath });
        return await this.requestInitialCertificate();
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

    // Save self-signed cert to default directory
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
    // Use Node.js X509Certificate for parsing (supports both RSA and ECDSA)
    const { X509Certificate } = require('crypto');
    const cert = new X509Certificate(certPem);

    // Extract SAN from certificate
    let san = ['localhost', '127.0.0.1', '::1'];
    try {
      const sanExt = cert.subjectAltName;
      if (sanExt) {
        san = sanExt.split(', ').map(s => s.replace('DNS:', '').trim());
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

    // Try Let's Encrypt via Host API if configured
    if (this.config.acme?.enabled && this.serverId && this.serverPassword) {
      this.logger.info('Attempting Let\'s Encrypt renewal via Ookla Host API...');
      let leResult = await this.renewLeCertificate();

      // If renewal fails, try initial request
      if (!leResult) {
        this.logger.info('Renewal failed, trying initial certificate request...');
        leResult = await this.requestLeCertificate();
      }

      if (leResult) {
        await this.saveCertificate(leResult.certPem, leResult.keyPem, leResult.caPem);
        const cert = await this.loadCertificate();
        if (cert) {
          this.emit('certificateRenewed', cert);
          return cert;
        }
      }

      this.logger.warning('Let\'s Encrypt via Host API failed, falling back to self-signed');
    }

    // Fallback to self-signed
    return this.generateSelfSignedCertificate();
  }

  /**
   * Request Let's Encrypt certificate from Ookla Host API
   */
  async requestLeCertificate() {
    if (!this.serverId || !this.serverPassword) {
      this.logger.warning('Server ID or password not configured for Let\'s Encrypt');
      return null;
    }

    try {
      this.logger.info('Requesting Let\'s Encrypt certificate from Ookla Host API...');

      const url = `${this.hostApiUrl}${LE_CERT_ENDPOINT}`;
      const auth = Buffer.from(`${this.serverId}:${this.serverPassword}`).toString('base64');

      const response = await this.makeHttpRequest('POST', url, {
        'Authorization': `Basic ${auth}`,
        'Content-Type': 'application/json',
        'User-Agent': 'OoklaServer/1.0',
      }, JSON.stringify({
        serverId: this.serverId,
        domains: this.config.acme?.domains || [],
        keyType: 'ECDSA',
      }));

      if (response.statusCode !== 200) {
        this.logger.error('Failed to request LE certificate', { status: response.statusCode, body: response.body });
        return null;
      }

      const data = JSON.parse(response.body);
      if (!data.certificate || !data.privateKey) {
        this.logger.error('Invalid LE certificate response', { data });
        return null;
      }

      this.logger.info('Let\'s Encrypt certificate received from Host API');
      return {
        certPem: data.certificate,
        keyPem: data.privateKey,
        caPem: data.caCertificate,
      };
    } catch (error) {
      this.logger.error('Error requesting LE certificate', { error: error.message });
      return null;
    }
  }

  /**
   * Renew Let's Encrypt certificate via Ookla Host API
   */
  async renewLeCertificate() {
    if (!this.serverId || !this.serverPassword) {
      this.logger.warning('Server ID or password not configured for Let\'s Encrypt renewal');
      return null;
    }

    try {
      this.logger.info('Renewing Let\'s Encrypt certificate via Ookla Host API...');

      const url = `${this.hostApiUrl}${LE_CERT_RENEW_ENDPOINT}`;
      const auth = Buffer.from(`${this.serverId}:${this.serverPassword}`).toString('base64');

      const response = await this.makeHttpRequest('POST', url, {
        'Authorization': `Basic ${auth}`,
        'Content-Type': 'application/json',
        'User-Agent': 'OoklaServer/1.0',
      }, JSON.stringify({
        serverId: this.serverId,
      }));

      if (response.statusCode !== 200) {
        this.logger.error('Failed to renew LE certificate', { status: response.statusCode, body: response.body });
        return null;
      }

      const data = JSON.parse(response.body);
      if (!data.certificate || !data.privateKey) {
        this.logger.error('Invalid LE certificate renewal response', { data });
        return null;
      }

      this.logger.info('Let\'s Encrypt certificate renewed via Host API');
      return {
        certPem: data.certificate,
        keyPem: data.privateKey,
        caPem: data.caCertificate,
      };
    } catch (error) {
      this.logger.error('Error renewing LE certificate', { error: error.message });
      return null;
    }
  }

  /**
   * Make HTTP request to Host API
   */
  makeHttpRequest(method, url, headers, body) {
    return new Promise((resolve, reject) => {
      const parsedUrl = new URL(url);
      const options = {
        hostname: parsedUrl.hostname,
        port: parsedUrl.port || 443,
        path: parsedUrl.pathname + parsedUrl.search,
        method,
        headers,
        rejectUnauthorized: false,
      };

      const req = https.request(options, (res) => {
        let data = '';
        res.on('data', (chunk) => { data += chunk; });
        res.on('end', () => {
          resolve({ statusCode: res.statusCode || 0, body: data });
        });
      });

      req.on('error', (err) => reject(err));
      req.setTimeout(30000, () => {
        req.destroy();
        reject(new Error('Request timeout'));
      });

      if (body) {
        req.write(body);
      }
      req.end();
    });
  }

  /**
   * Save certificate files to disk
   */
  async saveCertificate(certPem, keyPem, caPem) {
    const certPath = this.certFile || path.join(this.certDir, CERT_FILE_NAME);
    const keyPath = this.keyFile || path.join(this.certDir, KEY_FILE_NAME);
    const caPath = this.caFile || path.join(this.certDir, CA_FILE_NAME);

    // Ensure directory exists
    const certDir = path.dirname(certPath);
    if (!fs.existsSync(certDir)) {
      fs.mkdirSync(certDir, { recursive: true, mode: 0o755 });
    }

    // Write files
    fs.writeFileSync(certPath, certPem, { mode: 0o644 });
    fs.writeFileSync(keyPath, keyPem, { mode: 0o600 });
    if (caPem) {
      fs.writeFileSync(caPath, caPem, { mode: 0o644 });
    }

    this.logger.debug('Certificate files saved', { certPath, keyPath });
  }

  /**
   * Initial certificate request - tries Let's Encrypt via Host API if enabled
   */
  async requestInitialCertificate() {
    // Try Let's Encrypt via Host API if configured
    if (this.config.acme?.enabled && this.serverId && this.serverPassword) {
      this.logger.info('Requesting Let\'s Encrypt certificate via Ookla Host API...');
      const leResult = await this.requestLeCertificate();

      if (leResult) {
        await this.saveCertificate(leResult.certPem, leResult.keyPem, leResult.caPem);
        const cert = await this.loadCertificate();
        if (cert) {
          this.emit('certificateGenerated', cert);
          return cert;
        }
      }

      this.logger.warning('Let\'s Encrypt via Host API failed, falling back to self-signed');
    }

    // Fallback to self-signed
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