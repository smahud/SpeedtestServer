/**
 * config.ts — typed environment configuration for the hybrid Worker.
 *
 * All values arrive as Worker env vars (wrangler.toml [vars] or secrets).
 * Sensible defaults mirror the OoklaServer 2.11.5.2 compatibility profile
 * verified in validation/PROTOCOL_CONTRACT.md.
 */

export interface Env {
  /** NetGauge compatibility banner (OoklaServer.netgaugeVersionString). */
  VERSION_STRING?: string;
  /** OoklaServer.allowedDomains — drives CSP connect-src / crossdomain.xml /
   *  CORS Origin filter. Default "*". */
  ALLOWED_DOMAINS?: string;
  /** Suppress the three default Ookla domains (excludeDefaultDomains). */
  EXCLUDE_DEFAULT_DOMAINS?: string;
  /** Strict Host validation (daemon SAN semantics + 307 redirect). Default
   *  off: at the Cloudflare edge, hostname routing is already enforced by
   *  SNI/TLS + zone routing before the Worker sees the request. */
  STRICT_HOST_VALIDATION?: string;
  /** Certificate-CN stand-in used as the 307 redirect target in strict mode. */
  CERT_CN?: string;
  /** SAN-equivalent host list for strict Host validation (comma-separated). */
  ALLOWED_HOSTS?: string;
  /** Shared HMAC secret for hybrid session tokens (VPS mints, Worker
   *  verifies locally — zero subrequests). Empty/absent = open lab mode. */
  HYBRID_SHARED_SECRET?: string;
  /** Download byte cap per DOWNLOAD command / __down request. */
  MAX_DOWNLOAD_BYTES?: string;
  /** Upload byte cap per UPLOAD command / __up request. */
  MAX_UPLOAD_BYTES?: string;
  /** WS message size limit (daemon websocket.frameSizeLimitBytes default). */
  WS_FRAME_LIMIT_BYTES?: string;
  /** G-7: serve the daemon-parity legacy HTTP surface (/, /hi, latency.txt,
   *  random*.jpg, upload.php, crossdomain.xml). Default in CODE is FALSE —
   *  production keeps it off (K-7); local tests and the [env.test] Worker
   *  set it to "true". */
  LEGACY_HTTP_ENABLED?: string;
  /** Verbose per-command JSONL logging (dev/evidence mode). Default off —
   *  G-6/Free CPU: per-command console.log on hot paths costs CPU. Session
   *  open/close, transfers and errors are always logged. */
  WORKER_VERBOSE_LOGS?: string;
  /** Worker-pool identity: this deployment's 1-based index in the pool
   *  (worker 1 = the canonical primary script). Default "1". */
  WORKER_ID?: string;
  /** Worker-pool size this deployment knows about (siblings 2..N exist).
   *  Drives autonomous deflection routing. Default "1" (no siblings). */
  WORKER_POOL_MAX?: string;
  /** Per-isolate in-flight requests above which an AUTHENTICATED request is
   *  deflected to the next sibling worker (smart-pool mutual help). Default 6. */
  WORKER_DEFLECT_CONCURRENCY?: string;
}

export const DEFAULTS = {
  versionString: '2.11 (2.11.5) 2026-06-04.1737.7d0993d',
  maxDownloadBytes: 0x7fffffff,
  maxUploadBytes: 0x7fffffff,
  wsFrameLimitBytes: 5242880,
};

export function num(v: string | undefined, dflt: number): number {
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : dflt;
}

export function bool(v: string | undefined): boolean {
  return v === 'true' || v === '1' || v === 'yes';
}

/** allowedDomains as a list (["*"] when unset — daemon default). */
export function domainList(env: Env): string[] {
  const raw = (env.ALLOWED_DOMAINS || '').split(',').map((s) => s.trim()).filter(Boolean);
  return raw.length ? raw : ['*'];
}
