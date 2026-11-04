# ARCHITECTURE_TARGET (canonical implementation, this audit)

```
bin/ooklaserver.ts ──► ConfigManager (search-path + --config + env + new keys)
                              │            OoklaServer.netgaugeVersionString
                              │            OoklaServer.evidenceLogFile
                              ▼
                        OoklaServer (facade: config → TLS material → ServerCore)
                              │   cert/key from openSSL.server.* or generated ./certs
                              ▼
 ┌──────────────────────── ServerCore ─────────────────────────┐
 │ one net listener per tcpPort (dual-stack), binds FAIL-CLOSED │
 │ per connection, sniff first bytes:                            │
 │   0x16 →03 → tls.TLSSocket(min 1.2) → sniff plaintext again   │
 │   HTTP method → http.Server (sockets injected, unshift)       │
 │   else        → NetGaugeEngine (TCP or TLS-wrapped session)   │
 │                                                               │
 │ http.Server ──► HttpApi handler (byte-parity legacy surface) │
 │      └─ 'upgrade' → /ws → ws lib → NetGaugeEngine over WS    │
 │                     (other paths: 200 page / 404, close)     │
 │                                                               │
 │ UdpLossEngine per udpPort ──► LossRegistry ◄─── INITPLOSS/PLOSS (TCP side)
 │        LOSS 4-field: count-only      LOSS 5-field: → RECV      │
 │                                                               │
 │ EvidenceLog (JSONL): connections, commands, byte counters     │
 └───────────────────────────────────────────────────────────────┘
```

Key invariants:

1. **One listener per port** — all protocols multiplexed; a bind failure is fatal.
2. **One protocol engine** shared by TCP, TLS and WebSocket transports
   (`NetGaugeSessionHooks` abstracts the wire).
3. **Evidence is built in** — every gate claim can be corroborated from the
   server's own counters.
4. **Zero outbound connections** — standalone by construction.
5. Fail-closed gates: unknown targets, absent listeners or leftover official
   daemons abort validation runs (harness scripts).
