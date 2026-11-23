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
