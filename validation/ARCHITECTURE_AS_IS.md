# ARCHITECTURE_AS_IS (baseline `f3ea41c`, before this audit)

```
bin/ooklaserver.ts ──► ConfigManager ──► OoklaServer (facade)
                                            │
        ┌───────────────────────────────────┼───────────────────────────┐
        ▼                                   ▼                           ▼
 OoklaRequestHandler                InstanceLocker               TLSCertificateManager
   ├─ http.Server  (httpPorts=[8080])   mkdir /var/lock/...      mkdir /etc/ooklaserver/certs
   ├─ https.Server (tcpPorts=[5060,8080])  ↑ EACCES as non-root   self-sign via node-forge
   │    → BOTH try to bind 8080; EADDRINUSE swallowed → "success"     + ACME client with
   ├─ ws.Server (noServer) on both            rejectUnauthorized:false (outbound!)
   ├─ dgram UDP echo (no protocol)
   ├─ HTTP route table: JSON-mangled bodies, no /hi, no /random*.jpg,
   │   /ws sends crypto.randomBytes()
   └─ (no net.Server anywhere → NO native NetGauge protocol)
 BinaryManager (mock data, throws) · MetricsUploader (no-op) · TracerouteManager (fake hops)
```

Defect consequences: a Speedtest client could not complete even a handshake;
the server could not start unprivileged; a bind failure was reported as
success. Full defect register with file:line references: `FINDINGS.md`.
