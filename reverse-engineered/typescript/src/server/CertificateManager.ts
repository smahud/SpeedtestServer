/**
 * CertificateManager — canonical TLS material resolution (MASTER PROMPT v6.0 §9).
 *
 * Implements the fail-closed certificate semantics required of an independent
 * OoklaServer-compatible deployment:
 *
 *   §9.2  BOTH openSSL.server.certificateFile and .privateKeyFile configured
 *         → load the custom pair, validate it, NEVER request automatic
 *           issuance, effectiveUseLetsEncrypt = false, never overwrite the
 *           user's files.
 *   §9.3  only ONE of the pair configured → fatal configuration error (no
 *         silent fallback to self-signed or automatic issuance).
 *   §9.4  useLetsEncrypt = true and no custom files → ACME provisioning
 *         (established `acme-client` library, HTTP-01 challenge). Failure to
 *         provision is FATAL — never hidden behind a self-signed certificate.
 *   §9.5  useLetsEncrypt = false → no automatic issuance; custom certificate
 *         where available; no production-HTTPS claim without one.
 *   §9.6  self-signed is allowed ONLY as explicitly selected development
 *         mode (ssl.allowSelfSigned / zero-TLS-config quick start) and is
 *         announced loudly; it is never a fallback.
 *
 * Custom pair validation covers: parseable certificate, parseable key,
 * matching public keys, and (reported, not fatal) validity period.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as tls from 'tls';
import * as crypto from 'crypto';
import * as forge from 'node-forge';
import { SSLConfig, TlsResolution } from '../types/core';
import { TlsConfigurationError } from '../types/core';
import { Logger } from './Logger';
import { AcmeProvisioner, AcmeResult } from './AcmeProvisioner';

export interface CertificateManagerDeps {
  logger: Logger;
  /** Used by the ACME path only. */
  acme?: AcmeProvisioner;
}

export class CertificateManager {
  private readonly ssl: SSLConfig;
  private readonly logger: Logger;
  private readonly acme?: AcmeProvisioner;

  constructor(ssl: SSLConfig | undefined, deps: CertificateManagerDeps) {
    this.ssl = ssl || {};
    this.logger = deps.logger;
    this.acme = deps.acme;
  }

  /**
   * Resolve the effective TLS material. Throws TlsConfigurationError on any
   * invalid/contradictory configuration (fail closed per §9.3/§9.6).
   */
  async resolve(): Promise<TlsResolution> {
    const warnings: string[] = [];
    const certFile = this.ssl.certificateFile?.trim() || '';
    const keyFile = this.ssl.privateKeyFile?.trim() || '';

    // §9.2 / §9.3 — custom certificate pair.
    if (certFile || keyFile) {
      if (!certFile || !keyFile) {
        throw new TlsConfigurationError(
          `Incomplete custom certificate configuration: ${
            certFile ? 'openSSL.server.certificateFile is set but openSSL.server.privateKeyFile is missing'
              : 'openSSL.server.privateKeyFile is set but openSSL.server.certificateFile is missing'
          }. Configure BOTH (custom mode) or NEITHER (automatic/dev mode). Refusing to fall back.`,
          'TLS_INCOMPLETE_CUSTOM_PAIR',
        );
      }
      const cert = this.readFile('certificate', certFile);
      const key = this.readFile('private key', keyFile);
      this.validatePair(cert, key, certFile);
      const info = this.inspect(cert);
      if (info.daysUntilExpiry <= 0) {
        warnings.push(`Certificate ${certFile} EXPIRED ${-info.daysUntilExpiry} day(s) ago; strict HTTPS clients will reject it.`);
      } else if (info.daysUntilExpiry <= 30) {
        warnings.push(`Certificate ${certFile} expires in ${info.daysUntilExpiry} day(s).`);
      }
      if (info.selfSigned) {
        warnings.push(`Certificate ${certFile} is self-signed; it is NOT publicly trusted (§9.6).`);
      }
      // §9.2: custom files effectively disable automatic issuance; the source
      // properties file is never rewritten.
      return {
        mode: 'custom',
        cert,
        key,
        effectiveUseLetsEncrypt: false,
        source: `custom pair ${certFile} + ${keyFile} (effectiveUseLetsEncrypt=false)`,
        warnings,
      };
    }

    // §9.4 — automatic issuance requested.
    if (this.ssl.useLetsEncrypt === true) {
      const acme = this.ssl.acme;
      if (!acme || !Array.isArray(acme.domains) || acme.domains.length === 0 || !acme.email) {
        throw new TlsConfigurationError(
          'OoklaServer.ssl.useLetsEncrypt=true requires ACME settings: ' +
          'OoklaServer.ssl.acme.domains=<fqdn,...> and OoklaServer.ssl.acme.email=<contact>. ' +
          'Automatic issuance needs a domain you control; alternatively configure ' +
          'openSSL.server.certificateFile/privateKeyFile for a custom certificate. ' +
          'Refusing to fall back to a self-signed certificate.',
          'TLS_ACME_UNCONFIGURED',
        );
      }
      if (!this.acme) {
        throw new TlsConfigurationError('ACME provisioner unavailable', 'TLS_ACME_UNAVAILABLE');
      }
      let issued: AcmeResult;
      try {
        issued = await this.acme.provision();
      } catch (error) {
        throw new TlsConfigurationError(
          `Automatic (ACME) certificate provisioning FAILED for [${acme.domains.join(', ')}]: ` +
          `${error instanceof Error ? error.message : String(error)}. ` +
          'Startup aborts — a self-signed fallback would hide the failure (§9.6).',
          'TLS_ACME_FAILED',
        );
      }
      return {
        mode: 'acme',
        cert: issued.certPem,
        key: issued.keyPem,
        effectiveUseLetsEncrypt: true,
        source: `ACME (Let's Encrypt) via ${acme.directoryUrl || AcmeProvisioner.DEFAULT_DIRECTORY} for ${acme.domains.join(', ')}`,
        warnings,
      };
    }

    // §9.5 — automatic issuance explicitly disabled, no custom pair.
    if (this.ssl.useLetsEncrypt === false) {
      if (this.ssl.allowSelfSigned === true) {
        warnings.push('DEVELOPMENT MODE: generating an untrusted self-signed certificate (OoklaServer.ssl.allowSelfSigned=true, useLetsEncrypt=false).');
        return this.selfSigned(warnings);
      }
      throw new TlsConfigurationError(
        'No usable TLS certificate: OoklaServer.ssl.useLetsEncrypt=false and no custom ' +
        'certificate configured (openSSL.server.certificateFile/privateKeyFile). Configure a ' +
        'custom pair, enable automatic issuance, or explicitly select development mode with ' +
        'OoklaServer.ssl.allowSelfSigned=true.',
        'TLS_NO_CERTIFICATE',
      );
    }

    // No TLS intent expressed at all: documented development quick start.
    warnings.push(
      'DEVELOPMENT MODE: no TLS material configured; generating an untrusted self-signed ' +
      'certificate. For production set openSSL.server.certificateFile/privateKeyFile (custom) ' +
      'or OoklaServer.ssl.useLetsEncrypt=true with OoklaServer.ssl.acme.* (automatic).',
    );
    return this.selfSigned(warnings);
  }

  /** §9.7 — re-read and validate the custom pair (reload path). */
  reloadCustomPair(): { cert: string; key: string } {
    const certFile = this.ssl.certificateFile?.trim();
    const keyFile = this.ssl.privateKeyFile?.trim();
    if (!certFile || !keyFile) {
      throw new TlsConfigurationError('reloadCustomPair called without a custom pair', 'TLS_NO_CUSTOM_PAIR');
    }
    const cert = this.readFile('certificate', certFile);
    const key = this.readFile('private key', keyFile);
    this.validatePair(cert, key, certFile);
    return { cert, key };
  }

  /** Validate that cert and key parse and that their public keys match. */
  validatePair(certPem: string, keyPem: string, label: string): void {
    let x509: crypto.X509Certificate;
    try {
      x509 = new crypto.X509Certificate(certPem);
    } catch (error) {
      throw new TlsConfigurationError(`${label}: certificate is not parseable PEM X.509: ${error instanceof Error ? error.message : String(error)}`, 'TLS_BAD_CERT');
    }
    try {
      // createSecureContext verifies the key matches the certificate.
      tls.createSecureContext({ cert: certPem, key: keyPem });
    } catch (error) {
      throw new TlsConfigurationError(
        `${label}: certificate/private key do not match (or key is invalid): ${error instanceof Error ? error.message : String(error)}`,
        'TLS_KEY_MISMATCH',
      );
    }
    void x509;
  }

  private readFile(kind: string, file: string): string {
    const expanded = file.replace('${application.dir}', process.cwd());
    try {
      return fs.readFileSync(path.resolve(expanded), 'utf-8');
    } catch (error) {
      throw new TlsConfigurationError(
        `${kind} file not readable: ${file} (${error instanceof Error ? error.message : String(error)})`,
        'TLS_FILE_UNREADABLE',
      );
    }
  }

  private inspect(certPem: string): { daysUntilExpiry: number; selfSigned: boolean } {
    try {
      const cert = new crypto.X509Certificate(certPem);
      const days = Math.ceil((new Date(cert.validTo).getTime() - Date.now()) / 86_400_000);
      return { daysUntilExpiry: days, selfSigned: cert.subject === cert.issuer };
    } catch {
      return { daysUntilExpiry: Number.NaN, selfSigned: false };
    }
  }

  private selfSigned(warnings: string[]): TlsResolution {
    const { cert, key } = generateDevSelfSigned();
    return {
      mode: 'dev-self-signed',
      cert,
      key,
      effectiveUseLetsEncrypt: false,
      source: 'generated self-signed (development only, NOT publicly trusted)',
      warnings,
    };
  }
}

/** Development self-signed pair (lab/quick-start only — §9.6). */
export function generateDevSelfSigned(): { cert: string; key: string } {
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

export default CertificateManager;
