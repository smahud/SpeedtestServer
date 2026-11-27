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
 *       (share=0 — pure edge: the legacy 429 path; with share>0 the front
 *       degrades to forced-local instead, covered by T13)
 *   T9  upload drain: size=N answer; watchdog cleared on abort
 *  T10  result dedup window
 *  T11  v1.4 assist: share=1.0 → UNCAPPED local lane (bytes, headers, no mints)
 *  T12  v1.4 assist: share=0 → pure edge 302; token cache = 1 mint for 5 req
 *  T13  v1.4 assist: share=0.5 Bresenham interleave E,V,E,V,E + forced-local
 *       when the mint is rate-limited (never 429 with share>0)
 *  T14  v1.4 assist: share=0.15 exact long-run distribution (20 → 3/17, 1 mint)
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

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

/** HTTP request over a UNIX domain socket (the production wiring — the
 * gateway has NO TCP port; the bridge mints and pipes over this socket). */
function reqSocket(sockPath, method, reqPath, { body, headers } = {}) {
  return new Promise((resolve, reject) => {
    const r = http.request({ socketPath: sockPath, method, path: reqPath, headers: { ...headers } }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString() }));
    });
    r.on('error', (e) => resolve({ status: 0, error: String(e) }));
    if (body !== undefined) r.write(body);
    r.end();
  });
}

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
      // v1.4: share=0 = pure edge offload (legacy behavior) — the 429 path
      // only applies when the VPS lane is NOT part of the design; with
      // share>0 a rate-limited mint degrades to forced-local instead.
      HYBRID_VPS_DL_SHARE: '0',
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
    assert.ok(hj.server.startsWith('hybrid-gateway/1.5'));
  } finally {
    await g.stop();
  }
});

test('T11: assist lane — share=1.0 LOCAL serve, UNCAPPED (daemon-parity bytes, exact length, X-Hybrid-Lane)', async () => {
  const g = spawnNode(
    {
      HYBRID_SHARED_SECRET: SECRET,
      HYBRID_FRONT_ENABLED: 'true',
      HYBRID_WORKER_BASE: 'http://127.0.0.1:59999',
      HYBRID_WORKER_POOL_MAX: '1',
      // v1.4: share=1.0 → EVERY download request takes the uncapped VPS
      // lane (full potential; no token bucket exists anymore).
      HYBRID_VPS_DL_SHARE: '1.0',
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
    // health shows the assist counters (v1.4: share, no budget)
    const h = await req(g.port, 'GET', '/api/health');
    const hj = JSON.parse(h.body);
    assert.ok(hj.front.assist.enabled);
    assert.equal(hj.front.assist.vpsDlShare, 1);
    assert.ok(hj.front.counters.dlLocal >= 2);
    assert.ok(hj.front.counters.dlLocalBytes >= 245388 + 1118012);
    // pure VPS share: not a single token mint / edge redirect happened
    assert.equal(hj.front.counters.tokensMinted, 0);
    assert.equal(hj.front.counters.downRedirects, 0);
    // latency still VPS-served
    const lat = await req(g.port, 'GET', '/speedtest/latency.txt');
    assert.equal(lat.body, 'test=test\n');
  } finally {
    await g.stop();
  }
});

test('T12: assist lane — share=0 pure edge offload; token cache reuses one mint', async () => {
  const g = spawnNode(
    {
      HYBRID_SHARED_SECRET: SECRET,
      HYBRID_FRONT_ENABLED: 'true',
      HYBRID_FRONT_RATE_LIMIT_MPM: '3',
      HYBRID_WORKER_BASE: 'http://127.0.0.1:59999',
      HYBRID_WORKER_POOL_MAX: '1',
      // v1.4: share=0 = pure edge offload (legacy v1.2 behavior) — every
      // request is 302-assisted by the Worker.
      HYBRID_VPS_DL_SHARE: '0',
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

test('T13: assist lane — share=0.5 Bresenham interleave + forced-local on rate-limit (no 429)', async () => {
  const g = spawnNode(
    {
      HYBRID_SHARED_SECRET: SECRET,
      HYBRID_FRONT_ENABLED: 'true',
      HYBRID_FRONT_RATE_LIMIT_MPM: '2',
      HYBRID_FRONT_TOKEN_CACHE_MS: '0', // every edge redirect mints (test the limit)
      HYBRID_WORKER_BASE: 'http://127.0.0.1:59999',
      HYBRID_WORKER_POOL_MAX: '1',
      // v1.4: share=0.5 per-IP Bresenham interleave — request lanes follow
      // E,V,E,V,E (deterministic from the first request).
      HYBRID_VPS_DL_SHARE: '0.5',
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
    // deterministic pattern: edge(302,mint1) → VPS(200) → edge(302,mint2) →
    // VPS(200) → edge lane picked BUT mint #3 is rate-limited → forced-local
    // 200 (share > 0: the measurement NEVER breaks with 429)
    assert.deepEqual(
      seq.map((s) => `${s.status}:${s.lane}`),
      ['302:null', '200:vps', '302:null', '200:vps', '200:vps'],
    );
    const h = await req(g.port, 'GET', '/api/health');
    const hj = JSON.parse(h.body);
    assert.equal(hj.front.assist.vpsDlShare, 0.5);
    assert.equal(hj.front.counters.dlLocal, 2);
    assert.equal(hj.front.counters.dlLocalForced, 1);
    assert.equal(hj.front.counters.rateLimited, 1);
    assert.equal(hj.front.counters.tokensMinted, 2);
  } finally {
    await g.stop();
  }
});

test('T14: assist lane — share=0.15 long-run distribution is exact (20 req → 3 VPS / 17 edge, 1 mint)', async () => {
  const g = spawnNode(
    {
      HYBRID_SHARED_SECRET: SECRET,
      HYBRID_FRONT_ENABLED: 'true',
      // limiter off (0) — distribution is the subject, not the rate limit
      HYBRID_FRONT_RATE_LIMIT_MPM: '0',
      HYBRID_WORKER_BASE: 'http://127.0.0.1:59999',
      HYBRID_WORKER_POOL_MAX: '1',
      HYBRID_VPS_DL_SHARE: '0.15',
    },
    (nextPort = freePort()),
  );
  await g.waitReady();
  try {
    let vps = 0;
    let edge = 0;
    for (let i = 0; i < 20; i++) {
      const r = await req(g.port, 'GET', '/speedtest/random350x350.jpg');
      if (r.status === 200 && r.headers['x-hybrid-lane'] === 'vps') vps++;
      else if (r.status === 302) edge++;
      else throw new Error(`unexpected status ${r.status} at request ${i + 1}`);
    }
    // Bresenham over 20 requests at share 0.15: local lanes at requests
    // 7, 14, 20 — EXACTLY 15% (a modulo split would starve the VPS lane).
    assert.equal(vps, 3);
    assert.equal(edge, 17);
    const h = await req(g.port, 'GET', '/api/health');
    const hj = JSON.parse(h.body);
    assert.equal(hj.front.counters.dlLocal, 3);
    assert.equal(hj.front.counters.downRedirects, 17);
    // token cache: 17 edge requests consumed ONE mint
    assert.equal(hj.front.counters.tokensMinted, 1);
  } finally {
    await g.stop();
  }
});

// ---------------------------------------------------------------------------
// v1.5 tests: live runtime configuration (.env watcher), rate setMpm, pool
// reconfigure, workersync vps-only status.
// ---------------------------------------------------------------------------
test('T15: .env hot-reload — share hot-applies WITHOUT restart; explicit deploy count 0 forces the vps-only fallback', async () => {
  const fs = await import('node:fs');
  const envFile = `/tmp/gw-t15-${process.pid}.env`;
  fs.writeFileSync(envFile, 'HYBRID_VPS_DL_SHARE=0.5\n');
  const g = spawnNode(
    {
      HYBRID_SHARED_SECRET: SECRET,
      HYBRID_FRONT_ENABLED: 'true',
      HYBRID_WORKER_BASE: 'http://127.0.0.1:59999',
      HYBRID_WORKER_POOL_MAX: '1',
      HYBRID_VPS_DL_SHARE: '0.5',
      HYBRID_FRONT_TOKEN_CACHE_MS: '0',
      HYBRID_ENV_FILE: envFile,
      HYBRID_ENV_POLL_MS: '300',
    },
    (nextPort = freePort()),
  );
  await g.waitReady();
  try {
    // Phase 1 (legacy local-pool mode, no deploy count): share=0.5 → the
    // FIRST request takes the edge lane (Bresenham: edge on odd requests).
    const r1 = await req(g.port, 'GET', '/speedtest/random350x350.jpg');
    assert.ok(r1.status === 302 || (r1.status === 200 && r1.headers['x-hybrid-lane'] === 'vps'));

    // Phase 2: hot change share → 1.0 (pure VPS lane), applied live.
    fs.writeFileSync(envFile, 'HYBRID_VPS_DL_SHARE=1.0\n');
    let share = 0.5;
    for (let i = 0; i < 40 && share !== 1; i++) {
      await new Promise((r) => setTimeout(r, 200));
      const h = await req(g.port, 'GET', '/api/health');
      share = JSON.parse(h.body).front.assist.vpsDlShare;
    }
    assert.equal(share, 1, 'vpsDlShare must hot-apply to 1.0 without restart');
    const r2 = await req(g.port, 'GET', '/speedtest/random350x350.jpg');
    assert.equal(r2.status, 200);
    assert.equal(r2.headers['x-hybrid-lane'], 'vps');

    // Phase 3: hot change share → 0.0 (pure edge lane).
    fs.writeFileSync(envFile, 'HYBRID_VPS_DL_SHARE=0.0\n');
    let share2 = 1;
    for (let i = 0; i < 40 && share2 !== 0; i++) {
      await new Promise((r) => setTimeout(r, 200));
      const h = await req(g.port, 'GET', '/api/health');
      share2 = JSON.parse(h.body).front.assist.vpsDlShare;
    }
    assert.equal(share2, 0, 'vpsDlShare must hot-apply to 0 without restart');
    const r3 = await req(g.port, 'GET', '/speedtest/random350x350.jpg');
    assert.equal(r3.status, 302);

    // Phase 4: an explicit CF_WORKER_DEPLOY_COUNT=0 with no credentials makes
    // the deployment plane authoritative → vps-only fallback: even share=0
    // serves everything from the VPS (never breaks the measurement).
    fs.writeFileSync(envFile, 'HYBRID_VPS_DL_SHARE=0.0\nCF_WORKER_DEPLOY_COUNT=0\n');
    let mode = 'hybrid';
    for (let i = 0; i < 40 && mode !== 'vps-only'; i++) {
      await new Promise((r) => setTimeout(r, 200));
      const h = await req(g.port, 'GET', '/api/health');
      mode = JSON.parse(h.body).mode;
    }
    assert.equal(mode, 'vps-only', 'explicit deploy count 0 → vps-only deployment mode');
    const r4 = await req(g.port, 'GET', '/speedtest/random350x350.jpg');
    assert.equal(r4.status, 200);
    assert.equal(r4.headers['x-hybrid-lane'], 'vps');

    // health exposes the env watcher state
    const h = await req(g.port, 'GET', '/api/health');
    const hj = JSON.parse(h.body);
    assert.ok(hj.env.watching === true);
    assert.ok(Array.isArray(hj.env.lastChangeKeys) && hj.env.lastChangeKeys.length > 0);
    assert.equal(hj.workers.mode, 'vps-only');
    assert.equal(hj.workers.target, 0);
  } finally {
    await g.stop();
    try { fs.unlinkSync(envFile); } catch {}
  }
});

test('T16: rate limiter setMpm is live', async () => {
  const { createRateLimiter } = await import(new URL('../src/workerpool.mjs', import.meta.url).href);
  const rl = createRateLimiter(2);
  assert.ok(rl.allow('k'));
  assert.ok(rl.allow('k'));
  assert.ok(!rl.allow('k'));
  rl.setMpm(4);
  assert.ok(rl.allow('k'));
  assert.ok(rl.allow('k'));
  assert.ok(!rl.allow('k'));
  rl.setMpm(0);
  assert.ok(rl.allow('k')); // 0 = unlimited
});

test('T17: pool reconfigure — grow/shrink with state preservation', async () => {
  const { createWorkerPool } = await import(new URL('../src/workerpool.mjs', import.meta.url).href);
  const logs = [];
  const pool = createWorkerPool({
    base: 'https://speedtest-hybrid-worker.example.workers.dev',
    poolMax: 3,
    activeMin: 1,
    log: (k, d) => logs.push({ k, d }),
  });
  pool.recordMint(1);
  pool.reconfigure({ poolMax: 5, activeMin: 2 });
  const st1 = pool.status();
  assert.equal(st1.poolMax, 5);
  assert.equal(st1.workers.length, 5);
  assert.equal(st1.workers[4].url, 'https://speedtest-hybrid-worker-5.example.workers.dev');
  assert.equal(st1.activeCount, 2);
  assert.equal(st1.workers[0].servedTotal, 1, 'per-URL counters survive reconfigure');
  pool.reconfigure({ poolMax: 2 });
  const st2 = pool.status();
  assert.equal(st2.poolMax, 2);
  assert.equal(st2.workers.length, 2);
  assert.ok(st2.activeIds.every((id) => id <= 2), 'active set clamped into bounds');
  assert.ok(logs.some((l) => l.k === 'pool_reconfigured'));
  pool.stop();
});

test('T18: workersync — vps-only without credentials; hybrid target from explicit deploy count', async () => {
  const { createWorkerSync } = await import(new URL('../src/workersync.mjs', import.meta.url).href);
  const logs = [];
  // no credentials → vps-only
  const ws1 = createWorkerSync({ cfg: { cf: { mode: 'none', accountId: '' }, deployCountExplicit: false, poolMax: 3, workerSyncDelete: true }, log: (k, d) => logs.push({ k, d }) });
  assert.equal(ws1.status().mode, 'vps-only');
  assert.equal(ws1.status().target, 0);
  const r1 = await ws1.sync();
  assert.equal(r1.mode, 'vps-only');
  assert.equal(ws1.status().deployStatus, 'ok');
  // credentials + explicit target → hybrid (REST is attempted; with a mock
  // fetch returning a valid empty script list the sync fails gracefully and
  // deployStatus must become 'error', never crash)
  const ws2 = createWorkerSync({
    cfg: { cf: { mode: 'key', token: '', email: 'a@b.c', key: 'k', accountId: 'acct' }, deployCountExplicit: true, deployCount: 4, poolMax: 3, workerSyncDelete: true, workerName: 'speedtest-hybrid-worker', workersSubdomain: 'sub', workerBundlePath: '', workerFingerprintFile: '', workerSyncIntervalMs: 0 },
    log: (k, d) => logs.push({ k, d }),
  });
  assert.equal(ws2.status().mode, 'hybrid');
  assert.equal(ws2.status().target, 4);
  const r2 = await ws2.sync();
  assert.ok(r2.error, 'sync without a readable bundle must fail gracefully');
  assert.equal(ws2.status().deployStatus, 'error');
});

test('T19: rest-deploy — name mapping, form shape, auth headers, listPool filtering', async () => {
  const mod = await import(new URL('../../worker/rest-deploy.mjs', import.meta.url).href);
  assert.equal(mod.poolName('speedtest-hybrid-worker', 1), 'speedtest-hybrid-worker');
  assert.equal(mod.poolName('speedtest-hybrid-worker', 42), 'speedtest-hybrid-worker-42');
  // form: metadata JSON with plain_text vars + secret_text binding
  const fd = mod.buildDeployForm({ bundleSrc: 'export default {};', workerId: 2, poolSize: 10, secret: 's3cr3t' });
  assert.ok(fd instanceof FormData);
  const meta = fd.get('metadata');
  assert.ok(meta instanceof Blob);
  const metaJson = JSON.parse(await meta.text());
  assert.equal(metaJson.main_module, 'index.js');
  assert.equal(metaJson.compatibility_date, '2026-10-01');
  const names = metaJson.bindings.map((b) => `${b.name}:${b.type}`).sort();
  assert.ok(names.includes('WORKER_ID:plain_text'));
  assert.ok(names.includes('WORKER_POOL_MAX:plain_text'));
  assert.ok(names.includes('HYBRID_SHARED_SECRET:secret_text'));
  const idBinding = metaJson.bindings.find((b) => b.name === 'WORKER_ID');
  assert.equal(idBinding.text, '2');
  const pmBinding = metaJson.bindings.find((b) => b.name === 'WORKER_POOL_MAX');
  assert.equal(pmBinding.text, '10');
  // auth headers: token mode vs key mode
  const ctxToken = mod.createRestCtx({ auth: { token: 'tok' }, accountId: 'a', baseName: 'speedtest-hybrid-worker', subdomain: 'sub' });
  const hT = ctxToken.headers({});
  assert.equal(hT.Authorization, 'Bearer tok');
  const ctxKey = mod.createRestCtx({ auth: { token: '', email: 'e@x.y', key: 'kk' }, accountId: 'a', baseName: 'speedtest-hybrid-worker', subdomain: 'sub' });
  const hK = ctxKey.headers({});
  assert.equal(hK['X-Auth-Email'], 'e@x.y');
  assert.equal(hK['X-Auth-Key'], 'kk');
  // listPool filters to the exact pool naming scheme
  const fakeResult = [
    { id: 'speedtest-hybrid-worker', modified_on: 'x' },
    { id: 'speedtest-hybrid-worker-2', modified_on: 'x' },
    { id: 'speedtest-hybrid-worker-10', modified_on: 'x' },
    { id: 'speedtest-hybrid-worker-evil', modified_on: 'x' }, // NOT a pool member (suffix must be numeric)
    { id: 'speedtest-hybrid-worker2', modified_on: 'x' }, // not pool naming
    { id: 'unrelated-script', modified_on: 'x' },
    { id: 'speedtest-other-worker', modified_on: 'x' },
  ];
  const calls = [];
  const ctxList = mod.createRestCtx({
    auth: { token: 'tok' }, accountId: 'a', baseName: 'speedtest-hybrid-worker', subdomain: 'sub',
    fetchImpl: async (url) => {
      calls.push(url);
      return { ok: true, status: 200, text: async () => JSON.stringify({ success: true, result: fakeResult }) };
    },
  });
  const pool = await mod.listPool(ctxList);
  assert.deepEqual(pool.map((w) => w.id), [1, 2, 10]);
});

test('T20: PORT AUTHORITY — socket mode: gateway serves over a UNIX socket, NO TCP listener', async () => {
  const sockPath = path.join(os.tmpdir(), `gw-sock-test-${process.pid}.sock`);
  const g = spawnNode({
    HYBRID_SHARED_SECRET: SECRET,
    HYBRID_FRONT_ENABLED: 'false',
    HYBRID_GATEWAY_SOCKET: sockPath,
  }, 0);
  try {
    await g.waitReady();
    const startedLine = g.logs.join('').split('\n').filter((l) => l.includes('gateway_started')).pop();
    const meta = JSON.parse(startedLine);
    assert.equal(meta.socketMode, true, 'gateway_started must announce socketMode');
    assert.equal(meta.socket, sockPath);
    // health + mint over the socket (the bridge's production path)
    const health = await reqSocket(sockPath, 'GET', '/api/health');
    assert.equal(health.status, 200);
    const h = JSON.parse(health.body);
    assert.equal(h.config.socket, sockPath);
    const mint = await reqSocket(sockPath, 'POST', '/api/sessions', { body: '{}' });
    assert.equal(mint.status, 200);
    assert.ok(JSON.parse(mint.body).token, 'mint works over the socket');
    // the socket file itself is mode 0660 (permission boundary)
    const mode = (fs.statSync(sockPath).mode & 0o777).toString(8);
    assert.equal(mode, '660', `socket mode 0660 (got 0${mode})`);
  } finally {
    await g.stop();
    try { fs.unlinkSync(sockPath); } catch {}
  }
});
