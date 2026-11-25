#!/usr/bin/env node
/**
 * rest-deploy.mjs — deploy / undeploy / verify the worker pool through the
 * Cloudflare REST API (no wrangler, zero npm dependencies, Node >= 18).
 *
 * Used by:
 *   - install.sh (fast primary deploy path; wrangler deploy-pool.sh remains
 *     the fallback)
 *   - the VPS gateway's on-the-fly worker sync (workersync.mjs imports this
 *     module) whenever CF_WORKER_DEPLOY_COUNT changes in .env
 *   - operators directly:
 *       CLOUDFLARE_EMAIL=... CLOUDFLARE_API_KEY=... CLOUDFLARE_ACCOUNT_ID=... \
 *       HYBRID_SHARED_SECRET=... POOL_SIZE=100 node rest-deploy.mjs
 *
 * Auth: Bearer CLOUDFLARE_API_TOKEN, or X-Auth-Email + X-Auth-Key (global
 * key). Deployment = one multipart PUT per worker:
 *   PUT /accounts/{acct}/workers/scripts/{name}
 *     metadata {main_module, compatibility_date, bindings[plain_text vars +
 *               secret_text HYBRID_SHARED_SECRET]}
 *     module   index.js  (the esbuild bundle at dist/worker-bundle.js)
 *   then POST subdomain {enabled:true} (idempotent) so *.workers.dev routes.
 *
 * Safety: only scripts whose name is EXACTLY the pool naming scheme
 * (`speedtest-hybrid-worker` or `speedtest-hybrid-worker-N`) are ever
 * deleted. Everything else in the account is untouched.
 *
 * The deployment FINGERPRINT (sha256 of bundle + vars + pool size + secret)
 * is persisted to a state file so install-time and runtime syncs agree on
 * when a full redeploy is needed.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const CF_BASE = 'https://api.cloudflare.com/client/v4';
const VARS = {
  VERSION_STRING: '2.11 (2.11.5) 2026-06-04.1737.7d0993d',
  ALLOWED_DOMAINS: '*',
  STRICT_HOST_VALIDATION: 'false',
  WS_FRAME_LIMIT_BYTES: '5242880',
  MAX_DOWNLOAD_BYTES: '26214400',
  MAX_UPLOAD_BYTES: '26214400',
  LEGACY_HTTP_ENABLED: 'false',
  WORKER_DEFLECT_CONCURRENCY: '6',
};

export function poolName(baseName, id) {
  return id === 1 ? baseName : `${baseName}-${id}`;
}

export function createRestCtx(opts = {}) {
  const auth = opts.auth || {
    token: process.env.CLOUDFLARE_API_TOKEN || '',
    email: process.env.CLOUDFLARE_EMAIL || '',
    key: process.env.CLOUDFLARE_API_KEY || '',
  };
  const accountId = opts.accountId || process.env.CLOUDFLARE_ACCOUNT_ID || '';
  const baseName = opts.baseName || process.env.CF_WORKER_NAME || 'speedtest-hybrid-worker';
  const subdomain = opts.subdomain || process.env.CF_WORKERS_SUBDOMAIN || '';
  const mode = auth.token ? 'token' : auth.email && auth.key ? 'key' : 'none';
  const fetchImpl = opts.fetchImpl || fetch;
  function headers(extra = {}) {
    const h = { ...extra };
    if (mode === 'token') h.Authorization = `Bearer ${auth.token}`;
    else {
      h['X-Auth-Email'] = auth.email;
      h['X-Auth-Key'] = auth.key;
    }
    return h;
  }
  async function cf(pathname, init = {}) {
    const res = await fetchImpl(CF_BASE + pathname, { ...init, headers: headers(init.headers || {}) });
    const text = await res.text();
    let body = null;
    try {
      body = JSON.parse(text);
    } catch {
      body = { raw: text.slice(0, 400) };
    }
    return { status: res.status, ok: res.ok, body };
  }
  return { auth, accountId, baseName, subdomain, mode, headers, cf, fetchImpl };
}

/** List deployed pool scripts (id/name/modified). Non-pool scripts ignored. */
export async function listPool(ctx) {
  const r = await ctx.cf(`/accounts/${ctx.accountId}/workers/scripts`);
  if (!r.ok) {
    throw new Error(`list scripts failed: HTTP ${r.status} ${JSON.stringify(r.body.errors || r.body).slice(0, 200)}`);
  }
  const all = Array.isArray(r.body.result) ? r.body.result : [];
  const prefixEsc = ctx.baseName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`^${prefixEsc}(-[0-9]+)?$`);
  const pool = [];
  for (const s of all) {
    const name = s.id || s.name; // the v4 list API reports the script name in `id`
    if (!re.test(name)) continue;
    const m = name.match(/-(\d+)$/);
    pool.push({ name, id: m ? Number(m[1]) : 1, modified: s.modified_on || null });
  }
  pool.sort((a, b) => a.id - b.id);
  return pool;
}

/** Build the multipart PUT body for one worker deployment. */
export function buildDeployForm({ bundleSrc, workerId, poolSize, secret }) {
  const bindings = Object.entries({ ...VARS, WORKER_ID: String(workerId), WORKER_POOL_MAX: String(poolSize) }).map(
    ([name, text]) => ({ name, type: 'plain_text', text }),
  );
  if (secret) bindings.push({ name: 'HYBRID_SHARED_SECRET', type: 'secret_text', text: secret });
  const metadata = JSON.stringify({
    main_module: 'index.js',
    compatibility_date: '2026-10-01',
    bindings,
  });
  const fd = new FormData();
  fd.append('metadata', new Blob([metadata], { type: 'application/json' }));
  fd.append('index.js', new Blob([bundleSrc], { type: 'application/javascript+module' }), 'index.js');
  return fd;
}

/** Deploy (create or update) one pool worker. */
export async function deployWorker(ctx, workerId, { poolSize, secret, bundleSrc, enableSubdomain = true }) {
  const name = poolName(ctx.baseName, workerId);
  const form = buildDeployForm({ bundleSrc, workerId, poolSize, secret });
  const r = await ctx.cf(`/accounts/${ctx.accountId}/workers/scripts/${name}`, { method: 'PUT', body: form });
  if (!r.ok) return { name, ok: false, status: r.status, error: JSON.stringify(r.body.errors || r.body).slice(0, 300) };
  if (enableSubdomain && ctx.subdomain) {
    // Idempotent: enabling an already-enabled workers.dev subdomain is a no-op.
    const sub = await ctx.cf(`/accounts/${ctx.accountId}/workers/scripts/${name}/subdomain`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled: true, previews_enabled: false }),
    });
    if (!sub.ok && sub.status !== 409) {
      const sub2 = await ctx.cf(`/accounts/${ctx.accountId}/workers/scripts/${name}/subdomain`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled: true, previews_enabled: false }),
      });
      if (!sub2.ok && sub2.status !== 409) {
        return { name, ok: true, status: r.status, warn: `subdomain enable failed: HTTP ${sub.status}/${sub2.status}` };
      }
    }
  }
  return { name, ok: true, status: r.status };
}

export async function deleteWorker(ctx, workerId) {
  const name = poolName(ctx.baseName, workerId);
  const r = await ctx.cf(`/accounts/${ctx.accountId}/workers/scripts/${name}`, { method: 'DELETE' });
  return { name, ok: r.ok, status: r.status };
}

export async function verifyWorker(ctx, workerId, timeoutMs = 15000) {
  const name = poolName(ctx.baseName, workerId);
  const url = `https://${name}.${ctx.subdomain}.workers.dev/__meta`;
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await ctx.fetchImpl(url, { signal: ctl.signal, cache: 'no-store' });
    const j = await res.json().catch(() => ({}));
    return { name, ok: res.status === 200 && Number(j?.worker?.id) === workerId, status: res.status, url };
  } catch (e) {
    return { name, ok: false, error: String(e).slice(0, 120), url };
  } finally {
    clearTimeout(t);
  }
}

/** Run async tasks with bounded concurrency. */
export async function runPool(tasks, concurrency = 6) {
  const results = new Array(tasks.length);
  let i = 0;
  const runners = Array.from({ length: Math.min(concurrency, Math.max(1, tasks.length)) }, async () => {
    while (i < tasks.length) {
      const idx = i++;
      results[idx] = await tasks[idx]();
    }
  });
  await Promise.all(runners);
  return results;
}

/** Fingerprint of a deployment (bundle + vars + pool size + secret). */
export function deploymentFingerprint({ bundleSrc, poolSize, secret, baseName = '' }) {
  return crypto
    .createHash('sha256')
    .update(String(baseName))
    .update('\0')
    .update(String(poolSize))
    .update('\0')
    .update(secret || '')
    .update('\0')
    .update(bundleSrc || '')
    .digest('hex');
}

// ---------------------------------------------------------------------------
// Converge the deployed pool to `poolSize` (used by CLI, install.sh and
// workersync.mjs). Fingerprint-gated: a full redeploy only happens when the
// bundle/vars/secret/poolSize fingerprint changed since the last success.
// ---------------------------------------------------------------------------
export async function converge({
  poolSize,
  secret,
  bundlePath,
  ctx,
  verify = true,
  deleteExtra = true,
  fingerprintFile = '',
  log = () => {},
}) {
  const bundleSrc = bundlePath ? fs.readFileSync(bundlePath, 'utf8') : '';
  if (!bundleSrc) {
    throw new Error('worker bundle source is empty (build it first: npx esbuild src/index.ts --bundle --format=esm --outfile=dist/worker-bundle.js)');
  }
  if (ctx.mode === 'none') throw new Error('no Cloudflare credentials (CLOUDFLARE_API_TOKEN or CLOUDFLARE_EMAIL+CLOUDFLARE_API_KEY)');
  if (!ctx.accountId) throw new Error('CLOUDFLARE_ACCOUNT_ID is required');
  const fp = deploymentFingerprint({ bundleSrc, poolSize, secret, baseName: ctx.baseName });
  let stored = '';
  if (fingerprintFile) {
    try {
      stored = fs.readFileSync(fingerprintFile, 'utf8').trim();
    } catch {
      stored = '';
    }
  }
  const fullRedeploy = Boolean(stored) && stored !== fp;

  const existing = await listPool(ctx);
  const existingIds = new Set(existing.map((w) => w.id));
  const actions = { deployed: [], deleted: [], verified: [], errors: [] };

  const toDeploy = [];
  for (let id = 1; id <= poolSize; id++) {
    if (fullRedeploy || !existingIds.has(id)) toDeploy.push(id);
  }
  if (toDeploy.length > 0) {
    log(
      `deploying ${toDeploy.length} worker(s)${fullRedeploy ? ' (full redeploy: fingerprint changed)' : ''}: ${toDeploy.slice(0, 20).join(', ')}${toDeploy.length > 20 ? '…' : ''}`,
    );
    const res = await runPool(
      toDeploy.map((id) => () => deployWorker(ctx, id, { poolSize, secret, bundleSrc })),
      6,
    );
    for (const r of res) {
      if (r.ok) actions.deployed.push(r.name);
      else actions.errors.push(`${r.name}: ${r.error}`);
    }
  }

  if (deleteExtra) {
    const extra = existing.map((w) => w.id).filter((id) => id > poolSize && id !== 1).sort((a, b) => b - a);
    if (extra.length > 0) {
      log(`deleting ${extra.length} worker(s) beyond target: ${extra.slice(0, 20).join(', ')}${extra.length > 20 ? '…' : ''}`);
      const res = await runPool(
        extra.map((id) => () => deleteWorker(ctx, id)),
        6,
      );
      for (const r of res) {
        if (r.ok) actions.deleted.push(r.name);
        else actions.errors.push(`${r.name}: HTTP ${r.status}`);
      }
    }
  }

  if (verify && ctx.subdomain && (toDeploy.length > 0 || !stored)) {
    const ids = Array.from({ length: Math.min(poolSize, 8) }, (_, k) => k + 1);
    if (poolSize > 8) ids.push(poolSize);
    const res = await runPool(
      ids.map((id) => () => verifyWorker(ctx, id)),
      4,
    );
    for (const r of res) {
      if (r.ok) actions.verified.push(r.name);
      else actions.errors.push(`verify ${r.name}: ${r.error || 'status ' + r.status}`);
    }
  }

  if (fingerprintFile && actions.errors.length === 0) {
    try {
      fs.mkdirSync(path.dirname(fingerprintFile), { recursive: true });
      fs.writeFileSync(fingerprintFile, fp + '\n');
    } catch {
      /* non-fatal: next run re-deploys */
    }
  }
  const finalList = await listPool(ctx);
  return { existing: existing.length, final: finalList.length, fullRedeploy, ...actions };
}

// ---------------------------------------------------------------------------
// CLI mode: converge the deployed pool to POOL_SIZE.
// ---------------------------------------------------------------------------
if (import.meta.url === `file://${process.argv[1]}`) {
  const poolSize = Number(process.env.POOL_SIZE || 0);
  const bundlePath = process.env.BUNDLE_PATH || path.resolve(import.meta.dirname, 'dist/worker-bundle.js');
  const secret = process.env.HYBRID_SHARED_SECRET || '';
  const verify = (process.env.VERIFY ?? '1') !== '0';
  const deleteExtra = (process.env.DELETE_EXTRA ?? 'true') !== 'false';
  const fingerprintFile = process.env.FP_FILE || '';
  if (!poolSize || poolSize < 1 || poolSize > 100) {
    console.error('POOL_SIZE must be 1..100');
    process.exit(2);
  }
  const ctx = createRestCtx({});
  const t0 = Date.now();
  try {
    const out = await converge({
      poolSize,
      secret,
      bundlePath,
      ctx,
      verify,
      deleteExtra,
      fingerprintFile,
      log: (m) => console.log(m),
    });
    console.log(
      JSON.stringify({ ok: out.errors.length === 0, poolSize, seconds: ((Date.now() - t0) / 1000).toFixed(1), ...out }, null, 2),
    );
    process.exit(out.errors.length === 0 ? 0 : 1);
  } catch (e) {
    console.error(`FATAL: ${e.message}`);
    process.exit(1);
  }
}
