/**
 * AcmeProvisioner — publicly-trusted certificate provisioning via standard
 * ACME (Let's Encrypt) using the established `acme-client` library.
 *
 * Design constraints (MASTER PROMPT v6.0 §9.4):
 *   - Standard, established ACME client — no custom ACME implementation.
 *   - HTTP-01 challenge only (port 80 listener), the appropriate method for a
 *     typical standalone speedtest host; DNS-01/TLS-ALPN-01 are deliberately
 *     not implemented ("do not implement every challenge method merely for
 *     completeness").
 *   - Requires the operator to control the domain's DNS (their responsibility,
 *     enforced by the CA's validation itself).
 *   - Failures propagate (fail closed) — CertificateManager turns them into a
 *     fatal startup error; renewal failures keep the last valid certificate
 *     (§9.7).
 */

import * as fs from 'fs';
import * as http from 'http';
import * as path from 'path';
import * as crypto from 'crypto';
import { SSLAcmeConfig } from '../types/core';

export interface AcmeResult {
  certPem: string; // full chain (leaf first)
  keyPem: string;
  expiresAt?: number;
}

export const DEFAULT_DIRECTORY = 'https://acme-v02.api.letsencrypt.org/directory';
const RENEW_BEFORE_EXPIRY_DAYS = 30;

export class AcmeProvisioner {
  public static readonly DEFAULT_DIRECTORY = DEFAULT_DIRECTORY;

  private readonly cfg: Required<Pick<SSLAcmeConfig, 'domains' | 'email'>> &
    SSLAcmeConfig & { directoryUrl: string; http01Port: number; storageDir: string };

  constructor(cfg: SSLAcmeConfig) {
    this.cfg = {
      ...cfg,
      directoryUrl: cfg.directoryUrl?.trim() || DEFAULT_DIRECTORY,
      http01Port: cfg.http01Port ?? 80,
      storageDir: cfg.storageDir?.trim() || path.join(process.cwd(), 'certs', 'acme'),
    };
  }

  get directoryUrl(): string {
    return this.cfg.directoryUrl;
  }

  get storageDir(): string {
    return this.cfg.storageDir;
  }

  /** Load a previously issued, still-valid certificate if present. */
  loadStored(): AcmeResult | null {
    try {
      const certPem = fs.readFileSync(path.join(this.cfg.storageDir, 'fullchain.pem'), 'utf-8');
      const keyPem = fs.readFileSync(path.join(this.cfg.storageDir, 'privkey.pem'), 'utf-8');
      const x509 = new crypto.X509Certificate(certPem);
      const expiresAt = new Date(x509.validTo).getTime();
      if (expiresAt <= Date.now()) return null;
      return { certPem, keyPem, expiresAt };
    } catch {
      return null;
    }
  }

  needsRenewal(stored: AcmeResult | null): boolean {
    if (!stored?.expiresAt) return true;
    const days = (stored.expiresAt - Date.now()) / 86_400_000;
    return days <= RENEW_BEFORE_EXPIRY_DAYS;
  }

  /**
   * Run the full ACME flow (account → order → HTTP-01 → finalize → download).
   * Throws on any failure. `acme-client` is imported lazily so environments
   * without the dependency still get a clear error.
   */
  async provision(): Promise<AcmeResult> {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const acme = require('acme-client');
    const { domains, email, directoryUrl, http01Port, storageDir } = this.cfg;

    fs.mkdirSync(storageDir, { recursive: true, mode: 0o755 });
    const accountKeyPath = path.join(storageDir, 'account.key');
    let accountKeyPem: string | null = fs.existsSync(accountKeyPath)
      ? fs.readFileSync(accountKeyPath, 'utf-8')
      : null;
    if (accountKeyPem === null) {
      const { privateKey } = await acme.crypto.createPrivateKey();
      const pem: string = acme.crypto.getPemFromPrivateKey(privateKey);
      fs.writeFileSync(accountKeyPath, pem, { mode: 0o600 });
      accountKeyPem = pem;
    }
    const accountKey = await acme.crypto.importPrivateKey(accountKeyPem);

    const client = new acme.Client({ directoryUrl, accountKey });

    // Register/Update account (idempotent; accepts the subscriber agreement).
    await client.createAccount({ termsOfServiceAgreed: true, contact: [`mailto:${email}`] });

    // Domain key + CSR.
    const domainKeyPath = path.join(storageDir, 'domain.key');
    let domainKeyPem: string | null = fs.existsSync(domainKeyPath)
      ? fs.readFileSync(domainKeyPath, 'utf-8')
      : null;
    if (domainKeyPem === null) {
      const { privateKey } = await acme.crypto.createPrivateKey();
      const pem: string = acme.crypto.getPemFromPrivateKey(privateKey);
      fs.writeFileSync(domainKeyPath, pem, { mode: 0o600 });
      domainKeyPem = pem;
    }
    const [keyObject, csr] = await acme.crypto.createCsr({
      commonName: domains[0],
      altNames: domains,
    }, domainKeyPem);
    void keyObject;

    // HTTP-01 challenge server on http01Port.
    const challenges: Map<string, string> = new Map(); // token → keyAuthorization
    const challengeServer = http.createServer((req, res) => {
      const m = /\/\.well-known\/acme-challenge\/(.+)$/.exec(req.url || '');
      if (m && challenges.has(m[1])) {
        res.writeHead(200, { 'Content-Type': 'application/octet-stream' });
        res.end(challenges.get(m[1]));
      } else {
        res.writeHead(404);
        res.end();
      }
    });
    await new Promise<void>((resolve, reject) => {
      challengeServer.once('error', reject);
      challengeServer.listen(http01Port, () => resolve());
    });
    try {
      const order = await client.createOrder({ identifiers: domains.map((d) => ({ type: 'dns', value: d })) });
      const authorizations = await client.getAuthorizations(order);

      for (const authz of authorizations) {
        const challenge = authz.challenges.find((c: { type: string }) => c.type === 'http-01');
        if (!challenge) {
          throw new Error(`No HTTP-01 challenge offered for ${authz.identifier.value} (challenge types: ${authorizations.map((a: { challenges: { type: string }[] }) => a.challenges.map((c) => c.type).join('/')).join(', ')})`);
        }
        const keyAuthorization = await client.getChallengeKeyAuthorization(challenge);
        challenges.set(challenge.token, keyAuthorization);
        try {
          await client.verifyChallenge(authz, challenge);
          await client.completeChallenge(challenge);
          await client.waitForValidStatus(challenge);
        } finally {
          challenges.delete(challenge.token);
        }
      }

      const finalized = await client.finalizeOrder(order, csr);
      const certPem = await client.getCertificate(finalized);

      fs.writeFileSync(path.join(storageDir, 'fullchain.pem'), certPem, { mode: 0o644 });
      fs.writeFileSync(path.join(storageDir, 'privkey.pem'), domainKeyPem, { mode: 0o600 });
      const x509 = new crypto.X509Certificate(certPem);
      return { certPem, keyPem: domainKeyPem, expiresAt: new Date(x509.validTo).getTime() };
    } finally {
      await new Promise<void>((resolve) => challengeServer.close(() => resolve()));
    }
  }
}

export default AcmeProvisioner;
