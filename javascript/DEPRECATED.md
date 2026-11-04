# DEPRECATED — 2026-11-04

This JavaScript tree is a frozen 1:1 port of the TypeScript implementation as
of `f3ea41c` and shares all of its P0 defects (competing listeners with
swallowed EADDRINUSE, no native NetGauge protocol, WS random-bytes, UDP blind
echo — see `../validation/FINDINGS.md`). It **cannot run** as shipped
(`ws` not installed) and its `npm test` was `echo … && exit 0`.

**The canonical implementation is `../reverse-engineered/typescript/`**
(ServerCore + NetGaugeEngine + UdpLossEngine + HttpApi), verified against the
official Speedtest CLI. See `../validation/DECISIONS.md` (D-1).

This tree is kept for historical reference only. Do not add features here;
do not present it as a working server. Removal is planned after one release
cycle with the TypeScript core stable (`../validation/HANDOFF.md`).
