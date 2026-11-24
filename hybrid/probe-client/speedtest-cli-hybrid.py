#!/usr/bin/env python3
"""speedtest-cli-hybrid.py — stock speedtest-cli with hybrid transport routing.

THE MEASUREMENT ENGINE IS 100% STOCK sivel/speedtest-cli. Only two
client-side transport hooks are installed (both documented, both equivalent
to what /etc/hosts cannot do for ports):

  1. Speedtest.get_servers — server URLs are rewritten to the VPS FRONT
     (mock domain). This is the "server selection + ping" plane: the client
     resolves the front hostname to the VPS IP and measures latency there.
  2. build_request — upload POSTs (requests WITH body) are routed directly
     to the Cloudflare Worker `__up` endpoint with a Bearer session token.
     This is the ONLY way a urllib client can send its payload to the edge:
     stock urllib always streams the full body to the first hop before
     reading any redirect, so a 307 cannot offload uploads (see docs).

Download needs no patch: the front 302-redirects `random*.jpg` GETs to the
Worker `__down` endpoint and stock urllib follows GET redirects natively.

Env:
  HYBRID_GATEWAY_BASE   e.g. https://speedtest.lumajangnetworks.my.id:8790
                         (session token mint + results)
  HYBRID_WORKER_BASE    e.g. https://speedtest-hybrid-worker.<sub>.workers.dev
  HYBRID_FRONT_BASE     e.g. https://speedtest-mock.lumajangnetworks.my.id:8790
  HYBRID_REWRITE_SERVERS  auto (default: rewrite when --server is used) |
                          always | never
  HYBRID_SUBMIT_RESULTS   1 (default) — POST the final JSON result document
                          to <gateway>/api/results (hybrid result intake)
"""
import json
import os
import sys
import urllib.request

import speedtest as st

GATEWAY_BASE = os.environ.get('HYBRID_GATEWAY_BASE', '').rstrip('/')
WORKER_BASE = os.environ.get('HYBRID_WORKER_BASE', '').rstrip('/')
FRONT_BASE = os.environ.get('HYBRID_FRONT_BASE', '').rstrip('/')
REWRITE_MODE = os.environ.get('HYBRID_REWRITE_SERVERS', 'auto').lower()
SUBMIT_RESULTS = os.environ.get('HYBRID_SUBMIT_RESULTS', '1') == '1'
# Optional: the operator's own server list (JSON array of speedtest-server
# entries). When set, it REPLACES the geo-localized speedtest.net list — this
# is the "speedtest pointed at the domain list" mode. The URL of every
# entry is rewritten to the VPS front.
SERVER_LIST_FILE = os.environ.get('HYBRID_SERVER_LIST_FILE', '')


def _session_token():
    req = urllib.request.Request(
        GATEWAY_BASE + '/api/sessions',
        data=b'{}',
        headers={'Content-Type': 'application/json'},
        method='POST',
    )
    with urllib.request.urlopen(req, timeout=20) as r:
        return json.load(r)['token']


TOKEN = _session_token() if (GATEWAY_BASE and WORKER_BASE) else None

# --- hook 1: rewrite server-list URLs to the VPS front ----------------------
_orig_get_servers = st.Speedtest.get_servers


def _has_server_flag():
    for a in sys.argv:
        if a == '--server' or a.startswith('--server='):
            return True
    return False


def _rewrite_servers(self):
    for _d, lst in self.servers.items():
        for s in lst:
            s['url'] = FRONT_BASE + '/speedtest/upload.php'


def hybrid_get_servers(self, servers=None, exclude=None):
    mini = any(a == '--mini' or a.startswith('--mini=') for a in sys.argv)

    # operator-supplied domain list: replace the geo-localized list entirely
    if SERVER_LIST_FILE and not mini and FRONT_BASE:
        if not self.config:
            self.get_config()
        self.servers.clear()
        with open(SERVER_LIST_FILE) as f:
            entries = json.load(f)
        wanted = set(int(x) for x in servers) if servers else None
        excl = set(int(x) for x in exclude) if exclude else set()
        ignore = set(self.config.get('ignore_servers', []))
        for e in entries:
            sid = int(e['id'])
            if wanted is not None and sid not in wanted:
                continue
            if sid in excl or sid in ignore:
                continue
            s = {
                'id': sid,
                'url': FRONT_BASE + '/speedtest/upload.php',
                'lat': str(e.get('lat', '0')),
                'lon': str(e.get('lon', '0')),
                'name': e.get('name', ''),
                'country': e.get('country', ''),
                'cc': e.get('cc', ''),
                'sponsor': e.get('sponsor', ''),
                'host': e.get('host', ''),
                'd': 0.0,
            }
            self.servers.setdefault(0.0, []).append(s)
        if (servers or exclude) and not self.servers:
            raise st.NoMatchedServers()
        return self.servers

    result = _orig_get_servers(self, servers=servers, exclude=exclude)
    do_rewrite = (
        FRONT_BASE
        and not mini
        and (REWRITE_MODE == 'always'
             or (REWRITE_MODE == 'auto' and _has_server_flag()))
    )
    if do_rewrite:
        _rewrite_servers(self)
    return result


st.Speedtest.get_servers = hybrid_get_servers

# --- hook 2: route upload POSTs directly to the Worker edge -----------------
_orig_build_request = st.build_request


def hybrid_build_request(url, data=None, headers=None, bump='0', secure=False):
    if data is not None and TOKEN and WORKER_BASE:
        url = WORKER_BASE + '/__up'
        headers = dict(headers or {})
        headers['Authorization'] = 'Bearer ' + TOKEN
    return _orig_build_request(url, data=data, headers=headers,
                               bump=bump, secure=secure)


st.build_request = hybrid_build_request


def submit_results(document):
    """POST the final speedtest result document to the gateway (best effort)."""
    if not (GATEWAY_BASE and TOKEN):
        return None
    try:
        payload = {
            'token': TOKEN,
            'guid': TOKEN.split('~')[1] if TOKEN.count('~') >= 4 else None,
            'metrics': document,
            'accounting': {
                'downloadBytes': document.get('bytes_received'),
                'uploadBytes': document.get('bytes_sent'),
                'pingMs': document.get('ping'),
                'client': 'speedtest-cli-hybrid/1.0 (engine: speedtest-cli %s)'
                          % st.__version__,
            },
        }
        req = urllib.request.Request(
            GATEWAY_BASE + '/api/results',
            data=json.dumps(payload).encode(),
            headers={'Content-Type': 'application/json'},
            method='POST',
        )
        with urllib.request.urlopen(req, timeout=20) as r:
            return json.load(r)
    except Exception as e:  # best effort only
        print('result submission skipped: %r' % (e,), file=sys.stderr)
        return None


if __name__ == '__main__':
    # capture the JSON document when --json is used, then submit to gateway
    _orig_printer = st.printer
    _captured = []

    def capturing_printer(string, quiet=False, debug=False, error=False,
                          **kwargs):
        if isinstance(string, str) and string.lstrip().startswith('{'):
            _captured.append(string)
        return _orig_printer(string, quiet=quiet, debug=debug, error=error,
                             **kwargs)

    if SUBMIT_RESULTS and '--json' in sys.argv:
        st.printer = capturing_printer

    try:
        st.shell()
    finally:
        # shell() returns normally on success (and may raise on error) —
        # submit the captured JSON document either way (best effort).
        if SUBMIT_RESULTS and _captured:
            try:
                doc = json.loads(_captured[-1])
            except Exception:
                doc = None
            if doc:
                receipt = submit_results(doc)
                if receipt:
                    print('hybrid-result: %s' % json.dumps(receipt),
                          file=sys.stderr)
