/**
 * NetGaugeEngine — transport-agnostic command engine for the Ookla
 * Speedtest native protocol ("NetGauge"), reconstructed from authorized
 * observations of OoklaServer 2.11.5.2 (2026-06-04.1737.7d0993d).
 *
 * Wire contract (all verified against the reference daemon; see
 * validation/PROTOCOL_CONTRACT.md):
 *   Client → Server commands are `\n`-terminated ASCII lines.
 *   HI [uuid]            → HELLO <version>            (uuid must be UUID-shaped, else ERROR)
 *   GETIP                → YOURIP <peer-ip>
 *   CAPABILITIES         → CAPABILITIES SERVER_HOST_AUTH UPLOAD_STATS
 *   SERVERID             → SERVERID <instance-uuid>
 *   UPTIME               → UPTIME <seconds>
 *   PING [x]             → PONG <server-epoch-ms>
 *   INITPLOSS            → OK                          (arms packet-loss accounting)
 *   PLOSS                → PLOSS <count> <dupes> <maxseq>
 *   UPLOAD_STATS         → ERROR                       (daemon parity; tolerated by clients)
 *   DOWNLOAD <n>         → exactly n bytes, first 9 = "DOWNLOAD " (counted in n), rest = pool data
 *   UPLOAD <n> [ms] [c]  → reads n bytes INCLUSIVE of the command line, then OK <n> <epoch-ms>
 *   QUIT                 → close
 *   <unknown/binary>     → ERROR
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
  instanceUuid: string;       // stable per-process instance id
  maxLineBytes: number;       // command line cap (default 1 MiB)
  maxDownloadBytes: number;   // per-DOWNLOAD cap (default 2 GiB - 1)
  maxUploadBytes: number;     // per-UPLOAD cap (default 2 GiB - 1)
  pool: Buffer;               // random data pool (2 MiB, like the reference daemon)
  loss: LossRegistry;         // shared UDP LOSS registry for INITPLOSS/PLOSS
  startedAt: number;          // process start time (ms)
}

/** Packet-loss session registry shared between the TCP and UDP engines. */
export interface LossSession {
  uuid: string;
  clientIp: string;
  count: number;
  dupes: number;
  maxSeq: number;
  lastSeen: number;
}

export class LossRegistry {
  private sessions = new Map<string, LossSession>();

  /** Get or auto-register a session (permissive: client-supplied UUIDs are
   *  accepted so plaintext-fallback clients — which pick their own UUIDs —
   *  get working packet-loss accounting). */
  ensure(uuid: string, clientIp: string): LossSession {
    let s = this.sessions.get(uuid);
    if (!s) {
      s = { uuid, clientIp, count: 0, dupes: 0, maxSeq: -1, lastSeen: Date.now() };
      this.sessions.set(uuid, s);
    }
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
    if (seq <= s.maxSeq) s.dupes++;
    else s.maxSeq = seq;
    s.count++;
    if (clientTimer === undefined) return null; // 4-field init form: counted, not answered
    return `RECV ${seq} ${clientTimer} [${s.count} ${seq} ${s.dupes}]`;
  }

  gc(maxIdleMs: number): void {
    const now = Date.now();
    for (const [k, v] of this.sessions) if (now - v.lastSeen > maxIdleMs) this.sessions.delete(k);
  }
}

export function normalizeIp(ip: string): string {
  if (ip.startsWith('::ffff:')) return ip.slice(7);
  return ip;
}

const UUID_RE = /^[0-9A-Za-z]{8}-[0-9A-Za-z]{4}-[0-9A-Za-z]{4}-[0-9A-Za-z]{4}-[0-9A-Za-z]{12}$/;

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
  /** Bytes transferred on this connection (evidence counters). */
  public readonly counters = { commands: 0, downloads: 0, uploads: 0, bytesDown: 0, bytesUp: 0 };

  constructor(hooks: NetGaugeSessionHooks, opts: NetGaugeEngineOptions) {
    this.hooks = hooks;
    this.opts = opts;
  }

  /** Feed received bytes (TCP chunk or WS frame payload). */
  feed(data: Buffer): void {
    if (this.closed) return;
    this.buf = Buffer.concat([this.buf, data]);
    this.processBuffer();
  }

  private processBuffer(): void {
    while (!this.closed) {
      if (this.uploadRemaining > 0) {
        const take = Math.min(this.uploadRemaining, this.buf.length);
        this.uploadCounted += take;
        this.uploadRemaining -= take;
        this.buf = this.buf.subarray(take);
        this.counters.bytesUp += take;
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
          this.hooks.close();
        }
        return;
      }
      const line = this.buf.subarray(0, idx);
      const lineLen = idx + 1; // includes the newline (UPLOAD counts it)
      this.buf = this.buf.subarray(idx + 1);
      this.processCommand(line, lineLen);
    }
  }

  private processCommand(line: Buffer, lineLen: number): void {
    const s = line.toString('latin1');
    this.counters.commands++;
    this.hooks.onEvent?.('cmd', { line: s.length > 80 ? s.slice(0, 80) + '…' : s });

    if (s === 'HI' || s.startsWith('HI ')) {
      const arg = s.split(' ')[1] || null;
      if (arg && !UUID_RE.test(arg)) {
        this.hooks.writeLine('ERROR'); // daemon rejects non-UUID HI args
        return;
      }
      this.sessionUuid = arg;
      if (arg) this.opts.loss.ensure(arg, this.hooks.peerIp()).lastSeen = Date.now();
      this.hooks.writeLine(`HELLO ${this.opts.versionString}`);
      return;
    }
    if (s === 'GETIP') {
      this.hooks.writeLine(`YOURIP ${normalizeIp(this.hooks.peerIp())}`);
      return;
    }
    if (s === 'CAPABILITIES') {
      this.hooks.writeLine('CAPABILITIES SERVER_HOST_AUTH UPLOAD_STATS');
      return;
    }
    if (s === 'SERVERID') {
      this.hooks.writeLine(`SERVERID ${this.opts.instanceUuid}`);
      return;
    }
    if (s === 'UPTIME') {
      this.hooks.writeLine(`UPTIME ${Math.floor((Date.now() - this.opts.startedAt) / 1000)}`);
      return;
    }
    if (s === 'PING' || s.startsWith('PING ')) {
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
    if (s === 'UPLOAD_STATS') {
      this.hooks.writeLine('ERROR'); // daemon parity (verified 2026-11-04)
      return;
    }
    if (s.startsWith('DOWNLOAD ')) {
      const n = parseInt(s.slice(9).trim().split(/\s+/)[0], 10);
      if (!Number.isFinite(n) || n < 0 || n > this.opts.maxDownloadBytes) {
        this.hooks.writeLine('ERROR');
        return;
      }
      this.startDownload(n);
      return;
    }
    if (s.startsWith('UPLOAD ')) {
      const parts = s.slice(7).trim().split(/\s+/);
      const n = parseInt(parts[0], 10);
      if (!Number.isFinite(n) || n < 0 || n > this.opts.maxUploadBytes) {
        this.hooks.writeLine('ERROR');
        return;
      }
      this.uploadTotal = n;
      // INCLUSIVE counting: the command line itself counts toward n.
      this.uploadRemaining = Math.max(0, n - lineLen);
      this.uploadCounted = 0;
      this.hooks.onEvent?.('upload_start', { declared: n, cmdLen: lineLen });
      if (this.uploadRemaining === 0) {
        this.counters.uploads++;
        this.hooks.writeLine(`OK ${n} ${Date.now()}`);
      }
      return;
    }
    if (s === 'QUIT') {
      this.hooks.close();
      return;
    }
    // Unknown (includes the CLI's encrypted-binary hello → triggers its
    // plaintext fallback) → ERROR, exactly like the reference daemon.
    this.hooks.writeLine('ERROR');
  }

  private startDownload(n: number): void {
    this.downloadActive = true;
    this.counters.downloads++;
    const PREFIX = 'DOWNLOAD ';
    let sent = 0;
    const CHUNK = 512 * 1024;
    const pool = this.opts.pool;
    const writeNext = (): void => {
      while (sent < n && !this.closed) {
        const len = Math.min(CHUNK, n - sent);
        let chunk: Buffer;
        if (sent === 0) {
          // First bytes are the 9-byte ASCII prefix, counted toward n.
          const prefixLen = Math.min(PREFIX.length, len);
          const restLen = len - prefixLen;
          chunk = Buffer.concat([
            Buffer.from(PREFIX, 'latin1').subarray(0, prefixLen),
            pool.subarray(0, restLen),
          ]);
        } else {
          const out = Buffer.allocUnsafe(len);
          let pos = sent % pool.length;
          for (let done = 0; done < len; ) {
            const take = Math.min(pool.length - pos, len - done);
            pool.copy(out, done, pos, pos + take);
            pos = (pos + take) % pool.length;
            done += take;
          }
          chunk = out;
        }
        const ok = this.hooks.write(chunk);
        sent += len;
        this.counters.bytesDown += len;
        if (!ok) return void this.waitDrain(writeNext);
      }
      if (sent >= n) {
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
  }
}
