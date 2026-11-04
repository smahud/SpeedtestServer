/**
 * ConfigParity + TLS semantics regression suite (MASTER PROMPT v6.0 §9/§11).
 *
 * Part 1 — Configuration parity: every property in the shipped
 * `config/OoklaServer.properties` template must map to the documented config
 * field with the documented value/type (including the version-string
 * exemption for openSSL.server.minimumTLSProtocol).
 *
 * Part 2 — TLS material resolution matrix (§9.2–§9.6): custom precedence,
 * incomplete pair = fatal, key mismatch = fatal, useLetsEncrypt=true without
 * ACME settings = fatal, useLetsEncrypt=false without any certificate =
 * fatal, explicit dev self-signed allowed, zero-config quick start = dev mode
 * with warnings.
 *
 * Part 3 — logging.loggers.* properties reach the Logger configuration.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as forge from 'node-forge';
import { ConfigManager } from './ConfigManager';
import { CertificateManager } from './CertificateManager';
import { minimumTlsProtocolToMinVersion } from './OoklaServer';
import { Logger } from './Logger';
import { TlsConfigurationError, TlsResolution } from '../types/core';

const TEMPLATE = path.join(__dirname, '..', '..', 'config', 'OoklaServer.properties');

function loadTemplate(): ConfigManager {
  process.env.OOKLA_SPEEDTESTSERVER_CONFIG_FILE = TEMPLATE;
  try {
    return new ConfigManager();
  } finally {
    delete process.env.OOKLA_SPEEDTESTSERVER_CONFIG_FILE;
  }
}

describe('Configuration parity: shipped template → ConfigManager', () => {
  test('template exists and is parseable', () => {
    expect(fs.existsSync(TEMPLATE)).toBe(true);
  });

  test('every template property maps to its config field (§11)', () => {
    const cfg = loadTemplate().getConfig();
    // Network / listeners
    expect(cfg.tcpPorts).toEqual([5060, 8080]);
    expect(cfg.udpPorts).toEqual([5060, 8080]);
    expect(cfg.httpPorts).toEqual([8080]);
    expect(cfg.useIPv4).toBe(true);
    expect(cfg.useIPv6).toBe(true);
    // The shipped template sets an explicit wildcard list (template parity);
    // a properties file that omits the key leaves the DEFAULT at [] which
    // ServerCore resolves to the useIPv4/useIPv6 wildcards (F-28, F-29).
    expect(cfg.addresses).toEqual(['0.0.0.0', '::']);
    // Access control
    expect(cfg.allowedDomains).toEqual(['*.speedtest.net', '*.ookla.com', '*.speedtestcustom.com']);
    expect(cfg.excludeDefaultDomains).toBe(false);
    // F-26 (2026-11-05): the template ships the key COMMENTED — matching the
    // official OoklaServer.properties.default, whose daemon default is OFF
    // (verified live: with the key absent, every UA string is served).
    expect(cfg.userAgentFilterEnabled).toBe(false);
    // Worker pool (parsed; runtime model is the Node event loop)
    expect(cfg.workerThreadPool).toEqual({ capacity: 30000, stackSizeBytes: 102400 });
    // IP tracking
    expect(cfg.ipTracking).toEqual({
      maxConnPerIp: 500,
      gcIntervalMinutes: 5,
      maxIdleAgeMinutes: 35,
      slidingWindowBucketLengthMinutes: 5,
      metricTopIpCount: 5,
      maxConnPerBucketPerIp: 20000,
    });
    // Limits
    expect(cfg.maxConnectionSeconds).toBe(3600);
    expect(cfg.http.maxHeadersSize).toBe(65536);
    expect(cfg.websocket?.frameSizeLimitBytes).toBe(5242880);
    // Client auth token
    expect(cfg.clientAuthToken.denyInvalid).toBe(true);
    expect(cfg.clientAuthToken.additionalValidationFields).toEqual([]);
    // SSL — note: minimumTLSProtocol '1.2' must stay a STRING (version
    // semantics), never a float (the value-type converter's special case).
    expect(cfg.ssl?.verificationMode).toBe('none');
    expect(cfg.ssl?.minimumTLSProtocol).toBe('1.2');
    expect(typeof cfg.ssl?.minimumTLSProtocol).toBe('string');
    // useLetsEncrypt / custom cert paths are commented out in the template —
    // they keep their defaults (empty string = not configured):
    expect(cfg.ssl?.useLetsEncrypt).toBeUndefined();
    expect(cfg.ssl?.certificateFile || '').toBe('');
    expect(cfg.ssl?.privateKeyFile || '').toBe('');
    // Update / telemetry settings (parsed; consumers decommissioned by
    // design — see CONFIG_MATRIX.md)
    expect(cfg.enableAutoUpdate).toBe(true);
  });

  test('logging.loggers.* properties reach getLogConfig (parsed AND applied)', () => {
    const log = loadTemplate().getLogConfig();
    expect(log.loggers.app).toBeDefined();
    expect(log.loggers.app.channel.class).toBe('EventLogChannel');
    expect(log.loggers.app.level).toBe('information');
    expect(log.loggers.app.name).toBe('OoklaServer');
  });

  test('--config explicit file selection takes precedence over search path', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sts-cfg-'));
    const file = path.join(dir, 'custom.properties');
    fs.writeFileSync(file, 'OoklaServer.tcpPorts = 9999\n');
    process.env.OOKLA_SPEEDTESTSERVER_CONFIG_FILE = file;
    try {
      const cfg = new ConfigManager().getConfig();
      expect(cfg.tcpPorts).toEqual([9999]);
    } finally {
      delete process.env.OOKLA_SPEEDTESTSERVER_CONFIG_FILE;
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('CLI-flag style overrides take precedence over the loaded file (§11 precedence)', () => {
    // Template (file) says 5060,8080; overrides must win after the fix.
    process.env.OOKLA_SPEEDTESTSERVER_CONFIG_FILE = TEMPLATE;
    try {
      const cfg = new ConfigManager({ tcpPorts: [1234], udpPorts: [1235] }).getConfig();
      expect(cfg.tcpPorts).toEqual([1234]);
      expect(cfg.udpPorts).toEqual([1235]);
    } finally {
      delete process.env.OOKLA_SPEEDTESTSERVER_CONFIG_FILE;
    }
  });

  test('OoklaServer.ssl.* and openSSL.server.* both map into ssl.*', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sts-cfg-'));
    const file = path.join(dir, 'mixed.properties');
    fs.writeFileSync(file, [
      'OoklaServer.ssl.useLetsEncrypt = true',
      'openSSL.server.certificateFile = /a.pem',
      'openSSL.server.privateKeyFile = /a.key',
      'OoklaServer.ssl.acme.domains = speed.example.org',
      'OoklaServer.ssl.acme.email = ops@example.org',
      'OoklaServer.ssl.acme.http01Port = 8080',
    ].join('\n'));
    process.env.OOKLA_SPEEDTESTSERVER_CONFIG_FILE = file;
    try {
      const ssl = new ConfigManager().getConfig().ssl;
      expect(ssl?.useLetsEncrypt).toBe(true);
      expect(ssl?.certificateFile).toBe('/a.pem');
      expect(ssl?.privateKeyFile).toBe('/a.key');
      expect(ssl?.acme?.domains).toEqual(['speed.example.org']);
      expect(ssl?.acme?.email).toBe('ops@example.org');
      expect(ssl?.acme?.http01Port).toBe(8080);
    } finally {
      delete process.env.OOKLA_SPEEDTESTSERVER_CONFIG_FILE;
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

/* ------------------------- TLS fixtures ------------------------- */

interface Pki {
  caCertPem: string;
  certPem: string;
  keyPem: string;
  otherKeyPem: string; // a DIFFERENT private key (mismatch test)
}

let pki: Pki;

beforeAll(() => {
  const caKeys = forge.pki.rsa.generateKeyPair(2048);
  const caCert = forge.pki.createCertificate();
  caCert.publicKey = caKeys.publicKey;
  caCert.serialNumber = '01';
  caCert.validity.notBefore = new Date();
  caCert.validity.notAfter = new Date();
  caCert.validity.notAfter.setFullYear(caCert.validity.notBefore.getFullYear() + 5);
  const caAttrs = [{ name: 'commonName', value: 'Test CA' }];
  caCert.setSubject(caAttrs);
  caCert.setIssuer(caAttrs);
  caCert.setExtensions([{ name: 'basicConstraints', cA: true }]);
  caCert.sign(caKeys.privateKey, forge.md.sha256.create());

  const leafKeys = forge.pki.rsa.generateKeyPair(2048);
  const leaf = forge.pki.createCertificate();
  leaf.publicKey = leafKeys.publicKey;
  leaf.serialNumber = '02';
  leaf.validity.notBefore = new Date();
  leaf.validity.notAfter = new Date();
  leaf.validity.notAfter.setFullYear(leaf.validity.notBefore.getFullYear() + 1);
  leaf.setSubject([{ name: 'commonName', value: 'localhost' }]);
  leaf.setIssuer(caAttrs);
  leaf.setExtensions([{ name: 'subjectAltName', altNames: [{ type: 2, value: 'localhost' }] }]);
  leaf.sign(caKeys.privateKey, forge.md.sha256.create());

  const otherKeys = forge.pki.rsa.generateKeyPair(2048);

  pki = {
    caCertPem: forge.pki.certificateToPem(caCert),
    certPem: forge.pki.certificateToPem(leaf),
    keyPem: forge.pki.privateKeyToPem(leafKeys.privateKey),
    otherKeyPem: forge.pki.privateKeyToPem(otherKeys.privateKey),
  };
});

const noopLogger = new Logger({ loggers: {}, defaultLevel: 'fatal', pattern: '' });

function writeFixtures(dir: string): { certFile: string; keyFile: string } {
  fs.mkdirSync(dir, { recursive: true });
  const certFile = path.join(dir, 'server.pem');
  const keyFile = path.join(dir, 'server.key');
  fs.writeFileSync(certFile, pki.certPem);
  fs.writeFileSync(keyFile, pki.keyPem);
  return { certFile, keyFile };
}

function resolveWith(ssl: Record<string, unknown>, expectFail: 'fatal' | 'ok'): Promise<TlsResolution> {
  const cm = new CertificateManager(ssl as never, { logger: noopLogger });
  const p = cm.resolve();
  if (expectFail === 'fatal') {
    return p.then(
      () => { throw new Error('expected TlsConfigurationError, got success'); },
      (e: unknown) => {
        expect(e).toBeInstanceOf(TlsConfigurationError);
        throw e;
      },
    );
  }
  return p;
}

describe('TLS material resolution matrix (§9.2–§9.6)', () => {
  test('§9.2 custom pair: loaded, validated, effectiveUseLetsEncrypt=false (precedence over useLetsEncrypt=true)', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sts-tls-'));
    try {
      const { certFile, keyFile } = writeFixtures(dir);
      const res = await new CertificateManager({
        certificateFile: certFile,
        privateKeyFile: keyFile,
        useLetsEncrypt: true, // custom pair must still win
      } as never, { logger: noopLogger }).resolve();
      expect(res.mode).toBe('custom');
      expect(res.effectiveUseLetsEncrypt).toBe(false);
      expect(res.cert).toContain('BEGIN CERTIFICATE');
      expect(res.warnings).toHaveLength(0); // CA-signed, not near expiry
      // Files must NOT be modified (§9.2 preserve user files)
      expect(fs.readFileSync(certFile, 'utf-8')).toBe(pki.certPem);
      expect(fs.readFileSync(keyFile, 'utf-8')).toBe(pki.keyPem);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('§9.3 certificateFile without privateKeyFile is FATAL (no fallback)', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sts-tls-'));
    try {
      const { certFile } = writeFixtures(dir);
      await expect(
        new CertificateManager({ certificateFile: certFile } as never, { logger: noopLogger }).resolve(),
      ).rejects.toMatchObject({ code: 'TLS_INCOMPLETE_CUSTOM_PAIR' });
      await expect(
        new CertificateManager({ privateKeyFile: path.join(dir, 'server.key') } as never, { logger: noopLogger }).resolve(),
      ).rejects.toMatchObject({ code: 'TLS_INCOMPLETE_CUSTOM_PAIR' });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('mismatched certificate/private key pair is FATAL', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sts-tls-'));
    try {
      const { certFile } = writeFixtures(dir);
      const wrongKey = path.join(dir, 'wrong.key');
      fs.writeFileSync(wrongKey, pki.otherKeyPem);
      await expect(
        new CertificateManager({ certificateFile: certFile, privateKeyFile: wrongKey } as never, { logger: noopLogger }).resolve(),
      ).rejects.toMatchObject({ code: 'TLS_KEY_MISMATCH' });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('unreadable/missing custom certificate file is FATAL', async () => {
    await expect(
      new CertificateManager({ certificateFile: '/nonexistent/a.pem', privateKeyFile: '/nonexistent/a.key' } as never, { logger: noopLogger }).resolve(),
    ).rejects.toMatchObject({ code: 'TLS_FILE_UNREADABLE' });
  });

  test('§9.4 useLetsEncrypt=true without ACME settings is FATAL (no silent fallback)', async () => {
    await expect(
      new CertificateManager({ useLetsEncrypt: true } as never, { logger: noopLogger }).resolve(),
    ).rejects.toMatchObject({ code: 'TLS_ACME_UNCONFIGURED' });
    await expect(
      new CertificateManager({ useLetsEncrypt: true, acme: { domains: [], email: 'x@example.org' } } as never, { logger: noopLogger }).resolve(),
    ).rejects.toMatchObject({ code: 'TLS_ACME_UNCONFIGURED' });
  });

  test('§9.4 ACME provisioning failure is FATAL (never self-signed fallback)', async () => {
    await expect(
      new CertificateManager({
        useLetsEncrypt: true,
        acme: { domains: ['speed.example.org'], email: 'ops@example.org', directoryUrl: 'http://127.0.0.1:1/dir' },
      } as never, {
        logger: noopLogger,
        acme: {
          provision: () => Promise.reject(new Error('connect ECONNREFUSED (dead directory)')),
        } as never,
      }).resolve(),
    ).rejects.toMatchObject({ code: 'TLS_ACME_FAILED' });
  });

  test('§9.5 useLetsEncrypt=false without certificate and without dev opt-in is FATAL', async () => {
    await expect(
      new CertificateManager({ useLetsEncrypt: false } as never, { logger: noopLogger }).resolve(),
    ).rejects.toMatchObject({ code: 'TLS_NO_CERTIFICATE' });
  });

  test('§9.5/§9.6 useLetsEncrypt=false + allowSelfSigned=true = explicit development mode', async () => {
    const res = await new CertificateManager({ useLetsEncrypt: false, allowSelfSigned: true } as never, { logger: noopLogger }).resolve();
    expect(res.mode).toBe('dev-self-signed');
    expect(res.effectiveUseLetsEncrypt).toBe(false);
    expect(res.warnings.join(' ')).toMatch(/DEVELOPMENT MODE/);
  });

  test('zero-config quick start = documented development mode with loud warning (§9.6)', async () => {
    const res = await new CertificateManager({} as never, { logger: noopLogger }).resolve();
    expect(res.mode).toBe('dev-self-signed');
    expect(res.warnings.join(' ')).toMatch(/DEVELOPMENT MODE/);
    expect(res.warnings.join(' ')).toMatch(/NOT publicly trusted|untrusted/);
  });

  test('§9.7 reloadCustomPair re-reads and validates; keeps throwing on breakage', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sts-tls-'));
    try {
      const { certFile, keyFile } = writeFixtures(dir);
      const cm = new CertificateManager({ certificateFile: certFile, privateKeyFile: keyFile } as never, { logger: noopLogger });
      const pair = cm.reloadCustomPair();
      expect(pair.cert).toBe(pki.certPem);
      // Corrupt the key → reload must fail (caller keeps last valid material)
      fs.writeFileSync(keyFile, 'not a key');
      expect(() => cm.reloadCustomPair()).toThrow(TlsConfigurationError);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('minimumTLSProtocol mapping (openSSL.server.minimumTLSProtocol)', () => {
  test.each([
    ['1.0', 'TLSv1'],
    ['1.1', 'TLSv1.1'],
    ['1.2', 'TLSv1.2'],
    ['1.3', 'TLSv1.3'],
    [undefined, 'TLSv1.2'],
    ['bogus', 'TLSv1.2'],
  ])('%s → %s', (input, expected) => {
    expect(minimumTlsProtocolToMinVersion(input)).toBe(expected);
  });
});
