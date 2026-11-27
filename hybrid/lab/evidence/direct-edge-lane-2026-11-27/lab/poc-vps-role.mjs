#!/usr/bin/env node
/**
 * poc-vps-role.mjs — lab stand-in for the VPS role in the DIRECT-LANE
 * architecture (operator contract 27 Nov 2026: "worker membantu load berat
 * LANGSUNG ke client — relay/bridge DILARANG").
 *
 * What this server proves, together with poc-webclient.mjs:
 *
 *   official speedtest.net web client (browser, unmodified)
 *     ├─ WSS  wss://<server>:8080/ws  → THIS server (control plane only:
 *     │                                HI/GETIP/CAPABILITIES/PING + loaded
 *     │                                latency during DL and UL — served
 *     │                                SIMULTANEOUSLY with both phases)
 *     ├─ XHR  GET  /hello /getip /capabilities /ping → THIS server (tiny)
 *     ├─ XHR  GET  /download?size=25MB  → 307 → Cloudflare Worker (DIRECT)
 *     └─ XHR  POST /upload (25MB body)  → 307 → Cloudflare Worker (DIRECT)
 *
 *   Payload bytes never transit this server. Every byte that DOES transit
 *   is logged to JSONL for the 3-sided attribution.
 *
 * Protocol behavior = byte-verified daemon parity
 * (docs/WEB_CLIENT_REVERSE_ENGINEERING_2026-11-26.md +
 *  docs/HTTPS_WEB_CLIENT_SUPPORT_2026-11-27.md):
 *   - WS HELLO and CAPABILITIES replies carry NO trailing newline
 *   - YOURIP / PONG / OK carry \n
 *   - one command per WS frame; frames without \n are complete commands
 *   - XHR /hello → lowercase `hello ...`, /ping → `pong\n`
 *   - 307 (not 302) on POST /upload so the browser re-POSTs the body
 *   - CAPABILITIES announced WITHOUT UPLOAD_STATS → the SDK measures
 *     upload LOCALLY (progress events), because the UL bytes land at the
 *     edge and the control plane cannot count them remotely.
 */

import https from 'node:https';
import fs from 'node:fs';
import { WebSocketServer } from 'ws';

const PORT = Number(process.env.PORT || 8080);
const WORKER = process.env.WORKER || 'https://speedtest-hybrid-worker-test.lumajangnetworks.workers.dev';
const VERSION = '2.11 (2.11.5) 2026-06-04.1737.7d0993d';
const LOG = '/home/z/my-project/lab/vps-role.jsonl';

const out = fs.createWriteStream(LOG, { flags: 'w' });
const t0 = Date.now();
const log = (kind, detail) => out.write(JSON.stringify({ ms: Date.now() - t0, kind, ...detail }) + '\n');

// byte accounting for the final summary
const acc = {
  wsControlFramesOut: 0, wsControlBytesOut: 0, wsUploadBytesIn: 0,
  httpControlOut: 0, httpControlIn: 0,
  dl307: 0, ul307: 0, ul307BytesIn: 0,
};

const cert = fs.readFileSync('/home/z/my-project/lab/mock-cert.pem');
const key = fs.readFileSync('/home/z/my-project/lab/mock-key.pem');

function cors(req, res) {
  const o = req.headers.origin;
  if (o) {
    res.setHeader('Access-Control-Allow-Origin', o);
    res.setHeader('Access-Control-Expose-Headers', 'Content-Length, X-Hybrid-Lane');
  }
}

function text(req, res, body, extra = {}) {
  const buf = Buffer.from(body);
  acc.httpControlOut += buf.length;
  cors(req, res);
  res.writeHead(200, {
    'Content-Type': 'text/plain; charset=UTF-8',
    'Content-Length': buf.length,
    'Cache-Control': 'no-store, no-transform',
    'X-Hybrid-Lane': 'vps-control',
    ...extra,
  });
  res.end(buf);
  log('http_control', { method: req.method, path: req.url, bytes: buf.length });
}

// ---------------------------------------------------------------------------
// HTTP XHR surface (control locally, heavy payload → 307 to the Worker)
// ---------------------------------------------------------------------------
const server = https.createServer({ cert, key }, (req, res) => {
  const u = new URL(req.url, `https://${req.headers.host || 'mock'}`);
  const p = u.pathname.replace(/\/+$/, '') || '/';
  const method = (req.method || 'GET').toUpperCase();

  req.on('data', (c) => { acc.httpControlIn += c.length; });

  if (method === 'OPTIONS') {
    cors(req, res);
    const h = {
      'Access-Control-Allow-Methods': 'GET, HEAD, POST, OPTIONS',
      'Content-Length': 0,
      'Cache-Control': 'no-store, no-transform',
    };
    // CRITICAL: echo the requested headers — the SDK's octet-stream POST
    // preflights with Access-Control-Request-Headers: content-type; without
    // this answer the preflight fails and the POST is never sent.
    const reqH = req.headers['access-control-request-headers'];
    if (reqH) h['Access-Control-Allow-Headers'] = reqH;
    res.writeHead(200, h);
    res.end();
    log('http_options', { path: p, allowHeaders: reqH || null });
    return;
  }

  switch (p) {
    case '/hello':
      text(req, res, `hello ${VERSION}\n`);
      return;
    case '/getip':
      text(req, res, `${req.socket.remoteAddress}\n`);
      return;
    case '/capabilities':
      // No UPLOAD_STATS: upload is measured client-side (bytes land at edge).
      text(req, res, 'capabilities SERVER_HOST_AUTH\n');
      return;
    case '/ping':
      text(req, res, 'pong\n');
      return;
    case '/upload-stats':
      res.writeHead(400, { 'Content-Length': 0, Connection: 'close' });
      res.end();
      return;
    case '/download': {
      // HEAVY DOWNLOAD: hand off to the edge. Preserve the SDK's query
      // (size/guid/nocache/ct) and add nothing else in the open test env.
      const size = Number(u.searchParams.get('size') || 0);
      const loc = `${WORKER}/download${u.search}`;
      acc.dl307++;
      log('dl_307', { size, guid: u.searchParams.get('guid'), to: loc.slice(0, 120) });
      cors(req, res);
      res.writeHead(307, {
        Location: loc,
        'Content-Length': 0,
        'Cache-Control': 'no-store, no-transform',
        'X-Hybrid-Lane': 'edge',
        Connection: 'close',
      });
      res.end();
      return;
    }
    case '/upload': {
      if (method !== 'POST') {
        res.writeHead(404, { 'Content-Length': 0, Connection: 'close' });
        res.end();
        return;
      }
      // HEAVY UPLOAD: 307 preserves method+body → the browser re-POSTs the
      // whole body DIRECTLY to the edge. Answer immediately; do not drain.
      const loc = `${WORKER}/upload${u.search}`;
      let saw = 0;
      req.on('data', (c) => { saw += c.length; });
      acc.ul307++;
      log('ul_307', { guid: u.searchParams.get('guid'), to: loc.slice(0, 120) });
      cors(req, res);
      res.writeHead(307, {
        Location: loc,
        'Content-Length': 0,
        'Cache-Control': 'no-store, no-transform',
        'X-Hybrid-Lane': 'edge',
        Connection: 'close',
      });
      res.end(() => {
        // response head flushed — discard whatever body arrived and reset.
        acc.ul307BytesIn += saw;
        log('ul_307_flushed', { bodyBytesDiscarded: saw });
        req.destroy();
      });
      return;
    }
    default:
      res.writeHead(404, { 'Content-Length': 0, Connection: 'close' });
      res.end();
      log('http_404', { path: p });
  }
});

// ---------------------------------------------------------------------------
// WSS /ws — NetGauge-over-WS control plane (web quirks)
// ---------------------------------------------------------------------------
const wss = new WebSocketServer({ noServer: true });
server.on('upgrade', (req, socket, head) => {
  const u = new URL(req.url, 'wss://mock');
  if (u.pathname.replace(/\/+$/, '') !== '/ws') {
    socket.destroy();
    return;
  }
  wss.handleUpgrade(req, socket, head, (ws) => {
    acc.wsSessions = (acc.wsSessions || 0) + 1;
    log('ws_open', { ip: socket.remoteAddress });
    let muted = false;
    let firstFrame = true;

    const reply = (line, nl = true) => {
      const buf = Buffer.from(nl ? line + '\n' : line);
      acc.wsControlFramesOut++;
      acc.wsControlBytesOut += buf.length;
      ws.send(buf);
    };

    ws.on('message', (data, isBinary) => {
      const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
      if (isBinary || buf.slice(0, 7).toString('latin1') === 'UPLOAD ') {
        // raw upload frame (WS transport) — count and ack per production
        acc.wsUploadBytesIn += buf.length;
        reply(`OK ${buf.length} ${Date.now()}`);
        log('ws_upload_frame', { bytes: buf.length });
        return;
      }
      const s = buf.toString('latin1').replace(/\r$/, '');
      const nl = s.indexOf('\n');
      const line = (nl === -1 ? s : s.slice(0, nl)).trim();
      const rest = nl === -1 ? '' : s.slice(nl + 1);

      // pre-session GETIP gate (daemon quirk): first frame GETIP + trailing
      // bytes → mute forever.
      if (firstFrame) {
        firstFrame = false;
        if (line === 'GETIP' && rest.length > 0) {
          muted = true;
          log('ws_muted_getip_gate');
          return;
        }
      }
      if (muted) return;

      log('ws_cmd', { line: line.slice(0, 80) });
      const sp = line.indexOf(' ');
      const cmd = sp === -1 ? line : line.slice(0, sp);
      switch (cmd) {
        case 'HI':
          reply(`HELLO ${VERSION}`, false); // NO trailing newline (quirk)
          return;
        case 'GETIP':
          reply(`YOURIP ${socket.remoteAddress}`);
          return;
        case 'CAPABILITIES':
          // No UPLOAD_STATS → SDK measures upload locally (edge lane).
          reply('CAPABILITIES SERVER_HOST_AUTH', false); // NO trailing \n
          return;
        case 'PING':
          reply(`PONG ${Date.now()}`);
          return;
        case 'UPTIME':
          reply(`UPTIME ${Math.floor((Date.now() - t0) / 1000)}`);
          return;
        case 'SERVERID':
          reply(`SERVERID 11111111-2222-4333-8444-555555555555`);
          return;
        case 'INITPLOSS':
          reply('OK');
          return;
        case 'UPLOAD_STATS':
          // not announced in CAPABILITIES — parity ERROR if asked anyway
          reply('ERROR');
          return;
        case 'DOWNLOAD': {
          const n = Number(line.slice(9).trim());
          if (!Number.isInteger(n) || n < 0) {
            reply('ERROR');
            return;
          }
          const payload = Buffer.alloc(Math.min(n, 2 * 1024 * 1024));
          for (let i = 0; i < payload.length; i++) payload[i] = 0x20 + ((i * 31) % 96);
          // production: single binary frame, first bytes "DOWNLOAD "
          if (n > 10) payload.write('DOWNLOAD ', 0, 'latin1');
          acc.wsControlFramesOut++;
          acc.wsControlBytesOut += payload.length;
          ws.send(payload);
          return;
        }
        case 'QUIT':
          ws.close(1000, 'quit');
          return;
        default:
          reply('ERROR');
      }
    });
    ws.on('close', () => log('ws_close'));
    ws.on('error', () => {});
  });
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`[poc-vps-role] listening on :${PORT} (TLS) — worker: ${WORKER}`);
  console.log(`[poc-vps-role] logging to ${LOG}`);
});

// summary on SIGINT (printed by the driver via SIGUSR2 too)
function summary() {
  console.log('[poc-vps-role] SUMMARY ' + JSON.stringify(acc));
  out.write(JSON.stringify({ kind: 'summary', ...acc }) + '\n');
  out.end();
}
process.on('SIGINT', () => { summary(); process.exit(0); });
process.on('SIGUSR2', summary);
