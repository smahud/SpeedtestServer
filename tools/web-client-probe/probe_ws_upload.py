#!/usr/bin/env python3
"""Ground-truth probe: WS upload raw frames + UPLOAD_STATS semantics on official servers."""
import base64, json, os, socket, struct, ssl, time

HOST = "speedtest-sby.xl.co.id"  # class A: plain WS accepted on :8080
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
        op = hdr[0] & 0x0F
        return (op, data)
    except socket.timeout:
        return None
    except Exception:
        return None

def connect(host=HOST, port=8080):
    s = socket.create_connection((host, port), timeout=8)
    key = base64.b64encode(os.urandom(16)).decode()
    s.sendall((f"GET /ws HTTP/1.1\r\nHost: {host}:{port}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n"
               f"Sec-WebSocket-Key: {key}\r\nSec-WebSocket-Version: 13\r\nOrigin: https://www.speedtest.net\r\n"
               f"User-Agent: {UA}\r\n\r\n").encode())
    resp = b""
    while b"\r\n\r\n" not in resp:
        c = s.recv(4096)
        if not c: break
        resp += c
    assert b"101" in resp.split(b"\r\n")[0], resp[:120]
    return s

def drain(sock, label, count=6, timeout=2.5):
    for _ in range(count):
        r = ws_read(sock, timeout)
        if r is None:
            print(f"      [{label}] (no more frames)")
            return
        op, data = r
        print(f"      [{label}] op={op} data={data[:110]!r}")

print("=== TEST 1: UPLOAD_STATS with no uploads (does it stream? what is b?) ===")
s = connect()
s.sendall(ws_frame(b"HI")); drain(s, "t1-hi", 2)
s.sendall(ws_frame(b"UPLOAD_STATS 1000 100 0"))
drain(s, "t1-stats", 6)
s.close()

print("\n=== TEST 2: raw WS upload frame ('UPLOAD ' + random bytes, no size) — reply? counted? ===")
s = connect()
s.sendall(ws_frame(b"HI")); drain(s, "t2-hi", 2)
payload = b"UPLOAD " + bytes((i * 13 + 30) % 100 + 20 for i in range(93))  # 100 bytes total
print(f"      sending binary frame {len(payload)}B starting with 'UPLOAD '")
s.sendall(ws_frame(payload, opcode=2))
drain(s, "t2-after-upload", 3, timeout=2)
# now check the stats counter sees it
s.sendall(ws_frame(b"UPLOAD_STATS 500 100 0"))
drain(s, "t2-stats", 5)
s.close()

print("\n=== TEST 3: raw WS upload frame with digits right after prefix (parse ambiguity) ===")
s = connect()
s.sendall(ws_frame(b"HI")); drain(s, "t3-hi", 2)
payload = b"UPLOAD 55" + bytes((i * 29 + 30) % 100 + 20 for i in range(41))  # starts 'UPLOAD 55' + junk
print(f"      sending {len(payload)}B frame 'UPLOAD 55'+junk")
s.sendall(ws_frame(payload, opcode=2))
drain(s, "t3-after", 3, timeout=2)
s.sendall(ws_frame(b"UPLOAD_STATS 400 100 0"))
drain(s, "t3-stats", 4)
s.close()

print("\n=== TEST 4: CLI-style UPLOAD <n> over WS ===")
s = connect()
s.sendall(ws_frame(b"HI")); drain(s, "t4-hi", 2)
s.sendall(ws_frame(b"UPLOAD 50"))
body = b"A" * 41  # command line 'UPLOAD 50\n' = 10 bytes, inclusive counting → 40 more needed
s.sendall(ws_frame(body, opcode=2))
drain(s, "t4-after", 3, timeout=2)
s.close()

print("\n=== TEST 5: multiple raw upload frames then stats (cumulative b) ===")
s = connect()
s.sendall(ws_frame(b"HI")); drain(s, "t5-hi", 2)
for k in range(3):
    payload = b"UPLOAD " + bytes((k * 7 + i * 13 + 30) % 100 + 20 for i in range(93))
    s.sendall(ws_frame(payload, opcode=2))
s.sendall(ws_frame(b"UPLOAD_STATS 600 200 0"))
drain(s, "t5-stats", 5)
s.close()
