#!/usr/bin/env python3
"""Fresh, bounded HTTP route/method/form observations against the original artifacts."""
import http.client
import json
import os
from pathlib import Path
import shutil
import signal
import socket
import subprocess
import tempfile
import time

root = Path(__file__).resolve().parents[2]
out = root / 'validation/evidence/http-repair-20261123'
out.mkdir(parents=True, exist_ok=True)
children = []
handles = []

def start(command, cwd, port, name):
    handle = (out / f'{name}.log').open('w'); handles.append(handle)
    child = subprocess.Popen(command, cwd=cwd, stdout=handle, stderr=handle, start_new_session=True)
    children.append(child)
    for _ in range(80):
        if child.poll() is not None: raise RuntimeError(f'{name} exited early')
        try:
            with socket.create_connection(('127.0.0.1', port), .2): return
        except OSError: time.sleep(.1)
    raise TimeoutError(name)

def request(port, method, target, body=None, extra=None, chunked=False):
    c = http.client.HTTPConnection('127.0.0.1',port,timeout=2)
    headers = {'Host':'speedtest.lumajangnetworks.my.id', 'User-Agent':'HostTesterCompatibilityAudit/1','Connection':'close'}
    if extra: headers.update(extra)
    try:
        c.request(method,target,body=body,headers=headers,encode_chunked=chunked)
        r = c.getresponse()
        raw = r.read()
        return {'status':r.status,'headers':dict(r.getheaders()),'body':raw[:2048].decode('utf8','replace'),'bytes':len(raw)}
    except (OSError,http.client.HTTPException) as e:
        return {'error':type(e).__name__,'details':str(e)}
    finally:c.close()

with tempfile.TemporaryDirectory(prefix='speedtest-http-audit-') as tmp:
    lab = Path(tmp)
    cert = lab / 'wildcard.pem'
    key = lab / 'wildcard.key'
    subprocess.run(['openssl','req','-x509','-newkey','rsa:2048','-nodes','-days','2',
                    '-subj','/CN=*.lumajangnetworks.my.id',
                    '-addext','subjectAltName=DNS:*.lumajangnetworks.my.id,DNS:lumajangnetworks.my.id,DNS:localhost,IP:127.0.0.1,IP:::1',
                    '-keyout',str(key),'-out',str(cert)],check=True,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
    key.chmod(0o600)
    shutil.copy2(root / 'OoklaServer-linux-x86_64',lab/'OoklaServer')
    base = (f'openSSL.server.certificateFile = {cert}\nopenSSL.server.privateKeyFile = {key}\n'
            'OoklaServer.enableAutoUpdate = false\nOoklaServer.binaryAutoUpdate = false\nOoklaServer.ssl.useLetsEncrypt = false\n'
            'OoklaServer.useIPv4 = true\nOoklaServer.useIPv6 = true\n'
            'OoklaServer.allowedDomains = *.ookla.com, *.speedtest.net, *.speedtestcustom.com\n')
    (lab/'OoklaServer.properties').write_text(base+'OoklaServer.tcpPorts = 18082,18085\nOoklaServer.udpPorts = 18082,18085\n')
    (lab/'replacement.properties').write_text(base+'OoklaServer.tcpPorts = 18083,18086\nOoklaServer.udpPorts = 18083,18086\nOoklaServer.addresses = 127.0.0.1, ::1\n')
    php = lab/'php';php.mkdir()
    shutil.copytree(root.parent/'SpeedtestHost-Tester/arena.ai/ooklaserver/sim/legacy/speedtest',php/'speedtest')
    try:
        start([str(lab/'OoklaServer')],lab,18082,'original')
        start(['node',str(root/'reverse-engineered/typescript/dist/bin/ooklaserver.js'),'--config',str(lab/'replacement.properties')],root,18083,'replacement')
        start(['php','-S','127.0.0.1:18084','-t',str(php)],lab,18084,'official-php-script')
        cases=[]
        for target in ['/crossdomain.xml','/speedtest/crossdomain.xml','/foo/crossdomain.xml','/CROSSDOMAIN.XML','/crossdomain.xml/']:
            cases.append((f'GET {target}','GET',target,None,None,False))
        for target in ['/speedtest/upload.php','/upload.php','/speedtest/upload','/upload','/foo/upload.php','/speedtest/upload.asp','/speedtest/upload.aspx','/speedtest/upload.jsp','/speedtest/upload.php/']:
            cases.append((f'POST {target}','POST',target,b'content1=abc',{'Content-Type':'application/x-www-form-urlencoded'},False))
        for method in ['GET','HEAD','OPTIONS','PUT']:
            cases.append((f'{method} upload',''+method,'/speedtest/upload.php',None,None,False))
        for content_type,body in [('text/plain',b'abc'),('application/octet-stream',b'abc'),('',b'abc'),('application/x-www-form-urlencoded',b'content1=a%00%FF&x=%C3%A9')]:
            cases.append((f'POST type={content_type}','POST','/speedtest/upload.php',body,{'Content-Type':content_type},False))
        cases += [('POST chunked','POST','/speedtest/upload.php',iter([b'content1=abc']),{'Content-Type':'application/x-www-form-urlencoded','Transfer-Encoding':'chunked'},True)]
        result=[]
        for name,method,target,body,headers,chunked in cases:
            row={'name':name}
            for label,port in [('original',18082),('replacement',18083),('official_php',18084)]:
                actual_body = iter([b'content1=abc']) if chunked else body
                row[label]=request(port,method,target,actual_body,headers,chunked)
            result.append(row)
            print(name, ' / '.join(f'{label}:{r.get("status",r.get("error"))}:{r.get("body","")[:90]!r}' for label,r in row.items() if isinstance(r,dict)),flush=True)
        (out/'reference-route-matrix.json').write_text(json.dumps(result,indent=2)+'\n')
    finally:
        for child in reversed(children):
            if child.poll() is None:
                os.killpg(child.pid,signal.SIGTERM)
                try:child.wait(timeout=5)
                except subprocess.TimeoutExpired:os.killpg(child.pid,signal.SIGKILL);child.wait()
        for handle in handles:handle.close()
