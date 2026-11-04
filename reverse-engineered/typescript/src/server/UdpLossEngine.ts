/**
 * UdpLossEngine — UDP side of the Ookla native protocol.
 *
 * Wire contract (verified against the reference daemon; see
 * validation/PROTOCOL_CONTRACT.md):
 *   Client datagram (init form):  "LOSS <timer> <seq> <uuid>\n"
 *     → counted, NO response.
 *   Client datagram (loaded-latency form):
 *                                 "LOSS <timer> <seq> <uuid> <timer>\n"
 *     → "RECV <seq> <clientTimer> [<count> <seq> <dupes>]\n" back to the
 *       sender's source address.
 *   Query over TCP:               "PLOSS" → "PLOSS <count> <dupes> <maxseq>"
 *                                 (latest active session; 0 0 0 when none)
 *
 * Sessions are auto-registered from client-supplied UUIDs and bound to the
 * sender IP; datagrams from a different IP for a known UUID are dropped
 * (anti-spoof, mirroring the daemon's "Mismatch address" check).
 *
 * Bind failures are FATAL (fail closed): `start()` rejects and the caller
 * aborts startup. The old implementation only emitted an `udp_error` event
 * and kept serving TCP while UDP was dead.
 */

import dgram from 'node:dgram';
import { LossRegistry, normalizeIp } from './NetGaugeEngine';

export interface UdpLossEngineOptions {
  ports: number[];
  loss: LossRegistry;
  onEvent?: (kind: string, detail: Record<string, unknown>) => void;
  maxDatagramBytes: number;
}

const UUID_RE = /^[0-9A-Za-z]{8}-[0-9A-Za-z]{4}-[0-9A-Za-z]{4}-[0-9A-Za-z]{4}-[0-9A-Za-z]{12}$/;

export class UdpLossEngine {
  private sockets: dgram.Socket[] = [];
  private opts: UdpLossEngineOptions;
  public readonly counters = { received: 0, answered: 0, rejected: 0 };

  constructor(opts: UdpLossEngineOptions) {
    this.opts = opts;
  }

  /** Bind every UDP port; rejects on the first failure (fail closed). */
  async start(): Promise<void> {
    const binds: Promise<void>[] = [];
    for (const port of this.opts.ports) {
      const sock = dgram.createSocket('udp6');
      sock.on('message', (msg, rinfo) => this.handle(msg, rinfo, sock));
      sock.on('error', (err) => this.opts.onEvent?.('udp_error', { port, error: String(err) }));
      binds.push(
        new Promise<void>((resolve, reject) => {
          sock.once('error', reject); // bind failure is fatal (fail closed)
          sock.bind(port, '::', () => {
            sock.removeListener('error', reject);
            this.opts.onEvent?.('listen_udp', { port });
            resolve();
          });
        }),
      );
      this.sockets.push(sock);
    }
    await Promise.all(binds);
  }

  stop(): void {
    for (const s of this.sockets) s.close();
    this.sockets = [];
  }

  private handle(msg: Buffer, rinfo: dgram.RemoteInfo, sock: dgram.Socket): void {
    if (msg.length > this.opts.maxDatagramBytes) {
      this.counters.rejected++;
      return;
    }
    const s = msg.toString('latin1');
    const parts = s.trim().split(/\s+/);
    if (parts[0] !== 'LOSS' || (parts.length !== 4 && parts.length !== 5)) {
      this.counters.rejected++;
      this.opts.onEvent?.('udp_bad', { from: rinfo.address, line: s.slice(0, 64) });
      return;
    }
    const timer = parts[1];
    const seq = parseInt(parts[2], 10);
    const uuid = parts[3];
    const clientTimer = parts[4];
    if (!UUID_RE.test(uuid) || !Number.isFinite(seq)) {
      this.counters.rejected++;
      return;
    }
    void timer;
    this.counters.received++;
    const isNew = !this.opts.loss.get(uuid);
    const reply = this.opts.loss.recordLoss(uuid, normalizeIp(rinfo.address), seq, clientTimer);
    if (reply !== null) {
      sock.send(Buffer.from(reply + '\n'), rinfo.port, rinfo.address);
      this.counters.answered++;
    }
    if (isNew) this.opts.onEvent?.('udp_session_new', { uuid, from: rinfo.address });
    if (clientTimer !== undefined) {
      this.opts.onEvent?.('udp_recv', { uuid, seq, from: rinfo.address });
    } else {
      this.opts.onEvent?.('udp_count', { uuid, seq, from: rinfo.address });
    }
  }
}
