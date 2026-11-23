#!/usr/bin/env python3
"""Run the independent 19-check engine with optional explicit target IP pinning.

Usage: python3 host-tester-check.py --tester-dir ../SpeedtestHost-Tester/chatgpt \
       --host lumajangnetworks.my.id --target-ip 45.126.249.250
Pinning preserves the real Host header and strict TLS hostname verification.
JSON on stdout is evidence, not a verdict from Ookla's hosted tester.
"""
import argparse
import ipaddress
import json
import pathlib
import sys

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--tester-dir', required=True)
parser.add_argument('--host', required=True)
parser.add_argument('--target-ip')
parser.add_argument('--legacy-port', type=int, default=80)
args = parser.parse_args()
engine_dir = pathlib.Path(args.tester_dir).resolve()
if not (engine_dir / 'engine.py').is_file():
    parser.error('tester-dir must contain the trusted SpeedtestHost-Tester/chatgpt/engine.py')
sys.path.insert(0, str(engine_dir))
import engine  # noqa: E402

if args.target_ip:
    ip = ipaddress.ip_address(args.target_ip)
    resolver = engine.resolve_host
    engine.resolve_host = lambda host, port, **kwargs: resolver(str(ip), port, allow_private=not ip.is_global)
result = engine.run_all_tests(args.host, allow_private=bool(args.target_ip), legacy_port=args.legacy_port)
result['target_ip_override'] = args.target_ip
print(json.dumps(result, indent=2))
sys.exit(1 if result['summary']['failed'] else 0)
