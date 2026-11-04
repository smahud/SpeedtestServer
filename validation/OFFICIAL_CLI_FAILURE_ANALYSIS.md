# OFFICIAL_CLI_FAILURE_ANALYSIS — every failure we hit, its cause and fix

Ordered by discovery; each entry ends with the divergence class from
MASTER PROMPT §13 and the resolution. No failure was ever "graded away".

## A-1 — First mock attempt: CLI exit 2, no result ("Cannot read from socket")

- **Symptom:** CLI connected to our plaintext prototype, exchanged nothing for
  3 s, reset, then selected a *real* Hong-Kong server and tested that instead
  (proxy had rewritten only one entry — the CLI silently fell back to an
  unrelated production server!).
- **First divergence point:** the CLI's encrypted-binary hello received **no
  response** from our server.
- **Root cause (ours):** the prototype never parsed the first buffered chunk
  (`head`) — the binary hello ending in `\n` sat in a buffer until more bytes
  arrived. The 3 s idle timeout then failed the probe.
- **Class:** server bug (prototype). **Fix:** parse the initial buffer
  immediately; regression-covered.
- **Harness lesson (hardened):** redirect **all** server entries to the lab
  target and verify the selected server post-run, so an accidental
  production-server test can never count as a replacement PASS. Also fixed the
  prototype's UDP first-packet race (bind-before-send).

## A-2 — Packet loss 51.5% on the relayed baseline run

- **Symptom:** baseline run through the recording relay reported
  `packetLoss 0.515` with 627 client datagrams and **zero** RECV responses
  observed by the relay, while direct runs report 0.
- **Analysis:** controlled experiments against the daemon (documented in
  `PROTOCOL_CONTRACT.md §3`) show RECV replies go to the UDP source address.
  For encrypted-protocol sessions the daemon additionally validates a
  client-self-reported address; behind the relay's NAT the reported (`::1`)
  and observed (`127.0.0.1`) addresses differ, so the daemon stopped replying.
- **Class:** environmental (measurement-path artifact), not a protocol bug.
- **Resolution:** gate runs are **direct** (no relay); the relay is used only
  for protocol capture. Baseline re-run direct: loss 0.

## A-3 — Upload phase stalled in the second prototype run (exit 2, no result)

- **Symptom:** 8 × `UPLOAD 32000000` started, none completed; CLI aborted.
- **First divergence point:** our UPLOAD accounting expected `n` bytes *after*
  the command line; the CLI sends `n` bytes *including* the command line.
- **Root cause:** upload byte-counting semantics were ambiguous in prior
  agents' findings (both interpretations fit their single data point).
- **Resolution:** settled by controlled daemon probes
  (`UPLOAD 100\n` + 89 B → `OK 100`; short payload → silence) — **inclusive**
  counting. Implemented + unit-tested (`UPLOAD waits until n total bytes`).
- **Class:** protocol-contract gap, closed with first-hand evidence (F-2).

## A-4 — GETIP/CAPABILITIES answered with ERROR (early prototype)

- **Symptom:** CLI proceeded past probes but the qualification flow expects
  `YOURIP`/`CAPABILITIES` (observed in fallback transcripts).
- **Resolution:** probed the daemon for exact response bytes and implemented
  them (`YOURIP <ip>`, `CAPABILITIES SERVER_HOST_AUTH UPLOAD_STATS`,
  `SERVERID`, `UPTIME`). After the fix the full test completes.

## A-5 — Host-tester/differential environment quirks

- The 96 MB largest image makes probe batteries slow; UDP probes always time
  out by design on both servers (naive datagrams are intentionally ignored).
- The probe process can outlive its output (open WS handle) — output JSON is
  complete; noted as a harness quirk, not a server issue.

## Non-issues confirmed as daemon parity

- `UPLOAD_STATS → ERROR` (daemon behaves identically; clients tolerate it).
- `HI <non-uuid> → ERROR`; `INITPLOSS` after bare `HI → ERROR` (daemon parity;
  we deviate only where required — see DECISIONS D-3).
- "Connection reset by peer" at CLI teardown is normal on both servers.
