#!/usr/bin/env python3
"""Direct protocol probe against the 10 Surabaya speedtest targets.

Implements the exact client behaviors reconstructed from the speedtest.net web
client (index-CUbMX1WR.js, SDK 3.1.3):
  - XHR transport: GET /hello?guid=..&nocache=.., /getip, /capabilities, /ping,
    /download?size=.., POST /upload (octet-stream), GET /upload-stats
  - Legacy: GET /speedtest/latency.txt, /speedtest/crossdomain.xml, /speedtest/upload.php
  - WS transport: ws(s)://host:8080/ws -> HI/GETIP/CAPABILITIES/PING <ts>
Per server: DNS, port scan, TLS info, timing. Results -> JSON.
"""
import base64, json, os, socket, ssl, struct, sys, time, hashlib

OUT = "/home/z/my-project/work/server_probes"
os.makedirs(OUT, exist_ok=True)

SERVERS = [
    (74964, "somedigit.net", "speedtest.somedigit.net", None, "103.134.66.6"),
    (61853, "PT XLSMART Telecom Sejahtera", "speedtest-sby.xl.co.id", None, None),
    (62314, "PT. Pratama Hasta Utama Solusindo", "speedtest.patas.id", None, "103.1.51.67"),
    (66281, "PT. Tuxsindo Cyber Networks", "speedtest.tuxsnet.id", "speedtest.tuxsnet.id.prod.hosts.ooklaserver.net", "160.25.58.7"),
    (65429, "Atharva", "ookla.sub.atharva.co.id", "ookla.sub.atharva.co.id.prod.hosts.ooklaserver.net", None),
    (68214, "PT. ERA NETWORK INDONESIA", "speedtest.era.net.id", None, "157.20.239.243"),
    (73025, "LINTAS MEDIA SOLUSINDO", "speedtest2.lintasmediasolusindo.com", "speedtest2.lintasmediasolusindo.com.prod.hosts.ooklaserver.net", None),
    (72945, "BLiP Integrator Provider", "ookla-sby.blip.co.id", None, None),
    (48532, "Faznet", "v137170.faznet.co.id", None, "103.111.137.170"),
    (55749, "RingNet", "sby.speedtest.ring.net.id", "sby.speedtest.ring.net.id.prod.hosts.ooklaserver.net", None),
]

GUID = "5d016376-1911-47e9-ac4c-8f7ed2c80fd5"  # from the captured run
UA = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36"


def resolve(host):
    out = {"ipv4": [], "ipv6": []}
    try:
        for fam, _, _, _, sa in socket.getaddrinfo(host, None):
            ip = sa[0]
            if ":" in ip and ip not in out["ipv6"]:
                out["ipv6"].append(ip)
            elif ip not in out["ipv4"]:
                out["ipv4"].append(ip)
    except Exception as e:
        out["error"] = repr(e)
    return out


def tcp_probe(host, port, timeout=4):
    t0 = time.perf_counter()
    try:
        s = socket.create_connection((host, port), timeout=timeout)
        dt = (time.perf_counter() - t0) * 1000
        s.close()
        return {"ok": True, "connect_ms": round(dt, 2)}
    except Exception as e:
        return {"ok": False, "error": repr(e)}


def http_get(host, port, path, use_ssl=False, timeout=6, read_body=True, method="GET"):
    """Raw HTTP request with Origin header like the browser."""
    t0 = time.perf_counter()
    try:
        if use_ssl:
            ctx = ssl.create_default_context()
            s = ctx.wrap_socket(socket.create_connection((host, port), timeout=timeout), server_hostname=host)
        else:
            s = socket.create_connection((host, port), timeout=timeout)
        req = (f"{method} {path} HTTP/1.1\r\nHost: {host}:{port}\r\n"
               f"Origin: https://www.speedtest.net\r\nUser-Agent: {UA}\r\n"
               f"Accept: */*\r\nConnection: close\r\n\r\n")
        s.sendall(req.encode())
        s.settimeout(timeout)
        buf = b""
        while len(buf) < 65536:
            try:
                chunk = s.recv(65536)
            except socket.timeout:
                break
            if not chunk:
                break
            buf += chunk
        s.close()
        dt = (time.perf_counter() - t0) * 1000
        head, _, body = buf.partition(b"\r\n\r\n")
        lines = head.decode("utf-8", "replace").split("\r\n")
        status = lines[0] if lines else ""
        headers = {}
        for ln in lines[1:]:
            if ":" in ln:
                k, v = ln.split(":", 1)
                headers[k.strip().lower()] = v.strip()
        return {"ok": True, "status": status, "headers": headers,
                "body_text": body[:200].decode("utf-8", "replace") if read_body else None,
                "body_len": len(body), "total_ms": round(dt, 2)}
    except Exception as e:
        return {"ok": False, "error": repr(e)}


def http_post_upload(host, port, use_ssl=False, size=1024, timeout=8):
    t0 = time.perf_counter()
    try:
        if use_ssl:
            ctx = ssl.create_default_context()
            s = ctx.wrap_socket(socket.create_connection((host, port), timeout=timeout), server_hostname=host)
        else:
            s = socket.create_connection((host, port), timeout=timeout)
        # payload identical in spirit to the client: "UPLOAD " + bytes in [20,120)
        data = b"UPLOAD " + bytes((i * 7 + 30) % 100 + 20 for i in range(size - 7))
        path = f"/upload?nocache=probe&guid={GUID}"
        req = (f"POST {path} HTTP/1.1\r\nHost: {host}:{port}\r\n"
               f"Origin: https://www.speedtest.net\r\nUser-Agent: {UA}\r\n"
               f"Content-Type: application/octet-stream\r\nContent-Length: {len(data)}\r\nConnection: close\r\n\r\n")
        s.sendall(req.encode() + data)
        s.settimeout(timeout)
        buf = b""
        while True:
            try:
                chunk = s.recv(65536)
            except socket.timeout:
                break
            if not chunk:
                break
            buf += chunk
        s.close()
        dt = (time.perf_counter() - t0) * 1000
        head, _, body = buf.partition(b"\r\n\r\n")
        lines = head.decode("utf-8", "replace").split("\r\n")
        return {"ok": True, "status": lines[0] if lines else "",
                "body": body[:200].decode("utf-8", "replace"), "body_len": len(body),
                "sent_bytes": len(data), "total_ms": round(dt, 2)}
    except Exception as e:
        return {"ok": False, "error": repr(e)}


# ---- minimal websocket client (masked text frames) ----
def ws_frame(payload: bytes, opcode=1):
    mask = os.urandom(4)
    length = len(payload)
    if length < 126:
        hdr = struct.pack("!BB", 0x80 | opcode, 0x80 | length)
    elif length < 65536:
        hdr = struct.pack("!BBH", 0x80 | opcode, 0x80 | 126, length)
    else:
        hdr = struct.pack("!BBQ", 0x80 | opcode, 0x80 | 127, length)
    masked = bytes(b ^ mask[i % 4] for i, b in enumerate(payload))
    return hdr + mask + masked


def ws_read(sock, timeout=5):
    """Read one WS frame (server->client, unmasked)."""
    sock.settimeout(timeout)
    try:
        hdr = sock.recv(2)
        if len(hdr) < 2:
            return None
        fin_op = hdr[0]
        ln = hdr[1] & 0x7F
        masked = bool(hdr[1] & 0x80)
        if ln == 126:
            ln = struct.unpack("!H", sock.recv(2))[0]
        elif ln == 127:
            ln = struct.unpack("!Q", sock.recv(8))[0]
        mask = sock.recv(4) if masked else b""
        data = b""
        while len(data) < ln:
            chunk = sock.recv(ln - len(data))
            if not chunk:
                break
            data += chunk
        if masked:
            data = bytes(b ^ mask[i % 4] for i, b in enumerate(data))
        return {"opcode": fin_op & 0x0F, "text": data.decode("utf-8", "replace") if (fin_op & 0x0F) == 1 else None,
                "raw": data[:60]}
    except socket.timeout:
        return None
    except Exception:
        return None


def ws_probe(host, port, use_ssl, path="/ws", timeout=6):
    """Full WS handshake + HI/GETIP/CAPABILITIES/PING sequence with timings."""
    res = {"url": f"{'wss' if use_ssl else 'ws'}://{host}:{port}{path}"}
    t0 = time.perf_counter()
    try:
        if use_ssl:
            ctx = ssl.create_default_context()
            sock = ctx.wrap_socket(socket.create_connection((host, port), timeout=timeout), server_hostname=host)
        else:
            sock = socket.create_connection((host, port), timeout=timeout)
        key = base64.b64encode(os.urandom(16)).decode()
        req = (f"GET {path} HTTP/1.1\r\nHost: {host}:{port}\r\nUpgrade: websocket\r\n"
               f"Connection: Upgrade\r\nSec-WebSocket-Key: {key}\r\nSec-WebSocket-Version: 13\r\n"
               f"Origin: https://www.speedtest.net\r\nUser-Agent: {UA}\r\n\r\n")
        sock.sendall(req.encode())
        sock.settimeout(timeout)
        # read HTTP upgrade response
        resp = b""
        while b"\r\n\r\n" not in resp:
            chunk = sock.recv(4096)
            if not chunk:
                break
            resp += chunk
        res["handshake"] = resp.split(b"\r\n")[0].decode("utf-8", "replace")
        if b"101" not in resp.split(b"\r\n")[0]:
            res["ok"] = False
            res["http_response"] = resp[:300].decode("utf-8", "replace")
            sock.close()
            return res
        # send the exact client sequence
        seq = [f"HI {GUID}".encode(), b"GETIP", b"CAPABILITIES"]
        t_send = {}
        for m in seq:
            sock.sendall(ws_frame(m))
        t_ping = time.perf_counter()
        sock.sendall(ws_frame(f"PING {t_ping}".encode()))
        res["messages"] = []
        for _ in range(8):
            fr = ws_read(sock, timeout=3)
            if fr is None:
                break
            fr["at_ms"] = round((time.perf_counter() - t_ping) * 1000, 2)
            res["messages"].append(fr)
            if fr["text"] and fr["text"].startswith("PONG"):
                # one more measured PING round-trip
                t2 = time.perf_counter()
                sock.sendall(ws_frame(f"PING {t2}".encode()))
                fr2 = ws_read(sock, timeout=3)
                if fr2:
                    fr2["rtt_ms"] = round((time.perf_counter() - t2) * 1000, 2)
                    res["messages"].append(fr2)
                break
        res["ok"] = True
        res["total_ms"] = round((time.perf_counter() - t0) * 1000, 2)
        sock.close()
    except Exception as e:
        res["ok"] = False
        res["error"] = repr(e)
    return res


def tls_info(host, port=8080, timeout=6):
    try:
        ctx = ssl.create_default_context()
        s = ctx.wrap_socket(socket.create_connection((host, port), timeout=timeout), server_hostname=host)
        cert = s.getpeercert()
        s.close()
        return {"ok": True, "subject": cert.get("subject"), "issuer": cert.get("issuer"),
                "san": cert.get("subjectAltName"), "notAfter": cert.get("notAfter"), "version": cert.get("version")}
    except Exception as e:
        return {"ok": False, "error": repr(e)}


results = {}
for sid, sponsor, host, alt_host, user_ip in SERVERS:
    hosts_to_try = [host] + ([alt_host] if alt_host else [])
    entry = {"id": sid, "sponsor": sponsor, "hosts": {}}
    for h in hosts_to_try:
        hd = {"dns": resolve(h), "user_provided_ip": user_ip}
        if hd["dns"].get("ipv4"):
            ip4 = hd["dns"]["ipv4"][0]
            hd["ports"] = {p: tcp_probe(h, p) for p in (8080, 443, 5060, 80)}
            hd["tls_8080"] = tls_info(h, 8080)
            # HTTP probes over 8080 (http + https)
            hd["http_8080_root"] = http_get(h, 8080, "/", use_ssl=False)
            hd["http_8080_hello"] = http_get(h, 8080, f"/hello?guid={GUID}&nocache=probe", use_ssl=False)
            hd["http_8080_getip"] = http_get(h, 8080, "/getip", use_ssl=False)
            hd["http_8080_capabilities"] = http_get(h, 8080, "/capabilities", use_ssl=False)
            hd["http_8080_ping_rtts_ms"] = []
            for i in range(5):
                r = http_get(h, 8080, f"/ping?nocache=p{i}-{os.urandom(4).hex()}", use_ssl=False)
                hd["http_8080_ping_rtts_ms"].append(r.get("total_ms") if r.get("ok") else None)
            hd["https_8080_hello"] = http_get(h, 8080, f"/hello?guid={GUID}&nocache=probe", use_ssl=True)
            hd["http_8080_download_1k"] = http_get(h, 8080, "/download?size=1000", use_ssl=False)
            hd["http_8080_upload"] = http_post_upload(h, 8080, use_ssl=False)
            hd["http_8080_upload_stats"] = http_get(h, 8080, "/upload-stats?testDurationMillis=500&updatePeriodMillis=50", use_ssl=False)
            # legacy endpoints
            hd["legacy_latency_txt"] = http_get(h, 8080, "/speedtest/latency.txt", use_ssl=False)
            hd["legacy_crossdomain"] = http_get(h, 8080, "/speedtest/crossdomain.xml", use_ssl=False)
            hd["legacy_upload_get"] = http_get(h, 8080, "/speedtest/upload.php", use_ssl=False)
            # WS probes
            hd["ws_plain"] = ws_probe(h, 8080, use_ssl=False)
            hd["ws_tls"] = ws_probe(h, 8080, use_ssl=True)
        hd["user_ip_matches_dns"] = (user_ip in hd["dns"].get("ipv4", [])) if user_ip else None
        entry["hosts"][h] = hd
    results[str(sid)] = entry
    print(f"[done] {sid} {sponsor} ({host})")

with open(f"{OUT}/probe_results.json", "w") as f:
    json.dump(results, f, indent=1, default=str)
print("saved", f"{OUT}/probe_results.json")
