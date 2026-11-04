#!/usr/bin/env node
/**
 * tls-strict-check.mjs — STRICT HTTPS / TLS probe (MASTER PROMPT v6.0 §10).
 *
 * Never disables verification: rejectUnauthorized is always true and the
 * trust anchors come from --ca (e.g. the lab CA for laboratory trust, or the
 * system store for public trust). Reports a machine-readable verdict:
 *
 *   { ok, code, fingerprint?, subject?, validTo?, protocol?, body? }
 *
 * Modes:
 *   https (default)  full HTTPS request to <path> with strict validation
 *   --tls-only       TLS handshake only (for minimumTLSProtocol tests); use
 *                    --min/--max to pin the client's protocol version
 */

import * as https from 'node:https';
import * as tls from 'node:tls';
import * as fs from 'node:fs';

function arg(name, def) {
  const i = process.argv.indexOf(name);
  return i !== -1 ? process.argv[i + 1] : def;
}

const host = arg('--host', '127.0.0.1');
const port = Number(arg('--port', '8443'));
const servername = arg('--servername', 'localhost');
const pathReq = arg('--path', '/hi');
const caFile = arg('--ca');
const mode = process.argv.includes('--tls-only') ? 'tls' : 'https';
const min = arg('--min');
const max = arg('--max');

const ca = caFile ? fs.readFileSync(caFile) : undefined;

function emit(obj) {
  console.log(JSON.stringify(obj));
}

if (mode === 'tls') {
  const socket = tls.connect({
    host, port, servername,
    ca,
    rejectUnauthorized: true,
    ...(min ? { minVersion: min } : {}),
    ...(max ? { maxVersion: max } : {}),
  });
  const t = setTimeout(() => {
    socket.destroy();
    emit({ ok: false, code: 'TIMEOUT' });
    process.exit(3);
  }, 8000);
  socket.once('secureConnect', () => {
    clearTimeout(t);
    const cert = socket.getPeerCertificate();
    emit({
      ok: true,
      code: 'OK',
      protocol: socket.getProtocol(),
      cipher: socket.getCipher()?.name,
      fingerprint: cert.fingerprint256,
      subject: cert.subject?.CN,
      validTo: cert.valid_to,
    });
    socket.end();
    process.exit(0);
  });
  socket.once('error', (err) => {
    clearTimeout(t);
    emit({ ok: false, code: err.code || 'ERROR', message: err.message });
    process.exit(0); // verdict, not a harness failure
  });
} else {
  let tlsSocket = null;
  const req = https.request({
    host, port, servername, path: pathReq, ca,
    rejectUnauthorized: true,
    method: 'GET',
    headers: { 'User-Agent': 'tls-strict-check' },
    timeout: 8000,
  }, (res) => {
    let body = '';
    res.on('data', (c) => { body += c; if (body.length > 4096) req.destroy(); });
    res.on('end', () => {
      const cert = tlsSocket?.getPeerCertificate?.() || {};
      emit({
        ok: res.statusCode === 200,
        code: `HTTP_${res.statusCode}`,
        protocol: tlsSocket?.getProtocol?.(),
        fingerprint: cert.fingerprint256,
        subject: cert.subject?.CN,
        validTo: cert.valid_to,
        body: body.slice(0, 120),
      });
      process.exit(res.statusCode === 200 ? 0 : 1);
    });
  });
  req.on('socket', (s) => { tlsSocket = s; });
  req.once('timeout', () => { req.destroy(new Error('TIMEOUT')); });
  req.once('error', (err) => {
    emit({ ok: false, code: err.code || 'ERROR', message: err.message });
    process.exit(0); // verdict, not a harness failure
  });
  req.end();
}
