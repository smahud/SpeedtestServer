/**
 * NetGaugeEngine — transport-agnostic command engine for the Ookla
 * Speedtest native protocol ("NetGauge"), reconstructed from authorized
 * observations of OoklaServer 2.11.5.2 (2026-06-04.1737.7d0993d).
 *
 * Wire contract (all verified against the reference daemon; see
 * validation/PROTOCOL_CONTRACT.md — revision 3 differential probes,
 * 2026-11-04):
 *   Client → Server commands are `\n`-terminated ASCII lines.
 *   HI                     → HELLO <version>
 *   HI <uuid>              → HELLO <version>            (arg must be UUID-shaped)
 *   HI <bad-arg>           → ERROR                      (incl. empty trailing arg)
 *   HI <a> <b>…            → connection CLOSED, no reply (daemon JWT-parse path)
 *   GETIP                  → YOURIP <peer-ip>           (STRICT: the line must be
 *                            exactly "GETIP"; any trailing bytes incl. \r, spaces
 *                            or extra commands in the same read silently MUTE the
 *                            connection — verified daemon quirk F-11/F-12)
 *   CAPABILITIES           → CAPABILITIES SERVER_HOST_AUTH UPLOAD_STATS (extra args tolerated)
 *   SERVERID               → SERVERID <instance-uuid>   (LOWER-CASE uuid; extra args tolerated)
 *   UPTIME                 → UPTIME <seconds>           (extra args tolerated)
 *   PING <x>               → PONG <server-epoch-ms>     (argument REQUIRED; any value)
 *   PING                   → ERROR
 *   INITPLOSS              → OK                          (arms packet-loss accounting)
 *   PLOSS                  → PLOSS <count> <dupes> <maxseq>
 *   UPLOAD_STATS (argless) → ERROR                       (daemon parity — verified
 *                            2026-11-27 on production OoklaServer 2.11.5 AND
 *                            2.11.7: no-arg form answers ERROR even with a session)
 *   UPLOAD_STATS <durMs> <intMs> [<index>]
 *                          → newline-delimited JSON stream (web-client remote
 *                            upload measurement; verified 2026-11-27 against
 *                            production 2.11.5/2.11.7 and a real speedtest.net
 *                            web run — 302 frames for `UPLOAD_STATS 15000 50 0`):
 *                            immediate ack {"t":"u"}\n, then every intMs a line
 *                            {"b":<session upload bytes since stream start>,
 *                             "e":<i*intMs>,"i":<index+i>,"t":"u"}\n, then the
 *                            transport is CLOSED (WS close code 1000) once
 *                            durMs elapses. REQUIRES a session ("HI <uuid>") —
 *                            with a bare HI the daemon answers ERROR.
 *   DOWNLOAD <n>           → exactly n bytes: "DOWNLOAD " prefix (truncated for
 *                            n<10) + (n-10) pool bytes + trailing "\n" (all counted
 *                            in n; n=0 → just "\n"). Pool data is printable ASCII
 *                            [0x20..0x7F] (daemon charset, verified F-9).
 *   UPLOAD <n> [ms] [c]    → reads n bytes INCLUSIVE of the command line, then
 *                            OK <n> <epoch-ms>. n < command-line length → ERROR
 *                            (n=0 included). Non-numeric/negative n → silently
 *                            ignored (connection continues). TCP ONLY — over
 *                            WebSocket every frame that starts with the 7-byte
 *                            prefix "UPLOAD " is a RAW UPLOAD FRAME counted by
 *                            its full frame length (no size parsing, no payload
 *                            phase), answered `OK <frame-length> <epoch-ms>`
 *                            (verified 2026-11-27 on production 2.11.5/2.11.7:
 *                            a 9-byte "UPLOAD 50" frame is answered
 *                            `OK 9 <epoch>` — the CLI size-command form does not
 *                            exist over WS). See feedRawUploadFrame().
 *   DOWNLOAD 0 (ws)        → ERROR over WebSocket (verified 2026-11-27,
 *                            production 2.11.5); over TCP it stays "\n".
 *   QUIT                   → close (TCP) / ERROR reply (WebSocket — verified F-14)
 *   <unknown>              → ERROR
 *
 * The official Speedtest CLI first attempts an encrypted (binary) hello; an
 * ERROR reply makes it fall back to this plaintext protocol — that fallback
 * is what makes an independent, unencrypted implementation interoperable.
 */

export interface NetGaugeSessionHooks {
  /** Send raw bytes to the client (TCP socket or WS frame). */
  write(data: Buffer): boolean;
  /** Send a protocol line. `noNewline` is used only for the WS HELLO quirk. */
  writeLine(line: string, noNewline?: boolean): boolean;
  /** Peer IP (normalized) for GETIP / session binding. */
  peerIp(): string;
  /** Close the transport. */
  close(): void;
  /** Optional evidence sink. */
  onEvent?(kind: string, detail: Record<string, unknown>): void;
}

export interface NetGaugeEngineOptions {
  versionString: string;      // e.g. "2.11 (2.11.5) 2026-06-04.1737.7d0993d"
  instanceUuid: string;       // stable per-process instance id (LOWER-CASE, daemon parity)
  maxLineBytes: number;       // command line cap (default 1 MiB)
  maxDownloadBytes: number;   // per-DOWNLOAD cap (default 2 GiB - 1)
  maxUploadBytes: number;     // per-UPLOAD cap (default 2 GiB - 1)
  pool: Buffer;               // random data pool (2 MiB printable ASCII, daemon parity)
  loss: LossRegistry;         // shared UDP LOSS registry for INITPLOSS/PLOSS
  startedAt: number;          // process start time (ms)
  /** QUIT behavior per transport: TCP closes the connection (daemon parity);
   *  WebSocket replies ERROR and keeps the session (verified F-14). */
  quitMode?: 'close' | 'error';
  /** Verified F-24 (daemon "three strikes"): a TCP connection is closed right
   *  after the 3rd cumulative ERROR reply. Valid commands do NOT reset the
   *  counter; the HI bad-argument ERROR does NOT count; WebSocket sessions
   *  do not enforce the limit at all. 0 disables (default). */
  errorStrikeLimit?: number;
  /** Transport the engine is attached to. 'ws' (WebSocket) selects the
   *  transport-specific daemon quirks verified on production servers
   *  (2026-11-27): DOWNLOAD 0 answers ERROR instead of "\n". */
  transport?: 'tcp' | 'ws';
  /** Shared cross-connection upload-session accounting (per run GUID). The
   *  web client binds ALL its upload traffic to one GUID — "HI <uuid>" on the
   *  WebSocket and "?guid=<uuid>" on every XHR upload — and the daemon's
   *  UPLOAD_STATS stream reports the session's cumulative received bytes
   *  (verified with a real speedtest.net run: 302 frames, b → 1.14 GB).
   *  When unset, UPLOAD_STATS answers ERROR (no session accounting). */
  uploadSessions?: UploadSessionRegistry;
}

/**
 * UploadSessionRegistry — per-run-GUID cumulative upload byte accounting,
 * shared across transports (WS raw upload frames, CLI UPLOAD payloads and
 * XHR/legacy HTTP upload bodies — the HTTP side attributes via the "?guid="
 * query parameter exactly like the web client sends it).
 *
 * Bounded like LossRegistry (F-33): client-supplied GUIDs are an
 * exhaustion vector, so the registry caps the number of tracked sessions
 * (default 4096) and evicts the least-recently-added entry. Only UUID-shaped
 * keys are accepted (the daemon binds sessions to UUIDs; junk GUID params
 * from HTTP requests must not allocate registry entries).
 */
export class UploadSessionRegistry {
  private totals = new Map<string, number>();
  private maxSessions: number;

  constructor(maxSessions = 4096) {
    this.maxSessions = Math.max(1, Math.floor(maxSessions));
  }

  size(): number {
    return this.totals.size;
  }

  /** Attribute n received upload bytes to a session. Invalid (non-UUID) keys
   *  are ignored — only daemon-shaped session identifiers allocate entries. */
  add(uuid: string, n: number): void {
    if (!UUID_RE.test(uuid) || !Number.isFinite(n) || n <= 0) return;
    const total = (this.totals.get(uuid) ?? 0) + Math.floor(n);
    if (!this.totals.has(uuid) && this.totals.size >= this.maxSessions) {
      const oldest = this.totals.keys().next().value;
      if (oldest !== undefined) this.totals.delete(oldest);
    }
    this.totals.delete(uuid); // re-insert at the end (recency order)
    this.totals.set(uuid, total);
  }

  get(uuid: string): number {
    return this.totals.get(uuid) ?? 0;
  }
}

/** Packet-loss session registry shared between the TCP and UDP engines.
 *
 *  Bounded resource management (F-33): the registry accepts client-supplied
 *  UUIDs, so it is a memory-exhaustion vector — a bounded burst of distinct
 *  valid session identifiers from a single source used to be retained in
 *  full (verified 2026-11-05: 100k UUIDs from one IP → +20.5 MB heap, all
 *  live). The registry now enforces:
 *    - a per-source-IP session cap (default 64) for fairness — one client
 *      IP cannot crowd out other clients' sessions;
 *    - a global session cap (default 2048) — bounds registry memory to well
 *      under 1 MB regardless of datagram rate.
 *  Both caps evict the LEAST RECENTLY SEEN session(s), so the newest
 *  legitimate session always wins. The official CLI registers exactly ONE
 *  uuid per test, so the defaults leave orders of magnitude of headroom
 *  while preserving the UDP LOSS/RECV/PLOSS contract verbatim.
 */
export interface LossSession {
  uuid: string;
  clientIp: string;
  count: number;
  dupes: number;
  maxSeq: number;
  lastSeen: number;
}

export interface LossRegistryOptions {
  /** Global concurrent-session cap (default 2048). */
  maxSessions?: number;
  /** Per-source-IP concurrent-session cap (default 64). */
  maxSessionsPerIp?: number;
}

export class LossRegistry {
  /** uuid → session. Map iteration order == recency order: touched entries
   *  are re-inserted at the end, so the FIRST entry is the least recently
   *  seen — the eviction candidate. */
  private sessions = new Map<string, LossSession>();
  /** Live sessions per normalized source IP (eviction bookkeeping). */
  private perIpCounts = new Map<string, number>();
  private maxSessions: number;
  private maxSessionsPerIp: number;

  constructor(opts: LossRegistryOptions = {}) {
    this.maxSessions = Math.max(1, Math.floor(opts.maxSessions ?? 2048));
    this.maxSessionsPerIp = Math.max(1, Math.floor(opts.maxSessionsPerIp ?? 64));
  }

  /** Number of live tracked sessions (observability/tests). */
  size(): number {
    return this.sessions.size;
  }

  /** Live sessions for one normalized source IP (tests). */
  sizeForIp(ip: string): number {
    return this.perIpCounts.get(normalizeIp(ip)) ?? 0;
  }

  /** Move a session to the most-recent position (Map re-insert). */
  private touch(s: LossSession): void {
    this.sessions.delete(s.uuid);
    this.sessions.set(s.uuid, s);
  }

  /** Drop a session (map + per-IP bookkeeping). */
  private remove(s: LossSession): void {
    this.sessions.delete(s.uuid);
    const ipKey = normalizeIp(s.clientIp);
    const n = this.perIpCounts.get(ipKey) ?? 0;
    if (n <= 1) this.perIpCounts.delete(ipKey);
    else this.perIpCounts.set(ipKey, n - 1);
  }

  /** Evict the least-recently-seen session (globally, or within one IP). */
  private evictOldest(forIp?: string): LossSession | undefined {
    if (forIp === undefined) {
      const first = this.sessions.values().next().value;
      if (!first) return undefined;
      this.remove(first);
      return first;
    }
    const ipKey = normalizeIp(forIp);
    for (const s of this.sessions.values()) {
      if (normalizeIp(s.clientIp) === ipKey) {
        this.remove(s);
        return s;
      }
    }
    return undefined;
  }

  /** Get or auto-register a session (permissive: client-supplied UUIDs are
   *  accepted so plaintext-fallback clients — which pick their own UUIDs —
   *  get working packet-loss accounting), subject to the F-33 bounds. */
  ensure(uuid: string, clientIp: string): LossSession {
    const existing = this.sessions.get(uuid);
    if (existing) {
      this.touch(existing);
      return existing;
    }
    const ipKey = normalizeIp(clientIp);
    if ((this.perIpCounts.get(ipKey) ?? 0) >= this.maxSessionsPerIp) {
      this.evictOldest(clientIp); // fairness: the IP's own oldest goes first
    }
    if (this.sessions.size >= this.maxSessions) {
      this.evictOldest(); // then the global oldest (any IP)
    }
    const s: LossSession = { uuid, clientIp, count: 0, dupes: 0, maxSeq: -1, lastSeen: Date.now() };
    this.sessions.set(uuid, s);
    this.perIpCounts.set(ipKey, (this.perIpCounts.get(ipKey) ?? 0) + 1);
    return s;
  }

  get(uuid: string): LossSession | undefined {
    return this.sessions.get(uuid);
  }

  /** Stats of the most recently active session (daemon behavior). */
  latest(): LossSession | undefined {
    let out: LossSession | undefined;
    for (const s of this.sessions.values()) if (!out || s.lastSeen > out.lastSeen) out = s;
    return out;
  }

  statsLine(): string {
    const s = this.latest();
    if (!s) return 'PLOSS 0 0 0';
    return `PLOSS ${s.count} ${s.dupes} ${Math.max(0, s.maxSeq)}`;
  }

  /** Record one UDP LOSS packet. Returns the reply text or null (4-field form). */
  recordLoss(uuid: string, clientIp: string, seq: number, clientTimer?: string): string | null {
    const s = this.ensure(uuid, clientIp);
    if (normalizeIp(s.clientIp) !== normalizeIp(clientIp)) return null; // anti-spoof (daemon parity)
    s.lastSeen = Date.now();
    this.touch(s);
    if (seq <= s.maxSeq) s.dupes++;
    else s.maxSeq = seq;
    s.count++;
    if (clientTimer === undefined) return null; // 4-field init form: counted, not answered
    return `RECV ${seq} ${clientTimer} [${s.count} ${seq} ${s.dupes}]`;
  }

  gc(maxIdleMs: number): void {
    const now = Date.now();
    for (const s of [...this.sessions.values()]) {
      if (now - s.lastSeen > maxIdleMs) this.remove(s);
    }
  }
}

export function normalizeIp(ip: string): string {
  if (ip.startsWith('::ffff:')) return ip.slice(7);
  return ip;
}

const UUID_RE = /^[0-9A-Za-z]{8}-[0-9A-Za-z]{4}-[0-9A-Za-z]{4}-[0-9A-Za-z]{4}-[0-9A-Za-z]{12}$/;

/** 9-byte download prefix, counted within n (daemon parity). */
const DOWNLOAD_PREFIX = 'DOWNLOAD ';

export class NetGaugeEngine {
  private hooks: NetGaugeSessionHooks;
  private opts: NetGaugeEngineOptions;
  private buf: Buffer = Buffer.alloc(0);
  private sessionUuid: string | null = null;
  private uploadRemaining = 0;
  private uploadTotal = 0;
  private uploadCounted = 0;
  private downloadActive = false;
  private closed = false;
  /** Verified daemon quirk (F-12): a malformed GETIP or a pre-session GETIP
   *  followed by extra data in the same read silences the connection: no
   *  replies, no processing, socket kept open until closed/timed out. */
  private muted = false;
  /** True once HI has been seen on this connection (pre-session gate scope). */
  private hiSeen = false;
  /** Cumulative ERROR replies ("three strikes" — verified F-24). */
  private errorStrikes = 0;
  /** Active UPLOAD_STATS stream timer (cleared on stream end / destroy). */
  private statsTimer: NodeJS.Timeout | null = null;
  /** Bytes transferred on this connection (evidence counters). */
  public readonly counters = { commands: 0, downloads: 0, uploads: 0, bytesDown: 0, bytesUp: 0 };

  constructor(hooks: NetGaugeSessionHooks, opts: NetGaugeEngineOptions) {
    this.hooks = hooks;
    this.opts = opts;
  }

  /** Feed received bytes (TCP chunk or WS frame payload).
   * `wireLen` — when the transport SYNTHESIZED a trailing newline for a
   * complete frame without one (WS one-command-per-frame, F-13), the number
   * of bytes actually received on the wire for that first command line; the
   * synthesized byte must NOT count toward the UPLOAD inclusive total. */
  feed(data: Buffer, wireLen?: number): void {
    if (this.closed || this.muted) return;
    // Pre-session GETIP gate (verified F-12): if HI has not been seen yet and
    // the first line of THIS read is exactly "GETIP" with more bytes behind
    // it in the same read, the reference daemon drops the whole connection
    // state (no reply ever again, socket kept open). Replicated verbatim.
    // Scope: command reads only — an in-progress UPLOAD's payload bytes are
    // data, not commands, and must not trip the gate.
    if (!this.hiSeen && this.uploadRemaining === 0 && data.length > 6 && data.subarray(0, 5).toString('latin1') === 'GETIP') {
      const nl = data.indexOf(0x0a);
      if (nl === -1 || nl + 1 < data.length) {
        this.muted = true;
        this.hooks.onEvent?.('conn_muted_getip_gate', { bytes: data.length });
        return;
      }
    }
    this.pendingWireLen = wireLen;
    this.buf = Buffer.concat([this.buf, data]);
    this.processBuffer();
  }

  /** Wire length of the first command line parsed from the current feed
   * (only set by transports that synthesize newlines). */
  private pendingWireLen: number | undefined;


  private processBuffer(): void {
    while (!this.closed && !this.muted) {
      if (this.uploadRemaining > 0) {
        const take = Math.min(this.uploadRemaining, this.buf.length);
        this.uploadCounted += take;
        this.uploadRemaining -= take;
        this.buf = this.buf.subarray(take);
        this.counters.bytesUp += take;
        this.attributeUploadBytes(take);
        if (this.uploadRemaining === 0) {
          this.hooks.onEvent?.('upload_done', { declared: this.uploadTotal, counted: this.uploadCounted });
          this.counters.uploads++;
          this.hooks.writeLine(`OK ${this.uploadTotal} ${Date.now()}`);
        }
        if (this.buf.length === 0) return;
        continue;
      }
      const idx = this.buf.indexOf(0x0a);
      if (idx === -1) {
        if (this.buf.length > this.opts.maxLineBytes) {
          this.hooks.onEvent?.('line_overflow', { bytes: this.buf.length });
          // Terminate the session FIRST: hooks.close() only half-closes the
          // TCP stream (FIN) — data events keep arriving after it, and
          // without `closed` this buffer would grow at line rate forever.
          this.closed = true;
          this.buf = Buffer.alloc(0);
          this.hooks.close();
        }
        return;
      }
      const line = this.buf.subarray(0, idx);
      const lineLen = this.pendingWireLen ?? idx + 1; // includes the newline (UPLOAD counts it) unless it was synthesized
      this.pendingWireLen = undefined;
      this.buf = this.buf.subarray(idx + 1);
      this.processCommand(line, lineLen);
    }
  }

  /** Send ERROR and apply the verified "three strikes" rule (F-24):
   *  the TCP connection closes right after the 3rd cumulative ERROR reply.
   *  `counts` is false for error paths that do NOT increment the counter
   *  (verified: the HI bad-argument ERROR). */
  private errorReply(counts = true): void {
    this.hooks.writeLine('ERROR');
    const limit = this.opts.errorStrikeLimit ?? 0;
    if (counts && limit > 0) {
      this.errorStrikes++;
      if (this.errorStrikes >= limit) {
        this.hooks.onEvent?.('conn_error_strike_close', { strikes: this.errorStrikes });
        this.hooks.close();
        this.closed = true;
      }
    }
  }

  /** Attribute received upload bytes to this connection's session (when a
   *  "HI <uuid>" registered one and a registry is wired). Shared across all
   *  of the run's connections — the web client binds XHR uploads by the
   *  "?guid=" parameter and WS uploads by the session on this transport. */
  private attributeUploadBytes(n: number): void {
    if (this.sessionUuid && this.opts.uploadSessions) {
      this.opts.uploadSessions.add(this.sessionUuid, n);
    }
  }

  /**
   * RAW UPLOAD FRAME (WebSocket only — verified 2026-11-27 against production
   * OoklaServer 2.11.5 and 2.11.7): a frame whose first 7 bytes are the ASCII
   * prefix "UPLOAD " is upload DATA, not a command. The whole frame counts as
   * received upload bytes (no size parsing — a 9-byte "UPLOAD 50" frame is
   * answered `OK 9 <epoch>`, so the CLI size-command form does not exist over
   * WS) and the reply is `OK <frame-length> <epoch-ms>`. The web client sends
   * these frames as binary payloads of exactly the requested message size
   * (bundle: bytes 0..6 = 85,80,76,79,65,68,32, then random bytes ≥ 0x14).
   */
  feedRawUploadFrame(buf: Buffer): void {
    if (this.closed || this.muted) return;
    this.counters.uploads++;
    this.counters.bytesUp += buf.length;
    this.attributeUploadBytes(buf.length);
    this.hooks.onEvent?.('upload_frame', { bytes: buf.length });
    this.hooks.writeLine(`OK ${buf.length} ${Date.now()}`);
  }

  /**
   * UPLOAD_STATS stream (web-client remote upload measurement — verified
   * 2026-11-27 on production 2.11.5/2.11.7 and against a real speedtest.net
   * web run that streamed 302 frames for `UPLOAD_STATS 15000 50 0`):
   *
   *   "HI <uuid>" (session) is REQUIRED — with a bare HI the daemon answers
   *   ERROR (verified). The argless form answers ERROR even with a session
   *   (verified). 2 or 3 integer arguments are accepted:
   *   `UPLOAD_STATS <durationMillis> <intervalMillis> [<index>]`.
   *
   *   Reply: an immediate ack line `{"t":"u"}`, then one line every
   *   intervalMillis `{"b":<session upload bytes received since the stream
   *   started>,"e":<i*intervalMillis>,"i":<index+i>,"t":"u"}` until
   *   durationMillis elapses, then the transport is CLOSED (WS close code
   *   1000 — verified). A second UPLOAD_STATS on the same connection
   *   replaces the active stream.
   */
  private startUploadStats(durationMs: number, intervalMs: number, index: number): void {
    this.stopUploadStats();
    const sessions = this.opts.uploadSessions;
    if (!sessions || !this.sessionUuid) {
      // Verified: no session (bare HI) → ERROR.
      this.errorReply();
      return;
    }
    const baseline = sessions.get(this.sessionUuid);
    let i = 0;
    const emitLine = (): void => {
      if (this.closed) return;
      const b = sessions.get(this.sessionUuid as string) - baseline;
      const e = i * intervalMs;
      this.hooks.writeLine(`{"b":${Math.max(0, b)},"e":${e},"i":${index + i},"t":"u"}`);
    };
    // Immediate ack (no b/e/i fields — verified shape), then the first data
    // line right away with e=0 (the observed stream delivered 1 ack + 301
    // lines for `15000 50`: i=0..300, e=0..15000).
    this.hooks.writeLine('{"t":"u"}');
    emitLine();
    const startedAt = Date.now();
    this.statsTimer = setInterval(() => {
      if (this.closed) {
        this.stopUploadStats();
        return;
      }
      i++;
      emitLine();
      if (Date.now() - startedAt >= durationMs) {
        this.stopUploadStats();
        this.hooks.onEvent?.('upload_stats_done', { durationMs, intervalMs, lines: i + 1 });
        this.hooks.close();
      }
    }, intervalMs);
  }

  private stopUploadStats(): void {
    if (this.statsTimer !== null) {
      clearInterval(this.statsTimer);
      this.statsTimer = null;
    }
  }

  private processCommand(line: Buffer, lineLen: number): void {
    const rawLine = line.toString('latin1');
    // Verified F-25: the daemon strips ONE trailing \r before command
    // dispatch ("HI\r" → HELLO, "PING 1\r" → PONG) — except GETIP, whose
    // strictness check runs on the RAW line ("GETIP\r" mutes the connection).
    const s = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine;
    this.counters.commands++;
    this.hooks.onEvent?.('cmd', { line: s.length > 80 ? s.slice(0, 80) + '…' : s });

    if (s === 'HI' || s.startsWith('HI ')) {
      const tokens = s.split(' ');
      if (tokens.length === 1) {
        // Bare HI: no session registration.
        this.hiSeen = true;
        this.hooks.writeLine(`HELLO ${this.opts.versionString}`);
        return;
      }
      if (tokens.length === 2) {
        const arg = tokens[1];
        if (!UUID_RE.test(arg)) {
          // Verified F-24: this ERROR does not count toward "three strikes".
          this.hooks.writeLine('ERROR');
          return;
        }
        this.hiSeen = true;
        this.sessionUuid = arg;
        this.opts.loss.ensure(arg, this.hooks.peerIp()).lastSeen = Date.now();
        this.hooks.writeLine(`HELLO ${this.opts.versionString}`);
        return;
      }
      // "HI <a> <b>…" (or trailing space after the uuid): the daemon parses the
      // second token as a client JWT; an invalid one aborts the connection
      // with no reply (verified: "Disconnect Exception: JWT parsing failed").
      this.hooks.onEvent?.('hi_jwt_disconnect', { tokens: tokens.length });
      this.hooks.close();
      this.closed = true;
      return;
    }
    if (s.startsWith('GETIP') || rawLine.startsWith('GETIP')) {
      if (rawLine !== 'GETIP') {
        // Strict GETIP (verified F-11): trailing space / \r / extra argument →
        // the daemon silently stops serving this connection (no ERROR reply).
        this.muted = true;
        this.hooks.onEvent?.('conn_muted_getip_strict', { line: rawLine.slice(0, 40) });
        return;
      }
      this.hooks.writeLine(`YOURIP ${normalizeIp(this.hooks.peerIp())}`);
      return;
    }
    if (s === 'CAPABILITIES' || s.startsWith('CAPABILITIES')) {
      // Extra arguments tolerated (verified: "CAPABILITIES x" answered normally).
      this.hooks.writeLine('CAPABILITIES SERVER_HOST_AUTH UPLOAD_STATS');
      return;
    }
    if (s === 'SERVERID' || s.startsWith('SERVERID')) {
      this.hooks.writeLine(`SERVERID ${this.opts.instanceUuid}`);
      return;
    }
    if (s === 'UPTIME' || s.startsWith('UPTIME')) {
      this.hooks.writeLine(`UPTIME ${Math.floor((Date.now() - this.opts.startedAt) / 1000)}`);
      return;
    }
    if (s === 'PING') {
      this.errorReply(); // argument REQUIRED (verified F-10)
      return;
    }
    if (s.startsWith('PING ')) {
      this.hooks.writeLine(`PONG ${Date.now()}`);
      return;
    }
    if (s === 'INITPLOSS') {
      if (this.sessionUuid) {
        const sess = this.opts.loss.ensure(this.sessionUuid, this.hooks.peerIp());
        sess.lastSeen = Date.now();
      }
      this.hooks.writeLine('OK');
      return;
    }
    if (s === 'PLOSS') {
      this.hooks.writeLine(this.opts.loss.statsLine());
      return;
    }
    if (s === 'UPLOAD_STATS' || s.startsWith('UPLOAD_STATS ')) {
      // Argless form → ERROR (daemon parity, re-verified 2026-11-27 on
      // production 2.11.5/2.11.7: ERROR even with an active session).
      const args = s.slice('UPLOAD_STATS'.length).trim().split(/\s+/).filter((a) => a.length > 0);
      const numbers = args.map((a) => (/^\d{1,10}$/.test(a) ? parseInt(a, 10) : NaN));
      if (args.length < 2 || args.length > 3 || numbers.some((n) => !Number.isFinite(n))) {
        this.errorReply();
        return;
      }
      const [durationMs, intervalMs, index = 0] = numbers;
      if (durationMs <= 0 || intervalMs <= 0) {
        this.errorReply();
        return;
      }
      this.startUploadStats(durationMs, intervalMs, index);
      return;
    }
    if (s.startsWith('DOWNLOAD ')) {
      const n = parseInt(s.slice(9).trim().split(/\s+/)[0], 10);
      if (!Number.isFinite(n) || n < 0 || n > this.opts.maxDownloadBytes) {
        // The reference daemon streams UNBOUNDED data for unparsable sizes
        // (verified: multi-GB before the probe was killed). We refuse with
        // ERROR instead — deliberate, documented safety deviation.
        this.errorReply();
        return;
      }
      if (n === 0 && this.opts.transport === 'ws') {
        // Verified 2026-11-27 (production 2.11.5, WebSocket): DOWNLOAD 0 is
        // answered ERROR over WS (the TCP "\n" reply is TCP-only).
        this.errorReply();
        return;
      }
      this.startDownload(n);
      return;
    }
    if (s.startsWith('UPLOAD ')) {
      const parts = s.slice(7).trim().split(/\s+/);
      const n = parseInt(parts[0], 10);
      if (!Number.isFinite(n) || n < 0) {
        // Verified daemon behavior: non-numeric / negative size → the command
        // is silently ignored (no reply) and the connection keeps processing.
        this.hooks.onEvent?.('upload_invalid_ignored', { arg: parts[0].slice(0, 24) });
        return;
      }
      if (n > this.opts.maxUploadBytes) {
        // A WELL-FORMED size above the configured cap: refusing with ERROR
        // mirrors DOWNLOAD's documented safety deviation (otherwise the
        // payload bytes would be parsed as commands and only produce garbage
        // ERROR replies — the client would hang on its OK).
        this.hooks.onEvent?.('upload_cap_rejected', { declared: n, cap: this.opts.maxUploadBytes });
        this.errorReply();
        return;
      }
      if (n < lineLen) {
        // Verified: n smaller than the command line itself (incl. n=0) → ERROR,
        // no bytes consumed, connection continues.
        this.errorReply();
        return;
      }
      this.uploadTotal = n;
      // INCLUSIVE counting: the command line itself counts toward n.
      this.uploadRemaining = n - lineLen;
      this.uploadCounted = 0;
      this.hooks.onEvent?.('upload_start', { declared: n, cmdLen: lineLen });
      if (this.uploadRemaining === 0) {
        this.counters.uploads++;
        this.hooks.writeLine(`OK ${n} ${Date.now()}`);
      }
      return;
    }
    if (s === 'QUIT') {
      // Transport-dependent (verified F-14): TCP closes; WebSocket replies ERROR.
      if ((this.opts.quitMode || 'close') === 'error') {
        this.hooks.writeLine('ERROR');
      } else {
        this.hooks.close();
        this.closed = true;
      }
      return;
    }
    // Unknown (includes the CLI's encrypted-binary hello → triggers its
    // plaintext fallback) → ERROR, exactly like the reference daemon.
    this.errorReply();
  }

  /**
   * DOWNLOAD reply structure (verified byte-exact F-9):
   *   n = 0  → exactly "\n" (1 byte)
   *   n ≥ 1  → exactly n bytes total:
   *            "DOWNLOAD " prefix truncated to min(n-1, 9) bytes, then
   *            max(0, n-10) pool bytes, then a trailing "\n".
   *   The last byte of every reply is "\n" and IS counted in n.
   */
  private startDownload(n: number): void {
    this.downloadActive = true;
    this.counters.downloads++;
    const pool = this.opts.pool;
    const total = n === 0 ? 1 : n;
    const prefixLen = n >= 1 ? Math.min(n - 1, DOWNLOAD_PREFIX.length) : 0;
    const phase = (n + this.counters.downloads) % pool.length;
    const CHUNK = 512 * 1024;
    const prefixBytes = Buffer.from(DOWNLOAD_PREFIX, 'latin1');
    let sent = 0;
    const writeNext = (): void => {
      while (sent < total && !this.closed) {
        const len = Math.min(CHUNK, total - sent);
        const chunk = Buffer.allocUnsafe(len);
        // Prefix occupies stream bytes [0, prefixLen) — only the first chunk.
        const localDataStart = Math.max(prefixLen - sent, 0);
        // Data region ends before the stream's last byte (the trailing "\n").
        const localDataEnd = Math.min(len, Math.max(total - 1 - sent, 0));
        if (localDataStart > 0) {
          prefixBytes.subarray(0, Math.min(prefixLen, len)).copy(chunk, 0);
        }
        let p = (phase + Math.max(0, sent + localDataStart - prefixLen)) % pool.length;
        for (let done = localDataStart; done < localDataEnd; ) {
          const take = Math.min(pool.length - p, localDataEnd - done);
          pool.copy(chunk, done, p, p + take);
          p = (p + take) % pool.length;
          done += take;
        }
        if (sent + len === total) chunk[len - 1] = 0x0a; // trailing newline, counted in n
        const ok = this.hooks.write(chunk);
        sent += len;
        this.counters.bytesDown += len;
        if (!ok) return void this.waitDrain(writeNext);
      }
      if (sent >= total) {
        this.downloadActive = false;
        this.hooks.onEvent?.('download_done', { n });
      }
    };
    writeNext();
  }

  private drainWaiters = new Set<(writable: boolean) => void>();

  private waitDrain(cb: () => void): void {
    // Transport-dependent backpressure hook: ServerCore wires this to the
    // socket's drain event; WS transport resolves immediately.
    this.drainWaiters.add(() => cb());
  }

  /** Called by the transport when it becomes writable again. */
  notifyWritable(): void {
    const waiters = [...this.drainWaiters];
    this.drainWaiters.clear();
    for (const w of waiters) w(true);
  }

  get isIdle(): boolean {
    return !this.downloadActive && this.uploadRemaining === 0;
  }

  destroy(): void {
    this.closed = true;
    this.stopUploadStats();
  }
}
