#!/usr/bin/env python3
"""Stricter public HTTP checks derived from fresh original-binary observations."""
import argparse
import http.client
import json
import xml.etree.ElementTree as ET

p = argparse.ArgumentParser(description=__doc__)
p.add_argument('--host', required=True)
p.add_argument('--port', type=int, default=8080)
p.add_argument('--required-ports', default='5060,8080')
args = p.parse_args()
required_ports = set(args.required_ports.split(','))
results = []

def request(method, target, body=None, secure=False, port=None):
    port = port or args.port
    cls = http.client.HTTPSConnection if secure else http.client.HTTPConnection
    c = cls(args.host, port, timeout=10)
    headers = {'User-Agent':'SpeedtestServerReferenceParity/1','Connection':'close','Origin':'https://www.speedtest.net'}
    if body is not None: headers['Content-Type'] = 'application/x-www-form-urlencoded'
    try:
        c.request(method,target,body=body,headers=headers)
        response = c.getresponse()
        return response.status, dict(response.getheaders()), response.read()
    finally:c.close()

def check(name, action):
    try: detail = action(); results.append({'name':name,'passed':True,'detail':detail})
    except Exception as e: results.append({'name':name,'passed':False,'error':str(e)})

def policy(target, secure):
    status, headers, body = request('GET',target,secure=secure)
    assert status == 200, f'HTTP {status}'
    root = ET.fromstring(body)
    assert root.tag == 'cross-domain-policy', 'Wrong XML root'
    entries = root.findall('allow-access-from')
    for domain in ['*.ookla.com','*.speedtest.net','*.speedtestcustom.com']:
        matches = [e for e in entries if e.get('domain') in [domain,'*']]
        assert any(e.get('to-ports') == '*' or required_ports.issubset(set(e.get('to-ports','').split(','))) for e in matches), f'{domain}: not all {sorted(required_ports)} advertised'
    return {'status':status,'bytes':len(body),'required_ports':sorted(required_ports)}

def native_upload(target, secure, method='POST', size=12):
    body = (b'content1=' + b'a' * (size - 9)) if method == 'POST' else None
    status, headers, data = request(method,target,body=body,secure=secure)
    assert status == 200, f'HTTP {status}'
    expected = f'size={size}\n'.encode() if method == 'POST' else b''
    assert data == expected, f'Expected {expected!r}, received {data[:100]!r}'
    if method == 'OPTIONS': assert headers.get('Content-Length') == '0', 'OPTIONS must advertise 0 bytes'
    return {'status':status,'body':data.decode()}

def legacy_upload(size):
    body = b'content1=' + b'a' * (size - 9)
    status, headers, data = request('POST','/speedtest/upload.php',body=body,port=80)
    expected = f'size={size + 502}'.encode()
    assert status == 200 and data == expected, f'HTTP {status}, received {data[:100]!r}, expected {expected!r}'
    return {'status':status,'sent':size,'body':data.decode()}

def encoded_legacy_upload(count):
    body = b'content1=' + b'%FF' * count
    status, headers, data = request('POST','/speedtest/upload.php',body=body,port=80)
    expected = f'size={500 + 8 + count + 3}'.encode()
    assert status == 200 and data == expected, f'HTTP {status}, received {data[:100]!r}, expected {expected!r}'
    return {'status':status,'wire_bytes':len(body),'decoded_value_bytes':count,'body':data.decode()}

for secure in [False,True]:
    scheme = 'https' if secure else 'http'
    for target in ['/crossdomain.xml','/speedtest/crossdomain.xml','/foo/crossdomain.xml']:
        check(f'{scheme} GET {target}',lambda target=target,secure=secure:policy(target,secure))
    for target in ['/upload','/speedtest/upload','/speedtest/upload.php','/foo/upload.php']:
        check(f'{scheme} POST {target}',lambda target=target,secure=secure:native_upload(target,secure))
    for target in ['/upload','/speedtest/upload.php']:
        check(f'{scheme} OPTIONS {target}',lambda target=target,secure=secure:native_upload(target,secure,'OPTIONS'))
    for size in [515798,1980998]:
        for target in ['/upload','/speedtest/upload.php']:
            check(f'{scheme} POST {target} bytes={size}',lambda target=target,secure=secure,size=size:native_upload(target,secure,size=size))
for size in [12,515798,1980998]:check(f'legacy port 80 upload {size}',lambda size=size:legacy_upload(size))
for count in [1,1980989]:check(f'legacy port 80 percent-encoded bytes={count}',lambda count=count:encoded_legacy_upload(count))
passed = sum(r['passed'] for r in results)
print(json.dumps({'host':args.host,'port':args.port,'required_ports':sorted(required_ports),'tls_verification':'system trust + hostname validation','summary':{'passed':passed,'failed':len(results)-passed,'total':len(results)},'results':results},indent=2))
raise SystemExit(0 if passed == len(results) else 1)
