/**
 * runtime.mjs — live runtime configuration for the hybrid gateway (v1.5).
 *
 * v1.5 adds ON-THE-FLY configuration: the repository .env is the single
 * source of truth and is re-read whenever it changes on disk — no restart,
 * no reinstall. The gateway bootstraps from its process environment (the
 * systemd EnvironmentFile) and then watches the .env file for deltas.
 *
 * What hot-applies (via applyEnvSnapshot → gateway wiring):
 *   CF_WORKER_DEPLOY_COUNT        worker pool deploy target (REST converge)
 *   HYBRID_WORKER_*               pool routing bounds + autoscaler tuning
 *   HYBRID_VPS_DL_SHARE           front lane split
 *   HYBRID_FRONT_*                front limits
 *   HYBRID_SESSIONS_RATE_LIMIT_MPM
 *   HYBRID_SHARED_SECRET          token secret (workers redeploy to match)
 *   CLOUDFLARE_* credentials      auth method switch (token ↔ global key)
 *
 * What still needs a restart (bootstrap-only): gateway port/bind/TLS,
 * results file, STS/VPS public bases. Changing those → re-run install.sh
 * (it regenerates gateway.env and restarts the unit).
 *
 * Parsing follows the install.sh env_load semantics exactly: literal
 * KEY=VALUE lines, optional symmetric outer quotes, no inline comments,
 * never evaluated as shell code.
 */

import fs from 'node:fs';

/** .env key → cfg key mapping for hot-syncable settings. */
const ENV_KEY_MAP = {
  CLOUDFLARE_API_TOKEN: 'cfToken',
  CLOUDFLARE_EMAIL: 'cfEmail',
  CLOUDFLARE_API_KEY: 'cfApiKey',
  CLOUDFLARE_ACCOUNT_ID: 'cfAccountId',
  CF_WORKER_DEPLOY_COUNT: 'deployCount',
  CF_WORKER_NAME: 'workerName',
  CF_WORKERS_SUBDOMAIN: 'workersSubdomain',
  HYBRID_SHARED_SECRET: 'secret',
  HYBRID_WORKER_POOL_MAX: 'poolMax',
  HYBRID_WORKER_ACTIVE_MIN: 'activeMin',
  HYBRID_WORKER_ACTIVE_MAX: 'activeMax',
  HYBRID_WORKER_SCALE_RATE: 'scaleRate',
  HYBRID_WORKER_SHRINK_RATE: 'shrinkRate',
  HYBRID_WORKER_IDLE_SHRINK_MS: 'idleShrinkMs',
  HYBRID_WORKER_PROBE_INTERVAL_MS: 'probeIntervalMs',
  HYBRID_WORKER_URLS: 'workerUrls',
  HYBRID_VPS_DL_SHARE: 'vpsDlShare',
  HYBRID_WEB_DIRECT: 'webDirect',
  HYBRID_FRONT_RATE_LIMIT_MPM: 'frontRateLimitMpm',
  HYBRID_FRONT_MAX_DOWN_BYTES: 'frontMaxDownBytes',
  HYBRID_FRONT_TOKEN_CACHE_MS: 'frontTokenCacheMs',
  HYBRID_SESSIONS_RATE_LIMIT_MPM: 'sessionsRateLimitMpm',
};

/** Literal KEY=VALUE parser — identical semantics to install.sh env_load. */
export function parseEnvText(text) {
  const out = new Map();
  for (let line of String(text || '').split(/\r?\n/)) {
    line = line.replace(/^\s+/, '');
    if (line === '' || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    const key = line.slice(0, eq);
    if (!/^[A-Za-z0-9_]+$/.test(key)) continue;
    let val = line.slice(eq + 1);
    if (val.length >= 2) {
      const q = val[0];
      if ((q === '"' || q === "'") && val[val.length - 1] === q) val = val.slice(1, -1);
    }
    out.set(key, val);
  }
  return out;
}

function num(v, dflt) {
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : dflt;
}

function clampShare(v, dflt) {
  if (v === undefined || v === null || v === '') return dflt;
  const n = Number(v);
  if (!Number.isFinite(n)) return dflt;
  return Math.min(1, Math.max(0, n));
}

export function createRuntime({ log = () => {} } = {}) {
  // --- cfg: the single mutable runtime configuration ----------------------
  const cfg = {
    // token plane
    secret: process.env.HYBRID_SHARED_SECRET || '',
    tokenTtlMs: num(process.env.HYBRID_TOKEN_TTL_MS, 300000),
    tokenBindIp: String(process.env.HYBRID_TOKEN_BIND_IP || '') === 'true',
    sessionsRateLimitMpm: num(process.env.HYBRID_SESSIONS_RATE_LIMIT_MPM, 60),
    // front
    frontEnabled: String(process.env.HYBRID_FRONT_ENABLED || '') === 'true',
    frontRateLimitMpm: num(process.env.HYBRID_FRONT_RATE_LIMIT_MPM, 90),
    frontMaxDownBytes: num(process.env.HYBRID_FRONT_MAX_DOWN_BYTES, 26214400),
    frontTokenCacheMs: num(
      process.env.HYBRID_FRONT_TOKEN_CACHE_MS,
      Math.max(30000, num(process.env.HYBRID_TOKEN_TTL_MS, 300000) - 60000),
    ),
    vpsDlShare: clampShare(process.env.HYBRID_VPS_DL_SHARE, 0.15),
    // DIRECT LANE (operator contract 27 Nov 2026): 307-hand the web client's
    // heavy XHRs to the Worker (payload client ↔ edge ONLY). Default true.
    webDirect: String(process.env.HYBRID_WEB_DIRECT || '') !== 'false',
    // worker routing pool
    workerBase: process.env.HYBRID_WORKER_BASE || 'http://127.0.0.1:8790',
    workerUrls: (process.env.HYBRID_WORKER_URLS || '').split(',').map((s) => s.trim()).filter(Boolean),
    poolMax: num(process.env.HYBRID_WORKER_POOL_MAX, 1),
    activeMin: num(process.env.HYBRID_WORKER_ACTIVE_MIN, 1),
    activeMax: num(process.env.HYBRID_WORKER_ACTIVE_MAX, 0), // 0 → resolved = poolMax
    scaleRate: num(process.env.HYBRID_WORKER_SCALE_RATE, 24),
    shrinkRate: num(process.env.HYBRID_WORKER_SHRINK_RATE, 6),
    idleShrinkMs: num(process.env.HYBRID_WORKER_IDLE_SHRINK_MS, 600000),
    probeIntervalMs: num(process.env.HYBRID_WORKER_PROBE_INTERVAL_MS, 0),
    benchCooldownMs: num(process.env.HYBRID_WORKER_BENCH_COOLDOWN_MS, 120000),
    // deployment plane (v1.5)
    deployCount: process.env.CF_WORKER_DEPLOY_COUNT !== undefined ? num(process.env.CF_WORKER_DEPLOY_COUNT, 0) : 0,
    deployCountExplicit: process.env.CF_WORKER_DEPLOY_COUNT !== undefined,
    workerName: process.env.CF_WORKER_NAME || 'speedtest-hybrid-worker',
    workersSubdomain: process.env.CF_WORKERS_SUBDOMAIN || 'lumajangnetworks',
    workerBundlePath: process.env.HYBRID_WORKER_BUNDLE || '',
    workerFingerprintFile: process.env.HYBRID_WORKER_FP_FILE || '',
    workerSyncIntervalMs: num(process.env.HYBRID_WORKER_SYNC_INTERVAL_MS, 0),
    workerSyncDelete: String(process.env.HYBRID_WORKER_SYNC_DELETE ?? 'true') !== 'false',
    // Cloudflare credentials (token method preferred; global key fallback)
    cf: {
      token: process.env.CLOUDFLARE_API_TOKEN || process.env.HYBRID_CF_API_TOKEN || '',
      email: process.env.CLOUDFLARE_EMAIL || process.env.HYBRID_CF_EMAIL || '',
      key: process.env.CLOUDFLARE_API_KEY || process.env.HYBRID_CF_API_KEY || '',
      accountId: process.env.CLOUDFLARE_ACCOUNT_ID || process.env.HYBRID_CF_ACCOUNT_ID || '',
      mode: 'none',
    },
    // env watch
    envFile: process.env.HYBRID_ENV_FILE || '',
    envPollMs: num(process.env.HYBRID_ENV_POLL_MS, 2000),
    versionFile: process.env.HYBRID_VERSION_FILE || '',
  };
  cfg.cf.mode = cfg.cf.token ? 'token' : cfg.cf.email && cfg.cf.key ? 'key' : 'none';

  const lastEnvSnapshot = new Map();
  const state = { watching: false, lastChangeAt: 0, lastChangeKeys: [], lastError: null, checks: 0 };
  cfg.onEnvChange = null;

  function snapshotFromEnvMap(map) {
    const snap = new Map();
    for (const envKey of Object.keys(ENV_KEY_MAP)) {
      if (map.has(envKey)) snap.set(envKey, map.get(envKey));
    }
    return snap;
  }

  /** Apply a parsed .env snapshot to cfg. Returns the list of CHANGED keys. */
  function applyEnvSnapshot(map) {
    const changed = [];
    const track = (envKey, cfgValFn) => {
      if (!map.has(envKey)) return;
      const prev = lastEnvSnapshot.has(envKey) ? lastEnvSnapshot.get(envKey) : undefined;
      if (prev !== map.get(envKey)) changed.push(envKey);
      cfgValFn();
    };
    const numApply = (envKey, cfgKey, dflt, min = 0, max = Infinity) =>
      track(envKey, () => {
        const n = Number(map.get(envKey));
        if (Number.isFinite(n)) cfg[cfgKey] = Math.min(max, Math.max(min, Math.floor(n)));
        else if (dflt !== undefined) cfg[cfgKey] = dflt;
      });

    // Cloudflare credentials
    track('CLOUDFLARE_API_TOKEN', () => { cfg.cf.token = map.get('CLOUDFLARE_API_TOKEN') || ''; });
    track('CLOUDFLARE_EMAIL', () => { cfg.cf.email = map.get('CLOUDFLARE_EMAIL') || ''; });
    track('CLOUDFLARE_API_KEY', () => { cfg.cf.key = map.get('CLOUDFLARE_API_KEY') || ''; });
    track('CLOUDFLARE_ACCOUNT_ID', () => { cfg.cf.accountId = map.get('CLOUDFLARE_ACCOUNT_ID') || ''; });
    const prevMode = cfg.cf.mode;
    cfg.cf.mode = cfg.cf.token ? 'token' : cfg.cf.email && cfg.cf.key ? 'key' : 'none';
    if (prevMode !== cfg.cf.mode && !changed.includes('CLOUDFLARE_AUTH_MODE')) changed.push('CLOUDFLARE_AUTH_MODE');

    // deploy target + worker identity
    if (map.has('CF_WORKER_DEPLOY_COUNT')) {
      const prev = lastEnvSnapshot.get('CF_WORKER_DEPLOY_COUNT');
      if (prev !== map.get('CF_WORKER_DEPLOY_COUNT')) changed.push('CF_WORKER_DEPLOY_COUNT');
      cfg.deployCountExplicit = true;
      const n = Number(map.get('CF_WORKER_DEPLOY_COUNT'));
      if (Number.isFinite(n) && n >= 0) cfg.deployCount = Math.min(100, Math.floor(n));
    }
    track('CF_WORKER_NAME', () => { cfg.workerName = map.get('CF_WORKER_NAME') || 'speedtest-hybrid-worker'; });
    track('CF_WORKERS_SUBDOMAIN', () => {
      cfg.workersSubdomain = map.get('CF_WORKERS_SUBDOMAIN') || cfg.workersSubdomain;
      cfg.workerBase = `https://${cfg.workerName}.${cfg.workersSubdomain}.workers.dev`;
    });

    // token / front / pool keys
    track('HYBRID_SHARED_SECRET', () => { cfg.secret = map.get('HYBRID_SHARED_SECRET') || ''; });
    track('HYBRID_VPS_DL_SHARE', () => { cfg.vpsDlShare = clampShare(map.get('HYBRID_VPS_DL_SHARE'), 0.15); });
    track('HYBRID_WEB_DIRECT', () => { cfg.webDirect = String(map.get('HYBRID_WEB_DIRECT') || '') !== 'false'; });
    numApply('HYBRID_FRONT_RATE_LIMIT_MPM', 'frontRateLimitMpm', 90);
    numApply('HYBRID_FRONT_MAX_DOWN_BYTES', 'frontMaxDownBytes', 26214400);
    numApply('HYBRID_FRONT_TOKEN_CACHE_MS', 'frontTokenCacheMs', 240000);
    numApply('HYBRID_SESSIONS_RATE_LIMIT_MPM', 'sessionsRateLimitMpm', 60);
    numApply('HYBRID_WORKER_POOL_MAX', 'poolMax', 1, 1);
    numApply('HYBRID_WORKER_ACTIVE_MIN', 'activeMin', 1, 1);
    numApply('HYBRID_WORKER_ACTIVE_MAX', 'activeMax', 0, 0);
    numApply('HYBRID_WORKER_SCALE_RATE', 'scaleRate', 24, 1);
    numApply('HYBRID_WORKER_SHRINK_RATE', 'shrinkRate', 6, 1);
    numApply('HYBRID_WORKER_IDLE_SHRINK_MS', 'idleShrinkMs', 600000);
    numApply('HYBRID_WORKER_PROBE_INTERVAL_MS', 'probeIntervalMs', 0);
    track('HYBRID_WORKER_URLS', () => {
      const urls = (map.get('HYBRID_WORKER_URLS') || '').split(',').map((s) => s.trim()).filter(Boolean);
      if (urls.length) cfg.workerUrls = urls;
    });

    // refresh snapshot
    lastEnvSnapshot.clear();
    for (const [k, v] of snapshotFromEnvMap(map)) lastEnvSnapshot.set(k, v);
    return changed;
  }

  // Bootstrap: fold the process environment through the same mapping so the
  // gateway.env (systemd) values participate in the diff baseline.
  const bootMap = new Map();
  for (const envKey of Object.keys(ENV_KEY_MAP)) {
    if (process.env[envKey] !== undefined) bootMap.set(envKey, process.env[envKey]);
  }
  applyEnvSnapshot(bootMap);

  // --- .env file watcher (poll: mtime+size, then content) ------------------
  let timer = null;
  let lastSig = '';
  function checkFile() {
    state.checks++;
    if (!cfg.envFile) return;
    try {
      const st = fs.statSync(cfg.envFile);
      const text = fs.readFileSync(cfg.envFile, 'utf8');
      const sig = `${st.mtimeMs}:${st.size}`;
      if (sig === lastSig) return;
      lastSig = sig;
      const map = parseEnvText(text);
      const changed = applyEnvSnapshot(map);
      if (changed.length > 0) {
        state.lastChangeAt = Date.now();
        state.lastChangeKeys = changed;
        state.lastError = null;
        log('env_change_applied', { file: cfg.envFile, keys: changed });
        if (cfg.onEnvChange) cfg.onEnvChange(changed);
      }
    } catch (e) {
      state.lastError = String(e && e.code ? e.code : e).slice(0, 120);
      // missing/unreadable .env: keep last known config; retry next tick
    }
  }

  function startEnvWatch(onChange) {
    if (state.watching || !cfg.envFile) return;
    cfg.onEnvChange = onChange;
    state.watching = true;
    checkFile(); // initial read merges the .env baseline
    timer = setInterval(checkFile, Math.max(500, cfg.envPollMs));
    timer.unref?.();
    log('env_watch_started', { file: cfg.envFile, pollMs: cfg.envPollMs });
  }

  function stopEnvWatch() {
    if (timer) clearInterval(timer);
    timer = null;
    state.watching = false;
  }

  /** Effective deploy target: explicit deployCount, else poolMax. */
  function deployTarget() {
    if (cfg.deployCountExplicit) return Math.min(100, Math.max(0, cfg.deployCount));
    return cfg.poolMax > 0 ? Math.min(100, cfg.poolMax) : 0;
  }

  return { cfg, state, applyEnvSnapshot, startEnvWatch, stopEnvWatch, deployTarget };
}
