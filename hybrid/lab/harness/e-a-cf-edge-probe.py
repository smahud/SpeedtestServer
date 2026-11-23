#!/usr/bin/env python3
"""
e-a-cf-edge-probe.py — Experiment E-A: what does the REAL Cloudflare edge do
with Ookla NetGauge bytes?

Probes (tiny, read-only, browser-scale traffic — platform characterization):
  1. TCP connect + plaintext NetGauge hello  `HI\n`            (the protocol
     the official CLI's measurement connections speak after fallback)
  2. TCP connect + a binary NetGauge-like frame (the class of bytes the
     CLI's encrypted hello produces — non-HTTP binary)
  3. A valid HTTP/1.1 GET for reference (confirms the port IS an HTTP
     listener and shows the normal edge answer)
  4. A WebSocket-upgrade-shaped HTTP request on /ws (what a WSS client
     would send after TLS — here plaintext, to characterize the listener)

Targets: speed.cloudflare.com (Cloudflare's own Worker-served speed test)
and cli.speedtest.net (Ookla's own CF-fronted API host), ports 8080 (HTTP
ingress) and 443 (TLS ingress).

Evidence: JSONL per probe with raw request/response bytes (hex+ascii),
timing, and the classification the CLI would observe.
"""
import json
import socket
import sys
import time
import datetime

TARGETS = [
    ("speed.cloudflare.com", 8080),
    ("speed.cloudflare.com", 443),
    ("cli.speedtest.net", 8080),
    ("cli.speedtest.net", 443),
]

PROBES = [
    ("netgauge_hi", b"HI\n"),
    ("netgauge_binary", bytes([0x17, 0x03, 0x03, 0x00, 0x25]) + bytes(range(0x20, 0x45))),  # TLS-record-shaped binary, NOT valid TLS
    ("http_get", b"GET / HTTP/1.1\r\nHost: {host}\r\nUser-Agent: probe\r\n\r\n"),
    ("ws_upgrade", b"GET /ws HTTP/1.1\r\nHost: {host}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\nUser-Agent: probe\r\n\r\n"),
]


def fmt(data: bytes) -> dict:
    return {
        "len": len(data),
        "hex": data[:160].hex(),
        "ascii": "".join(chr(b) if 32 <= b < 127 else "." for b in data[:160]),
    }


def probe(host: str, port: int, name: str, payload: bytes, timeout: float = 8.0) -> dict:
    rec = {
        "ts": datetime.datetime.now(datetime.timezone.utc).isoformat(),
        "target": f"{host}:{port}",
        "probe": name,
    }
    t0 = time.monotonic()
    try:
        s = socket.create_connection((host, port), timeout=timeout)
        s.settimeout(timeout)
        rec["connect_ms"] = round((time.monotonic() - t0) * 1000, 1)
        rec["ip"] = s.getpeername()[0]
        if payload:
            s.sendall(payload)
            rec["sent"] = fmt(payload)
        chunks = []
        total = 0
        try:
            while total < 2048:
                d = s.recv(2048 - total)
                if not d:
                    rec["eof"] = True
                    break
                chunks.append(d)
                total += len(d)
                # stop early once we have a full HTTP-looking response
                if b"\r\n\r\n" in b"".join(chunks):
                    break
        except socket.timeout:
            rec["recv_timeout"] = True
        except ConnectionResetError as e:
            rec["reset"] = str(e)
        except OSError as e:
            rec["oserror"] = str(e)
        rec["recv"] = fmt(b"".join(chunks))
        rec["total_ms"] = round((time.monotonic() - t0) * 1000, 1)
        s.close()
    except Exception as e:
        rec["error"] = f"{type(e).__name__}: {e}"
        rec["total_ms"] = round((time.monotonic() - t0) * 1000, 1)
    return rec


def classify(rec: dict) -> str:
    """What the official CLI's connection layer would conclude."""
    if rec.get("error"):
        return "CONNECT-FAIL"
    r = rec.get("recv", {}).get("ascii", "")
    if rec.get("reset"):
        return "TCP-RESET"
    if rec.get("recv_timeout") or (rec.get("recv", {}).get("len") == 0 and not rec.get("eof")):
        return "SILENT"
    if r.startswith("HTTP/"):
        return "HTTP-RESPONSE"
    if "HELLO" in r:
        return "NETGAUGE-HELLO"
    return "OTHER-BYTES"


def main():
    out_path = sys.argv[1] if len(sys.argv) > 1 else "e-a-cf-edge-probes.jsonl"
    n = 0
    with open(out_path, "w") as f:
        for host, port in TARGETS:
            for name, payload in PROBES:
                p = payload.replace(b"{host}", host.encode())
                rec = probe(host, port, name, p)
                rec["classification"] = classify(rec)
                f.write(json.dumps(rec) + "\n")
                f.flush()
                n += 1
                cls = rec["classification"]
                detail = rec.get("recv", {}).get("ascii", "")[:60].replace("\r\n", "¶")
                err = rec.get("error", "")
                print(f"{rec['target']:28} {name:16} → {cls:14} {err or detail}")
                time.sleep(0.7)  # be gentle
    print(f"\n{n} probes → {out_path}")


if __name__ == "__main__":
    main()
