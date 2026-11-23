#!/usr/bin/env python3
"""Own and clean up a temporary two-backend lab; no service installation or VPS writes."""
import json
import os
from pathlib import Path
import shutil
import signal
import socket
import subprocess
import tempfile
import time
import argparse

root = Path(__file__).resolve().parents[2]
p = argparse.ArgumentParser(description=__doc__)
p.add_argument('--out', type=Path, default=root / 'validation/evidence/reinvestigation-20261123')
p.add_argument('--group', choices=['http','tcp','tls','ws','udp'])
args = p.parse_args()
out = args.out.resolve()
out.mkdir(parents=True, exist_ok=True)
children = []
handles = []
with tempfile.TemporaryDirectory(prefix='speedtest-differential-') as temporary:
    lab = Path(temporary)
    shutil.copy2(root / 'OoklaServer-linux-x86_64', lab / 'OoklaServer')
    base = ('OoklaServer.useIPv4 = true\nOoklaServer.useIPv6 = true\n'
            'OoklaServer.enableAutoUpdate = false\nOoklaServer.binaryAutoUpdate = false\n'
            'OoklaServer.ssl.useLetsEncrypt = false\n'
            f'openSSL.server.certificateFile = {root}/validation/harness/certs/server.pem\n'
            f'openSSL.server.privateKeyFile = {root}/validation/harness/certs/server.key\n'
            'OoklaServer.allowedDomains = *.ookla.com, *.speedtest.net, *.speedtestcustom.com\n')
    (lab / 'OoklaServer.properties').write_text(base + 'OoklaServer.tcpPorts = 18080\nOoklaServer.udpPorts = 18080\n')
    (lab / 'replacement.properties').write_text(base + 'OoklaServer.tcpPorts = 18081\nOoklaServer.udpPorts = 18081\nOoklaServer.addresses = 127.0.0.1, ::1\n')
    commands = [
        ['strace', '-f', '-e', 'trace=network', '-s', '96', '-o', str(out / 'reference-protocol.trace'), str(lab / 'OoklaServer')],
        ['node', str(root / 'reverse-engineered/typescript/dist/bin/ooklaserver.js'), '--config', str(lab / 'replacement.properties')],
    ]
    try:
        for command, port, label in zip(commands, [18080,18081], ['reference','replacement']):
            with socket.socket() as probe:
                probe.setsockopt(socket.SOL_SOCKET,socket.SO_REUSEADDR,1)
                probe.bind(('127.0.0.1',port))
            handle = (out / f'differential-{label}.stdout').open('w'); handles.append(handle)
            child = subprocess.Popen(command, cwd=lab, stdout=handle, stderr=handle, start_new_session=True); children.append(child)
            for _ in range(100):
                if child.poll() is not None: raise RuntimeError(f'{label} exited early')
                try:
                    with socket.create_connection(('127.0.0.1',port),.2): break
                except OSError: time.sleep(.1)
            else: raise RuntimeError(f'{label} not ready')
        env = dict(os.environ, PROBE_OUT=str(out / 'protocol-differential.json'), PROBE_HTTP_HOST='localhost')
        handle = (out / 'protocol-differential.stdout').open('w'); handles.append(handle)
        command = ['node', str(root / 'validation/harness/probe-diff.mjs'), '18080','18081']
        if args.group: command.append(f'--{args.group}-only')
        child = subprocess.Popen(command, cwd=root, env=env, stdout=handle, stderr=handle, start_new_session=True); children.append(child)
        code = child.wait(timeout=240)
        result = json.loads((out / 'protocol-differential.json').read_text())
        print(json.dumps({'exit_code':code,'total':len(result['results']),'harness_identical':sum(bool(r['identical']) for r in result['results'])}))
    finally:
        for child in reversed(children):
            if child.poll() is None:
                os.killpg(child.pid,signal.SIGTERM)
                try: child.wait(timeout=5)
                except subprocess.TimeoutExpired: os.killpg(child.pid,signal.SIGKILL); child.wait()
        for handle in handles: handle.close()
