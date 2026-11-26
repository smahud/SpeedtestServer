#!/usr/bin/env python3
"""build-matrix.py — compute the run matrix for cli-bridge evidence dir.

Reads: runs/*.cli.json (client side), bridge-logs/*.jsonl (VPS side),
and writes run-matrix.json + run-matrix.md with 3-side attribution.
"""
import json
import pathlib
import re

EV = pathlib.Path(__file__).resolve().parent.parent
RUNS = EV / "runs"
LOGS = EV / "bridge-logs"

BRIDGE_LOG_FOR = {
    "b0-daemon-baseline": None,          # daemon only, no bridge
    "b1-local-1": "cli-bridge-local1.jsonl",
    "b2-wh-1": "cli-bridge-worker-http.jsonl",
    "b2-wh-2": "cli-bridge-worker-http2.jsonl",
    "b2-wh-3": "cli-bridge-worker-http3.jsonl",
    "b2-wh-4": "cli-bridge-worker-http4.jsonl",
    "b3-ww-1": "cli-bridge-worker-ws1.jsonl",
    "b3-ww-2": "cli-bridge-worker-ws2.jsonl",
    "b4-restore-verify": None,           # daemon only, restored
}


def cli_side(label):
    raw = (RUNS / f"{label}.cli.json").read_text()
    lines = [l for l in raw.splitlines() if not l.startswith("EXIT=")]
    exit_line = [l for l in raw.splitlines() if l.startswith("EXIT=")]
    d = json.loads("\n".join(lines))
    return {
        "exit": int(exit_line[0].split("=")[1]) if exit_line else None,
        "server": d.get("server", {}).get("id"),
        "serverHost": d.get("server", {}).get("host"),
        "dl_mbps": round(d.get("download", {}).get("bandwidth", 0) * 8 / 1e6, 1),
        "dl_bytes": d.get("download", {}).get("bytes"),
        "ul_mbps": round(d.get("upload", {}).get("bandwidth", 0) * 8 / 1e6, 1),
        "ul_bytes": d.get("upload", {}).get("bytes"),
        "ping_ms": round(d.get("ping", {}).get("latency", 0), 1),
        "packetLoss": (d.get("result") or {}).get("packetLoss"),
        "persisted": (d.get("result") or {}).get("persisted"),
        "interface": d.get("interface"),
    }


def bridge_side(logname):
    if not logname:
        return None
    hb = None
    conns = 0
    retries = 0
    errs = 0
    for line in (LOGS / logname).read_text().splitlines():
        try:
            e = json.loads(line)
        except Exception:
            continue
        if e.get("k") == "heartbeat" and "downloads" in e:
            hb = e
        if e.get("k") == "conn_open":
            conns += 1
        if e.get("k") == "worker_retry":
            retries += 1
        if e.get("k") == "worker_err":
            errs += 1
    if not hb:
        return None
    return {
        "conns": conns,
        "downloads": hb["downloads"],
        "uploads": hb["uploads"],
        "bytesDownCli": hb["bytesDownCli"],
        "bytesUpCli": hb["bytesUpCli"],
        "bytesFromWorkerDl": hb["bytesFromWorkerDl"],
        "bytesToWorkerUl": hb["bytesToWorkerUl"],
        "bytesLocalDl": hb["bytesLocalDl"],
        "workerRequests": hb["workerRequests"],
        "workerErrors": hb["workerErrors"],
        "workerReceipts": hb["workerReceipts"],
        "workerRetries": retries,
        "workerErrEvents": errs,
    }


def window(label):
    p = RUNS / f"{label}.window"
    if not p.exists():
        return None
    return [l.strip() for l in p.read_text().splitlines() if l.strip()]


def main():
    matrix = {}
    for label, log in BRIDGE_LOG_FOR.items():
        try:
            row = {"client": cli_side(label), "window": window(label)}
        except FileNotFoundError:
            continue
        b = bridge_side(log)
        if b:
            row["bridge"] = b
            c = row["client"]
            if c["dl_bytes"]:
                b["dlWorkerShare"] = round(b["bytesFromWorkerDl"] / (c["dl_bytes"] or 1) * 100, 1)
            if c["ul_bytes"]:
                b["ulWorkerShare"] = round(b["bytesToWorkerUl"] / (c["ul_bytes"] or 1) * 100, 1)
        matrix[label] = row
    (EV / "lab-meta" / "run-matrix.json").write_text(json.dumps(matrix, indent=1))

    # markdown table
    rows = ["| Run | Backend | Exit | DL Mbps | DL MB (cli) | DL dari Worker | UL Mbps | UL MB (cli) | UL ke Worker | Receipts | Ping ms | persisted |",
            "|---|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---|"]
    backend_of = {
        "b0-daemon-baseline": "daemon (produksi)",
        "b1-local-1": "bridge local",
        "b2-wh-1": "bridge worker-http (v1)",
        "b2-wh-2": "bridge worker-http (v2, bug mint)",
        "b2-wh-3": "bridge worker-http",
        "b2-wh-4": "bridge worker-http",
        "b3-ww-1": "bridge worker-ws (v1, bug UL cmd)",
        "b3-ww-2": "bridge worker-ws",
        "b4-restore-verify": "daemon (dipulihkan)",
    }
    for label, r in matrix.items():
        c = r["client"]
        b = r.get("bridge")
        if b:
            dlw = f"{b.get('dlWorkerShare', 0)}% ({b['bytesFromWorkerDl']/1e6:.1f} MB)"
            ulw = f"{b.get('ulWorkerShare', 0)}% ({b['bytesToWorkerUl']/1e6:.1f} MB)"
            rec = str(b["workerReceipts"])
        else:
            dlw = "0% (daemon)"
            ulw = "0% (daemon)"
            rec = "n/a"
        dl_mb = f"{c['dl_bytes']/1e6:.1f}" if c["dl_bytes"] else "—"
        ul_mb = f"{c['ul_bytes']/1e6:.1f}" if c["ul_bytes"] else "—"
        rows.append(
            f"| {label} | {backend_of.get(label, '')} | {c['exit']} | {c['dl_mbps']} | {dl_mb} | {dlw} | {c['ul_mbps']} | {ul_mb} | {ulw} | {rec} | {c['ping_ms']} | {c['persisted']} |"
        )
    (EV / "lab-meta" / "run-matrix.md").write_text("\n".join(rows) + "\n")
    print("\n".join(rows))


if __name__ == "__main__":
    main()
