#!/usr/bin/env python3
"""Matrix probe: which UPLOAD_STATS forms stream vs close, with precise timing."""
import base64, os, socket, struct, time, uuid as uuidlib

HOST = "speedtest-sby.xl.co.id"
UA = "Mozilla/5.0 probe"

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
        mask = b""
        if hdr[1] & 0x80:
            mask = sock.recv(4)
        data = b""
        while len(data) < ln:
            c = sock.recv(ln - len(data))
            if not c: break
            data += c
        if mask: data = bytes(b ^ mask[i % 4] for i, b in enumerate(data))
        return (hdr[0] & 0x0F, data)
    except Exception:
        return None

def connect():
    s = socket.create_connection((HOST, 8080), timeout=8)
    key = base64.b64encode(os.urandom(16)).decode()
    s.sendall((f"GET /ws HTTP/1.1\r\nHost: {HOST}:8080\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n"
               f"Sec-WebSocket-Key: {key}\r\nSec-WebSocket-Version: 13\r\nOrigin: https://www.speedtest.net\r\n"
               f"User-Agent: {UA}\r\n\r\n").encode())
    resp = b""
    while b"\r\n\r\n" not in resp:
        c = s.recv(4096)
        if not c: break
        resp += c
    assert b"101" in resp.split(b"\r\n")[0]
    return s

def trial(cmd_bytes, label, max_frames=6, read_timeout=2.0, uploads_before=0, hold_secs=0.0):
    G = str(uuidlib.uuid4())
    s = connect()
    s.sendall(ws_frame(f"HI {G}".encode()))
    ws_read(s)
    for k in range(uploads_before):
        payload = b"UPLOAD " + bytes((k * 7 + i * 13 + 30) % 100 + 20 for i in range(93))
        s.sendall(ws_frame(payload, opcode=2))
    t0 = time.perf_counter()
    s.sendall(ws_frame(cmd_bytes))
    seen = []
    for _ in range(max_frames):
        r = ws_read(s, read_timeout)
        if r is None: break
        op, data = r
        at = (time.perf_counter() - t0) * 1000
        seen.append((at, op, data))
    print(f"  [{label}] cmd={cmd_bytes.decode()!r} uploads_before={uploads_before}")
    for at, op, data in seen:
        kind = "CLOSE" if op == 8 else ("ACK" if data == b'{"t":"u"}\n' else "line")
        print(f"      +{at:7.1f}ms {kind:<6} {data[:70]!r}")
    s.close()

# the exact real-client form
trial(b"UPLOAD_STATS 15000 50 0", "real-client form", max_frames=8, read_timeout=0.9)
# duration variants at interval 50
trial(b"UPLOAD_STATS 1500 50 0", "dur1500 int50", max_frames=8, read_timeout=0.7)
trial(b"UPLOAD_STATS 1000 50 0", "dur1000 int50", max_frames=6, read_timeout=0.7)
# interval variants at duration 1000
trial(b"UPLOAD_STATS 1000 250 0", "dur1000 int250", max_frames=6, read_timeout=0.8)
# uploads before the command with the failing form
trial(b"UPLOAD_STATS 1500 250 0", "dur1500 int250 +uploads", uploads_before=3, max_frames=8, read_timeout=0.8)
