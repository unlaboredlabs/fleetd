// A node's link to one session host (./host/serve.ts), whatever carries it: the host's own socket (./host.ts), or a
// box's channel to the host inside it (../sandbox/box.ts dialHost). One JSON object per line:
// - host → node: `{"seq":n,"event":<RunnerEvent>}`; the host keeps each until acknowledged and resends what it kept;
// - node → host: `{"ack":n}` once the service applied events up to n, `{"command":<SessionCommand>}`, and `"stop"`.
// Box side (docs/CONTRIBUTING.md "The package"): it only speaks on the stream it's given, so a service with no node
// drives a box's session host with it too.

/** Bumped when the lines between a host and a node change incompatibly (host.rs PROTOCOL). */
export const PROTOCOL = 1;
const ACK_EVERY_MS = 200;
const DRAIN_MS = 5_000;
const CLOSE_MS = 1_000;

/** Why a host didn't start claude, as its registration says. */
export type Refusal = { message: string; missing: boolean };

export type Registration = {
  protocol: number;
  hostPid: number;
  hostStart?: number | null;
  pid: number;
  start?: number | null;
  marker: string;
  refused?: Refusal | null;
};

/** Normalized events of one session (runner/mod.rs `RunnerEvent`), as serde writes an externally tagged enum. */
export type RunnerEvent = Record<string, any> | string;
/** Commands to a session's process (`SessionCommand`). */
export type SessionCommand =
  | { Send: { run_id: string; text: string; mode: "plain" | "boundary" | "now" } }
  | { Withdraw: { run_id: string } }
  | "Interrupt"
  | { Answer: { request_id: string; decision: unknown; by: string | null } }
  | { Shutdown: { grace: { secs: number; nanos: number } } };

export const shutdown = (graceMs = 0): SessionCommand => ({
  Shutdown: { grace: { secs: Math.floor(graceMs / 1000), nanos: (graceMs % 1000) * 1e6 } },
});

/** The node's link to one host: events in order, commands out, acknowledgements of what the service applied. */
export class HostLink {
  /** Events the service applied: what the node acknowledges. */
  applied = 0;
  /** The node let go of the host (its shutdown): the events end without an exit, and the session goes on. */
  detached = false;
  #socket: HostSocket | undefined;
  /** What the socket hasn't taken yet: Bun's sockets don't buffer, so a write past what the kernel takes at once goes
   * when it drains (a long message, a pasted image, went cut otherwise). */
  #out: Uint8Array | undefined;
  #buf = "";
  #handed: number[] = [];
  #acked = 0;
  #last = 0;
  #ended = false;
  #exitSeen = false;
  #queue: Numbered[] = [];
  #waiter: ((e: Numbered | undefined) => void) | undefined;
  #ticker: ReturnType<typeof setInterval> | undefined;
  #closed: Promise<void>;
  #closedResolve!: () => void;

  private constructor(
    readonly registration: Registration,
    readonly lost: ((r: Registration) => void) | undefined,
  ) {
    this.#closed = new Promise((r) => (this.#closedResolve = r));
  }

  /** Opens the link to a host over `dial`: its events start with every one it kept. Refused for another PROTOCOL, or a
   * host that didn't start claude. `lost`: what's left of a host whose link dropped before it said its session exited,
   * and that the node didn't let go of (the node's own kills its tree: ./host.ts). */
  static async open(o: { registration: Registration; dial: HostDial; lost?: (r: Registration) => void }): Promise<HostLink> {
    const { registration } = o;
    if (registration.protocol !== PROTOCOL) throw new Error(`it speaks protocol ${registration.protocol}, this node ${PROTOCOL}`);
    if (registration.refused) throw new Error(registration.refused.message);
    const link = new HostLink(registration, o.lost);
    // One decoder for the connection, streaming: a character split across two reads comes out whole.
    const decoder = new TextDecoder();
    link.#socket = await o.dial({
      data: (_s, chunk) => link.#data(decoder.decode(chunk, { stream: true })),
      drain: () => link.#flush(),
      close: () => link.#gone(),
      error: () => link.#gone(),
    });
    link.#ticker = setInterval(() => link.#ack(), ACK_EVERY_MS);
    return link;
  }

  get pid(): number {
    return this.registration.pid;
  }

  #data(text: string): void {
    this.#buf += text;
    let nl: number;
    while ((nl = this.#buf.indexOf("\n")) >= 0) {
      const line = this.#buf.slice(0, nl);
      this.#buf = this.#buf.slice(nl + 1);
      let parsed: { seq: number; event: RunnerEvent };
      try {
        parsed = JSON.parse(line);
      } catch {
        this.#gone();
        return;
      }
      if (parsed.seq <= this.#last) continue;
      this.#last = parsed.seq;
      if (typeof parsed.event === "object" && "Exited" in parsed.event) this.#exitSeen = true;
      this.#handed.push(parsed.seq);
      this.#push({ seq: parsed.seq, event: parsed.event });
    }
  }

  #push(event: Numbered | undefined): void {
    const waiter = this.#waiter;
    if (waiter) {
      this.#waiter = undefined;
      waiter(event);
    } else if (event !== undefined) this.#queue.push(event);
  }

  #gone(): void {
    if (this.#ended) return;
    this.#ended = true;
    clearInterval(this.#ticker);
    this.#closedResolve();
    if (!this.detached && !this.#exitSeen) this.lost?.(this.registration);
    this.#push(undefined);
  }

  /** The next event; undefined once the host went away (or the node let go of it). */
  next(): Promise<RunnerEvent | undefined> {
    const queued = this.#queue.shift();
    if (queued !== undefined) return Promise.resolve(queued.event);
    if (this.#ended) return Promise.resolve(undefined);
    return new Promise((resolve) => (this.#waiter = (e) => resolve(e?.event)));
  }

  /** `next`, with the seq the host gave the event: a service that keeps the events it applied across links (a host
   * resends what wasn't acknowledged to the next link, whose seqs start afresh here) tells a resent one by it. */
  nextWithSeq(): Promise<Numbered | undefined> {
    const queued = this.#queue.shift();
    if (queued !== undefined) return Promise.resolve(queued);
    if (this.#ended) return Promise.resolve(undefined);
    return new Promise((resolve) => (this.#waiter = resolve));
  }

  #write(line: unknown): boolean {
    if (this.#ended || !this.#socket) return false;
    const bytes = new TextEncoder().encode(`${JSON.stringify(line)}\n`);
    this.#out = this.#out ? Buffer.concat([this.#out, bytes]) : bytes;
    this.#flush();
    return true;
  }

  #flush(): void {
    const out = this.#out;
    if (!out || !this.#socket) return;
    const wrote = this.#socket.write(out);
    this.#out = wrote < 0 || wrote >= out.length ? undefined : out.subarray(wrote);
  }

  send(command: SessionCommand): boolean {
    return this.#write({ command });
  }

  #ack(): void {
    let upto: number | undefined;
    while (this.#acked < this.applied && this.#handed.length) {
      upto = this.#handed.shift();
      this.#acked++;
    }
    if (upto !== undefined) this.#write({ ack: upto });
  }

  /** Lets go of the host without ending its session, once the service applied what it was handed. */
  async detach(): Promise<void> {
    if (this.#ended) return;
    this.detached = true;
    const total = this.#acked + this.#handed.length;
    const deadline = Date.now() + DRAIN_MS;
    while (this.applied < total && Date.now() < deadline) await Bun.sleep(10);
    this.#ack();
    while (this.#out && Date.now() < deadline) await Bun.sleep(10);
    this.#socket?.end();
    await Promise.race([this.#closed, Bun.sleep(CLOSE_MS)]);
    this.#gone();
  }
}

/** An event as the host numbered it. */
export type Numbered = { seq: number; event: RunnerEvent };

/** What a link writes to: a host's socket, or a box's channel to one. */
export type HostSocket = { write(data: Uint8Array): number; end(): void };
export type HostHandlers = { data(socket: unknown, chunk: Uint8Array): void; drain(): void; close(): void; error(): void };
export type HostDial = (handlers: HostHandlers) => Promise<HostSocket>;

