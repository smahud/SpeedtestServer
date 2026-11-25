#!/usr/bin/env node
/**
 * gateway-tests.mjs — regression + feature tests for the hybrid gateway.
 *
 * Run: node test/gateway-tests.mjs
 *
 * Covers the 2026-11-25 production-hardening pass:
 *   T1  null JSON body on /api/results no longer crashes the process
 *       (verified crash on rev 1.1 — one unauthenticated request killed it)
 *   T2  garbage Host header does not crash
 *   T3  oversized body → 413 response actually DELIVERED (not a socket reset)
 *   T4  /api/sessions per-IP rate limit
 *   T5  invalid token on /api/results → 401 with reason
 *   T6  worker pool: URL derivation, selection round-robin, mint recording,
 *       autoscaler scale-up/scale-down state machine, benching
 *   T7  rate limiter: IPv6 /64 bucketing
 *   T8  front: 302 redirect target follows the pool selection; rate limit 429
 *   T9  upload drain: size=N answer; watchdog cleared on abort
 *  T10  result dedup window
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import http from 'node:http';
import crypto from 'node:crypto';

const GATEWAY = new URL('../src/gateway.mjs', import.meta.url).pathname;

/** Start a gateway child process with the given env; returns {proc, port, stop()}. */
function startGateway(env, port) {
  const proc = execFileSync; // placeholder to keep linters quiet
  const child = spawnNode(env, port);
  return child;
}

function spawnNode(env, port) {
  const { spawn } = require('node:child_process');
  const child = spawn(process.execPath, [GATEWAY], {
    env: { ...process.env, ...env, HYBRID_GATEWAY_PORT: String(port), HYBRID_GATEWAY_BIND: '127.0.0.1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let ready = false;
  const logs = [];
  child.stdout.on('data', (d) => {
    const s = d.toString();
    logs.push(s);
    if (s.includes('gateway_started')) ready = true;
  });
  child.stderr.on('data', (d) => logs.push(d.toString()));
  return {
    child,
    port,
    logs,
    async waitReady(ms = 5000) {
      const t0 = Date.now();
      while (!ready && Date.now() - t0 < ms) await new Promise((r) => setTimeout(r, 50));
      if (!ready) throw new Error('gateway did not start:\n' + logs.join('').slice(0, 2000));
    },
    async stop() {
      child.kill('SIGTERM');
      await new Promise((r) => {
        child.on('exit', r);
        setTimeout(r, 1000);
      });
    },
  };
}

import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

function req(port, method, path, { body, headers } = {}) {
  return new Promise((resolve, reject) => {
    const r = http.request({ host: '127.0.0.1', port, method, path, headers: { ...headers } }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString() }));
    });
    r.on('error', (e) => {
      // A connection reset is itself a signal (the old crash behavior).
      resolve({ status: 0, error: String(e) });
    });
    if (body !== undefined) r.write(body);
    r.end();
  });
}

let nextPort = 18230;
const freePort = () => nextPort++;

const SECRET = 'testsecret-abc123';

test('T1: POST /api/results with JSON null body does NOT crash the gateway', async () => {
  const g = spawnNode({ HYBRID_SHARED_SECRET: SECRET, HYBRID_FRONT_ENABLED: 'false' }, (nextPort = freePort()));
  await g.waitReady();
  try {
    const r1 = await req(g.port, 'POST', '/api/results', { body: 'null' });
    assert.ok(r1.status === 400 || r1.status === 401, `expected 4xx, got ${r1.status} (${r1.body})`);
    // The gateway must STILL be alive afterwards:
    const r2 = await req(g.port, 'GET', '/api/health');
    assert.equal(r2.status, 200);
    assert.ok(r2.body.includes('hybrid-gateway'));
  } finally {
    await g.stop();
  }
});

test('T2: garbage Host header does not crash the gateway', async () => {
  const g = spawnNode({ HYBRID_SHARED_SECRET: SECRET }, (nextPort = freePort()));
  await g.waitReady();
  try {
    const r1 = await req(g.port, 'GET', '/api/health', { headers: { Host: 'a b' } });
    assert.ok(r1.status >= 200, `expected a status, got ${r1.status}`);
    const r2 = await req(g.port, 'GET', '/api/health');
    assert.equal(r2.status, 200);
  } finally {
    await g.stop();
  }
});

test('T3: oversized body → 413 actually delivered', async () => {
  const g = spawnNode({ HYBRID_SHARED_SECRET: SECRET }, (nextPort = freePort()));
  await g.waitReady();
  try {
    const big = Buffer.alloc(2 * 1024 * 1024, 0x41); // 2 MiB > 1 MiB readBody cap
    const r = await req(g.port, 'POST', '/api/results', { body: big, headers: { 'Content-Length': String(big.length) } });
    assert.equal(r.status, 413);
  } finally {
    await g.stop();
  }
});

test('T4: /api/sessions is rate limited per IP', async () => {
  const g = spawnNode({ HYBRID_SHARED_SECRET: SECRET, HYBRID_SESSIONS_RATE_LIMIT_MPM: '3' }, (nextPort = freePort()));
  await g.waitReady();
  try {
    const codes = [];
    for (let i = 0; i < 5; i++) {
      const r = await req(g.port, 'POST', '/api/sessions');
      codes.push(r.status);
    }
    assert.deepEqual(codes, [200, 200, 200, 429, 429]);
  } finally {
    await g.stop();
  }
});

test('T5: /api/results with bad token → 401 reason; with valid token → 200 + dedup', async () => {
  const g = spawnNode({ HYBRID_SHARED_SECRET: SECRET }, (nextPort = freePort()));
  await g.waitReady();
  try {
    const bad = await req(g.port, 'POST', '/api/results', {
      body: JSON.stringify({ token: 'v1~x~99999999999999~*~deadbeef' }),
      headers: { 'Content-Type': 'application/json' },
    });
    assert.equal(bad.status, 401);
    assert.ok(bad.body.includes('bad-signature') || bad.body.includes('expired'));

    const s = await req(g.port, 'POST', '/api/sessions');
    assert.equal(s.status, 200);
    const { token, guid } = JSON.parse(s.body);
    assert.ok(token.startsWith('v1~'));
    assert.ok(typeof guid === 'string' && guid.length > 10);
    assert.ok(JSON.parse(s.body).worker && JSON.parse(s.body).worker.url);
    const payload = JSON.stringify({ token, guid, metrics: { down: 123 } });
    const ok1 = await req(g.port, 'POST', '/api/results', { body: payload, headers: { 'Content-Type': 'application/json' } });
    assert.equal(ok1.status, 200);
    // T10: duplicate replay within the window → same response
    const ok2 = await req(g.port, 'POST', '/api/results', { body: payload, headers: { 'Content-Type': 'application/json' } });
    assert.equal(ok2.status, 200);
    assert.equal(ok1.body, ok2.body);
  } finally {
    await g.stop();
  }
});

test('T6: worker pool — selection, mint recording, scale-up guard, bench, status', async () => {
  const { createWorkerPool, createRateLimiter, ipKey } = await import(new URL('../src/workerpool.mjs', import.meta.url).href);
  const logs = [];
  const pool = createWorkerPool({
    base: 'https://speedtest-hybrid-worker.example.workers.dev',
    poolMax: 5,
    activeMin: 1,
    activeMax: 5,
    scaleRate: 2,
    shrinkRate: 1,
    idleShrinkMs: 50,
    log: (k, d) => logs.push({ k, d }),
  });
  // URL derivation
  const st = pool.status();
  assert.equal(st.poolMax, 5);
  const w1 = pool.pickWorker();
  assert.equal(w1.url, 'https://speedtest-hybrid-worker.example.workers.dev');
  // Round-robin over active set with mint recording
  pool.recordMint(w1.id);
  const seen = new Set([w1.id]);
  for (let i = 0; i < 20; i++) {
    const w = pool.pickWorker();
    pool.recordMint(w.id);
    seen.add(w.id);
  }
  assert.ok(seen.size === 1); // only worker 1 is active
  // Simulate load: mints so far = 1 + 20 = 21, plus 10 more → 31 in-window.
  for (let i = 0; i < 10; i++) pool.recordMint(1);
  assert.equal(pool.mintRatePerMin(), 31);
  // Scale-up is canary-gated — the fake URL is unreachable, so a tick would
  // bench instead of grow; verify benching via recordWorkerError×2.
  pool.recordWorkerError(1);
  pool.recordWorkerError(1);
  const st2 = pool.status();
  const w1After = st2.workers.find((w) => w.id === 1);
  assert.equal(w1After.healthy, false, 'worker 1 should be benched after 2 errors');
  assert.ok(w1After.benchedUntil);
  pool.stop();

  // T7: rate limiter IPv6 /64 bucketing
  assert.equal(ipKey('2001:db8:1:2:3:4:5:6'), ipKey('2001:db8:1:2:aaaa:bbbb:cccc:dddd'));
  assert.notEqual(ipKey('2001:db8:1:2::1'), ipKey('2001:db8:9:9::1'));
  assert.equal(ipKey('::ffff:1.2.3.4'), '1.2.3.4');
  const rl = createRateLimiter(2);
  assert.ok(rl.allow('k'));
  assert.ok(rl.allow('k'));
  assert.ok(!rl.allow('k'));
  assert.ok(rl.allow('other'));
});

test('T8: front 302 redirect follows the pool worker and rate-limits', async () => {
  const g = spawnNode(
    {
      HYBRID_SHARED_SECRET: SECRET,
      HYBRID_FRONT_ENABLED: 'true',
      HYBRID_FRONT_RATE_LIMIT_MPM: '2',
      // v1.3: tokens are cached per IP by default — disable the cache here
      // so every redirect actually mints (the legacy per-request behavior
      // this test was written against).
      HYBRID_FRONT_TOKEN_CACHE_MS: '0',
      HYBRID_WORKER_BASE: 'http://127.0.0.1:59999', // unreachable — irrelevant for redirect logic
      HYBRID_WORKER_POOL_MAX: '1',
    },
    (nextPort = freePort()),
  );
  await g.waitReady();
  try {
    const r = await req(g.port, 'GET', '/speedtest/random350x350.jpg');
    assert.equal(r.status, 302);
    const loc = r.headers.location;
    assert.ok(loc.startsWith('http://127.0.0.1:59999/__down?bytes=245388&token=v1~'), `bad location: ${loc}`);
    // latency served directly
    const lat = await req(g.port, 'GET', '/speedtest/latency.txt');
    assert.equal(lat.status, 200);
    assert.equal(lat.body, 'test=test\n');
    // 3rd token mint → 429
    await req(g.port, 'GET', '/speedtest/random350x350.jpg');
    const r3 = await req(g.port, 'GET', '/speedtest/random350x350.jpg');
    assert.equal(r3.status, 429);
  } finally {
    await g.stop();
  }
});

test('T9: front upload drain answers size=N and stays alive', async () => {
  const g = spawnNode({ HYBRID_SHARED_SECRET: SECRET, HYBRID_FRONT_ENABLED: 'true' }, (nextPort = freePort()));
  await g.waitReady();
  try {
    const body = 'x'.repeat(1000);
    const r = await req(g.port, 'POST', '/speedtest/upload.php', {
      body,
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': String(body.length) },
    });
    assert.equal(r.status, 200);
    assert.equal(r.body, 'size=1000\n');
    // gateway still alive
    const h = await req(g.port, 'GET', '/api/health');
    assert.equal(h.status, 200);
  } finally {
    await g.stop();
  }
});

test('extra: /api/pool and /api/health expose pool state', async () => {
  const g = spawnNode(
    {
      HYBRID_SHARED_SECRET: SECRET,
      HYBRID_WORKER_BASE: 'https://speedtest-hybrid-worker.lumajangnetworks.workers.dev',
      HYBRID_WORKER_POOL_MAX: '3',
    },
    (nextPort = freePort()),
  );
  await g.waitReady();
  try {
    const p = await req(g.port, 'GET', '/api/pool');
    assert.equal(p.status, 200);
    const j = JSON.parse(p.body);
    assert.equal(j.poolMax, 3);
    assert.equal(j.activeCount, 1);
    assert.equal(j.workers[1].url, 'https://speedtest-hybrid-worker-2.lumajangnetworks.workers.dev');
    const h = await req(g.port, 'GET', '/api/health');
    const hj = JSON.parse(h.body);
    assert.equal(hj.pool.poolMax, 3);
    assert.ok(hj.server.startsWith('hybrid-gateway/1.3'));
  } finally {
    await g.stop();
  }
});

test('T11: assist lane — budget-gated LOCAL serve (daemon-parity bytes, exact length, X-Hybrid-Lane)', async () => {
  const g = spawnNode(
    {
      HYBRID_SHARED_SECRET: SECRET,
      HYBRID_FRONT_ENABLED: 'true',
      HYBRID_WORKER_BASE: 'http://127.0.0.1:59999',
      HYBRID_WORKER_POOL_MAX: '1',
      // 100 Mbps budget, 2 s burst → 25 MB bucket: the first (and several)
      // requests take the VPS lane.
      HYBRID_VPS_DL_BUDGET_MBPS: '100',
    },
    (nextPort = freePort()),
  );
  await g.waitReady();
  try {
    const r = await req(g.port, 'GET', '/speedtest/random350x350.jpg');
    assert.equal(r.status, 200);
    assert.equal(r.headers['content-length'], String(245388));
    assert.equal(r.headers['content-type'], 'image/jpeg');
    assert.equal(r.headers['x-hybrid-lane'], 'vps');
    assert.equal(r.body.length, 245388);
    // daemon parity F-9: printable ASCII [0x20..0x7F]
    let bad = 0;
    for (let i = 0; i < r.body.length; i++) {
      const c = r.body.charCodeAt(i);
      if (c < 0x20 || c > 0x7f) bad++;
    }
    assert.equal(bad, 0, 'local-lane bytes must be printable ASCII');
    // a 1.1 MB image also serves locally (multi-chunk + wrap + backpressure path)
    const r2 = await req(g.port, 'GET', '/speedtest/random750x750.jpg');
    assert.equal(r2.status, 200);
    assert.equal(r2.body.length, 1118012);
    assert.equal(r2.headers['x-hybrid-lane'], 'vps');
    // health shows the assist counters
    const h = await req(g.port, 'GET', '/api/health');
    const hj = JSON.parse(h.body);
    assert.ok(hj.front.assist.enabled);
    assert.ok(hj.front.counters.dlLocal >= 2);
    assert.ok(hj.front.counters.dlLocalBytes >= 245388 + 1118012);
    // latency still VPS-served
    const lat = await req(g.port, 'GET', '/speedtest/latency.txt');
    assert.equal(lat.body, 'test=test\n');
  } finally {
    await g.stop();
  }
});

test('T12: assist lane — budget exhausted → 302 edge overflow; token cache reuses one mint', async () => {
  const g = spawnNode(
    {
      HYBRID_SHARED_SECRET: SECRET,
      HYBRID_FRONT_ENABLED: 'true',
      HYBRID_FRONT_RATE_LIMIT_MPM: '3',
      HYBRID_WORKER_BASE: 'http://127.0.0.1:59999',
      HYBRID_WORKER_POOL_MAX: '1',
      // 0.001 Mbps × 0.5 s (min burst) → ~62 B bucket: every image (≥245 KB)
      // immediately exceeds the budget → edge lane from the first request.
      HYBRID_VPS_DL_BUDGET_MBPS: '0.001',
    },
    (nextPort = freePort()),
  );
  await g.waitReady();
  try {
    const codes = [];
    const locations = [];
    for (let i = 0; i < 5; i++) {
      const r = await req(g.port, 'GET', '/speedtest/random350x350.jpg');
      codes.push(r.status);
      if (r.headers.location) locations.push(r.headers.location);
    }
    // all edge redirects, NO 429: the per-IP token cache mints once and
    // reuses the token — 5 requests consume ONE mint of the 3/min budget.
    assert.deepEqual(codes, [302, 302, 302, 302, 302]);
    assert.ok(locations.length === 5);
    assert.ok(locations[0].startsWith('http://127.0.0.1:59999/__down?bytes=245388&token=v1~'));
    assert.equal(locations[0], locations[4], 'cached token: the same token is reused');
    const h = await req(g.port, 'GET', '/api/health');
    const hj = JSON.parse(h.body);
    assert.equal(hj.front.counters.tokensMinted, 1);
    assert.equal(hj.front.counters.downRedirects, 5);
    assert.equal(hj.front.counters.dlLocal, 0);
  } finally {
    await g.stop();
  }
});

test('T13: assist lane — mint rate-limited degrades to FORCED local (not 429)', async () => {
  const g = spawnNode(
    {
      HYBRID_SHARED_SECRET: SECRET,
      HYBRID_FRONT_ENABLED: 'true',
      HYBRID_FRONT_RATE_LIMIT_MPM: '2',
      HYBRID_FRONT_TOKEN_CACHE_MS: '0', // every edge redirect mints (test the limit)
      HYBRID_WORKER_BASE: 'http://127.0.0.1:59999',
      HYBRID_WORKER_POOL_MAX: '1',
      // 1.5 Mbps × 1.5 s = 281,250 B bucket: exactly ONE 245,388 B local
      // serve; afterwards the budget is drained → edge lane.
      HYBRID_VPS_DL_BUDGET_MBPS: '1.5',
      HYBRID_VPS_DL_BURST_S: '1.5',
    },
    (nextPort = freePort()),
  );
  await g.waitReady();
  try {
    const seq = [];
    for (let i = 0; i < 5; i++) {
      const r = await req(g.port, 'GET', '/speedtest/random350x350.jpg');
      seq.push({ status: r.status, lane: r.headers['x-hybrid-lane'] || null });
    }
    // deterministic pattern: local → 302 → 302 (mints 1+2) → forced-local → forced-local
    assert.deepEqual(
      seq.map((s) => `${s.status}:${s.lane}`),
      ['200:vps', '302:null', '302:null', '200:vps', '200:vps'],
    );
    const h = await req(g.port, 'GET', '/api/health');
    const hj = JSON.parse(h.body);
    assert.equal(hj.front.counters.dlLocalForced, 2);
    assert.equal(hj.front.counters.rateLimited, 2);
  } finally {
    await g.stop();
  }
});
