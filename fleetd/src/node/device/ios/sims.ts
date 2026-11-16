// The simulators agents hold on the agents' Mac (`sim_end`,
// `end_idle_sims`, `sim_env`): `mac sim start` lends an agent a clone from the warm pool (or one of the device type it
// named), within the Mac's budget of simulators at once and in the order agents asked (node/mac_tool/queue.ts); `mac
// sim end`, or 30 minutes without a step, gives it back and deletes it. While an agent holds one, its jobs' agent-device and plain simctl are pointed at it.
//
// Each simulator lent is a screen of the agent's too (sim_screen.ts), when the hub made one for the step that lent it:
// a person watches and takes it over in Screens, and it ends with the simulator.
import { join } from "node:path";
import { ToolError } from "../../../shared/errors.ts";
import { simBudget } from "../../mac_tool/protocol.ts";
import { Queue } from "../../mac_tool/queue.ts";
import type { SimScreen as SimScreenKey } from "../../../shared/screens_wire.ts";
import { controlPath, release, sessionDir } from "../agent_device.ts";
import { blocksSimulators } from "../../agents_mac/checks.ts";
import { simWaiting, type Simulators } from "./index.ts";
import type { Lent } from "./pool.ts";
import type { Runner } from "./screen.ts";
import type { SimScreens } from "./sim_screen.ts";
import { binDir, iosEnv, setDir, writeConfig } from "./wrapper.ts";

/** A simulator nobody sent a step for this long goes. */
export const SIM_IDLE = 30 * 60_000;

/** What an agent's simulator goes by in agent-device's wrapper (its config, under the node's `sessions/`). */
export const simKey = (agent: string) => `mac-${agent}`;

type Held = { lent: Lent; device: string; project: string; sinceMs: number; used: number };
type Started = { step: "sim_start"; udid: string; device: string };
type Queued = { step: "sim_queued"; place: number; secs: number | null; why: string };
const WAIT_FIX = "mac sim start without --no-wait waits its turn, or carry on without one";

/** The Mac's memory (`sysctl -n hw.memsize`); 16 GB when it can't be read. */
export function memBytes(): number {
  try {
    const out = Bun.spawnSync(["sysctl", "-n", "hw.memsize"], { stdin: "ignore", stdout: "pipe", stderr: "ignore" });
    const n = Number(out.stdout.toString().trim());
    if (out.success && Number.isFinite(n) && n > 0) return n;
  } catch {
    // Not a Mac.
  }
  return 16 * 2 ** 30;
}

export class MacSims {
  readonly held = new Map<string, Held>();
  /** The agents waiting for one, in the order they asked. */
  readonly queue = new Queue();
  /** The simulators' screens, where the Mac shows them (its link to the hub). */
  screens: SimScreens | undefined;

  constructor(
    /** The node's home: the wrapper's config for each agent, the golden's set. */
    readonly home: string,
    readonly simulators: Simulators,
    /** node.json's `mac.simulators`: how many agents may hold one at once; absent, from the Mac's memory. */
    private readonly setting: number | undefined,
    private readonly mem: () => number = memBytes,
  ) {}

  /** How many simulators agents may hold at once: the setting, else from the Mac's memory; at least 1. */
  budget(): number {
    return Math.max(this.setting ?? simBudget(this.mem()), 1);
  }

  /**
   * The agent's simulator: its own again while it holds one, else within the budget a clone from the warm pool, or with
   * `device` a simulator of that device type (`mac sim start --device`). Simulators go to agents in the order they
   * asked (queue.ts): one that `wait`s and isn't first, or finds none free, hears its place in line; one that doesn't
   * wait is told why there is none, as before the line. A simulator lent now is the `screen` the hub made for this
   * step, when it made one.
   */
  async start(agent: { name: string; project: string }, device?: string, wait = false, screen?: SimScreenKey): Promise<Started | Queued> {
    // Developer Mode off: the clone's XCTest runner would wait on a password prompt at the Mac's screen.
    const blocked = blocksSimulators(this.home);
    if (blocked) {
      this.queue.leave(agent.name);
      throw new ToolError(
        "failed",
        `The agents' Mac can't run iOS simulators yet: ${blocked.message}`,
        `do without a simulator and tell your lead: an admin runs \`${blocked.command ?? ""}\` in Terminal at the Mac, then mac sim start works`,
      );
    }
    const mine = this.held.get(agent.name);
    if (mine) {
      this.queue.leave(agent.name);
      return heldAgain(mine, device);
    }
    const budget = this.budget();
    const inUse = this.held.size;
    const turn = this.queue.turn(agent.name, wait, inUse, budget, Date.now());
    if (!turn.now) {
      const { place, full } = turn;
      if (!wait && full) throw new ToolError("failed", `All ${budget} of the Mac's iOS simulators are in use by other agents.`, WAIT_FIX);
      if (!wait) throw new ToolError("failed", `${place - 1} agents are waiting for the Mac's iOS simulators, and get theirs first.`, WAIT_FIX);
      const free = Math.max(budget - inUse, 0);
      return {
        step: "sim_queued",
        place,
        secs: !full && place <= free ? (this.simulators.readyIn(place) ?? null) : null,
        why: full ? `all ${budget} of the Mac's iOS simulators are in use by other agents` : "the agents ahead of you get theirs first",
      };
    }
    let taken: Awaited<ReturnType<Simulators["lendType"]>>;
    try {
      taken = device !== undefined ? await this.simulators.lendType(device) : this.simulators.lendOrWait();
    } catch (e) {
      this.queue.leave(agent.name);
      throw e;
    }
    if ("waiting" in taken) {
      const { waiting } = taken;
      // First in line, and the pool is booting the clone that is the agent's.
      if (wait && waiting.retryIn === undefined) {
        return {
          step: "sim_queued",
          place: 1,
          secs: waiting.secs,
          why: waiting.failing === undefined ? "yours is booting" : `the last boot failed (${waiting.failing}); yours is booting again`,
        };
      }
      if (wait) this.queue.leave(agent.name);
      throw simWaiting(waiting);
    }
    const [lent, named] = taken.lent;
    this.queue.leave(agent.name);
    // Another `mac sim start` of the agent's got one meanwhile: that one stays, this goes.
    const meanwhile = this.held.get(agent.name);
    if (meanwhile) {
      void lent.discard();
      return heldAgain(meanwhile);
    }
    const key = simKey(agent.name);
    try {
      writeConfig(this.home, key, lent.udid, lent.runner ? lent.home : undefined);
    } catch (e) {
      void lent.discard();
      throw new ToolError("failed", `agent-device wasn't pointed at the simulator: ${(e as Error).message}`);
    }
    this.held.set(agent.name, { lent, device: named, project: agent.project, sinceMs: Date.now(), used: Date.now() });
    if (screen) {
      this.screens?.open({
        screen,
        agent: agent.name,
        udid: lent.udid,
        device: named,
        scale: lent.scale,
        runner: this.runner(agent.name, lent.udid),
        controlFile: controlPath(this.home, key),
      });
    }
    return { step: "sim_start", udid: lent.udid, device: named };
  }

  /** The agent's simulator goes: deleted with its clone. Waiting for one, it leaves the line. Whether it held one. */
  end(agent: string): boolean {
    this.queue.leave(agent);
    const held = this.held.get(agent);
    if (!held) return false;
    this.held.delete(agent);
    release(this.home, simKey(agent));
    // Its screen's video is finished before the simulator goes.
    void (this.screens?.close(agent) ?? Promise.resolve()).finally(() => held.lent.discard());
    return true;
  }

  /** How a person's commands on the agent's simulator run: its wrapper, in the agent's own agent-device home (its
   * daemon and runner), past the control file that holds the agent's back. */
  private runner(agent: string, udid: string): Runner {
    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) if (v !== undefined) env[k] = v;
    for (const [k, v] of this.env(agent, process.env.PATH) ?? []) env[k] = v;
    delete env.FLEETD_DEVICE_CONTROL;
    return { wrapper: join(binDir(this.home), "agent-device"), env, udid };
  }

  /** An agent's job on the Mac ended (its screen's log). */
  ran(agent: string, command: string, ok: boolean, durationMs: number): void {
    this.screens?.ran(agent, command, ok, durationMs);
  }

  /** A step of the agent's: its simulator isn't idle. */
  touch(agent: string): void {
    const held = this.held.get(agent);
    if (held) held.used = Date.now();
  }

  /** Ends the simulators of agents that sent no step for `idle`. */
  endIdle(idle = SIM_IDLE, now = Date.now()): string[] {
    const idleOnes = [...this.held].filter(([, h]) => now - h.used >= idle).map(([name]) => name);
    for (const name of idleOnes) this.end(name);
    return idleOnes;
  }

  /**
   * What points a job's agent-device (and plain simctl) at the agent's simulator, while it holds one: the wrapper
   * first on PATH, and for simctl its udid and the node's device set (`xcrun simctl --set "$FLEETD_MAC_SIM_SET" …`).
   */
  env(agent: string, path?: string): [string, string][] | undefined {
    const held = this.held.get(agent);
    if (!held) return undefined;
    return [...iosEnv(this.home, simKey(agent), path), ["FLEETD_MAC_SIM", held.lent.udid], ["FLEETD_MAC_SIM_SET", setDir(this.home)]];
  }

  /** The simulators agents hold now, oldest first (the menu bar's activity). */
  activity(): { agent: string; projectId: string; device: string; sinceMs: number }[] {
    return [...this.held]
      .map(([agent, h]) => ({ agent, projectId: h.project, device: h.device, sinceMs: h.sinceMs }))
      .sort((a, b) => a.sinceMs - b.sinceMs || a.agent.localeCompare(b.agent));
  }

  /** Every held simulator goes, and the pool's (the node stops). */
  async shutdown(): Promise<void> {
    await this.screens?.shutdown();
    for (const agent of [...this.held.keys()]) this.end(agent);
    await this.simulators.shutdown();
  }
}

/** The simulator the agent holds, asked for again: the same one, unless it named another device type. */
function heldAgain(h: Held, device?: string): Started {
  if (device !== undefined && !h.device.startsWith(`${device} on `)) {
    throw new ToolError("invalid", `You hold a ${h.device} simulator already.`, `mac sim end, then mac sim start --device "${device}"`);
  }
  h.used = Date.now();
  return { step: "sim_start", udid: h.lent.udid, device: h.device };
}

/** The agent-device config the agent's simulator is named in (for tests and the doctor). */
export const simConfig = (home: string, agent: string) => join(sessionDir(home, simKey(agent)), "config.json");
