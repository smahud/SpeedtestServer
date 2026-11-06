/**
 * netgauge.ts — NetGauge command engine for the Cloudflare Worker.
 *
 * Faithful port of the verified OoklaServer 2.11.5.2 command semantics
 * (validation/PROTOCOL_CONTRACT.md §2, engine source:
 * reverse-engineered/typescript/src/server/NetGaugeEngine.ts) onto the
 * Workers runtime: Uint8Array instead of Buffer, async paced sends for
 * DOWNLOAD streams, WebSocket frames instead of TCP segments.
 *
 * Verified behaviors preserved here (labels from the contract):
 *   - HI / HI <uuid> / HI <uuid> <extra>          [V]
 *   - GETIP strictness + pre-session gate (mute)  [V]
 *   - CAPABILITIES / SERVERID / UPTIME            [V]
 *   - PING <x> (arg required) → PONG <server-ms>  [V]
 *   - INITPLOSS → OK, PLOSS → "PLOSS 0 0 0" (no UDP ingress exists at the
 *     edge — the packet-loss data plane stays on the VPS by design)   [V+D]
 *   - UPLOAD_STATS → ERROR (daemon parity)        [V]
 *   - DOWNLOAD <n> → exactly n bytes: truncated "DOWNLOAD " prefix +
 *     pool bytes + trailing "\n", all counted in n                  [V]
 *   - UPLOAD <n> inclusive counting (command line counts toward n)   [V]
 *   - QUIT → ERROR over WS, session stays open    [V]
 *   - one-command-per-frame (first line only) when idle             [V]
 *   - no "three strikes" over WS                  [V]
 *   - unknown/encrypted-binary hello → ERROR (drives the CLI's
 *     documented plaintext fallback)                                [V]
 */

import { fillFromPool } from './pool';

const UUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
const DOWNLOAD_PREFIX = 'DOWNLOAD ';

export interface NetGaugeHooks {
  /** Send one reply line. `noNewline` for the WS HELLO quirk. */
  writeLine(line: string): void;
  /** Send raw (binary) data — DOWNLOAD payloads. */
  writeBinary(data: Uint8Array): void;
  /** Close the session (daemon disconnect semantics). */
  close(): void;
  /** Peer IP (CF-Connecting-IP). */
  peerIp(): string;
  /** Isolate-scoped instance UUID + start time. */
  instanceUuid(): string;
  startedAt(): number;
  onEvent?(kind: string, detail: Record<string, unknown>): void;
}

export interface NetGaugeOptions {
  versionString: string;
  maxDownloadBytes: number;
  maxUploadBytes: number;
  maxLineBytes: number;
}

/** Accumulated evidence counters (surfaced via /__meta). */
export interface EngineCounters {
  commands: number;
  downloads: number;
  uploads: number;
  bytesDown: number;
  bytesUp: number;
}

export class NetGaugeEngine {
  private hooks: NetGaugeHooks;
  private opts: NetGaugeOptions;
  private sessionUuid: string | null = null;
  private uploadRemaining = 0;
  private uploadTotal = 0;
  private hiSeen = false;
  private muted = false;
  private closed = false;
  private downloadActive = false;
  public counters: EngineCounters = { commands: 0, downloads: 0, uploads: 0, bytesDown: 0, bytesUp: 0 };

  constructor(hooks: NetGaugeHooks, opts: NetGaugeOptions) {
    this.hooks = hooks;
    this.opts = opts;
  }

  get isIdle(): boolean {
    return !this.downloadActive && this.uploadRemaining === 0;
  }

  destroy(): void {
    this.closed = true;
  }

  /** Feed one received WS frame payload (already reduced to its first
   * command line when idle — see the WS adapter in index.ts). */
  feedFrame(data: Uint8Array): void {
    if (this.closed || this.muted) return;
    if (this.uploadRemaining > 0) {
      // Upload payload frames are exempt from the first-command rule [V]
      // and count as data toward the declared UPLOAD total.
      const take = Math.min(this.uploadRemaining, data.length);
      this.uploadRemaining -= take;
      this.counters.bytesUp += take;
      if (this.uploadRemaining === 0) {
        this.counters.uploads++;
        this.hooks.onEvent?.('upload_done', { declared: this.uploadTotal });
        this.hooks.writeLine(`OK ${this.uploadTotal} ${Date.now()}`);
        // Leftover bytes after the declared total are processed as the next
        // command (engine buffer semantics — a frame that exceeds the
        // UPLOAD total continues as command data).
        const leftover = data.subarray(take);
        if (leftover.length > 0) this.processCommandLine(decodeLatin1(leftover), leftover);
      }
      return;
    }
    // Command frame: process the (single) command line.
    this.processCommandLine(decodeLatin1(data), data);
  }

  /** Pre-session GETIP gate check on the RAW frame (before first-command
   * reduction) — verified F-12: a first frame whose first line is exactly
   * "GETIP" with trailing bytes in the same read mutes the connection. */
  rawFramePreCheck(data: Uint8Array): boolean {
    if (this.hiSeen || this.muted || this.uploadRemaining > 0) return false;
    if (data.length > 6 && latin1Slice(data, 0, 5) === 'GETIP') {
      const nl = data.indexOf(0x0a);
      if (nl === -1 || nl + 1 < data.length) {
        this.muted = true;
        this.hooks.onEvent?.('conn_muted_getip_gate', { bytes: data.length });
        return true;
      }
    }
    return false;
  }

  private processCommandLine(rawLine: string, _rawBytes?: Uint8Array): void {
    // The adapter feeds exactly one command line. Normalize exactly like the
    // TCP engine: strip the trailing \n first (processBuffer semantics),
    // then strip ONE trailing \r before dispatch (F-25) — EXCEPT GETIP,
    // whose strictness check runs on the raw line minus \n (F-11).
    const lineNoNl = rawLine.endsWith('\n') ? rawLine.slice(0, -1) : rawLine;
    const s = lineNoNl.endsWith('\r') ? lineNoNl.slice(0, -1) : lineNoNl;
    const line = s;
    this.counters.commands++;
    this.hooks.onEvent?.('cmd', { line: line.length > 80 ? line.slice(0, 80) + '…' : line });

    if (line === 'HI' || line.startsWith('HI ')) {
      const tokens = line.split(' ');
      if (tokens.length === 1) {
        this.hiSeen = true;
        this.hooks.writeLine(`HELLO ${this.opts.versionString}`);
        return;
      }
      if (tokens.length === 2) {
        if (!UUID_RE.test(tokens[1])) {
          // F-24: this ERROR does not count toward any strike limit.
          this.hooks.writeLine('ERROR');
          return;
        }
        this.hiSeen = true;
        this.sessionUuid = tokens[1];
        this.hooks.onEvent?.('session', { uuid: tokens[1] });
        this.hooks.writeLine(`HELLO ${this.opts.versionString}`);
        return;
      }
      // "HI <a> <b>…": the daemon parses the second token as a client JWT;
      // invalid → silent disconnect ("JWT parsing failed") [V].
      this.hooks.onEvent?.('hi_jwt_disconnect', { tokens: tokens.length });
      this.hooks.close();
      this.closed = true;
      return;
    }
    if (line.startsWith('GETIP') || lineNoNl.startsWith('GETIP')) {
      if (lineNoNl !== 'GETIP') {
        // Strict GETIP [V F-11]: trailing space/\r/extra argument → the
        // connection silently stops being served.
        this.muted = true;
        this.hooks.onEvent?.('conn_muted_getip_strict', { line: lineNoNl.slice(0, 40) });
        return;
      }
      this.hooks.writeLine(`YOURIP ${this.hooks.peerIp()}`);
      return;
    }
    if (line === 'CAPABILITIES' || line.startsWith('CAPABILITIES')) {
      this.hooks.writeLine('CAPABILITIES SERVER_HOST_AUTH UPLOAD_STATS');
      return;
    }
    if (line === 'SERVERID' || line.startsWith('SERVERID')) {
      this.hooks.writeLine(`SERVERID ${this.hooks.instanceUuid()}`);
      return;
    }
    if (line === 'UPTIME' || line.startsWith('UPTIME')) {
      this.hooks.writeLine(`UPTIME ${Math.floor((Date.now() - this.hooks.startedAt()) / 1000)}`);
      return;
    }
    if (line === 'PING') {
      this.hooks.writeLine('ERROR'); // argument REQUIRED [V F-10]
      return;
    }
    if (line.startsWith('PING ')) {
      this.hooks.writeLine(`PONG ${Date.now()}`);
      return;
    }
    if (line === 'INITPLOSS') {
      // No UDP ingress exists at the edge; the loss data plane stays on the
      // VPS. Arming still answers OK (daemon parity for the TCP side).
      this.hooks.writeLine('OK');
      return;
    }
    if (line === 'PLOSS') {
      this.hooks.writeLine('PLOSS 0 0 0');
      return;
    }
    if (line === 'UPLOAD_STATS') {
      this.hooks.writeLine('ERROR'); // daemon parity [V]
      return;
    }
    if (line.startsWith('DOWNLOAD ')) {
      const n = parseInt(line.slice(9).trim().split(/\s+/)[0], 10);
      if (!Number.isFinite(n) || n < 0 || n > this.opts.maxDownloadBytes) {
        // Safety deviation (documented): the daemon streams UNBOUNDED data
        // for unparsable sizes; we refuse with ERROR like SpeedtestServer.
        this.hooks.writeLine('ERROR');
        return;
      }
      void this.startDownload(n);
      return;
    }
    if (line.startsWith('UPLOAD ')) {
      const parts = line.slice(7).trim().split(/\s+/);
      const n = parseInt(parts[0], 10);
      if (!Number.isFinite(n) || n < 0 || n > this.opts.maxUploadBytes) {
        // Silently ignored (daemon parity) [V].
        this.hooks.onEvent?.('upload_invalid_ignored', { arg: parts[0].slice(0, 24) });
        return;
      }
      const lineLen = lineNoNl.length + 1; // inclusive counting: command line + \n [V]
      if (n < lineLen) {
        this.hooks.writeLine('ERROR');
        return;
      }
      this.uploadTotal = n;
      this.uploadRemaining = n - lineLen;
      this.hooks.onEvent?.('upload_start', { declared: n, cmdLen: lineLen });
      if (this.uploadRemaining === 0) {
        this.counters.uploads++;
        this.hooks.writeLine(`OK ${n} ${Date.now()}`);
      }
      return;
    }
    if (line === 'QUIT') {
      // WS transport: ERROR reply, session stays open [V F-14].
      this.hooks.writeLine('ERROR');
      return;
    }
    // Unknown — includes the CLI's encrypted-binary hello (which triggers
    // its documented plaintext fallback) [V].
    this.hooks.writeLine('ERROR');
  }

  /**
   * DOWNLOAD reply stream (verified byte-exact F-9):
   *   n = 0  → exactly "\n" (1 byte)
   *   n ≥ 1  → exactly n bytes: "DOWNLOAD " prefix truncated to min(n-1, 9),
   *            then max(0, n-10) pool bytes, then a trailing "\n".
   * Emitted as paced 64 KiB binary frames (backpressure-safe under the
   * 128 MB isolate budget; the frame size is invisible to byte-counting
   * clients — the first frame still carries the "DOWNLOAD " prefix).
   */
  private async startDownload(n: number): Promise<void> {
    this.downloadActive = true;
    this.counters.downloads++;
    const total = n === 0 ? 1 : n;
    const prefixLen = n >= 1 ? Math.min(n - 1, DOWNLOAD_PREFIX.length) : 0;
    const prefixBytes = new TextEncoder().encode(DOWNLOAD_PREFIX);
    const CHUNK = 64 * 1024;
    let sent = 0;
    let frames = 0;
    while (sent < total && !this.closed) {
      const len = Math.min(CHUNK, total - sent);
      const chunk = new Uint8Array(len);
      const localDataStart = Math.max(prefixLen - sent, 0);
      if (localDataStart > 0) chunk.set(prefixBytes.subarray(0, Math.min(prefixLen, len)), 0);
      const localDataEnd = Math.min(len, Math.max(total - 1 - sent, 0));
      if (localDataEnd > localDataStart) {
        fillFromPool(chunk.subarray(localDataStart, localDataEnd), sent + localDataStart - prefixLen);
      }
      if (sent + len === total) chunk[len - 1] = 0x0a; // trailing "\n", counted in n
      this.hooks.writeBinary(chunk);
      sent += len;
      this.counters.bytesDown += len;
      frames++;
      // Yield periodically so the isolate keeps servicing other events and
      // the runtime can flush send buffers (no exposed backpressure API).
      if (frames % 32 === 0) await new Promise((r) => setTimeout(r, 0));
    }
    if (sent >= total) {
      this.downloadActive = false;
      this.hooks.onEvent?.('download_done', { n, frames });
    }
  }
}

/** latin1 decode (command bytes are ASCII). */
function decodeLatin1(b: Uint8Array): string {
  let s = '';
  for (let i = 0; i < b.length; i++) s += String.fromCharCode(b[i]);
  return s;
}

/** latin1 slice of a Uint8Array without allocating a string per byte. */
function latin1Slice(b: Uint8Array, start: number, end: number): string {
  let s = '';
  for (let i = start; i < end; i++) s += String.fromCharCode(b[i]);
  return s;
}

/** First command line of a WS frame (inclusive newline). Frames with NO
 * newline are one complete command (verified F-13) — a newline is
 * synthesized for the line-based engine. Mirrors ServerCore.firstCommandLine. */
export function firstCommandLine(buf: Uint8Array): Uint8Array {
  const nl = buf.indexOf(0x0a);
  if (nl === -1) {
    const out = new Uint8Array(buf.length + 1);
    out.set(buf, 0);
    out[buf.length] = 0x0a;
    return out;
  }
  return buf.subarray(0, nl + 1);
}
