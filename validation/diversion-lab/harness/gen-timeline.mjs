#!/usr/bin/env node
/**
 * gen-timeline.mjs — timeline koneksi lengkap (master prompt §11/Stage-5) dari
 * evidence satu run diversion: diverter.jsonl (routing + byte + perintah),
 * proxy.jsonl (config + blokir), cli.json (hasil), analysis.json (fase).
 *
 * Aturan integritas: FASE/perintah TIDAK PERNAH diinfer dari payload terenkripsi.
 * Koneksi terenkripsi dilabel fase dengan BASIS = "byte-signature" (arah/volume/
 * durasi + korroborasi STS/daemon/CLI) dan ditandai inference di kolom basis.
 *
 * Pemakaian: node gen-timeline.mjs <evidence-dir>   → stdout markdown + <dir>/timeline.csv
 */
import fs from 'node:fs';
import path from 'node:path';

const dir = process.argv[2];
const rd = (f) => { try { return fs.readFileSync(path.join(dir, f), 'utf8'); } catch { return null; } };
const jl = (f) => (rd(f) || '').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
const div = jl('diverter.jsonl');
const proxy = jl('proxy.jsonl');
let cli = null; try { cli = JSON.parse(rd('cli.json')); } catch {}
const iso = (ms) => new Date(ms).toISOString().replace('T', ' ').replace('Z', ' UTC');

const meta = div.find((e) => e.k === 'meta');
const gwPort = meta?.port ?? 9090;
const beAddr = { A: meta?.a ?? '127.0.0.1:18080', B: meta?.b ?? '127.0.0.1:8080' };

// ---- koneksi
const conns = new Map();
for (const e of div) {
  if (e.k === 'conn_open') conns.set(e.id, { id: e.id, openTs: e.ts, openRt: e.rt, peer: e.peer, backend: null, reason: null, routed: false, cmds: [], closeTs: null, durMs: null, c2b: null, b2c: null, upErr: null, replayed: null });
  const c = conns.get(e.id); if (!c) continue;
  if (e.k === 'conn_route') { c.backend = e.backend; c.reason = e.reason; c.routed = true; c.replayed = e.replayed ?? null; }
  else if (e.k === 'conn_cmd') c.cmds.push(e.line);
  else if (e.k === 'conn_close') { c.closeTs = e.ts; c.durMs = e.durMs; c.c2b = e.bytesCli2Be; c.b2c = e.bytesBe2Cli; }
  else if (e.k === 'conn_upstream_err') c.upErr = e.error;
}

function classify(c) {
  // handshake: (1) reason 'enc-hello' = gateway memeriksa byte pertama (phase mode); (2) cmds[0]=«BIN» = sniff 256B pertama (all/firstN mode)
  const encByRoute = c.reason === 'enc-hello';
  const firstBin = c.cmds.length && c.cmds[0].startsWith('«BIN');
  const isEnc = encByRoute || (firstBin && !c.cmds.some((x) => !x.startsWith('«BIN')));
  const txt = c.cmds.filter((x) => !x.startsWith('«BIN'));
  const has = (p) => txt.some((x) => x.startsWith(p));
  const uuid = (txt.find((x) => /^HI [0-9A-Fa-f-]{36}/.test(x)) || '').split(' ')[1] || null;
  let handshake, phase, basis;
  if ((c.c2b ?? 0) === 0 && (c.b2c ?? 0) === 0 && !c.cmds.length) { handshake = 'none'; phase = 'zero-byte (no data)'; basis = 'observed (0 bytes both ways)'; }
  else if (isEnc && txt.length === 0) {
    handshake = 'encrypted-binary-hello (byte pertama diperiksa gateway)';
    // payload terenkripsi — fase HANYA by signature, dilabel inference
    const gbIn = (c.b2c ?? 0) > 1e9, gbOut = (c.c2b ?? 0) > 1e9, short = (c.durMs ?? 0) < 500;
    if (gbIn) { phase = 'download-worker (inferred)'; basis = 'byte-signature: GB-scale backend→cli' ; }
    else if (gbOut) { phase = 'upload-worker (inferred)'; basis = 'byte-signature: GB-scale cli→backend'; }
    else if (short) { phase = c.id <= 22 ? 'selection-probe (inferred)' : 'encrypted control (inferred)'; basis = 'byte-signature: small, short-lived'; }
    else if ((c.c2b ?? 0) < 500 && (c.b2c ?? 0) < 200000) { phase = 'upload-control (inferred)'; basis = 'byte-signature: tiny c→b, tens-of-KB b→c, upload-phase window'; }
    else { phase = 'ping-monitor (inferred)'; basis = 'byte-signature: KB-scale, long-lived, spans a load phase'; }
  } else {
    handshake = (encByRoute || firstBin) ? 'encrypted-binary-hello → plaintext fallback' : 'plaintext-HI';
    if (has('INITPLOSS') || has('PLOSS')) { phase = 'packet-loss-accounting'; basis = 'observed command'; }
    else if (has('DOWNLOAD')) { phase = 'download-worker'; basis = 'observed command'; }
    else if (has('UPLOAD_STATS') || has('CAPABILITIES')) { phase = 'upload-control'; basis = 'observed command'; }
    else if (has('UPLOAD')) { phase = 'upload-worker'; basis = 'observed command'; }
    else if (uuid && (c.c2b ?? 0) > 1e9) { phase = 'upload-worker'; basis = 'observed HI <UUID> + byte-signature GB-scale cli→backend (perintah UPLOAD menyatu dgn payload acak dlm satu chunk non-printable)'; }
    else if (has('GETIP') || has('PING')) { phase = (c.durMs ?? 0) < 500 ? 'selection-probe' : 'ping-monitor'; basis = 'observed command'; }
    else if (txt.length) { phase = 'other/text'; basis = 'observed command'; }
    else { phase = 'unknown'; basis = 'insufficient data'; }
  }
  return { handshake, phase, basis, uuid };
}

const rows = [];
for (const c of [...conns.values()].sort((a, b) => a.openRt - b.openRt)) {
  const { handshake, phase, basis, uuid } = classify(c);
  const closure = c.upErr ? `upstream-error (${c.upErr})` : 'client-close (conn_close)';
  rows.push({
    conn: c.id, start: iso(c.openTs), end: c.closeTs ? iso(c.closeTs) : 'open/unobserved',
    durMs: c.durMs, proto: 'TCP', cliSrc: c.peer, gw: `localhost:${gwPort}`,
    backend: c.backend ? `${c.backend} (${beAddr[c.backend]})` : '—',
    routeReason: c.reason || (c.routed ? '' : 'no-route (zero-byte)'),
    handshake, uuid: uuid || (handshake.includes('encrypted') && !uuid ? '(not observable — encrypted)' : ''),
    phase, basis, c2b: c.c2b ?? 0, b2c: c.b2c ?? 0, closure,
    ev: `diverter.jsonl conn ${c.id}` + (c.replayed ? ' (prefix replayed cross-backend)' : ''),
  });
}

// ---- UDP
const udpRows = [];
const udpSummary = div.find((e) => e.k === 'summary');
for (const u of udpSummary?.udpClients || []) {
  udpRows.push({ client: u.client, backend: `${u.backend} (${beAddr[u.backend]})`, sent: u.sent, recv: u.recv });
}

// ---- proxy events
const cfgReq = proxy.find((e) => e.k === 'config_req');
const cfgServed = proxy.find((e) => e.k === 'config_served');
const blocked = proxy.filter((e) => e.k === 'blocked').map((e) => e.target);

// ---- output
const W = process.stdout;
const gb = (n) => (n / 1e9).toFixed(2);
W.write(`# TIMELINE — ${path.basename(dir)} (generator: gen-timeline.mjs)\n\n`);
W.write(`Policy: \`${meta?.policy}\` | UDP→${meta?.udp} | diverter :${gwPort} | A=${beAddr.A} (official) | B=${beAddr.B} (SpeedtestServer TS)\n\n`);
if (cfgReq) W.write(`- **Config fetch**: ${iso(cfgReq.ts)} — GET ${cfgReq.target.slice(0, 52)}… via lab proxy (MITM lab-CA) → ${cfgServed ? `served ${cfgServed.source}, ${cfgServed.servedBytes} B, semua servers[] → localhost:${gwPort}` : 'GAGAL'}\n`);
if (blocked.length) W.write(`- **Non-publishing**: ${blocked.join(', ')} DITOLAK proxy (403) → CLI \`persisted:${cli?.result?.persisted}\`\n`);
if (cli) W.write(`- **Hasil CLI**: exit=0 type=${cli.type} | latency ${cli.ping?.latency} ms | DL ${gb(cli.download?.bytes || 0)} GB | UL ${gb(cli.upload?.bytes || 0)} GB | packetLoss ${cli.packetLoss} | result.id=${cli.result?.id}\n`);
W.write(`- **UUID sesi**: ${cli?.result?.id} (diumumkan winner-probe & dipakai semua koneksi pasca-seleksi)\n\n`);
W.write(`## Koneksi TCP (${rows.length})\n\n`);
W.write('| # | mulai (UTC) | dur (ms) | sumber CLI | gateway | backend aktual | handshake | UUID sesi | fase | basis fase | c→b (B) | b→c (B) | penutupan | evidence |\n');
W.write('|---|---|---|---|---|---|---|---|---|---|---|---|---|---|\n');
for (const r of rows) {
  W.write(`| ${r.conn} | ${r.start} | ${r.durMs ?? '—'} | ${r.cliSrc} | ${r.gw} | ${r.backend} | ${r.handshake} | ${r.uuid || '—'} | ${r.phase} | ${r.basis} | ${r.c2b} | ${r.b2c} | ${r.closure} | ${r.ev} |\n`);
}
W.write(`\n## Endpoint UDP (${udpRows.length})\n\n`);
W.write('| klien | backend | datagram cli→be | balasan be→cli |\n|---|---|---|---|\n');
for (const u of udpRows) W.write(`| ${u.client} | ${u.backend} | ${u.sent} | ${u.recv} |\n`);
W.write(`\n> Fase koneksi terenkripsi dilabel **(inferred)** dan basisnya byte-signature — perintah TIDAK diinfer dari payload terenkripsi (master prompt §11). Fase koneksi plaintext berbasis perintah teramati langsung.\n`);

// ---- CSV
const esc = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
const cols = ['conn_id', 'start_utc', 'end_utc', 'duration_ms', 'protocol', 'cli_source', 'gateway', 'actual_backend', 'route_reason', 'handshake_type', 'session_uuid', 'measurement_phase', 'phase_basis', 'bytes_cli_to_backend', 'bytes_backend_to_cli', 'closure', 'evidence_reference'];
const csv = [cols.join(',')];
for (const r of rows) {
  csv.push([r.conn, r.start, r.end, r.durMs, r.proto, r.cliSrc, r.gw, r.backend, r.routeReason, r.handshake, r.uuid, r.phase, r.basis, r.c2b, r.b2c, r.closure, r.ev].map(esc).join(','));
}
fs.writeFileSync(path.join(dir, 'timeline.csv'), csv.join('\n') + '\n');
W.write(`\n(CSV mesin-terbaca: ${path.join(dir, 'timeline.csv')})\n`);
