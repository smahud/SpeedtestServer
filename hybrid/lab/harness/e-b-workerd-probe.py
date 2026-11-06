#!/usr/bin/env python3
"""
e-b-workerd-probe.py — Experiment E-B: the same NetGauge byte classes
against the LOCAL hybrid Worker (workerd via wrangler dev).

Compares three ingress paths on the Worker's origin:
  1. plain HTTP listener with `HI\n` (what a misdirected CLI would send)
  2. plain HTTP listener with a binary NetGauge-like frame
  3. the REAL web-lane path: HTTP GET / (valid) — and the WS upgrade that
     the conformance battery already proves works on /ws.

Evidence goes to e-b-workerd-probes.jsonl next to this script's output dir.
"""
import json
import socket
import sys
import time
import datetime

HOST = "127.0.0.1"
PORT = int(sys.argv[2]) if len(sys.argv) > 2 else 8790

PROBES = [
    ("netgauge_hi", b"HI\n"),
    ("netgauge_ping", b"PING 1\n"),
    ("netgauge_binary", bytes([0x17, 0x03, 0x03, 0x00, 0x25]) + bytes(range(0x20, 0x45))),
    ("http_get_root", b"GET / HTTP/1.1\r\nHost: localhost\r\nUser-Agent: probe\r\n\r\n"),
    ("http_get_hi", b"GET /hi HTTP/1.1\r\nHost: localhost\r\nUser-Agent: probe\r\n\r\n"),
    ("ws_upgrade_no_tls", b"GET /ws HTTP/1.1\r\nHost: localhost\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\nUser-Agent: probe\r\n\r\n"),
]


def fmt(data: bytes) -> dict:
    return {
        "len": len(data),
        "ascii": "".join(chr(b) if 32 <= b < 127 else "." for b in data[:200]),
    }


def probe(name: str, payload: bytes, timeout: float = 6.0) -> dict:
    rec = {"ts": datetime.datetime.now(datetime.timezone.utc).isoformat(), "target": f"{HOST}:{PORT}", "probe": name}
    t0 = time.monotonic()
    try:
        s = socket.create_connection((HOST, PORT), timeout=timeout)
        s.settimeout(timeout)
        s.sendall(payload)
        rec["sent"] = fmt(payload)
        chunks = []
        try:
            while sum(len(c) for c in chunks) < 4096:
                d = s.recv(4096)
                if not d:
                    rec["eof"] = True
                    break
                chunks.append(d)
                if b"\r\n\r\n" in b"".join(chunks):
                    break
        except socket.timeout:
            rec["recv_timeout"] = True
        except ConnectionResetError as e:
            rec["reset"] = str(e)
        rec["recv"] = fmt(b"".join(chunks))
        rec["total_ms"] = round((time.monotonic() - t0) * 1000, 1)
        s.close()
    except Exception as e:
        rec["error"] = f"{type(e).__name__}: {e}"
    return rec


def main():
    out_path = sys.argv[1] if len(sys.argv) > 1 else "e-b-workerd-probes.jsonl"
    with open(out_path, "w") as f:
        for name, payload in PROBES:
            rec = probe(name, payload)
            first = rec.get("recv", {}).get("ascii", "")[:70].replace("\r\n", "¶")
            print(f"{name:20} → {first or rec.get('error','')}")
            f.write(json.dumps(rec) + "\n")
            time.sleep(0.3)
    print(f"→ {out_path}")


if __name__ == "__main__":
    main()
