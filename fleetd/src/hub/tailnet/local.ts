// The team's Tailscale gateway on a self-hosted hub (./gateway.ts): one tailscaled of the hub's own, in userspace
// networking, so it never touches the host's own tailscaled, routes or resolv.conf. It runs with its own socket and
// state in a directory of the hub's that only lives while it runs, on a RAM-backed filesystem where there is one
// ($XDG_RUNTIME_DIR, /dev/shm): its login state is kept sealed (`StateStore`, the hub's database under the vault's key),
// written out for tailscaled at its start and sealed again whenever tailscaled changes it.
//
// - Connect: tailscaled starts with no state, and `tailscale up` (with no key) asks Tailscale for a sign-in page: the
//   one the person opens. Once they approve, the device is in their tailnet as `fleetd`, shields up: nothing on the
//   tailnet connects to the hub's machine through it (userspace tailscaled would pass such connections to the host's
//   loopback).
// - Each dial and name lookup goes through tailscaled's local API (`tailscale nc`'s dial, its DNS query). A dial goes
//   only to a peer in the gateway's netmap, by address or name: never the gateway's own (userspace tailscaled hands
//   those to the host's loopback), nor an address no peer has (it would dial that on the host's network).
// - Disconnect logs the device out (Tailscale drops it from the tailnet) and deletes the state, here and sealed.
// - The hub's stop ends tailscaled; the next start brings the device back from its sealed state.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import type { Duplex } from "node:stream";
import { join } from "node:path";
import type { TailnetState } from "../../shared/contracts.ts";
import { type Gateway, NotHere, Off, type StateStore } from "./gateway.ts";
import { DNS_TYPES, isPeer, LocalApi, type Peers, peersOf, type Programs, type Status, unsupported } from "./tailscale.ts";

export { NotHere };

/** A process the gateway started: tailscaled, or a `tailscale` command. Tests stand one in. */
export type Proc = { pid?: number; exited: Promise<number | null>; kill(signal?: NodeJS.Signals): void };
export type Spawn = (argv: string[], env: Record<string, string>, log: (line: string) => void) => Proc;

export type LocalOptions = {
  /** The hub's home: where its own copy of Tailscale's programs goes. */
  home: string;
  store: StateStore;
  /** The pinned programs, fetched on first need (./tailscale.ts programs). */
  programs: () => Promise<Programs>;
  /** The device's name on the tailnet. */
  hostname?: string;
  /** Where it runs (its socket and state while it runs); by default a directory of the hub's on a RAM-backed
   * filesystem. */
  runDir?: string;
  spawn?: Spawn;
  /** How often its status is read: while it waits for a sign-in, and once connected. */
  waitMs?: number;
  everyMs?: number;
  /** Why it can't run on this hub at all (another OS); undefined where it can. */
  unsupported?: string | undefined;
};

/** How long Connect waits for Tailscale's sign-in page. */
const LOGIN_WAIT_MS = 30_000;
/** How long tailscaled's socket may take to answer after its start. */
const START_WAIT_MS = 15_000;
const LOG_LINES = 20;
/** How long the netmap's peers, once read, answer a dial: a device that left can't be dialled for longer. */
const PEERS_MS = 5_000;

/** The directory a hub at `home` runs its tailscaled in: on a RAM-backed filesystem where there is one, so its
 * plaintext state never sits on a disk. */
export function runDirFor(home: string, env: Record<string, string | undefined> = process.env): string {
  const tag = createHash("sha256").update(home).digest("hex").slice(0, 10);
  const ram = [env.XDG_RUNTIME_DIR, "/dev/shm"].find((d) => d && isDir(d));
  return ram ? join(ram, `fleetd-tailnet-${process.getuid?.() ?? 0}-${tag}`) : join(home, "tailnet", "run");
}

const isDir = (p: string) => {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
};

const realSpawn: Spawn = (argv, env, log) => {
  const child = Bun.spawn(argv, { env, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  for (const stream of [child.stdout, child.stderr]) void lines(stream, log);
  return { pid: child.pid, exited: child.exited, kill: (s) => child.kill(s) };
};

async function lines(stream: ReadableStream<Uint8Array>, log: (line: string) => void): Promise<void> {
  const dec = new TextDecoder();
  let rest = "";
  for await (const chunk of stream) {
    const all = (rest + dec.decode(chunk, { stream: true })).split("\n");
    rest = all.pop() ?? "";
    for (const l of all) if (l.trim()) log(l);
  }
}

export class LocalGateway implements Gateway {
  #s: TailnetState = { status: "off" };
  #suffix: string | undefined;
  #daemon: Proc | undefined;
  #up: Proc | undefined;
  #api: LocalApi;
  #run: string;
  #log: string[] = [];
  #listeners = new Set<(s: TailnetState) => void>();
  #timer: ReturnType<typeof setTimeout> | undefined;
  /** The state file's change time when it was last sealed. */
  #sealedAt = 0;
  /** Whether the team wants it running: it has a state, or a Connect is under way. */
  #wanted = false;
  #queue: Promise<unknown> = Promise.resolve();
  #retryMs = 5_000;
  /** A Connect is under way: no sign-in page yet is no sign-out. */
  #connecting = false;
  /** Whom a dial may reach (`dial`): the netmap's peers when last read. */
  #peers: Peers | undefined;
  #peersAt = 0;

  constructor(readonly o: LocalOptions) {
    this.#run = o.runDir ?? runDirFor(o.home);
    this.#api = new LocalApi(join(this.#run, "tailscaled.sock"));
    if (o.unsupported !== undefined) this.#s = { status: "off", problem: o.unsupported };
  }

  get #stateFile() {
    return join(this.#run, "tailscaled.state");
  }

  state(): TailnetState {
    return { ...this.#s };
  }

  suffix(): string | undefined {
    return this.#s.status === "connected" ? this.#suffix : undefined;
  }

  onChange(fn: (s: TailnetState) => void): () => void {
    this.#listeners.add(fn);
    return () => void this.#listeners.delete(fn);
  }

  /** At the hub's start: the device comes back from its sealed state, if it has one. */
  start(): Promise<void> {
    return this.#serial(async () => {
      if (this.o.unsupported !== undefined) return;
      const sealed = await this.o.store.load();
      if (!sealed) return;
      this.#wanted = true;
      try {
        await this.#launch(sealed);
      } catch (error) {
        this.#set({ status: "failed", problem: `Tailscale's gateway didn't start: ${(error as Error).message}` });
        this.#later();
      }
    });
  }

  connect(): Promise<TailnetState> {
    return this.#serial(async () => {
      if (this.o.unsupported !== undefined) return this.state();
      this.#wanted = true;
      this.#connecting = true;
      try {
        return await this.#connect();
      } finally {
        this.#connecting = false;
      }
    });
  }

  async #connect(): Promise<TailnetState> {
    if (!this.#daemon) {
      this.#set({ status: "starting" });
      try {
        await this.#launch(await this.o.store.load());
      } catch (error) {
        this.#set({ status: "failed", problem: `Tailscale's gateway didn't start: ${(error as Error).message}` });
        return this.state();
      }
    }
    let st = await this.#read();
    if (st.BackendState === "Running") return this.state();
    if (!this.#up) {
      const p = await this.o.programs();
      // No key: Tailscale answers with the sign-in page, which `up` waits on until someone approves it.
      const up = this.#spawn([p.tailscale, `--socket=${this.#api.sock}`, "up", `--hostname=${this.o.hostname ?? "fleetd"}`, "--shields-up", "--json"]);
      this.#up = up;
      void up.exited.then(() => {
        if (this.#up === up) this.#up = undefined;
      });
    }
    const deadline = Date.now() + LOGIN_WAIT_MS;
    while (!st.AuthURL && st.BackendState !== "Running" && st.BackendState !== "NeedsMachineAuth" && Date.now() < deadline) {
      await Bun.sleep(this.o.waitMs ?? 250);
      st = await this.#read();
    }
    if (this.#s.status !== "login" && this.#s.status !== "connected" && this.#s.status !== "approve")
      this.#set({ status: "failed", problem: `Tailscale didn't give a sign-in page within ${LOGIN_WAIT_MS / 1000} s${this.#lastLog()}` });
    return this.state();
  }

  disconnect(): Promise<TailnetState> {
    return this.#serial(async () => {
      this.#wanted = false;
      if (this.#daemon) {
        try {
          const p = await this.o.programs();
          const out = this.#spawn([p.tailscale, `--socket=${this.#api.sock}`, "logout"]);
          await Promise.race([out.exited, Bun.sleep(20_000).then(() => out.kill("SIGKILL"))]);
        } catch {}
      }
      await this.#end();
      await this.o.store.clear();
      this.#sealedAt = 0;
      this.#suffix = undefined;
      this.#peers = undefined;
      this.#set({ status: "off" });
      console.info("tailnet: the team's Tailscale gateway was disconnected and its state deleted");
      return this.state();
    });
  }

  async stop(): Promise<void> {
    await this.#serial(async () => {
      await this.#seal().catch(() => {});
      this.#wanted = false;
      await this.#end();
    });
  }

  async dial(host: string, port: number, signal?: AbortSignal): Promise<Duplex> {
    if (this.#s.status !== "connected") throw new Off();
    // Only the netmap's peers, read again once on a miss (a device that joined since): never the gateway's own address
    // or name, which userspace tailscaled hands to the hub machine's loopback, nor an address no peer has, which
    // tailscaled would dial on the host's own network.
    if (!this.#peers || Date.now() - this.#peersAt > PEERS_MS || !isPeer(this.#peers, host)) await this.#readPeers(signal);
    if (!isPeer(this.#peers!, host)) throw new Error(`${host} isn't a device on the tailnet the gateway reaches`);
    return this.#api.dial(host, port, signal);
  }

  /** The netmap's peers as tailscaled has them now. */
  async #readPeers(signal?: AbortSignal): Promise<Peers> {
    this.#peers = peersOf(await this.#api.status(signal ?? AbortSignal.timeout(5_000), true));
    this.#peersAt = Date.now();
    return this.#peers;
  }

  async dns(name: string, type: number, signal?: AbortSignal): Promise<Uint8Array> {
    if (this.#s.status !== "connected") throw new Off();
    const t = DNS_TYPES[type];
    if (!t) throw new Error(`DNS type ${type} isn't looked up on the tailnet`);
    return this.#api.dns(name, t, signal);
  }

  /** One change at a time: a Connect, a Disconnect, a start or a stop. */
  #serial<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.#queue.catch(() => undefined).then(fn);
    this.#queue = next;
    return next;
  }

  #spawn(argv: string[]): Proc {
    const env: Record<string, string> = { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: this.#run, TS_LOGS_DIR: this.#run };
    return (this.o.spawn ?? realSpawn)(argv, env, (l) => {
      this.#log.push(l);
      if (this.#log.length > LOG_LINES) this.#log.shift();
    });
  }

  #lastLog(): string {
    const l = this.#log.at(-1);
    return l ? ` (tailscaled: ${l.slice(0, 200)})` : "";
  }

  /** Starts tailscaled in its run dir, from `sealed` state if it has one, and waits for its socket. */
  async #launch(state: Uint8Array | undefined): Promise<void> {
    const p = await this.o.programs();
    this.#endLeft();
    rmSync(this.#run, { recursive: true, force: true });
    mkdirSync(this.#run, { recursive: true, mode: 0o700 });
    if (state) writeFileSync(this.#stateFile, state, { mode: 0o600 });
    this.#sealedAt = state ? statSync(this.#stateFile).mtimeMs : 0;
    const daemon = this.#spawn([
      p.tailscaled,
      "--tun=userspace-networking",
      `--statedir=${this.#run}`,
      `--state=${this.#stateFile}`,
      `--socket=${this.#api.sock}`,
      "--port=0",
    ]);
    this.#daemon = daemon;
    if (daemon.pid !== undefined) writeFileSync(join(this.#run, "tailscaled.pid"), `${daemon.pid}\n`);
    void daemon.exited.then((code) => {
      if (this.#daemon !== daemon) return;
      this.#daemon = undefined;
      this.#up?.kill("SIGTERM");
      this.#up = undefined;
      if (!this.#wanted) return;
      this.#set({ status: "failed", problem: `Tailscale's gateway ended (exit ${code})${this.#lastLog()}` });
      this.#retry();
    });
    const deadline = Date.now() + START_WAIT_MS;
    for (;;) {
      try {
        await this.#read();
        break;
      } catch (error) {
        if (!this.#daemon) throw new Error(`tailscaled ended at its start${this.#lastLog()}`);
        if (Date.now() >= deadline) throw new Error(`tailscaled didn't answer within ${START_WAIT_MS / 1000} s: ${(error as Error).message}`);
        await Bun.sleep(100);
      }
    }
    this.#retryMs = 5_000;
    this.#later();
  }

  /** A tailscaled an earlier hub left running here (it ended without stopping it): only that one, by its recorded pid
   * while its command still names this run dir. */
  #endLeft(): void {
    try {
      const pid = Number(readFileSync(join(this.#run, "tailscaled.pid"), "utf8").trim());
      if (!Number.isInteger(pid) || pid <= 1 || pid === process.pid) return;
      if (readFileSync(`/proc/${pid}/cmdline`, "utf8").includes(this.#run)) process.kill(pid, "SIGTERM");
    } catch {}
  }

  /** A gateway that ended while wanted starts again, a little later each time. */
  #retry(): void {
    clearTimeout(this.#timer);
    this.#timer = setTimeout(() => {
      void this.#serial(async () => {
        if (!this.#wanted || this.#daemon) return;
        try {
          await this.#launch(await this.o.store.load());
        } catch (error) {
          this.#set({ status: "failed", problem: `Tailscale's gateway didn't start again: ${(error as Error).message}` });
          this.#retryMs = Math.min(this.#retryMs * 2, 60_000);
          this.#retry();
        }
      });
    }, this.#retryMs);
    this.#timer.unref?.();
  }

  /** Reads its status again soon: often while it waits on someone, now and then once connected. */
  #later(): void {
    clearTimeout(this.#timer);
    const ms = this.#s.status === "connected" ? (this.o.everyMs ?? 15_000) : (this.o.waitMs ?? 1_000);
    this.#timer = setTimeout(() => {
      if (!this.#daemon) return;
      void this.#read()
        .catch(() => undefined)
        .finally(() => this.#later());
    }, ms);
    this.#timer.unref?.();
  }

  /** tailscaled's status, as the gateway's state; a change of its login state is sealed. */
  async #read(): Promise<Status> {
    const st = await this.#api.status(AbortSignal.timeout(5_000));
    const b = st.BackendState;
    if (b === "Running") {
      this.#suffix = st.CurrentTailnet?.MagicDNSSuffix || undefined;
      const device = (st.Self?.DNSName ?? "").replace(/\.$/u, "").split(".")[0] || st.Self?.HostName || undefined;
      // Connected whether or not its sign-in could be sealed (a vault locked by its passphrase): then it says so, and the
      // seal is tried again at each read until the vault opens.
      let unsealed: string | undefined;
      try {
        await this.#seal();
      } catch (error) {
        const why = (error as Error).message.replace(/\.$/u, "");
        unsealed = `Connected, but its sign-in isn't kept: ${why.charAt(0).toLowerCase()}${why.slice(1)}. Unlock the vault in Settings › Vault; until then the hub's next restart signs it out`;
      }
      this.#set({
        status: "connected",
        ...(st.CurrentTailnet?.Name ? { tailnet: st.CurrentTailnet.Name } : {}),
        ...(device ? { device } : {}),
        ...(unsealed ? { problem: unsealed } : {}),
      });
    } else if (b === "NeedsMachineAuth") this.#set({ status: "approve" });
    else if (b === "NeedsLogin" && st.AuthURL) this.#set({ status: "login", loginUrl: st.AuthURL });
    else if (b === "NeedsLogin" && !this.#up && !this.#connecting) this.#set({ status: "failed", problem: "Tailscale signed the gateway out (its key expired, or it was removed from the tailnet): connect it again" });
    else if (this.#s.status !== "failed" || b === "Starting") this.#set({ status: "starting" });
    return st;
  }

  /** The state file, sealed again when tailscaled changed it. */
  async #seal(): Promise<void> {
    let at: number;
    try {
      at = statSync(this.#stateFile).mtimeMs;
    } catch {
      return;
    }
    if (at === this.#sealedAt || !this.#wanted) return;
    await this.o.store.save(new Uint8Array(readFileSync(this.#stateFile)));
    this.#sealedAt = at;
  }

  /** Ends tailscaled and any `up`, and deletes its run dir. */
  async #end(): Promise<void> {
    clearTimeout(this.#timer);
    const up = this.#up;
    const daemon = this.#daemon;
    this.#up = undefined;
    this.#daemon = undefined;
    up?.kill("SIGTERM");
    if (daemon) {
      daemon.kill("SIGTERM");
      await Promise.race([daemon.exited, Bun.sleep(5_000).then(() => daemon.kill("SIGKILL"))]);
    }
    if (existsSync(this.#run)) rmSync(this.#run, { recursive: true, force: true });
  }

  #set(next: TailnetState): void {
    const prev = this.#s;
    if (this.o.unsupported !== undefined) next = { ...next, problem: this.o.unsupported };
    this.#s = next;
    const same = prev.status === next.status && prev.tailnet === next.tailnet && prev.loginUrl === next.loginUrl && prev.problem === next.problem && prev.device === next.device;
    if (same) return;
    if (next.status === "connected" && prev.status !== "connected") console.info(`tailnet: the team's Tailscale gateway is connected to ${next.tailnet ?? "its tailnet"}`);
    if (next.status === "failed") console.warn(`tailnet: ${next.problem ?? "the gateway failed"}`);
    for (const fn of this.#listeners) fn(this.state());
  }
}

export { unsupported };
