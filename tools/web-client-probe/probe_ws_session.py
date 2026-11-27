#!/usr/bin/env python3
"""Decisive probe: session-guid binding for UPLOAD_STATS + cross-transport upload accounting."""
import base64, os, socket, struct, time, uuid as uuidlib

HOSTS = ["speedtest-sby.xl.co.id", "speedtest.tuxsnet.id.prod.hosts.ooklaserver.net"]
UA = "Mozilla/5.0 probe"

def ws_frame(payload: bytes, opcode=1):
    mask = os.urandom(4)
    ln = len(payload)
    if ln < 126:
        hdr = struct.pack("!BB", 0x80 | opcode, 0x80 | ln)
    elif ln < 65536:
        hdr = struct.pack("!BBH", 0x80 | opcode, 0x80 | 126, ln)
    else:
        hdr = struct.pack("!BBQ", 0x80 | opcode, 0x80 | 127, ln)
    return hdr + mask + bytes(b ^ mask[i % 4] for i, b in enumerate(payload))

def ws_read(sock, timeout=4):
    sock.settimeout(timeout)
    try:
        hdr = sock.recv(2)
        if len(hdr) < 2: return None
        ln = hdr[1] & 0x7F
        masked = bool(hdr[1] & 0x80)
        if ln == 126: ln = struct.unpack("!H", sock.recv(2))[0]
        elif ln == 127: ln = struct.unpack("!Q", sock.recv(8))[0]
        mask = sock.recv(4) if masked else b""
        data = b""
        while len(data) < ln:
            c = sock.recv(ln - len(data))
            if not c: break
            data += c
        if masked: data = bytes(b ^ mask[i % 4] for i, b in enumerate(data))
        return (hdr[0] & 0x0F, data)
    except Exception:
        return None

def connect(host):
    s = socket.create_connection((host, 8080), timeout=8)
    key = base64.b64encode(os.urandom(16)).decode()
    s.sendall((f"GET /ws HTTP/1.1\r\nHost: {host}:8080\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n"
               f"Sec-WebSocket-Key: {key}\r\nSec-WebSocket-Version: 13\r\nOrigin: https://www.speedtest.net\r\n"
               f"User-Agent: {UA}\r\n\r\n").encode())
    resp = b""
    while b"\r\n\r\n" not in resp:
        c = s.recv(4096)
        if not c: break
        resp += c
    assert b"101" in resp.split(b"\r\n")[0], resp[:120]
    return s

def drain(sock, label, count=8, timeout=2.2):
    out = []
    for _ in range(count):
        r = ws_read(sock, timeout)
        if r is None: break
        out.append(r[1])
        print(f"      [{label}] op={r[0]} {r[1][:100]!r}")
    return out

def http_upload(host, guid, size=1000):
    s = socket.create_connection((host, 8080), timeout=8)
    data = b"UPLOAD " + bytes((i * 7 + 30) % 100 + 20 for i in range(size - 7))
    req = (f"POST /upload?nocache=probe&guid={guid} HTTP/1.1\r\nHost: {host}:8080\r\nUser-Agent: {UA}\r\n"
           f"Origin: https://www.speedtest.net\r\nContent-Type: application/octet-stream\r\n"
           f"Content-Length: {len(data)}\r\nConnection: close\r\n\r\n")
    s.sendall(req.encode() + data)
    buf = b""
    while True:
        try:
            c = s.recv(65536)
        except socket.timeout:
            break
        if not c: break
        buf += c
    s.close()
    return buf.split(b"\r\n")[0].decode(), buf.split(b"\r\n\r\n", 1)[1][:40]

for HOST in HOSTS:
    G = str(uuidlib.uuid4())
    print(f"\n########## {HOST}  guid={G} ##########")
    print("--- A: HI <guid> then UPLOAD_STATS (session-bound?) ---")
    s = connect(HOST)
    s.sendall(ws_frame(f"HI {G}".encode()))
    drain(s, "a-hi", 2)
    s.sendall(ws_frame(b"UPLOAD_STATS 1200 200 0"))
    drain(s, "a-stats", 6)
    s.close()

    print("--- B: WS raw upload frames (session) then UPLOAD_STATS on same conn ---")
    s = connect(HOST)
    s.sendall(ws_frame(f"HI {G}".encode()))
    drain(s, "b-hi", 2)
    for k in range(3):
        payload = b"UPLOAD " + bytes((k * 7 + i * 13 + 30) % 100 + 20 for i in range(93))
        s.sendall(ws_frame(payload, opcode=2))
    drain(s, "b-uploads", 4)
    s.sendall(ws_frame(b"UPLOAD_STATS 1000 200 0"))
    drain(s, "b-stats", 6)
    s.close()

    print("--- C: HTTP POST /upload?guid= then WS UPLOAD_STATS (cross-transport binding) ---")
    st, body = http_upload(HOST, G, 1000)
    print(f"      http upload -> {st} {body!r}")
    st2, body2 = http_upload(HOST, G, 2000)
    print(f"      http upload -> {st2} {body2!r}")
    s = connect(HOST)
    s.sendall(ws_frame(f"HI {G}".encode()))
    drain(s, "c-hi", 2)
    s.sendall(ws_frame(b"UPLOAD_STATS 1000 200 0"))
    drain(s, "c-stats", 6)
    s.close()

    print("--- D: UPLOAD_STATS argless & 2-arg forms (after HI <guid>) ---")
    s = connect(HOST)
    s.sendall(ws_frame(f"HI {G}".encode()))
    drain(s, "d-hi", 2)
    s.sendall(ws_frame(b"UPLOAD_STATS"))
    drain(s, "d-argless", 2)
    s.sendall(ws_frame(b"UPLOAD_STATS 500 100"))
    drain(s, "d-2arg", 2)
    s.close()
