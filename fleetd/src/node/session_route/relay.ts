// The node's ends of a session relay, for sessions the hub placed on another
// machine than their agent's. On the agent's machine the proxy hands each connection of the agent's driver to the
// hub's relay; on the runner each `relay_dial` from the hub is a channel `dial` connects between the hub and the
// session's own CDP proxy.
//
// The two nodes encrypt every message between them from the session's relay key, which the agent's node made and
// sealed to the runner: the hub carries ciphertext alone. Each channel opens with a fresh salt from each end; each
// direction has its own key (SHA-256 of a label, the relay key and both salts), and each message's nonce is its count
// in that direction (XSalsa20-Poly1305). So the hub can't replay a message, reflect one back, or carry one into another
// channel. Neither end logs a message, a payload or the relay's URL, whose path is its token.
import { goneProof, GONE_HEADER, hashToken } from "../../hub/machine_roles/relay.ts";
import { secretbox, secretboxOpen } from "../../shared/sealed_box.ts";

const SALT = 16;
/** How long a channel's end waits for the other's salt. */
const SALT_WAIT = 15_000;

export type Side = "agent" | "runner";

const sha256 = (...parts: Uint8Array[]) => {
  const h = new Bun.CryptoHasher("sha256");
  for (const p of parts) h.update(p);
  return new Uint8Array(h.digest());
};

function directionKey(relayKey: Uint8Array, from: Side, agentSalt: Uint8Array, runnerSalt: Uint8Array): Uint8Array {
  const label = new TextEncoder().encode(from === "agent" ? "fleetd relay 1: agent to runner" : "fleetd relay 1: runner to agent");
  return sha256(label, relayKey, agentSalt, runnerSalt);
}

function nonce(count: number): Uint8Array {
  const bytes = new Uint8Array(24);
  new DataView(bytes.buffer).setBigUint64(0, BigInt(count), true);
  return bytes;
}

/** A message as a websocket carries it. */
export type Frame = string | Uint8Array;

/** One channel's crypto: a key per direction, and the count of messages each way, which is each message's nonce. */
export class Channel {
  private readonly sendKey: Uint8Array;
  private readonly recvKey: Uint8Array;
  private sent = 0;
  private received = 0;

  /** `side`'s end of a channel, from the relay key, its own salt and the other end's. */
  constructor(relayKey: Uint8Array, side: Side, mine: Uint8Array, theirs: Uint8Array) {
    const [agentSalt, runnerSalt] = side === "agent" ? [mine, theirs] : [theirs, mine];
    this.sendKey = directionKey(relayKey, side, agentSalt, runnerSalt);
    this.recvKey = directionKey(relayKey, side === "agent" ? "runner" : "agent", agentSalt, runnerSalt);
  }

  /** A message for the other end: its kind (text 0, binary 1) and payload, sealed under the next count. */
  seal(message: Frame): Uint8Array {
    const payload = typeof message === "string" ? new TextEncoder().encode(message) : message;
    const plain = new Uint8Array(payload.length + 1);
    plain[0] = typeof message === "string" ? 0 : 1;
    plain.set(payload, 1);
    return secretbox(this.sendKey, nonce(this.sent++), plain);
  }

  /** The other end's next message, opened; undefined for anything else (a replay, a reflection, one the hub made up). */
  open(message: Frame): Frame | undefined {
    if (typeof message === "string") return undefined;
    const plain = secretboxOpen(this.recvKey, nonce(this.received), message);
    if (!plain || plain.length === 0) return undefined;
    this.received += 1;
    const payload = plain.subarray(1);
    if (plain[0] === 0) return new TextDecoder("utf-8", { fatal: true }).decode(payload);
    if (plain[0] === 1) return payload.slice();
    return undefined;
  }
}

/** The hub's relay at `token`, from the hub's URL. */
export function relayUrl(hub: string, token: string): string {
  const url = new URL(hub);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.pathname = `/relay/${token}`;
  url.search = "";
  url.hash = "";
  return url.href;
}

/** One end of a pipe: a client socket, or the proxy's server side of an agent's driver. */
export type End = {
  ready: Promise<boolean>;
  send(message: Frame): void;
  close(): void;
  onMessage(fn: (message: Frame) => void): void;
  onClose(fn: () => void): void;
};

/** A client websocket as a pipe's end. */
export function clientEnd(ws: WebSocket): End {
  ws.binaryType = "nodebuffer";
  let onMessage: (m: Frame) => void = () => {};
  const closes: (() => void)[] = [];
  ws.onmessage = (e) => onMessage(e.data as Frame);
  ws.onclose = () => closes.splice(0).forEach((fn) => fn());
  return {
    ready: new Promise<boolean>((resolve) => {
      if (ws.readyState === WebSocket.OPEN) return resolve(true);
      ws.addEventListener("open", () => resolve(true), { once: true });
      ws.addEventListener("error", () => resolve(false), { once: true });
      ws.addEventListener("close", () => resolve(false), { once: true });
    }),
    send: (m) => ws.send(m),
    close: () => ws.close(),
    onMessage: (fn) => (onMessage = fn),
    onClose: (fn) => closes.push(fn),
  };
}

/**
 * Opens the channel (each end's salt, through the hub), then pipes the plain side's messages sealed to the hub, and
 * the hub's opened to the plain side, until either side closes or a message doesn't open.
 */
export async function pipeSealed(plain: End, hub: End, relayKey: Uint8Array, side: Side): Promise<void> {
  const early: Frame[] = [];
  plain.onMessage((m) => early.push(m));
  const theirs = new Promise<Uint8Array | undefined>((resolve) => {
    const timer = setTimeout(() => resolve(undefined), SALT_WAIT);
    hub.onMessage((salt) => {
      clearTimeout(timer);
      resolve(typeof salt !== "string" && salt.length === SALT ? salt : undefined);
    });
  });
  const ended = new Promise<void>((resolve) => {
    plain.onClose(() => (hub.close(), resolve()));
    hub.onClose(() => (plain.close(), resolve()));
  });
  if (!(await hub.ready) || !(await plain.ready)) return void (hub.close(), plain.close());
  const mine = crypto.getRandomValues(new Uint8Array(SALT));
  hub.send(mine);
  const salt = await theirs;
  if (!salt) return void (hub.close(), plain.close());
  const channel = new Channel(relayKey, side, mine, salt);
  plain.onMessage((m) => hub.send(channel.seal(m)));
  hub.onMessage((m) => {
    const message = channel.open(m);
    // A message that doesn't open ends the channel.
    if (message === undefined) return void (hub.close(), plain.close());
    plain.send(message);
  });
  for (const m of early.splice(0)) hub.send(channel.seal(m));
  await ended;
}

/** The runner's side of a `relay_dial`: the hub's channel piped to the session's own CDP proxy here. */
export async function dial(hubUrl: string, token: string, target: string, relayKey: Uint8Array): Promise<void> {
  await pipeSealed(clientEnd(new WebSocket(target)), clientEnd(new WebSocket(relayUrl(hubUrl, token))), relayKey, "runner");
}

/**
 * Whether the relay at `url` refuses as its own word that the session ended: 410 with the proof of the token, which
 * only a party that knows the token makes. A 403 from a proxy in front of the hub proves nothing.
 */
export async function relaySaysGone(url: string): Promise<boolean> {
  const token = url.slice(url.lastIndexOf("/") + 1);
  try {
    const answer = await fetch(url.replace(/^ws/, "http"), { headers: { upgrade: "websocket", connection: "upgrade" } });
    return answer.status === 410 && answer.headers.get(GONE_HEADER) === goneProof(hashToken(token));
  } catch {
    return false;
  }
}
