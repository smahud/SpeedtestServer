#!/usr/bin/env python3
"""CLI-exhaust lab: what does the OFFICIAL Ookla CLI (1.2.0.84) do when
NetGauge is made to fail COMPLETELY, while a full Ookla HTTP surface (with
307 redirects to a Cloudflare Worker) is available on the same port?

Verdict driver for the operator question "can the CLI ever be pushed onto a
redirectable (HTTP) transport?" — prior sessions say NO (NetGauge-only);
this experiment re-verifies it first-hand from the network side.

Listener behavior on 127.0.0.1:8080 (plain TCP, first-byte dispatch):
  - TLS ClientHello (0x16 0x03...)  -> immediate close (kill the TLS path so
    the client must fall back to plaintext NetGauge)
  - HTTP method line                -> FULL Ookla web surface: /hello,
    /getip, /capabilities, /ping, 307 on /download & /upload -> the Worker
    (if the CLI EVER speaks HTTP, it gets a perfectly redirectable answer)
  - anything else (NetGauge)        -> ERROR to every line + 3-strikes close
Listeners on :80 :443 :5060 log any connection (does it retry other ports?).

Run inside an isolated namespace with mockhosts:
  speedtest.tuxsnet.id(.prod.hosts.ooklaserver.net) -> 127.0.0.1
  results.speedtest.net -> 127.0.0.1 (blackhole, non-publishing)
  cli.speedtest.net / www.speedtest.net stay AUTHENTIC.
"""
import socket, ssl, threading, sys, time, json

WORKER = 'https://speedtest-hybrid-worker-test.lumajangnetworks.workers.dev'
LOG = []

def log(kind, **kw):
    e = {'ts': time.time(), 'kind': kind, **kw}
    LOG.append(e)
    print(json.dumps(e)[:220], flush=True)

def http_response(code, reason, headers, body=b''):
    head = f'HTTP/1.1 {code} {reason}\r\n' + ''.join(f'{k}: {v}\r\n' for k, v in headers.items()) + '\r\n'
    return head.encode() + body

def serve_http(data, addr):
    """Serve the Ookla web surface for one HTTP request (already read)."""
    try:
        line = data.split(b'\r\n', 1)[0].decode('latin1')
        method, target = line.split(' ')[0], line.split(' ')[1]
    except Exception:
        return http_response(400, 'Bad Request', {'Content-Length': 0, 'Connection': 'close'})
    path = target.split('?')[0]
    o = f'http://{addr[0]}'  # no Origin in CLI, CORS irrelevant here
    hdrs = {'Content-Length': 0, 'Cache-Control': 'no-store', 'Connection': 'close'}
    if path in ('/hello', '/hi'):
        b = b'hello 2.11 (2.11.5) 2026-06-04.1737.7d0993d\n'
        return http_response(200, 'OK', {**hdrs, 'Content-Type': 'text/plain; charset=UTF-8', 'Content-Length': len(b)}, b)
    if path == '/getip':
        b = f'{addr[0]}\n'.encode()
        return http_response(200, 'OK', {**hdrs, 'Content-Type': 'text/plain; charset=UTF-8', 'Content-Length': len(b)}, b)
    if path == '/capabilities':
        b = b'capabilities SERVER_HOST_AUTH UPLOAD_STATS\n'
        return http_response(200, 'OK', {**hdrs, 'Content-Type': 'text/plain; charset=UTF-8', 'Content-Length': len(b)}, b)
    if path == '/ping':
        b = b'pong\n'
        return http_response(200, 'OK', {**hdrs, 'Content-Type': 'text/plain; charset=UTF-8', 'Content-Length': len(b)}, b)
    if path.startswith('/latency.txt'):
        return http_response(200, 'OK', {**hdrs, 'Content-Type': 'text/plain; charset=UTF-8'}, b'test=test\n')
    if path.startswith('/download'):
        log('HTTP_DOWNLOAD_REQUEST', method=method, target=target[:100])
        return http_response(307, 'Temporary Redirect', {**hdrs, 'Location': f'{WORKER}/download{target.split("?",1)[1] if "?" in target else ""}'})
    if path.startswith('/upload'):
        log('HTTP_UPLOAD_REQUEST', method=method, target=target[:100])
        return http_response(307, 'Temporary Redirect', {**hdrs, 'Location': WORKER + '/upload'})
    if 'random' in path and '.jpg' in path:
        log('HTTP_LEGACY_JPEG_REQUEST', target=target[:100])
        return http_response(307, 'Temporary Redirect', {**hdrs, 'Location': WORKER + '/download?size=245388'})
    return http_response(404, 'Not Found', hdrs)

def handle_8080(conn, addr):
    conn.settimeout(60)
    try:
        data = conn.recv(4096)
        if not data:
            log('tcp_empty_close', peer=addr[0])
            return
        first2 = data[:2]
        # TLS ClientHello -> kill (force plaintext fallback)
        if first2 == b'\x16\x03':
            log('tls_clienthello_REJECTED', peer=addr[0], hello=len(data))
            conn.close()
            return
        # HTTP method?
        first_line = data.split(b'\r\n', 1)[0].decode('latin1', 'replace')
        words = first_line.split(' ')
        if len(words) >= 2 and words[0] in ('GET', 'POST', 'HEAD', 'OPTIONS', 'PUT', 'DELETE', 'PATCH'):
            log('HTTP_REQUEST', method=words[0], target=words[1][:100], peer=addr[0])
            conn.sendall(serve_http(data, addr))
            conn.close()
            return
        # NetGauge plaintext -> ERROR to every line, 3-strikes close
        log('netgauge_conn', peer=addr[0], first_bytes=data[:40].hex())
        errors = 0
        buf = data
        while True:
            for line in buf.split(b'\n'):
                if line.strip():
                    log('ng_line', line=line.decode('latin1', 'replace')[:60])
                    conn.sendall(b'ERROR\n')
                    errors += 1
                    if errors >= 3:
                        conn.close()
                        return
            more = conn.recv(65536)
            if not more:
                return
            buf = more
    except Exception as e:
        log('handler_err', err=str(e)[:80])
    finally:
        try: conn.close()
        except Exception: pass

def logger_port(port):
    s = socket.socket()
    s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    try:
        s.bind(('127.0.0.1', port)); s.listen(16)
    except Exception as e:
        log('log_listener_bind_failed', port=port, err=str(e)[:60]); return
    while True:
        c, a = s.accept()
        log('probe_connection', port=port, peer=a[0])
        try: c.recv(1024)
        except Exception: pass
        try: c.close()
        except Exception: pass

if __name__ == '__main__':
    for p in (80, 443, 5060):
        threading.Thread(target=logger_port, args=(p,), daemon=True).start()
    srv = socket.socket()
    srv.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    srv.bind(('127.0.0.1', 8080)); srv.listen(64)
    log('rejector_listening', port=8080)
    while True:
        c, a = srv.accept()
        threading.Thread(target=handle_8080, args=(c, a), daemon=True).start()
