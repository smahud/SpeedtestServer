#!/usr/bin/env python3
"""speedtest-cli-hybrid.py — stock speedtest-cli with hybrid transport routing.

THE MEASUREMENT ENGINE IS 100% STOCK sivel/speedtest-cli. Only these
documented client-side transport hooks are installed (equivalent to what
/etc/hosts cannot do for ports/parallelism):

  1. Speedtest.get_servers — server URLs are rewritten to the VPS FRONT
     (mock domain). This is the "server selection + ping" plane: the client
     resolves the front hostname to the VPS IP and measures latency there.
  2. build_request — upload POSTs (requests WITH body targeted at the
     speedtest upload endpoint) are split between the Cloudflare Worker
     `__up` endpoint (Bearer token) and the VPS front upload.php drain —
     the VPS contributes its ingress capacity, the edge covers the rest
     ("CF membantu beban, bukan menggantikan").
  3. Speedtest.get_config — optional thread/URL-count overrides. The stock
     engine uses speedtest.net's thread counts (download = threadcount×2,
     historically small; upload = 4). On a fast link the stock counts cap
     the aggregate far below client capacity — Ookla's own CLI scales to
     32 connections. 0 (default) keeps the stock values untouched.

Download needs no routing patch: the front's v1.4 assist lanes serve a
SHARE of downloads directly from the VPS at FULL speed (HYBRID_VPS_DL_SHARE
— no budget, no throttle) and 302-redirect the complementary share to the
Worker `__down` — stock urllib follows GET redirects natively, and the
threads run unmodified.

Env:
  HYBRID_GATEWAY_BASE   e.g. https://speedtest.lumajangnetworks.my.id:8790
                         (session token mint + results)
  HYBRID_WORKER_BASE    e.g. https://speedtest-hybrid-worker.<sub>.workers.dev
  HYBRID_FRONT_BASE     e.g. https://speedtest-mock.lumajangnetworks.my.id:8790
  HYBRID_REWRITE_SERVERS  auto (default: rewrite when --server is used) |
                          always | never
  HYBRID_SUBMIT_RESULTS   1 (default) — POST the final JSON result document
                          to <gateway>/api/results (hybrid result intake)
  HYBRID_DL_THREADS       0 = stock (speedtest.net threadcount×2); e.g. 16
                          to let a 1 Gbps client actually saturate
  HYBRID_UL_THREADS       0 = stock; e.g. 8
  HYBRID_DL_COUNTS        0 = stock urls-per-size; e.g. 8 (more URLs amortize
                          per-request TLS handshakes at gigabit rates)
  HYBRID_VPS_UL_SHARE     0.0-1.0 fraction of upload POSTs kept on the VPS
                          front (its ingress contribution); default 0.15,
                          0.0 = all edge (v1.1 behavior), 1.0 = all VPS
"""
import json
import os
import sys
import time
import urllib.request

import speedtest as st

GATEWAY_BASE = os.environ.get('HYBRID_GATEWAY_BASE', '').rstrip('/')
WORKER_BASE = os.environ.get('HYBRID_WORKER_BASE', '').rstrip('/')
FRONT_BASE = os.environ.get('HYBRID_FRONT_BASE', '').rstrip('/')
REWRITE_MODE = os.environ.get('HYBRID_REWRITE_SERVERS', 'auto').lower()
SUBMIT_RESULTS = os.environ.get('HYBRID_SUBMIT_RESULTS', '1') == '1'

# --- sesi 9 (assist mode): parallelism + VPS/edge upload split ------------
def _int_env(name, dflt=0):
    try:
        return int(os.environ.get(name, str(dflt)))
    except ValueError:
        return dflt


def _float_env(name, dflt):
    try:
        v = float(os.environ.get(name, str(dflt)))
        return v if 0.0 <= v <= 1.0 else dflt
    except ValueError:
        return dflt


DL_THREADS = _int_env('HYBRID_DL_THREADS', 0)
UL_THREADS = _int_env('HYBRID_UL_THREADS', 0)
DL_COUNTS = _int_env('HYBRID_DL_COUNTS', 0)
VPS_UL_SHARE = _float_env('HYBRID_VPS_UL_SHARE', 0.15)
# Optional: the operator's own server list (JSON array of speedtest-server
# entries). When set, it REPLACES the geo-localized speedtest.net list — this
# is the "speedtest pointed at the domain list" mode. The URL of every
# entry is rewritten to the VPS front.
SERVER_LIST_FILE = os.environ.get('HYBRID_SERVER_LIST_FILE', '')

# --- session token: LAZY mint + TTL refresh -------------------------------
# BUG FIX (2026-11-25): the token used to be minted once at IMPORT time —
# a run slower than the 5-minute TTL (slow links; the stock engine runs many
# upload rounds) got 401s from /__up and the result submission was skipped.
# The token is now minted lazily on first use and re-minted when it is
# older than TTL_MARGIN seconds (importing --help no longer performs a
# network call either).
TOKEN_TTL_MS = 300000
TTL_MARGIN = 45  # re-mint this many seconds before expiry

_token_cache = {'token': None, 'minted_at': 0.0}


def _session_token(force=False):
    now = time.time()
    age_ms = (now - _token_cache['minted_at']) * 1000.0
    if (not force and _token_cache['token'] is not None
            and age_ms < TOKEN_TTL_MS - TTL_MARGIN * 1000):
        return _token_cache['token']
    req = urllib.request.Request(
        GATEWAY_BASE + '/api/sessions',
        data=b'{}',
        headers={'Content-Type': 'application/json'},
        method='POST',
    )
    with urllib.request.urlopen(req, timeout=20) as r:
        _token_cache['token'] = json.load(r)['token']
        _token_cache['minted_at'] = now
        return _token_cache['token']


def _token_guid():
    tok = _token_cache['token']
    if tok and tok.count('~') >= 4:
        return tok.split('~')[1]
    return None


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

# --- hook 3 (sesi 9): parallelism overrides (engine CONFIG, not the
# measurement algorithm — the stock thread counts come from speedtest.net
# and cap aggregates far below client capacity on fast links; Ookla's own
# CLI scales 4→32 connections). 0 = keep stock. ---------------------------
_orig_get_config = st.Speedtest.get_config


def hybrid_get_config(self):
    result = _orig_get_config(self)
    try:
        threads = self.config.get('threads') or {}
        counts = self.config.get('counts') or {}
        if DL_THREADS > 0 and 'download' in threads:
            threads['download'] = DL_THREADS
        if UL_THREADS > 0 and 'upload' in threads:
            threads['upload'] = UL_THREADS
        if DL_COUNTS > 0 and 'download' in counts:
            counts['download'] = max(int(counts['download']), DL_COUNTS)
    except (TypeError, ValueError, KeyError):
        pass
    return result


st.Speedtest.get_config = hybrid_get_config

# --- hook 2: split upload POSTs between the Worker edge and the VPS front ---
# "CF membantu beban, bukan menggantikan": a weighted fraction of the upload
# POSTs keeps its original URL (the VPS front upload.php drain — the VPS's
# ingress contribution), the rest go directly to the Worker __up with a
# Bearer session token (the only way a urllib client can reach the edge:
# stock urllib streams the full body before reading any redirect, so a 307
# cannot offload uploads — see docs).
_orig_build_request = st.build_request
_UL_SEQ = {'n': 0, 'phase': 0.0}


def _pick_upload_lane():
    """Bresenham-style weighted interleave: deterministic VPS/edge split that
    distributes from the FIRST requests (the naive `n % 1000 < share*1000`
    sent the first 150 consecutive requests ALL to the VPS — a speedtest run
    only has ~50-100 upload POSTs, so the edge never saw a single one)."""
    _UL_SEQ['phase'] += VPS_UL_SHARE
    if _UL_SEQ['phase'] >= 1.0:
        _UL_SEQ['phase'] -= 1.0
        return True  # VPS lane
    return False  # edge lane


def hybrid_build_request(url, data=None, headers=None, bump='0', secure=False):
    # BUG FIX (2026-11-25): the reroute previously hijacked EVERY
    # data-carrying request — sivel's `Speedtest.share()` (--share) also
    # POSTs a body (to www.speedtest.net/share/api/0) and was silently
    # shipped to the Worker. Only the speedtest upload endpoint is rerouted.
    is_upload_target = 'upload.php' in (url or '')
    if data is not None and is_upload_target and GATEWAY_BASE and WORKER_BASE:
        _UL_SEQ['n'] += 1
        to_vps = VPS_UL_SHARE > 0.0 and _pick_upload_lane()
        if not to_vps:
            url = WORKER_BASE + '/__up'
            headers = dict(headers or {})
            headers['Authorization'] = 'Bearer ' + _session_token()
        # else: keep the original URL — the POST drains at the VPS front
        # (its share of the aggregate upload measurement).
    return _orig_build_request(url, data=data, headers=headers,
                               bump=bump, secure=secure)


st.build_request = hybrid_build_request


def submit_results(document):
    """POST the final speedtest result document to the gateway (best effort)."""
    if not (GATEWAY_BASE and _token_cache['token']):
        return None
    try:
        payload = {
            'token': _session_token(),  # fresh/valid token for the intake
            'guid': _token_guid(),
            'metrics': document,
            'accounting': {
                'downloadBytes': document.get('bytes_received'),
                'uploadBytes': document.get('bytes_sent'),
                'pingMs': document.get('ping'),
                'client': 'speedtest-cli-hybrid/1.2 (engine: speedtest-cli %s)'
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
        # Mint the session token now (after flags are known — --help and
        # friends never touch the network; see the lazy-mint fix above).
        if GATEWAY_BASE and WORKER_BASE:
            _session_token()
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
