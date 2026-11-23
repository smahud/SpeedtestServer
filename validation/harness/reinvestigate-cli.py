#!/usr/bin/env python3
"""Bounded, non-publishing official CLI runs; local daemons are temporary lab processes."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import signal
import socket
import subprocess
import shutil
import sys
import tempfile
import time

ROOT = Path(__file__).resolve().parents[2]
CLI = ROOT.parent / 'SpeedtestHost-Tester/arena.ai/speedtest-cli/x86_64/speedtest'
HOST = 'speedtest.lumajangnetworks.my.id'
p = argparse.ArgumentParser(description=__doc__)
p.add_argument('backend', choices=['reference', 'replacement', 'remote'])
p.add_argument('--out', required=True, type=Path)
p.add_argument('--force-target', action='store_true', help='Remote lab only: replace nearest-server endpoints instead of claiming successful official host discovery')
args = p.parse_args()
out = args.out.resolve()
out.mkdir(parents=True, exist_ok=False)
lab_owner = tempfile.TemporaryDirectory(prefix='speedtest-cli-lab-')
lab = Path(lab_owner.name)
certs = ROOT / 'validation/harness/certs'
if not (certs / 'cli-ca-bundle.pem').is_file():
    subprocess.run(['bash', str(ROOT / 'validation/harness/gen-pki.sh')], check=True)
base = ('OoklaServer.useIPv4 = true\nOoklaServer.useIPv6 = true\n'
        'OoklaServer.enableAutoUpdate = false\nOoklaServer.binaryAutoUpdate = false\n'
        'OoklaServer.ssl.useLetsEncrypt = false\n'
        f'openSSL.server.certificateFile = {certs}/server.pem\n'
        f'openSSL.server.privateKeyFile = {certs}/server.key\n'
        'OoklaServer.allowedDomains = *.ookla.com, *.speedtest.net, *.speedtestcustom.com\n')
if args.backend != 'remote':
    shutil.copy2(ROOT / 'OoklaServer-linux-x86_64', lab / 'OoklaServer')
    (lab / 'OoklaServer.properties').write_text(base + 'OoklaServer.tcpPorts = 18080\nOoklaServer.udpPorts = 18080\n')
    (lab / 'replacement.properties').write_text(base + 'OoklaServer.tcpPorts = 18081\nOoklaServer.udpPorts = 18081\nOoklaServer.addresses = 127.0.0.1, ::1\n')
processes = []
files = []

def start(command, log, cwd=ROOT, env=None):
    handle = (out / log).open('w'); files.append(handle)
    child = subprocess.Popen(command, cwd=cwd, env=env, stdout=handle, stderr=subprocess.STDOUT, start_new_session=True)
    processes.append(child)
    return child

def ready(child, port):
    deadline = time.monotonic() + 15
    while time.monotonic() < deadline:
        if child.poll() is not None:
            raise RuntimeError(f'Process exited before listening: {child.args}')
        try:
            with socket.create_connection(('127.0.0.1', port), timeout=.2): return
        except OSError: time.sleep(.1)
    raise TimeoutError(f'Listener not ready on {port}')

def free(port):
    with socket.socket() as sock:
        sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        sock.bind(('127.0.0.1', port))

summary = {'backend': args.backend, 'hostname': HOST, 'publishing': False,
           'selection': 'official-host-discovery' if args.backend == 'remote' and not args.force_target else 'lab-config-endpoint-rewrite',
           'cli_sha256': hashlib.sha256(CLI.read_bytes()).hexdigest(),
           'reference_sha256': hashlib.sha256((ROOT / 'OoklaServer-linux-x86_64').read_bytes()).hexdigest()}
try:
    port = {'reference':18080, 'replacement':18081, 'remote':8080}[args.backend]
    target = f'{HOST if args.backend == "remote" else "localhost"}:{port}'
    summary['target'] = target
    if args.backend != 'remote':
        free(port)
        if args.backend == 'reference':
            child = start([str(lab / 'OoklaServer')], 'reference.stdout', lab)
        else:
            child = start(['node', str(ROOT / 'reverse-engineered/typescript/dist/bin/ooklaserver.js'), '--config', str(lab / 'replacement.properties')], 'replacement.stdout')
        ready(child, port)
    free(18888)
    proxy = start(['node', str(ROOT / 'validation/diversion-lab/harness/live-config-proxy.mjs'), '--port', '18888', '--target', target, '--log', str(out / 'proxy.jsonl')], 'proxy.stdout', env=dict(os.environ, CV_CERTS_DIR=str(certs)))
    ready(proxy, 18888)
    env = dict(os.environ, ALL_PROXY='http://127.0.0.1:18888', HTTPS_PROXY='http://127.0.0.1:18888', HTTP_PROXY='http://127.0.0.1:18888')
    command = ['strace', '-f', '-e', 'trace=connect', '-s', '128', '-o', str(out / 'connect.trace'), str(CLI), '--accept-license', '--accept-gdpr', '--selection-details', '--progress=no', '--format=json-pretty', '--ca-certificate=' + str(ROOT / 'validation/harness/certs/cli-ca-bundle.pem')]
    if args.backend == 'remote' and not args.force_target: command += ['--host=' + HOST]
    with (out / 'cli.json').open('w') as stdout, (out / 'cli.stderr').open('w') as stderr:
        cli = subprocess.Popen(command, env=env, cwd=ROOT, stdout=stdout, stderr=stderr, start_new_session=True)
        processes.append(cli)
        try: summary['exit_code'] = cli.wait(timeout=140)
        except subprocess.TimeoutExpired:
            summary['exit_code'] = 124
            summary['timed_out'] = True
    try:
        result = json.loads((out / 'cli.json').read_text())
        summary['server'] = result.get('server')
        summary['result_type'] = result.get('type')
        summary['packet_loss'] = result.get('packetLoss')
        summary['persisted'] = result.get('result', {}).get('persisted')
        summary['target_verified'] = (result.get('server', {}).get('host') == target.rsplit(':',1)[0] and result.get('server',{}).get('port') == port)
    except (ValueError, OSError): summary['target_verified'] = False
finally:
    for child in reversed(processes):
        if child.poll() is None:
            os.killpg(child.pid, signal.SIGTERM)
            try: child.wait(timeout=5)
            except subprocess.TimeoutExpired:
                os.killpg(child.pid, signal.SIGKILL); child.wait()
    for handle in files: handle.close()
    summary['owned_processes_stopped'] = all(child.poll() is not None for child in processes)
    if (out / 'proxy.jsonl').exists():
        summary['submission_block_observed'] = any(json.loads(line).get('k') == 'blocked' for line in (out / 'proxy.jsonl').read_text().splitlines())
    (out / 'summary.json').write_text(json.dumps(summary, indent=2) + '\n')
    print(json.dumps(summary, indent=2))
    lab_owner.cleanup()
sys.exit(0 if summary.get('exit_code') == 0 and summary.get('target_verified') and summary.get('persisted') is False and summary.get('submission_block_observed') else 1)
