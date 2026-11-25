# CLI official sandbox campaign — 2026-11-25 (session 8, non-publishing)

Official Ookla CLI 1.2.0.84 (x86_64, sha256 5690596c…dfeeb7, from
speedtest-cli_official/) run from an external sandbox against the production
VPS daemon via mock-DNS: user+mount namespace (`unshare -rm`) with a
bind-mounted /etc/hosts mapping the 9 official Surabaya server hostnames to
45.126.249.250 (see mock-hosts.txt) and blackholing results.speedtest.net
to 127.0.0.1 (no result submission — persisted:false in both runs, per the
forced-endpoint testing rule).

Results (both exit 0, full latency+download+upload+packet-loss):
- t1 server 74964 (speedtest.somedigit.net:8080): 65.311 ms latency,
  451.689 Mbps down (499,715,080 B), 133.421 Mbps up (190,732,985 B), loss 0%
- t2 server 61853 (speedtest-sby.xl.co.id:8080): 63.493 ms latency,
  435.964 Mbps down (616,607,572 B), 155.019 Mbps up (230,954,154 B), loss 0%

Method: the same mock-DNS technique as the e-m campaign (24 Nov), executed
without root via unshare+bind-mount. Raw JSON is the CLI's own output.
