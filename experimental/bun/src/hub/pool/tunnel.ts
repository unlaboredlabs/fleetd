// The way cloud machines reach the hub (crates/fleetd/src/hub/pool/tunnel.rs, D307): the hub dials out, so it never
// needs a public address. While a pool machine is up the hub holds an SSH connection to it with one reverse forward:
// the machine's `127.0.0.1:47900` goes to the hub's own listen address.
// - The key: the hub's own ed25519 key, made the first time it is needed and kept in the ledger sealed to the hub's
//   box key. It lives only in the hub's memory (an OpenSSH key built in a Buffer for ssh2), never on disk.
// - The way in: at each dial, boat's `POST /sshkey` lets that public key in and names the SSH server's host key, which
//   is pinned (exact match; a dial with none named goes no further). Where to dial is read from boat's GET each time.
// - What it carries: only connections to the forwards the hub asked for, each to the hub's listen address. No shell,
//   no command, no agent or X11 forwarding.
// - The hub's Claude endpoint: when the hub's API key names an http:// endpoint (a proxy on the hub's private network,
//   say, which a cloud machine can't reach), a second reverse forward carries the machine's `127.0.0.1:47901` to it,
//   and the machine is handed that local address as its endpoint (`machineEndpoint`). The hub dials it for each
//   connection, so a machine needs no VPN of its own; whether it answers is the machine's health (`ClaudeForward`).
// - Its life: opened at the wake or create; redialled with backoff (1 s doubling to 30 s) while the machine should be
//   up; closed when it sleeps or is deleted. Keepalives every 15 s, 3 unanswered drop it.
import { createPrivateKey, createPublicKey, randomBytes } from "node:crypto";
import { connect as tcp } from "node:net";
import { Client } from "ssh2";
import { loadOrCreateBoxKey, openSealed, publicKeyOf, seal } from "../../shared/sealed_box.ts";
import { type Boat, boatError, boatLine, sshTarget, sshUser } from "./boat.ts";
import type { Ledger } from "./ledger.ts";

/** The port on the cloud machine's loopback that reaches the hub. */
export const MACHINE_PORT = 47900;
/** The port on the cloud machine's loopback that reaches the hub's Claude endpoint, when it names one. */
export const CLAUDE_PORT = 47901;
/** Each step of a dial: the TCP connect and handshake, the key, the forward. */
const STEP_MS = 20_000;
/** A tunnel that held this long redials from the shortest wait again. */
const HELD_LONG_MS = 60_000;

export type Timing = { shortest: number; longest: number; keepalive: number };
export const defaultTunnelTiming = (): Timing => ({ shortest: 1000, longest: 30_000, keepalive: 15_000 });

/** The hub URL a cloud machine's node joins and dials: its own loopback, through the tunnel. */
export const machineHubUrl = () => `http://127.0.0.1:${MACHINE_PORT}`;

/**
 * Where the hub dials its Claude endpoint for a machine: the host and port of an http:// one. An https:// one names
 * a host its certificate must match, which a machine's loopback can't, so it is used as it is, and must be reachable
 * from the machine.
 */
export function claudeTarget(endpoint: string | undefined): [string, number] | undefined {
  if (endpoint === undefined || !/^http:\/\//i.test(endpoint)) return undefined;
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    return undefined;
  }
  return [url.hostname.replace(/^\[|\]$/g, ""), url.port === "" ? 80 : Number(url.port)];
}

/** The endpoint as a cloud machine is handed it: an http:// one through the tunnel, its path kept; else as it is. */
export function machineEndpoint(endpoint: string): string {
  if (!claudeTarget(endpoint)) return endpoint;
  const path = endpoint.indexOf("/", "http://".length);
  return `http://127.0.0.1:${CLAUDE_PORT}${path < 0 ? "" : endpoint.slice(path)}`;
}

/** One slot's tunnel: up (with why its Claude endpoint doesn't answer, when it doesn't), or down with why ("opening",
 * or the last dial's failure). */
export type Tunnel = { up: true; claude?: string } | { down: string };

/** The tunnels the pool holds; the pool's tests use a fake. */
export interface Tunnels {
  open(slot: string, sandbox: string): void;
  close(slot: string): void;
  status(slot: string): Tunnel | undefined;
  /** The hub's Claude endpoint changed: each tunnel up adds or drops its forward. */
  claudeChanged?(): void;
}

/** The hub's Claude endpoint as the tunnels carry it: where to dial it now (undefined: no forward), and what each
 * machine's tunnel found of it (undefined: it answers, or isn't forwarded), for the machine's health. */
export type ClaudeForward = { target(): [string, number] | undefined; heard(slot: string, problem: string | undefined): void };
const noClaude: ClaudeForward = { target: () => undefined, heard: () => {} };

/** The hub's SSH key: its ed25519 seed, the 32-byte public key, and the OpenSSH private key ssh2 reads. */
export type HubKey = { seed: Uint8Array; public: Uint8Array; openssh: Buffer };

const PKCS8_ED25519 = Buffer.from("302e020100300506032b657004220420", "hex");

const sshString = (b: Uint8Array | string) => {
  const data = typeof b === "string" ? Buffer.from(b) : Buffer.from(b);
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  return Buffer.concat([len, data]);
};
const u32 = (n: number) => {
  const b = Buffer.alloc(4);
  b.writeUInt32BE(n >>> 0);
  return b;
};

/** The key made from its seed, with the comment `fleetd-hub` (tunnel.rs `key_of`). */
export function keyOf(seed: Uint8Array): HubKey {
  if (seed.length !== 32) throw new Error("the hub's SSH key is damaged");
  const priv = createPrivateKey({ key: Buffer.concat([PKCS8_ED25519, seed]), format: "der", type: "pkcs8" });
  const spki = createPublicKey(priv).export({ format: "der", type: "spki" });
  const pub = new Uint8Array(spki.subarray(spki.length - 32));
  const blob = Buffer.concat([sshString("ssh-ed25519"), sshString(pub)]);
  const check = randomBytes(4).readUInt32BE();
  let inner = Buffer.concat([u32(check), u32(check), sshString("ssh-ed25519"), sshString(pub), sshString(Buffer.concat([seed, pub])), sshString("fleetd-hub")]);
  const pad: number[] = [];
  for (let i = 1; (inner.length + pad.length) % 8 !== 0; i++) pad.push(i);
  inner = Buffer.concat([inner, Buffer.from(pad)]);
  const body = Buffer.concat([Buffer.from("openssh-key-v1\0"), sshString("none"), sshString("none"), sshString(""), u32(1), sshString(blob), sshString(inner)]);
  const b64 = body.toString("base64").match(/.{1,70}/g)!.join("\n");
  return { seed, public: pub, openssh: Buffer.from(`-----BEGIN OPENSSH PRIVATE KEY-----\n${b64}\n-----END OPENSSH PRIVATE KEY-----\n`) };
}

/** The hub's SSH key: the ledger's, opened with the hub's box key, or made now and kept sealed. Never logged. */
export function hubKey(ledger: Ledger, home: string): HubKey {
  let box: Uint8Array;
  try {
    box = loadOrCreateBoxKey(home);
  } catch {
    throw new Error("the hub can't read its box key");
  }
  let sealed = ledger.sealedSshKey();
  if (!sealed) sealed = ledger.sshKeyOr(seal(publicKeyOf(box), new Uint8Array(randomBytes(32))));
  const seed = openSealed(box, sealed);
  if (!seed) throw new Error("the hub's SSH key was sealed to another box key");
  return keyOf(seed);
}

/** The public half, OpenSSH format: what boat puts on each machine, and what the Cloud panel shows. */
export const publicLine = (k: HubKey) =>
  `ssh-ed25519 ${Buffer.concat([sshString("ssh-ed25519"), sshString(k.public)]).toString("base64")} fleetd-hub`;

/** The address the hub dials for itself: its listen address, an any-address bind dialled on loopback. */
export function hubTarget(listen: { host: string; port: number }): [string, number] {
  const h = listen.host.replace(/^\[|\]$/g, "");
  return [h === "" || h === "0.0.0.0" ? "127.0.0.1" : h === "::" ? "::1" : h, listen.port];
}

/** The key blob of an OpenSSH public key line, for an exact pin; undefined when it can't be read. */
function blobOf(line: string): Buffer | undefined {
  const parts = line.trim().split(/\s+/);
  if (parts.length < 2) return undefined;
  const blob = Buffer.from(parts[1]!, "base64");
  if (blob.length < 8) return undefined;
  const n = blob.readUInt32BE(0);
  return blob.subarray(4, 4 + n).toString() === parts[0] ? blob : undefined;
}

type Held = { sandbox: string; status: Tunnel; stop: AbortController; client?: Client; claude?: boolean };

/** The hub's tunnels over SSH, with ssh2: the key stays in the hub's memory, and the hub needs no OpenSSH client. */
export class SshTunnels implements Tunnels {
  private readonly held = new Map<string, Held>();

  constructor(
    private readonly boat: Boat,
    private readonly key: () => HubKey,
    private readonly hub: [string, number],
    private readonly timing: Timing = defaultTunnelTiming(),
    private readonly claude: ClaudeForward = noClaude,
  ) {}

  open(slot: string, sandbox: string): void {
    const now = this.held.get(slot);
    if (now?.sandbox === sandbox) return;
    now?.stop.abort();
    const held: Held = { sandbox, status: { down: "opening" }, stop: new AbortController() };
    this.held.set(slot, held);
    void this.hold(slot, held);
  }

  close(slot: string): void {
    const held = this.held.get(slot);
    if (!held) return;
    held.stop.abort();
    this.held.delete(slot);
    this.claude.heard(slot, undefined);
    console.info(`pool: tunnel to ${slot} closed`);
  }

  status(slot: string): Tunnel | undefined {
    return this.held.get(slot)?.status;
  }

  claudeChanged(): void {
    const want = this.claude.target() !== undefined;
    for (const [slot, held] of this.held) {
      if (!held.client || !("up" in held.status)) continue;
      if (want && held.claude) this.probeClaude(slot, held);
      else if (want) this.forwardClaude(slot, held, held.client);
      else if (held.claude) {
        held.claude = false;
        held.client.unforwardIn("127.0.0.1", CLAUDE_PORT, () => {});
        this.claudeHeard(slot, held, undefined);
      }
    }
  }

  /** Asks for the Claude endpoint's forward on the connection, and checks the endpoint answers the hub. */
  private forwardClaude(slot: string, held: Held, client: Client): void {
    held.claude = true;
    client.forwardIn("127.0.0.1", CLAUDE_PORT, (err) => {
      if (err) {
        held.claude = false;
        return this.claudeHeard(slot, held, `the hub's tunnel couldn't forward its port ${CLAUDE_PORT} to the hub's Claude endpoint: ${err.message}`);
      }
      this.probeClaude(slot, held);
    });
  }

  /** Checks the hub's Claude endpoint answers, for the machine's health. */
  private probeClaude(slot: string, held: Held): void {
    const probe = this.dialClaude(slot, held);
    probe?.on("connect", () => probe.destroy());
  }

  /** Dials the hub's Claude endpoint for the machine, keeping whether it answered; undefined with no endpoint now. */
  private dialClaude(slot: string, held: Held) {
    const to = this.claude.target();
    if (!to) return undefined;
    const [host, port] = to;
    const sock = tcp(port, host);
    sock.setTimeout(STEP_MS, () => sock.destroy(new Error(`no answer within ${STEP_MS / 1000} s`)));
    sock.on("connect", () => {
      sock.setTimeout(0);
      this.claudeHeard(slot, held, undefined);
    });
    sock.on("error", (e) => this.claudeHeard(slot, held, `the hub's Claude endpoint at ${host}:${port} doesn't answer the hub: ${e.message}`));
    return sock;
  }

  private claudeHeard(slot: string, held: Held, problem: string | undefined): void {
    if (this.held.get(slot) !== held) return;
    if ("up" in held.status) held.status = problem === undefined ? { up: true } : { up: true, claude: problem };
    this.claude.heard(slot, problem);
  }

  /** One slot's tunnel: dialled, held, and redialled with backoff, until it is closed. */
  private async hold(slot: string, held: Held): Promise<void> {
    let wait = this.timing.shortest;
    const signal = held.stop.signal;
    while (!signal.aborted) {
      const began = Date.now();
      let why: string;
      try {
        await this.session(slot, held, signal);
        return;
      } catch (e) {
        why = (e as Error).message;
      }
      if (signal.aborted) return;
      held.claude = false;
      this.claude.heard(slot, undefined);
      if ("up" in held.status) console.warn(`pool: tunnel to ${slot} dropped, redialling: ${why}`);
      else console.info(`pool: tunnel to ${slot} not up yet, redialling: ${why}`);
      held.status = { down: why };
      if (Date.now() - began >= HELD_LONG_MS) wait = this.timing.shortest;
      await new Promise<void>((resolve) => {
        const t = setTimeout(resolve, wait);
        signal.addEventListener("abort", () => (clearTimeout(t), resolve()), { once: true });
      });
      wait = Math.min(wait * 2, this.timing.longest);
    }
  }

  /**
   * One connection: boat lets the key in and names the host key, a GET says where to dial, the hub dials and checks
   * the host key, signs in and asks for the forward, then holds it. Resolves once closed by the hub; rejects with why
   * it failed or dropped.
   */
  private async session(slot: string, held: Held, signal: AbortSignal): Promise<void> {
    const key = this.key();
    let access;
    try {
      access = await this.boat.sshKey(held.sandbox, publicLine(key));
    } catch (e) {
      throw new Error(`boat.dev didn't let the hub's key in: ${boatLine(boatError(e))}`);
    }
    const named = access.hostKey ?? "";
    if (named === "") throw new Error("boat.dev named no host key for its SSH server: not dialled");
    const pin = blobOf(named);
    if (!pin) throw new Error("boat.dev's host key for it can't be read");
    let seen;
    try {
      seen = await this.boat.get(held.sandbox);
    } catch (e) {
      throw new Error(`boat.dev didn't say where it is: ${boatLine(boatError(e))}`);
    }
    const target = sshTarget(access, seen);
    if (!target) throw new Error("boat.dev names no SSH endpoint for it yet");
    const [host, port] = target;
    const at = `its SSH server at ${host}:${port}`;
    const user = sshUser(access);
    const client = new Client();
    let mismatch = false;
    await new Promise<void>((resolve, reject) => {
      let up = false;
      const fail = (why: string) => {
        client.end();
        reject(new Error(why));
      };
      const timer = setTimeout(() => fail(`${at}: no answer within ${STEP_MS / 1000} s`), STEP_MS);
      const stop = () => {
        client.end();
        resolve();
      };
      signal.addEventListener("abort", stop, { once: true });
      client.on("ready", () => {
        clearTimeout(timer);
        const forward = setTimeout(() => fail(`${at}, the forward of its port ${MACHINE_PORT}: no answer within ${STEP_MS / 1000} s`), STEP_MS);
        client.forwardIn("127.0.0.1", MACHINE_PORT, (err) => {
          clearTimeout(forward);
          if (err) return fail(`${at}, the forward of its port ${MACHINE_PORT}: ${err.message}`);
          up = true;
          held.status = { up: true };
          held.client = client;
          if (this.claude.target()) this.forwardClaude(slot, held, client);
        });
      });
      // Every connection the machine opens to the hub's forward goes to the hub's listen address, whatever it names;
      // one to the Claude endpoint's, to the endpoint as it is now.
      client.on("tcp connection", (info, accept, rejectConn) => {
        if (!up) return rejectConn();
        if (info.destPort === CLAUDE_PORT) {
          if (!held.claude) return rejectConn();
          const sock = this.dialClaude(slot, held);
          if (!sock) return rejectConn();
          const ch = accept();
          sock.on("error", () => ch.close());
          ch.on("error", () => sock.destroy());
          ch.pipe(sock).pipe(ch);
          return;
        }
        const ch = accept();
        const sock = tcp(this.hub[1], this.hub[0]);
        sock.on("error", () => ch.close());
        ch.on("error", () => sock.destroy());
        ch.pipe(sock).pipe(ch);
      });
      client.on("error", (e) => {
        clearTimeout(timer);
        if (mismatch) return fail(`${at} showed a host key other than the one pinned: refused`);
        const auth = (e as { level?: string }).level === "client-authentication";
        fail(auth ? `${at} refused the hub's SSH key` : `${at}: ${e.message}`);
      });
      client.on("close", () => {
        clearTimeout(timer);
        if (held.client === client) delete held.client;
        signal.removeEventListener("abort", stop);
        if (signal.aborted) return resolve();
        reject(new Error(up ? `${at}: the connection dropped` : `${at}: the connection closed`));
      });
      client.connect({
        host,
        port,
        username: user,
        privateKey: key.openssh,
        readyTimeout: STEP_MS,
        keepaliveInterval: this.timing.keepalive,
        keepaliveCountMax: 3,
        hostVerifier: (presented: Buffer) => {
          const ok = Buffer.compare(presented, pin) === 0;
          if (!ok) mismatch = true;
          return ok;
        },
      });
    });
  }
}
