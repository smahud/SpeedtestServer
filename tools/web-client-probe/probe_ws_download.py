#!/usr/bin/env python3
"""Final ground-truth probe: WS DOWNLOAD reply framing + OK/upload/ping shapes on official server."""
import base64, os, socket, struct, time, uuid as uuidlib

HOST = "speedtest-sby.xl.co.id"

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

def connect():
    s = socket.create_connection((HOST, 8080), timeout=8)
    key = base64.b64encode(os.urandom(16)).decode()
    s.sendall((f"GET /ws HTTP/1.1\r\nHost: {HOST}:8080\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n"
               f"Sec-WebSocket-Key: {key}\r\nSec-WebSocket-Version: 13\r\nOrigin: https://www.speedtest.net\r\n"
               f"User-Agent: probe\r\n\r\n").encode())
    resp = b""
    while b"\r\n\r\n" not in resp:
        c = s.recv(4096)
        if not c: break
        resp += c
    assert b"101" in resp.split(b"\r\n")[0]
    return s

G = str(uuidlib.uuid4())
s = connect()
s.sendall(ws_frame(f"HI {G}".encode()))
print("HI ->", ws_read(s))
s.sendall(ws_frame(b"GETIP"))
print("GETIP ->", ws_read(s))
s.sendall(ws_frame(b"CAPABILITIES"))
print("CAPABILITIES ->", ws_read(s))
s.sendall(ws_frame(b"PING 123.456"))
r = ws_read(s); print("PING ->", r[0], repr(r[1]))
s.sendall(ws_frame(b"DOWNLOAD 100"))
r = ws_read(s)
print(f"DOWNLOAD 100 -> op={r[0]} len={len(r[1])} head={r[1][:12]!r} tail={r[1][-4:]!r}")
r2 = ws_read(s, 1.0)
print("  (next frame after DOWNLOAD):", None if r2 is None else (r2[0], repr(r2[1][:40])))
s.sendall(ws_frame(b"DOWNLOAD 0"))
r = ws_read(s)
print(f"DOWNLOAD 0 -> op={r[0]} len={len(r[1])} data={r[1]!r}" if r else "DOWNLOAD 0 -> none")
s.sendall(ws_frame(b"DOWNLOAD 250000"))
total = 0
frames = 0
first = None
t0 = time.perf_counter()
while time.perf_counter() - t0 < 5:
    r = ws_read(s, 2.0)
    if r is None: break
    if first is None: first = (r[0], r[1][:10], len(r[1]))
    total += len(r[1]); frames += 1
print(f"DOWNLOAD 250000 -> frames={frames} total_bytes={total} first_frame={first}")
s.close()
