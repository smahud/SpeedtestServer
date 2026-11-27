#!/usr/bin/env python3
"""Follow-up probes: somedigit TLS cert detail + legacy random*.jpg + root path."""
import json, socket, ssl

def get_cert_unverified(host, port=8080):
    try:
        ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_CLIENT)
        ctx.check_hostname = False
        ctx.verify_mode = ssl.CERT_NONE
        s = ctx.wrap_socket(socket.create_connection((host, port), timeout=6), server_hostname=host)
        der = s.getpeercert(binary_form=True)
        proto = s.version()
        s.close()
        import subprocess, tempfile, os
        with tempfile.NamedTemporaryFile(suffix=".der", delete=False) as f:
            f.write(der); path = f.name
        out = subprocess.run(["openssl", "x509", "-inform", "der", "-in", path, "-noout", "-subject", "-issuer", "-dates", "-ext", "subjectAltName"], capture_output=True, text=True).stdout
        os.unlink(path)
        return {"ok": True, "tls": proto, "cert": out}
    except Exception as e:
        return {"ok": False, "error": repr(e)}

def head(host, port, path, use_ssl=False):
    try:
        if use_ssl:
            ctx = ssl.create_default_context()
            ctx.check_hostname = False; ctx.verify_mode = ssl.CERT_NONE
            s = ctx.wrap_socket(socket.create_connection((host, port), timeout=6), server_hostname=host)
        else:
            s = socket.create_connection((host, port), timeout=6)
        s.sendall(f"HEAD {path} HTTP/1.1\r\nHost: {host}:{port}\r\nOrigin: https://www.speedtest.net\r\nConnection: close\r\n\r\n".encode())
        s.settimeout(6)
        buf = b""
        while b"\r\n\r\n" not in buf:
            c = s.recv(4096)
            if not c: break
            buf += c
        s.close()
        return buf.decode("utf-8", "replace").split("\r\n\r\n")[0][:400]
    except Exception as e:
        return repr(e)

out = {}
print("=== somedigit TLS cert (unverified) ===")
out["somedigit_cert"] = get_cert_unverified("speedtest.somedigit.net", 8080)
print(out["somedigit_cert"])

print("\n=== legacy random*.jpg + upload.php GET on somedigit & xl (plain :8080) ===")
out["legacy_random"] = {}
for host in ("speedtest.somedigit.net", "speedtest-sby.xl.co.id"):
    out["legacy_random"][host] = {
        p: head(host, 8080, p) for p in (
            "/speedtest/random350x350.jpg",
            "/speedtest/random1000x1000.jpg",
            "/speedtest/random4000x4000x4.jpg",
            "/speedtest/upload.php",
            "/speedtest/latency.txt",
            "/",
        )
    }
    for p, r in out["legacy_random"][host].items():
        first = r.split("\r\n")[0] if isinstance(r, str) else r
        clen = [l for l in r.split("\r\n") if l.lower().startswith("content-length") or l.lower().startswith("location")]
        print(f"  {host} {p}: {first} {clen}")

with open("/home/z/my-project/work/server_probes/followup.json", "w") as f:
    json.dump(out, f, indent=1)
print("saved followup.json")
