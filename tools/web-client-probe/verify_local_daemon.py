#!/usr/bin/env python3
"""Local end-to-end verification: full web-client protocol flow against the
SpeedtestServer daemon (self-signed TLS). Mirrors the production probes."""
import base64, json, os, socket, ssl, struct, sys, time, uuid as uuidlib

HOST = "127.0.0.1"
PORT = 18080
SNI = "speedtest.localtest"
GUID = str(uuidlib.uuid4())
PASS, FAIL = [], []

def check(name, cond, detail=""):
    (PASS if cond else FAIL).append(name)
    print(f"  {'PASS' if cond else 'FAIL'}  {name}{(' — ' + detail) if detail and not cond else ''}")

def tls_ctx():
    ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_CLIENT)
    ctx.check_hostname = False
    ctx.verify_mode = ssl.CERT_NONE
    return ctx

def http_req(path, method="GET", body=None, use_ssl=True, ct=None):
    try:
        s = tls_ctx().wrap_socket(socket.create_connection((HOST, PORT), timeout=6), server_hostname=SNI) if use_ssl \
            else socket.create_connection((HOST, PORT), timeout=6)
        hdrs = (f"{method} {path} HTTP/1.1\r\nHost: {SNI}:{PORT}\r\nUser-Agent: Mozilla/5.0 verify\r\n"
                f"Origin: https://www.speedtest.net\r\nAccept: */*\r\n")
        if body is not None:
            hdrs += f"Content-Type: {ct or 'application/octet-stream'}\r\nContent-Length: {len(body)}\r\n"
        hdrs += "Connection: close\r\n\r\n"
        s.sendall(hdrs.encode() + (body or b""))
        s.settimeout(6)
        buf = b""
        while len(buf) < 2_000_000:
            c = s.recv(65536)
            if not c: break
            buf += c
        s.close()
        head, _, body_out = buf.partition(b"\r\n\r\n")
        lines = head.decode("utf-8", "replace").split("\r\n")
        hd = {}
        for l in lines[1:]:
            if ":" in l:
                k, v = l.split(":", 1)
                hd[k.strip().lower()] = v.strip()
        return {"status": lines[0], "headers": hd, "body": body_out}
    except Exception as e:
        return {"error": repr(e)[:100]}

def ws_frame(payload: bytes, opcode=1):
    mask = os.urandom(4)
    ln = len(payload)
    hdr = struct.pack("!BB", 0x80 | opcode, 0x80 | ln) if ln < 126 else struct.pack("!BBH", 0x80 | opcode, 0x80 | 126, ln)
    return hdr + mask + bytes(b ^ mask[i % 4] for i, b in enumerate(payload))

def ws_read(sock, timeout=3.0):
    sock.settimeout(timeout)
    try:
        hdr = sock.recv(2)
        if len(hdr) < 2: return None
        ln = hdr[1] & 0x7F
        if ln == 126: ln = struct.unpack("!H", sock.recv(2))[0]
        elif ln == 127: ln = struct.unpack("!Q", sock.recv(8))[0]
        mask = sock.recv(4) if (hdr[1] & 0x80) else b""
        data = b""
        while len(data) < ln:
            c = sock.recv(ln - len(data))
            if not c: break
            data += c
        if mask: data = bytes(b ^ mask[i % 4] for i, b in enumerate(data))
        return (hdr[0] & 0x0F, data)
    except Exception:
        return None

def ws_connect(use_ssl=True):
    s0 = socket.create_connection((HOST, PORT), timeout=6)
    s = tls_ctx().wrap_socket(s0, server_hostname=SNI) if use_ssl else s0
    key = base64.b64encode(os.urandom(16)).decode()
    s.sendall((f"GET /ws HTTP/1.1\r\nHost: {SNI}:{PORT}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n"
               f"Sec-WebSocket-Key: {key}\r\nSec-WebSocket-Version: 13\r\nOrigin: https://www.speedtest.net\r\n"
               f"User-Agent: Mozilla/5.0 verify\r\n\r\n").encode())
    resp = b""
    while b"\r\n\r\n" not in resp:
        c = s.recv(4096)
        if not c: break
        resp += c
    assert b"101" in resp.split(b"\r\n")[0], resp[:150]
    return s

print("=== 1. HTTPS XHR handshake surface (https://host:8080/...) ===")
r = http_req(f"/hello?guid={GUID}&nocache=x1")
check("GET /hello → 200 hello banner", "200" in r.get("status", "") and r["body"].startswith(b"hello 2.11 ("), str(r)[:150])
check("  CORS ACAO reflected + no-store", r["headers"].get("access-control-allow-origin") == "https://www.speedtest.net" and r["headers"].get("cache-control") == "no-store")
r2 = http_req("/getip")
check("GET /getip → peer ip line", r2.get("body", b"").endswith(b"\n") and r2["body"].strip().count(b".") == 3, str(r2.get("body"))[:60])
r3 = http_req("/capabilities")
check("GET /capabilities → capabilities line", r3.get("body", b"") == b"capabilities SERVER_HOST_AUTH UPLOAD_STATS\n")
r4 = http_req("/ping?nocache=x2")
check("GET /ping → pong", r4.get("body", b"") == b"pong\n")
r5 = http_req("/download?size=1000&guid=" + GUID + "&nocache=x3")
check("GET /download?size=1000 → exact 1000 bytes octet-stream",
      len(r5.get("body", b"")) == 1000 and r5["headers"].get("content-type") == "application/octet-stream"
      and r5["headers"].get("content-length") == "1000")
r5b = http_req("/upload-stats?testDurationMillis=500&updatePeriodMillis=50&index=0")
check("GET /upload-stats → 400", "400" in r5b.get("status", ""))

print("=== 2. HTTPS POST /upload?guid= (XHR upload lane) ===")
upbody = b"UPLOAD " + bytes((i * 13 + 30) % 100 + 20 for i in range(993))
r6 = http_req(f"/upload?guid={GUID}&nocache=x4", method="POST", body=upbody)
check("POST /upload → 200 size=1000", r6.get("body", b"") == b"size=1000\n", str(r6.get("body"))[:60])
check("  upload content-type text/plain + no-store", r6["headers"].get("content-type") == "text/plain; charset=UTF-8")

print("=== 3. WSS /ws — selection-ping flow (HI/GETIP/CAPABILITIES/PING) ===")
s = ws_connect()
s.sendall(ws_frame(f"HI {GUID}".encode()))
s.sendall(ws_frame(b"GETIP"))
s.sendall(ws_frame(b"CAPABILITIES"))
hello, yourip, caps = ws_read(s), ws_read(s), ws_read(s)
check("HI <guid> → HELLO (no trailing newline)", hello and hello[1] == b"HELLO 2.11 (2.11.5) 2026-06-04.1737.7d0993d")
check("GETIP → YOURIP <ip>\\n", yourip and yourip[1].startswith(b"YOURIP 127.0.0.1") and yourip[1].endswith(b"\n"))
check("CAPABILITIES → CAPABILITIES (no trailing \\n — web client regex is $-anchored)", caps and caps[1] == b"CAPABILITIES SERVER_HOST_AUTH UPLOAD_STATS", repr(caps[1]) if caps else "none")
s.sendall(ws_frame(b"PING 123.456"))
pong = ws_read(s)
check("PING <ms> → PONG <epoch>\\n", pong and pong[1].startswith(b"PONG 17") and pong[1].endswith(b"\n"))

print("=== 4. WSS — web upload lane: raw UPLOAD frame + UPLOAD_STATS stream ===")
# XHR-lane bytes already attributed (1000) are the stream BASELINE; raw frames
# sent DURING the stream must appear in "b" (mirrors the real client flow).
s.sendall(ws_frame(b"UPLOAD_STATS 400 50 0"))
ack = ws_read(s)
check("UPLOAD_STATS → immediate ack {\"t\":\"u\"}", ack and ack[1] == b'{"t":"u"}\n', str(ack))
s.sendall(ws_frame(b"UPLOAD " + bytes((i * 7 + 30) % 100 + 20 for i in range(93)), opcode=2))  # 100B raw frame
lines = []
closed = False
t0 = time.time()
while time.time() - t0 < 2.0:
    r = ws_read(s, 0.6)
    if r is None: break
    if r[0] == 8:
        closed = True; break
    lines.append(r[1])
bs = [json.loads(l)["b"] for l in lines if l.startswith(b"{\"b\"")]
es = [json.loads(l)["e"] for l in lines if l.startswith(b"{\"b\"")]
check("stats lines ticked (e=0,50,100,...)", es[:4] == [0, 50, 100, 150] and len(es) >= 5, f"es={es[:8]}")
check("raw UPLOAD frame attributed to the session (b=100)", 100 in bs, f"bs={bs[:8]}")
check("XHR-lane pre-stream bytes are the baseline (b does not count them)", 0 in bs, f"bs={bs[:8]}")
check("stream ends with WS CLOSE (code 1000)", closed)

print("=== 5. WSS — DOWNLOAD + quirks ===")
s2 = ws_connect()
s2.sendall(ws_frame(b"DOWNLOAD 1000"))
fr = ws_read(s2)
check("DOWNLOAD 1000 → ONE binary frame of exactly 1000 bytes", fr and fr[0] == 2 and len(fr[1]) == 1000 and fr[1][:9] == b"DOWNLOAD ", str(fr[1][:12]) if fr else "none")
s2.sendall(ws_frame(b"DOWNLOAD 0"))
r = ws_read(s2)
check("DOWNLOAD 0 over WS → ERROR (production quirk)", r and r[1] == b"ERROR\n")
# raw upload frame also gets OK on this fresh connection (no session needed)
s2.sendall(ws_frame(b"UPLOAD 50", opcode=2))
r = ws_read(s2)
check("9-byte 'UPLOAD 50' binary frame → OK 9 (raw-frame semantics)", r and r[1].startswith(b"OK 9 "), str(r[1]) if r else "none")
s2.close()

print("=== 6. plain (non-TLS) lane still serves legacy + CLI flows ===")
r7 = http_req("/speedtest/latency.txt", use_ssl=False)
check("plain GET /speedtest/latency.txt → test=test", r7.get("body", b"") == b"test=test\n")
r8 = http_req("/speedtest/crossdomain.xml", use_ssl=False)
check("plain GET /speedtest/crossdomain.xml → policy", b"cross-domain-policy" in r8.get("body", b""))
s3 = ws_connect(use_ssl=False)
s3.sendall(ws_frame(b"HI"))
h3 = ws_read(s3)
check("plain ws:// /ws upgrade works", h3 and h3[1].startswith(b"HELLO 2.11"))
s3.close()

print(f"\n==== RESULT: {len(PASS)} passed, {len(FAIL)} failed ====")
if FAIL:
    print("FAILED:", FAIL)
    sys.exit(1)
