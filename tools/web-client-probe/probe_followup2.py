#!/usr/bin/env python3
"""Ground-truth probe: the web client's XHR paths against official Surabaya servers."""
import socket

HOSTS = ["speedtest-sby.xl.co.id", "speedtest.patas.id", "speedtest.tuxsnet.id.prod.hosts.ooklaserver.net"]
UA = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/131.0.0.0 Safari/537.36"

def get(host, path, method="GET", extra="", body=None):
    try:
        s = socket.create_connection((host, 8080), timeout=8)
        req = (f"{method} {path} HTTP/1.1\r\nHost: {host}:8080\r\nUser-Agent: {UA}\r\n"
               f"Origin: https://www.speedtest.net\r\nAccept: */*\r\n{extra}")
        if body is not None:
            req += f"Content-Type: application/octet-stream\r\nContent-Length: {len(body)}\r\n"
        req += "Connection: close\r\n\r\n"
        s.sendall(req.encode() + (body or b""))
        s.settimeout(8)
        buf = b""
        while len(buf) < 300000:
            c = s.recv(65536)
            if not c:
                break
            buf += c
        s.close()
        head, _, body_out = buf.partition(b"\r\n\r\n")
        lines = head.decode("utf-8", "replace").split("\r\n")
        hd = {}
        for l in lines[1:]:
            if ":" in l:
                k, v = l.split(":", 1)
                hd[k.strip().lower()] = v.strip()
        return f"{lines[0]} | ct={hd.get('content-type','')[:26]} cl={hd.get('content-length','')} acao={hd.get('access-control-allow-origin','')} cache={hd.get('cache-control','')} body={body_out[:40]!r}"
    except Exception as e:
        return f"ERR {e!r}"[:90]

for host in HOSTS[:2]:
    print(f"===== {host} =====")
    for path in ["/hello", "/hi", "/getip", "/capabilities", "/ping", "/ping?nocache=x",
                 "/download?size=100", "/upload-stats?testDurationMillis=500&updatePeriodMillis=50&index=0",
                 "/upload-stats?guid=abc&testDurationMillis=500&updatePeriodMillis=50&index=0"]:
        print(f"  GET {path[:70]:<72} -> {get(host, path)}")
    # OPTIONS preflight shape on /upload
    print(f"  OPTIONS /upload (preflight) -> {get(host, '/upload', method='OPTIONS', extra='Access-Control-Request-Method: POST\r\nAccess-Control-Request-Headers: content-type\r\n')}")
    # HEAD parity
    print(f"  HEAD /hello -> {get(host, '/hello', method='HEAD')}")
