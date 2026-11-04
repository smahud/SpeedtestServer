# PERFORMANCE_REPORT

Environment: single sandbox node, Debian 13, unprivileged user, Node v24.22.2,
loopback topology. Numbers are not comparable to production NIC throughput and
are not required to be (MASTER PROMPT §15: functional correctness and
compatibility are the mandatory baseline; host limitations dominate).

## Throughput (official CLI runs)

| Path | Download | Upload | Notes |
|---|---|---|---|
| CLI → reference daemon (direct) | 67–68.8 Gbps | 37.6–42.3 Gbps | C++/POCO, multi-threaded |
| CLI → SpeedtestServer (direct) | 18.4–21.7 Gbps | 13.6–15.7 Gbps | Node single-process |
| CLI → STS vs daemon (ratio) | ~30% | ~37% | expected: single-threaded JS vs native threaded daemon on loopback |

Run-to-run variability (STS): 18.4–21.7 Gbps download across 3 runs (±8%),
exit 0 and packetLoss 0 in every run — stability is the requirement, and it held.

## Sustained load

- 3 replacement runs moved ≈63 GB down + ≈55 GB up through one process in
  ~60 s total; the host-tester differential added 17.5 GB (daemon) and
  11.9 GB (STS) of mixed traffic.
- After all runs the evidence counters showed connections closed and the
  process remained responsive (immediate `PING → PONG` checks passed between
  runs — negative-tests.mjs's `alive()` probe).
- RSS after sustained load: stable (no growth trend across the 6 CLI runs;
  detailed leak profiling with --expose-gc left as future work, see HANDOFF).

## Resource behavior details

- Download streaming is **backpressure-aware** (write→drain), so a slow client
  cannot balloon memory; the 2 MiB pool is shared, so N concurrent downloads
  cost O(1) extra memory.
- Uploads are consumed incrementally (never buffered beyond the current chunk).
- CPU: single event loop saturates near ~20 Gbps on this host — the practical
  ceiling observed. For higher scales: cluster mode / multiple processes is
  the natural next step (see HANDOFF future work).

## Comparison verdict

Functional correctness and protocol compatibility: **equivalent** (the
differential matrix is behaviorally identical; CLI gates pass 3/3). Raw
throughput: lower than the native daemon on loopback by design of the runtime,
not of the protocol; acceptable per assignment rules and typical of real-world
deployments where uplinks (≤1–10 Gbps) are the bottleneck, not the server.
