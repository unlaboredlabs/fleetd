// The one link between the node and a box's guest helper (`fleetd sandbox-guest`, ./guest.ts): any duplex byte stream
// (a unix socket now, vsock or a provider's port later), carrying numbered channels in frames of one shape:
//
//   type u8 | channel u32 BE | length u32 BE | payload
//
// - OPEN: a channel starts; its payload is the JSON target. The guest opens channels 2 and up (below NODE_CHANNELS),
//   for a connection to a node.sock forward (`{"unix":path}`) or a TCP forward (`{"tcp":port}`); the node opens
//   channel 1, the session host's lines (`{"host":true}`), and from NODE_CHANNELS up a connection the guest makes from
//   inside the box (`{"dial":{"host","port"}}`, its browser's: ../browser/egress.ts). The guest says how that dial
//   went in a control message, `{"op":"dial","channel":n}` or with `"error"`, before any of the channel's bytes.
//   A hosted box's guest also opens a channel per connection to the team's tailnet (`{"tailnet":{"host","port"}}`), and
//   the node says how its dial went the same way (`{"op":"tailnetDialed","channel"[,"error"]}`), and one per tailnet
//   name lookup (`{"tailnetDns":{"name","type"}}`), on which the node sends the answer and ends it.
// - DATA: bytes of a channel, at most CHUNK of them a frame.
// - END: the sender sends nothing more on the channel (a half-close). A channel is done once both sides ended it.
// - CREDIT: a u32: the receiver handed that many more of the channel's bytes on. A sender keeps at most WINDOW bytes
//   of a channel unacknowledged, and stops reading the channel's end until credit comes back, so one slow reader holds
//   back only its own channel.
// - Channel 0 carries the control messages, one JSON object a DATA frame, outside the windows.
//
// A link that drops ends every channel on it; the node dials again (./box.ts) and the session host's own seq/ack
// resend (../runner/host_link.ts) carries its lines across. Box side (docs/CONTRIBUTING.md "The package").
import { Duplex } from "node:stream";
import type { Refusal } from "../runner/host_link.ts";

/** Bumped when the link's frames or control messages change incompatibly. */
export const GUEST_PROTOCOL = 1;
/** The most bytes one `read` answers: a control message's frame takes 1 MiB, base64 included. */
export const READ_CHUNK = 512 * 1024;

/** What the guest says of the session host it started: its protocol (./host_link.ts PROTOCOL), or why it refused. */
export type HostInfo = { protocol: number; refused: Refusal | null | undefined };

export const FRAME = { OPEN: 1, DATA: 2, END: 3, CREDIT: 4 } as const;
const HEADER = 9;
/** The most bytes of a channel in one DATA frame. */
export const CHUNK = 64 * 1024;
/** The most bytes of a channel in flight unacknowledged, each way. */
export const WINDOW = 256 * 1024;
/** A longer frame ends the link: the other side doesn't speak this protocol. */
const MAX_FRAME = 1 << 20;
export const CONTROL = 0;
export const HOST = 1;
/** The first channel the node opens beside the host's: a dial (`{dial}`). The guest's own stay below it. */
export const NODE_CHANNELS = 0x8000_0000;

/** A channel's far end: a unix socket, a TCP port (on the guest's loopback, or on `addr` in the guest), the session
 * host, (`dial`) a host and port the guest connects to from inside the box, or the team's tailnet through the node
 * (`tailnet`, a connection; `tailnetDns`, a lookup: ./tailnet_box.ts). */
export type Target =
  | { unix: string }
  | { tcp: number; addr?: string }
  | { host: true }
  | { dial: { host: string; port: number } }
  | { tailnet: { host: string; port: number } }
  | { tailnetDns: { name: string; type: number } };

export function frame(type: number, channel: number, payload: Uint8Array = new Uint8Array(0)): Buffer {
  const out = Buffer.allocUnsafe(HEADER + payload.length);
  out.writeUInt8(type, 0);
  out.writeUInt32BE(channel, 1);
  out.writeUInt32BE(payload.length, 5);
  out.set(payload, HEADER);
  return out;
}

/** Splits a byte stream into frames; throws on one this protocol doesn't have. */
export class Frames {
  #buf = Buffer.alloc(0);
  push(chunk: Uint8Array): { type: number; channel: number; payload: Buffer }[] {
    this.#buf = this.#buf.length ? Buffer.concat([this.#buf, chunk]) : Buffer.from(chunk);
    const out: { type: number; channel: number; payload: Buffer }[] = [];
    while (this.#buf.length >= HEADER) {
      const type = this.#buf.readUInt8(0);
      const length = this.#buf.readUInt32BE(5);
      if (type < FRAME.OPEN || type > FRAME.CREDIT) throw new Error(`a frame of unknown type ${type}`);
      if (length > MAX_FRAME) throw new Error(`a frame of ${length} bytes`);
      if (this.#buf.length < HEADER + length) break;
      out.push({ type, channel: this.#buf.readUInt32BE(1), payload: this.#buf.subarray(HEADER, HEADER + length) });
      this.#buf = this.#buf.subarray(HEADER + length);
    }
    return out;
  }
}

type Channel = { local: Duplex; credit: number; sentEnd: boolean; gotEnd: boolean };

/** What one side of a link does with what the other sends. */
export type MuxHooks = {
  /** A control message. */
  control: (message: Record<string, unknown>) => void;
  /** The other side opened `channel` to `target`: its local end, or undefined to refuse it (it is ended at once). */
  open: (channel: number, target: Target) => Duplex | undefined;
  /** The link is gone, with every channel on it. */
  closed: (why: string) => void;
};

/** One side of a link: channels between local duplex ends and the other side's. */
export class Mux {
  #channels = new Map<number, Channel>();
  #frames = new Frames();
  #closed = false;

  constructor(
    readonly link: Duplex,
    readonly hooks: MuxHooks,
  ) {
    link.on("data", (chunk: Buffer) => this.#data(chunk));
    link.on("error", (e) => this.close(`the link failed: ${e.message}`));
    link.on("close", () => this.close("the link closed"));
    link.on("end", () => this.close("the other side closed the link"));
    // A link slower than its channels holds them all back, whatever credit the other side grants.
    link.on("drain", () => {
      for (const c of this.#channels.values()) if (c.credit > 0 && !c.sentEnd) c.local.resume();
    });
  }

  get closed(): boolean {
    return this.#closed;
  }

  /** Sends a control message; throws for one longer than a frame takes (a start's environment, say). */
  control(message: Record<string, unknown>): void {
    const bytes = Buffer.from(JSON.stringify(message));
    if (bytes.length > MAX_FRAME) throw new Error(`a control message of ${bytes.length} bytes, past the ${MAX_FRAME} a frame takes`);
    this.#send(frame(FRAME.DATA, CONTROL, bytes));
  }

  /** Opens `channel` to `target` on the other side, `local` its end here. */
  open(channel: number, target: Target, local: Duplex): void {
    if (this.#closed) {
      local.destroy();
      return;
    }
    this.#send(frame(FRAME.OPEN, channel, Buffer.from(JSON.stringify(target))));
    this.#attach(channel, local);
  }

  /** Ends the link and every channel on it. */
  close(why: string): void {
    if (this.#closed) return;
    this.#closed = true;
    for (const c of this.#channels.values()) c.local.destroy();
    this.#channels.clear();
    this.link.destroy();
    this.hooks.closed(why);
  }

  #send(bytes: Buffer): void {
    // What the link hasn't taken yet waits in its stream: the windows, and the pause while it drains, bound it.
    if (!this.#closed) this.link.write(bytes);
  }

  #attach(id: number, local: Duplex): void {
    const c: Channel = { local, credit: WINDOW, sentEnd: false, gotEnd: false };
    this.#channels.set(id, c);
    const end = () => {
      if (c.sentEnd || this.#closed) return;
      c.sentEnd = true;
      this.#send(frame(FRAME.END, id));
      this.#done(id, c);
    };
    local.on("data", (chunk: Buffer) => {
      if (c.sentEnd) return;
      for (let at = 0; at < chunk.length; at += CHUNK) this.#send(frame(FRAME.DATA, id, chunk.subarray(at, at + CHUNK)));
      c.credit -= chunk.length;
      if (c.credit <= 0 || this.link.writableNeedDrain) local.pause();
    });
    local.on("end", end);
    local.on("close", end);
    local.on("error", () => local.destroy());
  }

  #done(id: number, c: Channel): void {
    if (c.sentEnd && c.gotEnd && this.#channels.get(id) === c) this.#channels.delete(id);
  }

  #data(chunk: Buffer): void {
    if (this.#closed) return;
    let frames;
    try {
      frames = this.#frames.push(chunk);
    } catch (error) {
      this.close(`the other side sent ${(error as Error).message}`);
      return;
    }
    for (const f of frames) {
      if (this.#closed) return;
      if (f.channel === CONTROL) {
        if (f.type !== FRAME.DATA) continue;
        let message: unknown;
        try {
          message = JSON.parse(f.payload.toString("utf8"));
        } catch {
          this.close("the other side sent a control message that isn't JSON");
          return;
        }
        if (message !== null && typeof message === "object") this.hooks.control(message as Record<string, unknown>);
        continue;
      }
      const c = this.#channels.get(f.channel);
      switch (f.type) {
        case FRAME.OPEN: {
          if (c) {
            this.close(`the other side opened channel ${f.channel} twice`);
            return;
          }
          let target: Target;
          try {
            target = JSON.parse(f.payload.toString("utf8")) as Target;
          } catch {
            this.close("the other side opened a channel to no target");
            return;
          }
          const local = this.hooks.open(f.channel, target);
          if (local) this.#attach(f.channel, local);
          else this.#send(frame(FRAME.END, f.channel));
          break;
        }
        case FRAME.DATA: {
          if (!c || c.gotEnd) break;
          const n = f.payload.length;
          // Credit once the bytes left this process: a reader that doesn't read holds back its own channel only.
          const copy = Buffer.from(f.payload);
          if (c.local.destroyed || c.local.writableEnded) this.#credit(f.channel, c, n);
          else c.local.write(copy, () => this.#credit(f.channel, c, n));
          break;
        }
        case FRAME.END:
          if (!c) break;
          c.gotEnd = true;
          if (!c.local.destroyed) c.local.end();
          this.#done(f.channel, c);
          break;
        case FRAME.CREDIT:
          if (!c || f.payload.length !== 4) break;
          c.credit = Math.min(WINDOW, c.credit + f.payload.readUInt32BE(0));
          if (c.credit > 0 && !c.sentEnd && !this.link.writableNeedDrain) c.local.resume();
          break;
      }
    }
  }

  #credit(id: number, c: Channel, n: number): void {
    if (this.#closed || c.sentEnd && c.gotEnd) return;
    const payload = Buffer.allocUnsafe(4);
    payload.writeUInt32BE(n, 0);
    this.#send(frame(FRAME.CREDIT, id, payload));
  }
}

/** One end of an in-memory stream (`pair`): what it writes, the other end reads, its write done once that end read it. */
class End extends Duplex {
  other!: End;
  #waiting: (() => void) | undefined;
  override _read(): void {
    const go = this.other.#waiting;
    this.other.#waiting = undefined;
    go?.();
  }
  override _write(chunk: Buffer, _encoding: BufferEncoding, done: (error?: Error | null) => void): void {
    if (this.other.push(chunk)) done();
    else this.#waiting = () => done();
  }
  override _final(done: (error?: Error | null) => void): void {
    this.other.push(null);
    done();
  }
  override _destroy(error: Error | null, done: (error?: Error | null) => void): void {
    this.other.destroy();
    done(error);
  }
}

/** Two ends of one stream: a dial's, its channel on one and its user on the other. */
export function pair(): [Duplex, Duplex] {
  const a = new End();
  const b = new End();
  a.other = b;
  b.other = a;
  return [a, b];
}
