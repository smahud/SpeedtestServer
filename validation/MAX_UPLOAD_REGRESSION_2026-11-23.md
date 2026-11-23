# Maximum upload regression hardening — 2026-11-23

The operator reported a renewed `max_upload` failure after the HTTP route repair.
The exact hosted tester request was unavailable, so this pass first reproduced
the public endpoints rather than assuming which request caused that verdict.

## Observations before the change

Ordinary ASCII uploads at 515,798, 1,980,998 and 1,981,500 wire bytes succeeded
on native HTTP/TLS port 8080, and the normal PHP-style ASCII checks succeeded on
port 80. The previous route repair did not by itself explain the renewed failure.

Two separate defects were reproduced in the port-80 fallback against the actual
reference `upload.php` script executed by PHP:

1. `content1=a%FF` must report `size=513`, but the fallback reported `size=515`.
   URLSearchParams decoded non-UTF-8 bytes into replacement characters, changing
   the value's byte length relative to PHP `strlen`.
2. A maximum value of 1,980,989 bytes encoded as `%FF` expands to **5,942,976 wire
   bytes** with its form key. The old 4 MiB cap rejected it (413 in regression;
   broken pipe while sending publicly), while PHP returned `size=1981500`.

These are confirmed fallback compatibility defects. They do not prove that the
private hosted tester used precisely these payloads.

## Scoped implementation

The fallback now uses `PhpFormCounter` to count decoded bytes incrementally,
without decoding values as UTF-8 or retaining the complete values in memory.
Percent sequences spanning chunks, malformed escapes, plus/space decoding,
duplicate scalar values and byte lengths are regression tested.

The wire cap is 8 MiB, sufficient for percent-encoding expansion of the maximum
test and aligned with the PHP reference's default post_max_size. It remains
bounded, with 1,024-byte field names and 1,000 scalar input fields. This is a
scalar-form compatibility profile, not a complete replacement for PHP arrays,
multipart parsing or all $_REQUEST configuration modes.

Native daemon uploads retain their raw-body accounting. The previous native
crossdomain/upload route fixes were not modified by this change.

## Regression evidence

All paths below are under `evidence/max-upload-regression-20261123/`:

- `php-byte-reference.json`: **9/9** live HTTP comparisons with the original PHP
  script match, including ordinary/max ASCII, percent-encoded maximum, raw and
  encoded non-UTF-8 bytes, UTF-8, duplicate fields and malformed escapes.
- `regression-suite.log`: **203/203** complete source tests pass.
- `public-before.json`: **29 passed, 2 failed** in the expanded 31-case gate.
- `public-after.json`: **31/31 pass** through public DNS and strict TLS. This
  single gate includes full crossdomain port policies and aliases, upload
  OPTIONS/aliases, small and large native HTTP/TLS uploads, ordinary/max legacy
  ASCII and percent-encoded legacy max uploads.
- `host-tester-after.json`: **19/19** independent repo tester result, retained
  separately from the stricter byte/encoding checks above.

## Deployment isolation

Only the legacy fallback runtime modules were replaced and its service restarted.
`speedtestserver` remained PID **271356** and nPerf remained PID **1268**.
The deployment asserts that both the main PID and the hashes of HttpApi.js and
OoklaServer.js remain unchanged. Its rollback hook restores the old fallback if
the combined gate fails.

Backup: `/root/speedtestserver-rollback/max-upload-E64ODq`.
The deployment's targeted 43-case regression run and runtime assertions are in
`deployment-rpc.json`.

Reproduce the combined public acceptance gate:

```sh
python3 validation/harness/check-http-compatibility.py --host speedtest.lumajangnetworks.my.id
```

These results are reference/regression/public endpoint evidence. A new passing
verdict from the CAPTCHA-protected official hosted tester has not been observed
by this agent and is not claimed.
