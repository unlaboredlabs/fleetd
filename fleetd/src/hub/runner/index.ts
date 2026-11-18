// The hub's own runner (D558): nothing in fleetd needs a computer of the team's. A team that connected a hosted sandbox
// provider (its own E2B, boat.dev or Daytona key) and no computer still runs agents, because the hub starts a fleetd
// node of its own, the same code every machine runs, under the reserved machine id RUNNER_ID with `node.json`'s
// `runner` on. That node keeps its bots' checkouts in `<hub home>/runner`, and runs every session of theirs, leads too,
// in a box of the team's providers, as a machine runs a task placed there (node/place/hosted.ts): its slot board's own
// slots are none (slots/board.ts), it offers no screens, runs no command on the hub's machine and never uses a
// machine's Claude login. Its agents run on the team's Claude account, sealed to it as to every machine.
//
// It is one more machine to everything else (ProjectRef, threads, slots, keys), which the apps show as "Hosted
// sandboxes", never as a computer. It runs while a provider is connected or a bot lives on it, and only where hosted
// boxes are made from (Linux on x86_64). It joins once with an enroll code the hub mints for it, over the hub's own
// address, then links as any node does; it stops with the hub, and its boxes, which outlive it, are re-adopted at its
// next start. A machine and a provider both connected: bots on the machine run as they always did.
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CAP_RUNNER, RUNNER_ID } from "../../shared/sandbox.ts";
import { readConfig } from "../../node/config.ts";
import { selfArgv } from "../../node/util.ts";
import type { Hub } from "../api/hub.ts";
import { limits } from "../sandbox/index.ts";
import { store } from "../store/hub_store.ts";

export { CAP_RUNNER, RUNNER_ID };

/** What the runner's process is to the hub: something that ends, and can be told to. */
export type Child = { pid?: number; exited: Promise<number | null>; kill(signal?: NodeJS.Signals): void };
/** Starts the runner's node: `argv` after fleetd's own, the enroll code on stdin when it joins. Tests stand one in. */
export type Spawn = (args: string[], stdin: string | undefined) => Child;

const PID_FILE = "runner.pid";
const FIRST_RETRY_MS = 1_000;
const LAST_RETRY_MS = 60_000;

/** Why this hub can't run agents in hosted sandboxes itself; undefined where it can. */
export function unsupported(platform: string = process.platform, arch: string = process.arch): string | undefined {
  if (platform === "linux" && arch === "x64") return undefined;
  return `this hub runs on ${platform} (${arch}), and hosted sandboxes are made from Linux on x86_64: connect a computer of the team's to run agents`;
}

/** The address the runner dials the hub at: its own listen address, on loopback where it listens on every one. */
export function dialUrl(host: string, port: number): string {
  const h = host === "0.0.0.0" || host === "" ? "127.0.0.1" : host === "::" ? "::1" : host;
  return `http://${h.includes(":") ? `[${h}]` : h}:${port}`;
}

/** A runner an earlier hub started and left (it ended without stopping it): it goes before another starts, so two
 * never take turns at the one link. Only that process, by its recorded pid and while its command still names `home`. */
function endLeft(home: string): void {
  const file = join(home, PID_FILE);
  let pid: number;
  try {
    pid = Number(readFileSync(file, "utf8").trim());
  } catch {
    return;
  }
  rmSync(file, { force: true });
  if (!Number.isInteger(pid) || pid <= 1 || pid === process.pid) return;
  try {
    const argv = readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0");
    if (argv.includes("node") && argv.includes(home)) process.kill(pid, "SIGTERM");
  } catch {}
}

/** fleetd's own process, running the CLI with `args`. */
const realSpawn: Spawn = (args, stdin) => {
  const child = Bun.spawn([...selfArgv(), ...args], { stdin: stdin === undefined ? "ignore" : "pipe", stdout: "pipe", stderr: "pipe" });
  if (stdin !== undefined && child.stdin) {
    child.stdin.write(`${stdin}\n`);
    void child.stdin.end();
  }
  for (const out of [child.stdout, child.stderr]) void relay(out);
  return { pid: child.pid, exited: child.exited, kill: (signal) => child.kill(signal) };
};

/** The runner's log lines, in the hub's log. */
async function relay(stream: ReadableStream<Uint8Array>): Promise<void> {
  let rest = "";
  for await (const chunk of stream.pipeThrough(new TextDecoderStream())) {
    const lines = (rest + chunk).split("\n");
    rest = lines.pop() ?? "";
    for (const line of lines) if (line.trim()) console.error(`runner: ${line}`);
  }
}

export class Runner {
  #child: Child | undefined;
  #url: string | undefined;
  #retryMs = FIRST_RETRY_MS;
  #timer: ReturnType<typeof setTimeout> | undefined;

  constructor(
    private readonly hub: Hub,
    private readonly spawn: Spawn = realSpawn,
    private readonly why: string | undefined = unsupported(),
  ) {
    hub.shutdown.signal.addEventListener("abort", () => this.stop(), { once: true });
  }

  /** Where the runner's node keeps its home. */
  get home(): string {
    return join(this.hub.config.home, "runner");
  }

  /** Why it doesn't run on this hub at all; undefined where it can. */
  get unsupported(): string | undefined {
    return this.why;
  }

  get running(): boolean {
    return this.#child !== undefined;
  }

  /** Whether the hub wants its runner now: a provider is connected, or a bot lives on it. */
  wanted(): boolean {
    if (this.why !== undefined) return false;
    return limits(this.hub).length > 0 || store(this.hub).projectsList(RUNNER_ID).length > 0;
  }

  /** The hub serves at `url` now: the runner starts if it's wanted. */
  start(url: string): void {
    this.#url = url;
    this.sync();
  }

  /** Starts the runner when it's wanted and not running, stops it when it isn't wanted. */
  sync(): void {
    if (this.#url === undefined || this.hub.shutdown.signal.aborted) return;
    const want = this.wanted();
    if (want && !this.#child && !this.#timer) this.#launch();
    if (!want && this.#child) this.stop();
  }

  stop(): void {
    clearTimeout(this.#timer);
    this.#timer = undefined;
    const child = this.#child;
    this.#child = undefined;
    child?.kill("SIGTERM");
  }

  #launch(): void {
    const home = this.home;
    mkdirSync(home, { recursive: true, mode: 0o700 });
    endLeft(home);
    let enrolled = false;
    try {
      enrolled = readConfig(home)?.enrolled === true;
    } catch {}
    let child: Child;
    if (enrolled) {
      child = this.spawn(["node", "run", "--home", home], undefined);
    } else {
      // Joins once, as any machine does, then keeps its link up as that node.
      const code = this.hub.auth.nodes.createEnrollToken(RUNNER_ID, "the hub's runner").token;
      child = this.spawn(["node", "join", "--hub", this.#url!, "--token-file", "-", "--machine", RUNNER_ID, "--home", home, "--runner"], code);
    }
    this.#child = child;
    if (child.pid !== undefined) writeFileSync(join(home, PID_FILE), `${child.pid}\n`);
    const started = Date.now();
    console.info(`runner: started the hub's runner for hosted sandboxes${enrolled ? "" : ", joining as a node"}`);
    void child.exited.then((code) => {
      if (this.#child !== child) return;
      this.#child = undefined;
      // A runner that ran a while starts again at once; one that keeps failing waits longer each time.
      this.#retryMs = Date.now() - started > LAST_RETRY_MS ? FIRST_RETRY_MS : Math.min(this.#retryMs * 2, LAST_RETRY_MS);
      console.warn(`runner: the hub's runner ended (exit ${code}); starting it again in ${this.#retryMs / 1000} s if still wanted`);
      this.#timer = setTimeout(() => {
        this.#timer = undefined;
        this.sync();
      }, this.#retryMs);
      this.#timer.unref?.();
    });
  }
}

/** The hub's runner. */
export const runner = (hub: Hub) => hub.area("runner", (h) => new Runner(h));
