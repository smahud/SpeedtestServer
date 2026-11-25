/**
 * workerpool.mjs — smart worker-pool manager for the hybrid gateway (v1.5).
 *
 * Implements the pool control plane ("VPS memegang kendali worker"):
 *
 *   - POOL: worker 1 is the canonical `HYBRID_WORKER_BASE` script; workers
 *     2..N are the numbered siblings (`<base-minus-.workers.dev>-N…`).
 *     The pool SIZE and the ACTIVE SET bounds are env-configured on the VPS.
 *   - SMART ACTIVATION (autoscaler): the number of ACTIVE workers — the set
 *     the gateway routes traffic to — grows with the observed token-mint
 *     rate (tokens/min per active worker) and shrinks after a sustained idle
 *     window. Growth is lazy-canaried: a new worker is health-probed (one
 *     cheap `__down?bytes=0` invocation) before it enters the rotation, and
 *     benched for a cooldown when it fails.
 *   - ROUND-ROBIN selection over healthy active workers.
 *   - OPTIONAL Cloudflare quota guard: with credentials present the manager
 *     polls Workers Analytics (GraphQL, hourly, 1 API call) and exposes the
 *     account-wide daily invocation usage. Above the soft threshold growth
 *     stops; above the hard threshold minting is refused so the account
 *     cannot be quota-burned (Workers Free: 100,000 requests/day
 *     ACCOUNT-WIDE — a pool of 100 workers does NOT multiply that number,
 *     it distributes it).
 *   - v1.5 reconfigure(patch): the routing pool follows the LIVE .env —
 *     deploy count, active bounds, autoscaler tuning and worker URLs can
 *     change while the gateway runs (state preserved per-URL).
 *   - v1.5 createRateLimiter: setMpm() — the rate itself is hot-configurable.
 *
 * Env (all optional; defaults preserve the legacy single-worker behavior):
 *   HYBRID_WORKER_POOL_MAX        default 1      (100 = the Free-plan script cap)
 *   HYBRID_WORKER_ACTIVE_MIN      default 1
 *   HYBRID_WORKER_ACTIVE_MAX      default = pool max
 *   HYBRID_WORKER_SCALE_RATE      default 24     tokens/min per active worker that justifies one more
 *   HYBRID_WORKER_SHRINK_RATE     default 6      tokens/min per active worker considered idle
 *   HYBRID_WORKER_IDLE_SHRINK_MS  default 600000 sustained idle before shrinking by one
 *   HYBRID_WORKER_PROBE_INTERVAL_MS default 0    periodic active-set probing (0 = off; canary on growth always on)
 *   HYBRID_WORKER_PROBE_TIMEOUT_MS default 4000
 *   HYBRID_WORKER_BENCH_COOLDOWN_MS default 120000
 *   HYBRID_WORKER_URLS            explicit comma-separated worker URL list (overrides derivation)
 *   HYBRID_WORKER_CANARY_BYTES    default 0      (__down?bytes=0 TTFB probe)
 *   HYBRID_CF_API_TOKEN / HYBRID_CF_EMAIL + HYBRID_CF_API_KEY / HYBRID_CF_ACCOUNT_ID
 *                                optional — enables the quota guard (token or global key auth)
 *   HYBRID_CF_QUOTA_SOFT_PCT      default 80     stop growing above this % of the daily quota
 *   HYBRID_CF_QUOTA_HARD_PCT      default 95     refuse mints above this %
 *   HYBRID_CF_DAILY_QUOTA         default 100000 (Workers Free)
 */

const TICK_MS = 5000;
const MINT_WINDOW_MS = 60_000;

/** Normalize an IPv4/IPv6 peer to a rate-limit key (IPv6 → /64 bucket). */
export function ipKey(ip) {
  let s = String(ip || 'unknown').trim();
  if (s.startsWith('::ffff:')) s = s.slice(7);
  if (!s.includes(':')) return s;
  const pct = s.indexOf('%');
  if (pct !== -1) s = s.slice(0, pct);
  const dbl = s.indexOf('::');
  let head;
  let tail = [];
  if (dbl !== -1) {
    head = s.slice(0, dbl).split(':').filter(Boolean);
    tail = s.slice(dbl + 2).split(':').filter(Boolean);
  } else {
    head = s.split(':');
  }
  const groups = [...head, ...Array(Math.max(0, 8 - head.length - tail.length)).fill('0'), ...tail];
  return groups.slice(0, 4).join(':') + '::';
}

/** Per-key sliding-window rate limiter. v1.5: setMpm() makes the rate live. */
export function createRateLimiter(mpm) {
  const window = new Map(); // key -> [timestamps]
  let rate = mpm;
  function allow(key) {
    if (!rate) return true;
    const now = Date.now();
    const list = (window.get(key) || []).filter((t) => now - t < 60_000);
    if (list.length >= rate) {
      window.set(key, list);
      if (window.size > 10_000) window.delete(window.keys().next().value);
      return false;
    }
    list.push(now);
    window.set(key, list);
    if (window.size > 10_000) window.delete(window.keys().next().value);
    return true;
  }
  return { allow, setMpm(v) { rate = Number.isFinite(Number(v)) ? Math.max(0, Number(v)) : 0; }, size: () => window.size };
}

function envNum(name, dflt) {
  const v = Number(process.env[name]);
  return Number.isFinite(v) && v >= 0 ? v : dflt;
}

/** Derive worker URLs from a workers.dev base URL:
 *  `<script>.<account>.workers.dev` → worker N is `<script>-N.<account>.workers.dev`.
 *  Non-workers.dev bases (custom domains) cannot be derived — only the
 *  primary is returned; the operator must list HYBRID_WORKER_URLS. */
function deriveWorkerUrls(base, max, log) {
  try {
    const u = new URL(base);
    const host = u.hostname.toLowerCase();
    if (host.endsWith('.workers.dev')) {
      const hostPart = host.slice(0, -'.workers.dev'.length);
      const lastDot = hostPart.lastIndexOf('.');
      if (lastDot > 0) {
        const script = hostPart.slice(0, lastDot);
        const account = hostPart.slice(lastDot + 1);
        const out = [base];
        for (let i = 2; i <= max; i++) {
          out.push(`${u.protocol}//${script}-${i}.${account}.workers.dev`);
        }
        return out;
      }
    }
  } catch {
    /* fall through */
  }
  if (max > 1 && log) {
    log('pool_urls_not_derivable', {
      base,
      hint: 'set HYBRID_WORKER_URLS explicitly (comma-separated) for custom-domain pools',
    });
  }
  return [base];
}

export function createWorkerPool(opts = {}) {
  const log = opts.log || (() => {});
  let base = opts.base || 'http://127.0.0.1:8790';
  let explicitUrls = (process.env.HYBRID_WORKER_URLS || opts.urls || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  let poolMax = Math.max(1, Math.floor(envNum('HYBRID_WORKER_POOL_MAX', opts.poolMax ?? 1)));
  let urls = explicitUrls.length > 1 ? explicitUrls.slice(0, poolMax) : deriveWorkerUrls(base, poolMax, log);
  let effectiveMax = Math.min(poolMax, urls.length);

  let activeMin = Math.max(1, Math.min(effectiveMax, Math.floor(envNum('HYBRID_WORKER_ACTIVE_MIN', opts.activeMin ?? 1))));
  let activeMaxArg = Math.floor(envNum('HYBRID_WORKER_ACTIVE_MAX', opts.activeMax ?? 0));
  let activeMax = Math.max(activeMin, Math.min(effectiveMax, activeMaxArg || effectiveMax));
  let scaleRate = Math.max(1, envNum('HYBRID_WORKER_SCALE_RATE', opts.scaleRate ?? 24));
  let shrinkRate = Math.max(1, envNum('HYBRID_WORKER_SHRINK_RATE', opts.shrinkRate ?? 6));
  let idleShrinkMs = envNum('HYBRID_WORKER_IDLE_SHRINK_MS', opts.idleShrinkMs ?? 600_000);
  let probeIntervalMs = envNum('HYBRID_WORKER_PROBE_INTERVAL_MS', opts.probeIntervalMs ?? 0);
  const probeTimeoutMs = envNum('HYBRID_WORKER_PROBE_TIMEOUT_MS', opts.probeTimeoutMs ?? 4000);
  const benchCooldownMs = envNum('HYBRID_WORKER_BENCH_COOLDOWN_MS', opts.benchCooldownMs ?? 120_000);
  const canaryBytes = envNum('HYBRID_WORKER_CANARY_BYTES', 0);

  // Cloudflare quota guard (optional): token method or global key method.
  const cfToken = process.env.HYBRID_CF_API_TOKEN || opts.cfToken || '';
  const cfEmail = process.env.HYBRID_CF_EMAIL || opts.cfEmail || '';
  const cfKey = process.env.HYBRID_CF_API_KEY || opts.cfKey || '';
  const cfAccount = process.env.HYBRID_CF_ACCOUNT_ID || opts.cfAccount || '';
  const cfQuota = Math.max(1000, envNum('HYBRID_CF_DAILY_QUOTA', 100_000));
  const cfSoftPct = envNum('HYBRID_CF_QUOTA_SOFT_PCT', 80);
  const cfHardPct = envNum('HYBRID_CF_QUOTA_HARD_PCT', 95);

  // Worker slots are POSITIONAL (worker N = url index N-1 — matches the
  // deployed script naming `<base>-N`). v1.5 reconfigure() preserves each
  // slot's counters by URL when the pool grows/shrinks.
  let workers = urls.map((url, i) => ({
    id: i + 1,
    url,
    mints: [], // timestamps of tokens routed to this worker (last 60 s)
    benchUntil: 0,
    probeFailures: 0,
    lastProbeOk: 0,
    lastProbeMs: -1,
    served: 0,
  }));

  // BUG FIX (2026-11-25, kept): the active set is an explicit id list;
  // growth scans for the next healthy, non-backing-off candidate anywhere
  // beyond the active set — a dead sibling no longer blocks scale-up.
  let activeIds = workers.slice(0, activeMin).map((w) => w.id);
  let activeCount = activeIds.length;
  let cursor = 0;
  let idleSince = 0;
  let mintTotal = 0;
  const state = { startedAt: Date.now() };
  const canaryBackoff = new Map(); // worker id → { retryAt, failCount }
  let cfUsage = { known: false, used: 0, quota: cfQuota, checkedAt: 0, error: null };
  let probeCursor = 0;
  let stopped = false;
  let reconfigures = 0;

  const healthy = (w) => Date.now() >= w.benchUntil;
  const activeWorkers = () => workers.filter((w) => activeIds.includes(w.id) && healthy(w));

  /** Next growth candidate: lowest-id worker NOT active, not benched, and
   *  not in canary backoff. */
  function nextCandidate() {
    for (const w of workers) {
      if (activeIds.includes(w.id)) continue;
      if (Date.now() < w.benchUntil) continue;
      const bo = canaryBackoff.get(w.id);
      if (bo && Date.now() < bo.retryAt) continue;
      return w;
    }
    return null;
  }

  function pickWorker() {
    const act = activeWorkers();
    if (act.length === 0) return workers[0]; // all benched: fall back to the primary
    // Weighted round-robin: prefer the worker with the fewest in-window mints
    // among the next few candidates (cheap "least busy" heuristic).
    let best = null;
    for (let k = 0; k < act.length; k++) {
      const w = act[(cursor + k) % act.length];
      if (!best || w.mints.length < best.mints.length) best = w;
    }
    cursor = (cursor + 1) % Math.max(1, act.length);
    return best;
  }

  function recordMint(id) {
    const w = workers.find((x) => x.id === id) || workers[0];
    if (!w) return;
    const now = Date.now();
    w.mints.push(now);
    w.served++;
    mintTotal++;
    if (w.mints.length > 512) w.mints.splice(0, w.mints.length - 512);
  }

  function recordWorkerError(id) {
    const w = workers.find((x) => x.id === id);
    if (!w) return;
    w.probeFailures++;
    if (w.probeFailures >= 2) {
      w.benchUntil = Date.now() + benchCooldownMs;
      w.probeFailures = 0;
      log('pool_worker_benched', { id: w.id, cooldownMs: benchCooldownMs });
    }
  }

  function recordWorkerOk(id, latencyMs) {
    const w = workers.find((x) => x.id === id);
    if (!w) return;
    w.probeFailures = 0;
    w.benchUntil = 0;
    w.lastProbeOk = Date.now();
    w.lastProbeMs = latencyMs;
  }

  /** Canary a candidate worker before it enters the rotation (1 invocation). */
  async function canary(w) {
    const bo = canaryBackoff.get(w.id);
    if (bo && Date.now() < bo.retryAt) return false; // backing off a failing candidate
    const url = `${w.url}/__down?bytes=${canaryBytes}`;
    const started = Date.now();
    let ok;
    try {
      const ctl = new AbortController();
      const t = setTimeout(() => ctl.abort(), probeTimeoutMs);
      const res = await fetch(url, { signal: ctl.signal, cache: 'no-store' });
      clearTimeout(t);
      ok = res.status === 200 || res.status === 401; // 401 = alive but token-gated — still healthy
      if (ok) recordWorkerOk(w.id, Date.now() - started);
      else recordWorkerError(w.id);
      await res.arrayBuffer().catch(() => {});
    } catch {
      ok = false;
      recordWorkerError(w.id);
    }
    // Exponential backoff for failing candidates (5 s → 60 s cap).
    if (!ok) {
      const prev = canaryBackoff.get(w.id) || { retryAt: 0, failCount: 0 };
      const backoffMs = Math.min(60_000, 5_000 * 2 ** Math.min(prev.failCount, 4));
      canaryBackoff.set(w.id, { retryAt: Date.now() + backoffMs, failCount: prev.failCount + 1 });
      log('pool_canary_backoff', { id: w.id, backoffMs, failCount: prev.failCount + 1 });
    } else {
      canaryBackoff.delete(w.id);
    }
    return ok;
  }

  function pruneMints() {
    const now = Date.now();
    for (const w of workers) w.mints = w.mints.filter((t) => now - t < MINT_WINDOW_MS);
  }

  function mintRatePerMin() {
    pruneMints();
    return workers.reduce((n, w) => n + w.mints.length, 0);
  }

  /** Quota guard: hourly GraphQL poll of the account-wide daily invocations. */
  function cfHeaders() {
    if (cfToken) return { Authorization: `Bearer ${cfToken}`, 'Content-Type': 'application/json' };
    return { 'X-Auth-Email': cfEmail, 'X-Auth-Key': cfKey, 'Content-Type': 'application/json' };
  }
  async function refreshCfUsage() {
    if ((!cfToken && !(cfEmail && cfKey)) || !cfAccount) return;
    if (Date.now() - cfUsage.checkedAt < 3600_000) return;
    cfUsage.checkedAt = Date.now();
    const since = new Date();
    since.setUTCHours(0, 0, 0, 0);
    const q = `query { viewer { accounts(filter: {accountTag: "${cfAccount}"}) { workersInvocationsAdaptive(limit: 100, filter: {datetime_geq: "${since.toISOString()}"}) { sum { requests errors } } } } }`;
    try {
      const res = await fetch('https://api.cloudflare.com/client/v4/graphql', {
        method: 'POST',
        headers: cfHeaders(),
        body: JSON.stringify({ query: q }),
      });
      const j = await res.json();
      const rows = j?.data?.viewer?.accounts?.[0]?.workersInvocationsAdaptive || [];
      const used = rows.reduce((n, r) => n + (r?.sum?.requests || 0), 0);
      cfUsage = { known: true, used, quota: cfQuota, checkedAt: Date.now(), error: null };
      log('pool_cf_usage', { used, quota: cfQuota });
    } catch (e) {
      cfUsage = { ...cfUsage, checkedAt: Date.now(), error: String(e).slice(0, 120) };
    }
  }

  const quotaPct = () => (cfUsage.known ? (100 * cfUsage.used) / cfUsage.quota : 0);
  const quotaBlocksGrowth = () => quotaPct() >= cfSoftPct;
  const quotaBlocksMint = () => quotaPct() >= cfHardPct;

  async function tick() {
    if (stopped) return;
    try {
      await refreshCfUsage();
      const rate = mintRatePerMin();
      const target = Math.max(activeMin, Math.min(activeMax, Math.ceil(rate / scaleRate)));

      if (target > activeCount && !quotaBlocksGrowth()) {
        // Grow one worker per tick (canary-gated).
        const candidate = nextCandidate();
        if (candidate) {
          const ok = await canary(candidate);
          if (ok) {
            activeIds.push(candidate.id);
            activeCount = activeIds.length;
            log('pool_scaled_up', { activeCount, target, mintRatePerMin: rate, workerId: candidate.id });
          } else {
            log('pool_canary_failed', { id: candidate.id });
          }
        }
        idleSince = 0;
      } else if (rate < shrinkRate * activeCount) {
        // Below the idle line: shrink by one after a sustained idle window
        // (from the tail — the primary worker 1 is never the one removed).
        if (!idleSince) idleSince = Date.now();
        else if (Date.now() - idleSince >= idleShrinkMs && activeCount > activeMin) {
          while (activeIds.length > activeMin && activeIds[activeIds.length - 1] === 1) {
            activeIds.unshift(activeIds.pop());
            break;
          }
          if (activeIds.length > activeMin) {
            const removed = activeIds.pop();
            activeCount = activeIds.length;
            log('pool_scaled_down', { activeCount, removed, mintRatePerMin: rate });
          }
          idleSince = Date.now();
        }
      } else {
        idleSince = 0;
      }

      // Optional periodic health probing of the ACTIVE set (staggered).
      if (probeIntervalMs > 0 && Date.now() - (state.lastPeriodicProbeAt || 0) >= probeIntervalMs / Math.max(1, activeCount)) {
        const act = activeWorkers();
        if (act.length > 0) {
          const w = act[probeCursor % act.length];
          probeCursor++;
          state.lastPeriodicProbeAt = Date.now();
          await canary(w);
        }
      }
    } catch (e) {
      log('pool_tick_error', { error: String(e).slice(0, 160) });
    }
    if (!stopped) setTimeout(tick, TICK_MS);
  }

  const timer = setTimeout(tick, TICK_MS);
  timer.unref?.();

  // --- v1.5: live reconfiguration (.env hot-reload) ------------------------
  function reconfigure(patch = {}) {
    reconfigures++;
    if (patch.poolMax !== undefined && Number.isFinite(Number(patch.poolMax)) && Number(patch.poolMax) >= 1) {
      poolMax = Math.floor(Number(patch.poolMax));
    }
    if (patch.activeMin !== undefined && Number.isFinite(Number(patch.activeMin)) && Number(patch.activeMin) >= 1) {
      activeMin = Math.floor(Number(patch.activeMin));
    }
    if (patch.activeMax !== undefined && Number.isFinite(Number(patch.activeMax)) && Number(patch.activeMax) >= 0) {
      activeMaxArg = Math.floor(Number(patch.activeMax));
    }
    if (patch.scaleRate !== undefined && Number.isFinite(Number(patch.scaleRate)) && Number(patch.scaleRate) >= 1) {
      scaleRate = Math.floor(Number(patch.scaleRate));
    }
    if (patch.shrinkRate !== undefined && Number.isFinite(Number(patch.shrinkRate)) && Number(patch.shrinkRate) >= 1) {
      shrinkRate = Math.floor(Number(patch.shrinkRate));
    }
    if (patch.idleShrinkMs !== undefined && Number.isFinite(Number(patch.idleShrinkMs)) && Number(patch.idleShrinkMs) >= 0) {
      idleShrinkMs = Number(patch.idleShrinkMs);
    }
    if (patch.probeIntervalMs !== undefined && Number.isFinite(Number(patch.probeIntervalMs)) && Number(patch.probeIntervalMs) >= 0) {
      probeIntervalMs = Number(patch.probeIntervalMs);
    }
    if (patch.workerUrls && patch.workerUrls.length > 1) {
      explicitUrls = patch.workerUrls.slice();
    }
    if (patch.workerBase && patch.workerBase !== base) {
      base = patch.workerBase;
    }
    if (explicitUrls.length > 1) {
      urls = explicitUrls.slice(0, poolMax);
    } else {
      urls = deriveWorkerUrls(base, poolMax, log);
    }
    effectiveMax = Math.min(poolMax, urls.length);
    activeMin = Math.max(1, Math.min(effectiveMax, activeMin));
    activeMax = Math.max(activeMin, Math.min(effectiveMax, activeMaxArg || effectiveMax));

    // Reconcile worker slots POSITIONALLY, preserving per-URL counters.
    const byUrl = new Map(workers.map((w) => [w.url, w]));
    workers = urls.map((url, i) => {
      const prev = byUrl.get(url);
      return prev
        ? { ...prev, id: i + 1 }
        : { id: i + 1, url, mints: [], benchUntil: 0, probeFailures: 0, lastProbeOk: 0, lastProbeMs: -1, served: 0 };
    });
    // Keep the backoff map bounded to the current pool size.
    for (const id of [...canaryBackoff.keys()]) if (id > effectiveMax) canaryBackoff.delete(id);

    // Clamp the active set into the new bounds (keep the lowest ids).
    activeIds = activeIds.filter((id) => id <= effectiveMax).sort((a, b) => a - b).slice(0, activeMax);
    while (activeIds.length < activeMin) {
      const next = activeIds.length + 1;
      if (next > effectiveMax) break;
      activeIds.push(next);
    }
    activeCount = activeIds.length;
    idleSince = 0;
    log('pool_reconfigured', { poolMax: effectiveMax, activeMin, activeMax, activeCount, reconfigures });
  }

  function status() {
    pruneMints();
    return {
      poolMax: effectiveMax,
      activeMin,
      activeMax,
      activeCount,
      reconfigures,
      mintRatePerMin: mintRatePerMin(),
      mintsTotal: mintTotal,
      scaleRate,
      shrinkRate,
      idleShrinkMs,
      probing: probeIntervalMs > 0,
      quotaGuard: cfToken || (cfEmail && cfKey) ? { enabled: true, ...cfUsage, usedPct: Math.round(quotaPct() * 10) / 10, softPct: cfSoftPct, hardPct: cfHardPct } : { enabled: false },
      quotaBlocksGrowth: quotaBlocksGrowth(),
      quotaBlocksMint: quotaBlocksMint(),
      activeIds: [...activeIds],
      workers: workers.slice(0, Math.min(effectiveMax, Math.max(...activeIds, activeMin) + 4)).map((w) => ({
        id: w.id,
        url: w.url,
        active: activeIds.includes(w.id),
        healthy: healthy(w),
        benchedUntil: w.benchUntil > Date.now() ? new Date(w.benchUntil).toISOString() : null,
        inWindowMints: w.mints.length,
        servedTotal: w.served,
        lastProbeMs: w.lastProbeMs,
      })),
    };
  }

  return {
    primaryUrl: base,
    poolMax: effectiveMax,
    pickWorker,
    recordMint,
    recordWorkerError,
    recordWorkerOk,
    canary,
    reconfigure,
    status,
    quotaBlocksMint,
    mintRatePerMin,
    stop() {
      stopped = true;
      clearTimeout(timer);
    },
  };
}
