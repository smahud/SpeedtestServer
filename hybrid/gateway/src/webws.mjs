/**
 * webws.mjs — Ookla WEB-CLIENT control plane (NetGauge over WebSocket) on
 * the hybrid gateway.
 *
 * DIRECT-LANE ARCHITECTURE (operator contract, 27 Nov 2026 — "relay/bridge
 * = salah total; worker membantu load berat LANGSUNG ke client"):
 *
 *   The official speedtest.net web client keeps its CONTROL plane on
 *   wss://<server>:8080/ws (server-selection pings, idle latency, loaded
 *   latency during both heavy phases) and moves its PAYLOAD plane over XHR
 *   (GET /download, POST /upload). This module serves the control plane on
 *   the VPS; front.mjs 307-hands the payload plane to the Cloudflare
 *   Worker so the heavy bytes flow client ↔ edge ONLY.
 *
 * Byte-verified web-client semantics (docs/WEB_CLIENT_REVERSE_ENGINEERING_
 * 2026-11-26.md + docs/HTTPS_WEB_CLIENT_SUPPORT_2026-11-27.md, and re-proven
 * first-hand in the 27 Nov direct-lane PoC against the live speedtest.net
 * page — hybrid/lab evidence poc-run.jsonl):
 *   - HELLO and CAPABILITIES replies carry NO trailing newline (the SDK's
 *     regexes are $-anchored); YOURIP/PONG/OK carry \n.
 *   - One command per WS frame; a frame without \n is a complete command.
 *   - Binary frames starting with ASCII "UPLOAD " are RAW UPLOAD DATA —
 *     answer `OK <frame-len> <epoch-ms>\n` per frame.
 *   - DOWNLOAD <n> answers one binary frame of exactly n bytes.
 *   - Pre-session GETIP-with-trailing-bytes mutes the connection (daemon
 *     quirk F-12).
 *   - CAPABILITIES is announced WITHOUT UPLOAD_STATS on the direct lane:
 *     upload bytes land at the edge, so the VPS cannot count them remotely;
 *     the SDK then measures upload LOCALLY (progress events) — the designed
 *     fallback for servers without the capability. Announcing UPLOAD_STATS
 *     here would silently report a ~0 upload speed.
 */

// "ws" is a production dependency (shipped by the installer from the TS
// daemon's prod node_modules to $PREFIX/node_modules). Resolve it lazily so
// a missing package degrades ONLY the WSS lane (loud log) instead of killing
// the whole gateway — the bridge/CLI lane must never depend on it.
let WebSocketServer = null;
try {
  ({ WebSocketServer } = await import('ws'));
} catch {
  console.error(JSON.stringify({ kind: 'webws_unavailable', error: "package 'ws' not resolvable — WSS control lane disabled; run npm install in hybrid/gateway or reinstall production deps" }));
}

export function attachWebWs(server, ctx) {
  if (!WebSocketServer) return null;
  const { log, counters, versionString } = ctx;
  const wss = new WebSocketServer({ noServer: true, maxPayload: 512 * 1024 * 1024 });

  server.on('upgrade', (req, socket, head) => {
    let path = '/';
    try {
      path = new URL(req.url, 'http://ws').pathname.replace(/\/+$/, '') || '/';
    } catch {
      socket.destroy();
      return;
    }
    if (path !== '/ws') {
      // daemon parity: upgrade only on /ws, other paths dropped
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      counters.webWsSessions = (counters.webWsSessions || 0) + 1;
      let ip = (req.socket && req.socket.remoteAddress) || '127.0.0.1';
      if (ip.startsWith('::ffff:')) ip = ip.slice(7);
      log('web_ws_open', { ip });
      let muted = false;
      let firstFrame = true;

      const reply = (line, nl = true) => {
        try {
          ws.send(nl ? line + '\n' : line);
          counters.webWsCtrlBytesOut = (counters.webWsCtrlBytesOut || 0) + Buffer.byteLength(line) + (nl ? 1 : 0);
        } catch {
          /* socket closing */
        }
      };

      ws.on('message', (data, isBinary) => {
        const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
        if (isBinary || buf.slice(0, 7).toString('latin1') === 'UPLOAD ') {
          // raw upload frame (WS transport) — ack per production parity
          counters.webWsUploadBytesIn = (counters.webWsUploadBytesIn || 0) + buf.length;
          reply(`OK ${buf.length} ${Date.now()}`);
          return;
        }
        const s = buf.toString('latin1').replace(/\r$/, '');
        const nl = s.indexOf('\n');
        const line = (nl === -1 ? s : s.slice(0, nl)).trim();
        const rest = nl === -1 ? '' : s.slice(nl + 1);

        if (firstFrame) {
          firstFrame = false;
          if (line === 'GETIP' && rest.length > 0) {
            muted = true; // daemon F-12 quirk: mute forever
            log('web_ws_muted_getip_gate', { ip });
            return;
          }
        }
        if (muted) return;

        counters.webWsCommands = (counters.webWsCommands || 0) + 1;
        const sp = line.indexOf(' ');
        const cmd = sp === -1 ? line : line.slice(0, sp);
        switch (cmd) {
          case 'HI':
            reply(`HELLO ${versionString}`, false); // NO trailing newline (quirk)
            return;
          case 'GETIP':
            reply(`YOURIP ${ip}`);
            return;
          case 'CAPABILITIES':
            // NO UPLOAD_STATS on the direct lane (upload is measured locally —
            // the bytes land at the edge, not here). See module header.
            reply('CAPABILITIES SERVER_HOST_AUTH', false); // NO trailing newline
            return;
          case 'PING':
            reply(`PONG ${Date.now()}`);
            return;
          case 'UPTIME':
            reply(`UPTIME ${Math.floor(process.uptime() * 1000)}`);
            return;
          case 'SERVERID':
            reply('SERVERID 00000000-0000-4000-8000-000000000001');
            return;
          case 'INITPLOSS':
            reply('OK');
            return;
          case 'PLOSS':
            reply('PLOSS 0 0 0');
            return;
          case 'UPLOAD_STATS':
            // not announced in CAPABILITIES — parity ERROR if asked anyway
            reply('ERROR');
            return;
          case 'DOWNLOAD': {
            const n = Number(line.slice(9).trim());
            if (!Number.isInteger(n) || n < 0 || n > 256 * 1024 * 1024) {
              reply('ERROR');
              return;
            }
            const payload = Buffer.alloc(n);
            for (let i = 0; i < n; i++) payload[i] = 0x20 + ((i * 31) % 96);
            if (n > 10) payload.write('DOWNLOAD ', 0, 'latin1');
            try {
              ws.send(payload);
              counters.webWsDlBytesOut = (counters.webWsDlBytesOut || 0) + n;
            } catch {
              /* socket closing */
            }
            return;
          }
          case 'QUIT':
            try { ws.close(1000, 'quit'); } catch { /* noop */ }
            return;
          default:
            reply('ERROR');
        }
      });
      ws.on('close', () => {
        counters.webWsSessionsClosed = (counters.webWsSessionsClosed || 0) + 1;
        log('web_ws_close', { ip });
      });
      ws.on('error', () => { /* logged via close */ });
    });
  });

  return wss;
}
