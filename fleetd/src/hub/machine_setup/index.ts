// Settings › Hub › Machines (W105): the hub adds and removes machines for
// an owner or admin with the CLI's own `machine add` and `machine remove` (src/cli/setup/machine.ts), run here with the
// hub's database. `machine_add` answers at once with its run and goes on in the background: each step it starts or
// ends updates the run and sends a `machine_add.step` event; `machine_add_status` reads the run. Runs live in memory:
// a hub that restarts forgets them, and adding the machine again picks up where it stopped.
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { MachineAddRun, MachineAddState, SetupStep } from "../../shared/contracts.ts";
import { currentExe } from "../../cli/setup/shared.ts";
import { type Begin, type Builds, execute, type HubSide, type Peer, prepare, type Progress, type Resolved, releases, type Runner, ssh, Stop, tail } from "../../cli/setup/machine.ts";
import type { Hub } from "../api/hub.ts";
import { link } from "../link/index.ts";
import type { NodeActionResult } from "../../shared/node_link.ts";
import { type NewEvent, events } from "../store/events.ts";
import { isoMs } from "../store/time.ts";

/** Runs kept for machine_add_status. */
const KEEP = 20;
/** A step's output, at most. */
const OUTPUT_MAX = 4000;

/** machine.removed: every open app drops the machine and its projects. */
export const removedEvent = (machineId: string, at: string): NewEvent => ({
  at,
  type: "machine.removed",
  machineId,
  summary: `${machineId} was removed from the hub`,
});

/** What adding a machine reaches outside the hub: the machine, the fleetd it gets, and where hosts are found. */
export interface SetupPorts {
  runner(): Runner;
  exe(): string;
  builds(): Builds;
  /** The `Host`s in the hub user's ~/.ssh/config, and the tailnet's peers. */
  hosts(): Promise<[string[], Peer[]]>;
  /** The machine's node runs `claude auth login`: without `code` it starts, with the code it ends. */
  claudeLogin(hub: Hub, machine: string, code?: string): Promise<{ ok: boolean; message: string; loginUrl?: string }>;
}

/** A Host line's hosts from an ssh_config (detect.rs `parse_ssh_hosts`): no patterns, no duplicates. */
export function parseSshHosts(config: string): string[] {
  const hosts: string[] = [];
  for (const raw of config.split("\n")) {
    const line = raw.trim();
    const m = /^(\S+?)(?:[\s=]+)(.*)$/.exec(line);
    if (!m || m[1]!.toLowerCase() !== "host") continue;
    for (const h of m[2]!.split(/\s+/)) {
      const host = h.replace(/^"+|"+$/g, "");
      if (host !== "" && !/[*?!]/.test(host) && !hosts.includes(host)) hosts.push(host);
    }
  }
  return hosts;
}

/** `tailscale status --json`'s online Linux and macOS peers (detect.rs `parse_tailscale_status`). */
export function parseTailscalePeers(json: string): Peer[] | undefined {
  let status: Record<string, unknown>;
  try {
    status = JSON.parse(json) as Record<string, unknown>;
  } catch {
    return undefined;
  }
  if (status.BackendState !== "Running" || !status.Self) return undefined;
  const peers: Peer[] = [];
  for (const peer of Object.values((status.Peer ?? {}) as Record<string, Record<string, unknown>>)) {
    if (peer.Online !== true || (peer.OS !== "linux" && peer.OS !== "macOS")) continue;
    const dnsName = typeof peer.DNSName === "string" ? peer.DNSName.replace(/\.+$/, "") : "";
    if (dnsName === "") continue;
    peers.push({ name: dnsName.split(".")[0]!, dnsName });
  }
  return peers.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

/** The real ones: ssh, the running fleetd, ~/.ssh/config and `tailscale status`. */
export const realPorts: SetupPorts = {
  runner: () => ssh,
  exe: currentExe,
  builds: () => releases,
  async hosts() {
    let sshHosts: string[] = [];
    try {
      sshHosts = parseSshHosts(readFileSync(join(process.env.HOME ?? "", ".ssh/config"), "utf8"));
    } catch {}
    let peers: Peer[] = [];
    try {
      const p = Bun.spawn(["tailscale", "status", "--json"], { stdout: "pipe", stderr: "ignore" });
      const out = await new Response(p.stdout).text();
      if ((await p.exited) === 0) peers = parseTailscalePeers(out) ?? [];
    } catch {}
    return [sshHosts, peers];
  },
  async claudeLogin(hub, machine, code) {
    if (!link(hub).can(machine, "claude_login")) {
      throw new Error(`${machine} isn't connected, or its fleetd is too old to log claude in from here. Fix: update its fleetd, or run claude auth login on ${machine}`);
    }
    let r: NodeActionResult;
    try {
      r = (await link(hub).commands.claudeLogin(machine, code)) as unknown as NodeActionResult;
    } catch (e) {
      throw new Error(e instanceof Error ? e.message : String(e));
    }
    return { ok: r.ok, message: r.message, ...(r.login_url !== undefined ? { loginUrl: r.login_url } : {}) };
  },
};

/** `Fix: ` and what follows, apart from what went wrong. */
export function splitFix(message: string): [string, string | undefined] {
  const at = message.lastIndexOf("Fix: ");
  return at < 0 ? [message.trim(), undefined] : [message.slice(0, at).trimEnd(), message.slice(at + 5).trim()];
}

function clipOutput(text: string): string | undefined {
  const t = tail(text);
  if (t === "") return undefined;
  const bytes = Buffer.from(t);
  if (bytes.length <= OUTPUT_MAX) return t;
  // The last OUTPUT_MAX bytes, from a character boundary.
  let start = bytes.length - OUTPUT_MAX;
  while (start < bytes.length && (bytes[start]! & 0xc0) === 0x80) start++;
  return bytes.subarray(start).toString();
}

/** A run's steps as `machine add` or `remove` reports them. */
export class Steps {
  steps: SetupStep[] = [];
  /** What it said besides its steps and notes. */
  said: string[] = [];

  private static step(b: Begin, state: SetupStep["state"]): SetupStep {
    return { title: b.title, ...(b.command !== undefined ? { command: b.command } : {}), ...(b.stdin !== undefined ? { stdin: b.stdin } : {}), state };
  }

  private running(): SetupStep | undefined {
    return [...this.steps].reverse().find((s) => s.state === "running");
  }

  planned(steps: Begin[]): void {
    this.steps = this.steps.filter((s) => s.state !== "planned");
    this.steps.push(...steps.map((b) => Steps.step(b, "planned")));
  }

  begin(b: Begin): void {
    const i = this.steps.findIndex((s) => s.state === "planned" && s.title === b.title);
    if (i >= 0) this.steps[i] = Steps.step(b, "running");
    else this.steps.push(Steps.step(b, "running"));
  }

  done(output: string): void {
    const s = this.running();
    if (!s) return;
    s.state = "done";
    const o = clipOutput(output);
    if (o !== undefined) s.output = o;
    else delete s.output;
  }

  /** The step going now failed with `output`; false when none was going. */
  failed(output: string): boolean {
    const s = this.running();
    if (!s) return false;
    s.state = "failed";
    const o = clipOutput(output);
    if (o !== undefined) s.output = o;
    else delete s.output;
    return true;
  }

  say(line: string): void {
    // Notes come with the result.
    if (!line.startsWith("note: ")) this.said.push(line);
  }
}

/** A Progress that keeps what a run reports in `steps`, calling `changed` after each step change. */
export function recorder(steps: Steps, changed: () => void = () => {}): Progress {
  return {
    planned(b) {
      steps.planned(b);
      changed();
    },
    begin(b) {
      steps.begin(b);
      changed();
    },
    done(output) {
      steps.done(output);
      changed();
    },
    failed(code, output, fix) {
      steps.failed(`exit ${code}: ${output}\nFix: ${fix}`);
      changed();
    },
    say: (line) => steps.say(line),
  };
}

const newId = () => `M${randomBytes(16).toString("hex")}`;

export class MachineSetup {
  ports: SetupPorts = realPorts;
  /** Newest first. */
  private runs_: MachineAddRun[] = [];

  constructor(private readonly hub: Hub) {}

  /** Tests put fakes in. */
  setPorts(ports: SetupPorts): void {
    this.ports = ports;
  }

  runs(): MachineAddRun[] {
    return structuredClone(this.runs_);
  }

  /** Starts a run for `machine`, unless one is going for it already. */
  start(machine: string, host: string | undefined, at: string): MachineAddRun | undefined {
    if (this.runs_.some((r) => r.machineId === machine && r.state === "running")) return undefined;
    const run: MachineAddRun = { runId: newId(), machineId: machine, ...(host !== undefined ? { host } : {}), state: "running", steps: [], notes: [], startedAt: at };
    this.runs_.unshift(run);
    this.runs_.length = Math.min(this.runs_.length, KEEP);
    return structuredClone(run);
  }

  update(runId: string, change: (r: MachineAddRun) => void): MachineAddRun | undefined {
    const run = this.runs_.find((r) => r.runId === runId);
    if (!run) return undefined;
    change(run);
    return structuredClone(run);
  }

  /** machine_add.step: one per change of a run. */
  emit(run: MachineAddRun): void {
    const m = run.machineId;
    let summary: string;
    if (run.state === "done") summary = `Added ${m}`;
    else if (run.state === "failed") summary = `Couldn't add ${m}`;
    else {
      const step = [...run.steps].reverse().find((s) => s.state !== "planned");
      summary = step ? `Adding ${m}: ${step.title}` : `Adding ${m}`;
    }
    try {
      events(this.hub).append({
        at: isoMs(this.hub.clock.now()),
        type: "machine_add.step",
        summary: [...summary].slice(0, 200).join(""),
        data: { runId: run.runId, machineId: m, state: run.state },
      });
    } catch (e) {
      console.warn(`machine_add.step for ${m}:`, e);
    }
  }

  /** Runs `machine add` for the resolved machine in the background, recording each step in `run`. */
  spawnAdd(run: MachineAddRun, resolved: Resolved, side: HubSide): void {
    const runner = this.ports.runner();
    const builds = this.ports.builds();
    const steps = new Steps();
    const progress = recorder(steps, () => {
      const r = this.update(run.runId, (x) => (x.steps = structuredClone(steps.steps)));
      if (r) this.emit(r);
    });
    void (async () => {
      let result: { notes: string[]; loggedIn: boolean } | Stop;
      try {
        const prepared = await prepare(resolved, side, runner, builds, true, progress);
        result = await execute(resolved, prepared, side, runner, progress);
      } catch (e) {
        result = e instanceof Stop ? e : new Stop(1, e instanceof Error ? e.message : String(e));
      }
      const at = isoMs(this.hub.clock.now());
      if (result instanceof Stop) {
        // "step 3 failed (exit 1):" heads the run's message; the step itself shows what it printed.
        const what = splitFix(result.message)[0];
        const nl = what.indexOf("\n");
        steps.failed(nl >= 0 && what.startsWith("step ") ? what.slice(nl + 1) : what);
      } else {
        // The wait for a node that was online already: nothing to wait for.
        for (const s of steps.steps) if (s.state === "planned") s.state = "done";
      }
      const finished = this.update(run.runId, (r) => {
        r.steps = structuredClone(steps.steps);
        r.finishedAt = at;
        if (result instanceof Stop) {
          const [message, fix] = splitFix(result.message);
          r.state = "failed" as MachineAddState;
          r.message = message;
          if (fix !== undefined) r.fix = fix;
        } else {
          r.state = "done";
          r.notes = result.notes;
          r.loggedIn = result.loggedIn;
        }
      });
      if (finished) this.emit(finished);
    })();
  }
}

/** The hub's machine setup, `hub.area("machine_setup")`. */
export const machineSetup = (hub: Hub) => hub.area("machine_setup", (h) => new MachineSetup(h));
