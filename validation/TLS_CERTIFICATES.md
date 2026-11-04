# TLS_CERTIFICATES — certificate semantics, provisioning, activation, strict validation (v6.0 §9/§10)

Evidence: `validation/evidence/tls/` (battery `tls-validation.json`, 10/10
PASS), `validation/evidence/gate-revision2/` (differential TLS probes),
unit suite `ConfigParity.test.ts` (TLS matrix), installer evidence
(`validation/evidence/installer/`). Reproduce: `validation/harness/run-tls-validation.sh`.

## 1. Official OoklaServer certificate observations (reference lab)

- Reference daemon 2.11.5.2 in the lab, configured with custom
  `openSSL.server.certificateFile/privateKeyFile` (lab CA pair), serves that
  exact certificate on its speedtest listener (differential probes:
  TLSv1.0/1.1 rejected, 1.2/1.3 accepted — minimumTLSProtocol=1.2 default).
- The official daemon's automatic provisioning (`OoklaServer.ssl.useLetsEncrypt=true`)
  participates in Ookla host management; **no documented public contract for
  it is available to an independent implementation**. An earlier project
  revision invented `/api/le/*` "Host API" endpoints for it — that code has
  been **removed** (RULE 4: no assumed private APIs; see FINDINGS C-3).
- Observed negative scenario (user-reported, reproduced in the lab): a
  self-signed certificate **fails** the Host Tester HTTPS trust check. This
  is REQUIRED behavior, not a defect — §9.6.

## 2. Independent implementation semantics (verified)

Resolution matrix implemented by `CertificateManager.resolve()` (fail-closed):

| # | certificateFile | privateKeyFile | useLetsEncrypt | Result | Evidence |
|---|---|---|---|---|---|
| 1 | set | set | any | **custom pair**: loaded, X.509-parsed, key-match validated, effectiveUseLetsEncrypt=false, files never rewritten, watcher installed | T1, T2, unit §9.2 |
| 2 | set | unset (or vice versa) | any | **fatal** `TLS_INCOMPLETE_CUSTOM_PAIR` — no fallback | N5, unit §9.3 |
| 3 | — | — | true, no `ssl.acme.*` | **fatal** `TLS_ACME_UNCONFIGURED` | N6, unit §9.4 |
| 4 | — | — | true + acme config, issuance fails | **fatal** `TLS_ACME_FAILED` — never a self-signed fallback | N7 (dead directory), unit |
| 5 | — | — | true + acme, issuance succeeds | **ACME cert** (Let's Encrypt via `acme-client`, HTTP-01) | code path verified; real issuance BLOCKED in lab (no operator domain) |
| 6 | — | — | false, no allowSelfSigned | **fatal** `TLS_NO_CERTIFICATE` | unit §9.5 |
| 7 | — | — | false + allowSelfSigned=true | **dev self-signed** with loud warning | unit §9.5/9.6 |
| 8 | — | — | unset (zero-config quick start) | **dev self-signed** with loud warning (documented development default) | N1 behavior |

## 3. Strict HTTPS validation (§10) — actual SpeedtestServer listener (port 8443)

Positive:
- **T1 PASS** — lab-CA-signed custom certificate: strict `https` GET
  (rejectUnauthorized, CA anchors = lab CA, servername=localhost) → HTTP 200,
  TLSv1.3, CN=localhost, chain + hostname + validity + key match all verified.
  Same-port multiplexing proven: HTTPS on the identical port that serves
  NetGauge/HTTP/WS.
- **T2 PASS (§9.7 activation)** — certificate obtained AFTER startup: cert
  file swapped A→B on disk → watcher hot-reloads → new connections serve B's
  fingerprint (no restart, no re-bind); a subsequent **broken** write is
  rejected by the pre-swap `createSecureContext` validation and the **last
  valid certificate (B) keeps being served**.
- **T3 PASS** — `openSSL.server.minimumTLSProtocol = 1.3` → TLSv1.2-only
  client rejected, TLSv1.3 accepted.

Negative (must fail — never verified-away):
- **N1 PASS** self-signed (dev quick start) → strict client FAIL
  (`DEPTH_ZERO_SELF_SIGNED_CERT`)
- **N2 PASS** expired certificate (signed by lab CA, notAfter −10 d) → FAIL
  (`CERT_HAS_EXPIRED`)
- **N3 PASS** wrong-hostname certificate (SAN other.example.test) → FAIL
  (`ERR_TLS_CERT_ALTNAME_INVALID`)
- **N4 PASS** cert/key mismatch → **server refuses to start**
  (`TLS_KEY_MISMATCH`)
- **N5 PASS** incomplete pair → refuses to start
- **N6/N7 PASS** useLetsEncrypt=true without/with-dead ACME → refuses to start

Differential corroboration: with both servers on the lab CA, the TLS probe
rows (protocol floors, strict verify-ok, wrong-hostname fail, no-CA fail) are
identical between daemon and SpeedtestServer — 35/37 probe parity overall.

## 4. Automatic provisioning (§9.4) — standard ACME, honestly bounded

- Implementation: `AcmeProvisioner` on the established `acme-client` library
  (no custom ACME code). **HTTP-01** challenge only (port 80, configurable
  `ssl.acme.http01Port`) — the appropriate method for a typical standalone
  speedtest host. DNS-01 / TLS-ALPN-01 deliberately not implemented (§9.4:
  do not implement every challenge method merely for completeness).
- Configuration: `OoklaServer.ssl.acme.domains` (operator-controlled FQDNs),
  `.email`, `.directoryUrl` (default: Let's Encrypt production), `.storageDir`
  (account key, domain key, fullchain.pem/privkey.pem).
- Renewal: daily check; renewal starts ≤30 days before expiry; renewed
  certificate is hot-activated via the same validated reload path (§9.7);
  renewal failure keeps the last valid certificate (logged).
- **Real issuance is BLOCKED in this lab** (no operator-controlled domain, no
  public port-80 validation path). What is verified instead: configuration
  presence checks, the fail-closed negative paths (N6/N7), the unit matrix,
  and the storage/reuse logic (`loadStored`/`needsRenewal`).
- A **staging-directory** run (`directoryUrl` =
  `https://acme-staging-v02.api.letsencrypt.org/directory`) is the documented
  operator path to validate the flow end-to-end on a real host before
  switching to production.

## 5. Public trust vs laboratory trust (§10 boundary)

The TLS battery proves trusted-chain behavior using the **lab CA** as the
trust anchor — deliberately distinguished from **public** trust: a certificate
is publicly trusted only when issued by a real ACME CA (§4) or supplied as a
commercially-signed custom pair (§2 row 1 with a public CA). The dev
self-signed mode is development-only, announced in every startup log, and
`--validate-config` reports `publiclyTrusted: false` for it.

## 6. Scope notes

- Single certificate per listener (no SNI-based multi-cert) — matches the
  verified reference profile; SNI is answered (default cert) without
  selection.
- `openSSL.server.verificationMode` is fixed to the verified daemon default
  (`none`): the server never requests client certificates.
- The legacy `TLSCertificateManager` is decommissioned; its invented Host-API
  endpoints and `rejectUnauthorized:false` are removed from the tree.
