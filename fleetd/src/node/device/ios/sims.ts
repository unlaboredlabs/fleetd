// The simulators agents hold on the agents' Mac (`sim_end`,
// `end_idle_sims`, `sim_env`): `mac sim start` lends an agent a clone from the warm pool (or one of the device type it
// named), within the Mac's budget of simulators at once and in the order agents asked (node/mac_tool/queue.ts); `mac
// sim end`, or 30 minutes without a step, gives it back and deletes it. While an agent holds one, its jobs' agent-device and plain simctl are pointed at it.
//
// Each simulator lent is a screen of the agent's too (sim_screen.ts), when the hub made one for the step that lent it:
// a person watches and takes it over in Screens, and it ends with the simulator.
//
// A node restart (an update installs as soon as it is ready) ends none of them: the clones run on in CoreSimulator,
// their agent-device daemons and runners and their videos' recordVideo in process groups of their own, and who holds
// which is kept in `<ios dir>/held.json`. The next node takes each one over (`adopt`), its screen under the same ids;
// one it can't take over goes, and its agent's next agent-device says why (`env`).
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { ToolError } from "../../../shared/errors.ts";
import { simBudget } from "../../mac_tool/protocol.ts";
import { Queue } from "../../mac_tool/queue.ts";
import type { SimScreen as SimScreenKey } from "../../../shared/screens_wire.ts";
import { controlPath, release, sessionDir } from "../agent_device.ts";
import { blocksSimulators } from "../../agents_mac/checks.ts";
import { writeAtomic } from "../../secrets/files.ts";
import { simWaiting, type Simulators } from "./index.ts";
import { Lent } from "./pool.ts";
import { type Runner, runCommand } from "./screen.ts";
import type { KeptScreen, SimScreens } from "./sim_screen.ts";
import { binDir, iosDir, iosEnv, setDir, writeConfig } from "./wrapper.ts";
import { foldable, Helpers, SimDevice, simctlControls, type DeviceState, type Shot } from "./controls.ts";
import { isPlainIphone, type Runtime } from "./simctl.ts";
import type { ScreenControl, SimModel, SimModels } from "../../../shared/contracts.ts";

/** A simulator nobody sent a step for this long goes. */
export const SIM_IDLE = 30 * 60_000;

/** What an agent's simulator goes by in agent-device's wrapper (its config, under the node's `sessions/`). */
export const simKey = (agent: string) => `mac-${agent}`;

/** `label`: the person a person's own simulator is for, its screen named for them. */
type Held = { lent: Lent; device: string; project: string; sinceMs: number; used: number; dev: SimDevice; label?: string };

/** A held simulator as `<ios dir>/held.json` keeps it for the next node: its clone, holder and screen. */
type Kept = {
  agent: string;
  udid: string;
  /** The clone's own agent-device home, and whether the pool started its runner there. */
  home: string;
  runner: boolean;
  scale: number;
  device: string;
  project: string;
  sinceMs: number;
  used: number;
  screen?: KeptScreen;
  /** Its device as fleetd last set it (controls.ts): a Duo's fold, the turn, light or dark. */
  state?: DeviceState;
  label?: string;
};

export const heldPath = (home: string) => join(iosDir(home), "held.json");

/** Where an agent's simulator that went with a node restart says why, until its next `mac sim start` or `end`. */
export const endedPath = (home: string, agent: string) => join(sessionDir(home, simKey(agent)), "sim-ended");
/** The directory whose `agent-device` says so, first on the agent's PATH meanwhile. */
const endedBin = (home: string) => join(iosDir(home), "ended-bin");
/** The stand-in agent-device: it prints why the agent's simulator ended, and fails as agent-device unavailable. */
const ENDED_SCRIPT = '#!/bin/sh\ncat "$FLEETD_MAC_SIM_ENDED" >&2 2>/dev/null || echo "Your iOS simulator on the agents\' Mac ended: run mac sim start again." >&2\nexit 69\n';
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

/** What a start is for beyond an agent's own: a person's simulator (`label`, "Ada"), ahead of agents in line, and the
 * runtime picked for it. */
export type StartFor = { person?: string; runtime?: string };

export class MacSims {
  readonly held = new Map<string, Held>();
  /** The device controls' helpers (controls.ts), built at their first use. */
  private readonly helpers: Helpers;
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
  ) {
    this.helpers = new Helpers(home);
  }

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
  async start(agent: { name: string; project: string }, device?: string, wait = false, screen?: SimScreenKey, as: StartFor = {}): Promise<Started | Queued> {
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
    const turn = this.queue.turn(agent.name, wait, inUse, budget, Date.now(), as.person !== undefined);
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
      taken =
        device !== undefined || as.runtime !== undefined
          ? await this.simulators.lendType(device ?? (await this.simulators.plainType()), as.runtime)
          : this.simulators.lendOrWait();
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
    rmSync(endedPath(this.home, agent.name), { force: true });
    const runner = this.runner(agent.name, lent.udid);
    const dev = this.device(lent.udid, named, runner);
    this.held.set(agent.name, {
      lent,
      device: named,
      project: agent.project,
      sinceMs: Date.now(),
      used: Date.now(),
      dev,
      ...(as.person !== undefined ? { label: as.person } : {}),
    });
    // Its appearance read, and a foldable put in the pose fleetd keeps for it, before anyone sees it.
    await dev.settle();
    // Ended meanwhile (mac sim end, or its idle end): it has no screen to show.
    if (screen && this.held.get(agent.name)?.dev === dev) {
      this.screens?.open({
        screen,
        agent: agent.name,
        udid: lent.udid,
        device: named,
        scale: lent.scale,
        runner,
        controlFile: controlPath(this.home, key),
        dev,
        ...(as.person !== undefined ? { label: as.person } : {}),
      });
    }
    this.save();
    return { step: "sim_start", udid: lent.udid, device: named };
  }

  /**
   * The agent's simulator goes: deleted with its clone. Waiting for one, it leaves the line. Whether it held one.
   * `note`: why it went, on its screen's recording.
   */
  end(agent: string, note?: string): boolean {
    this.queue.leave(agent);
    if (note === undefined) rmSync(endedPath(this.home, agent), { force: true });
    const held = this.held.get(agent);
    if (!held) return false;
    this.held.delete(agent);
    this.save();
    release(this.home, simKey(agent));
    // Its screen's video is finished before the simulator goes.
    void (this.screens?.close(agent, note) ?? Promise.resolve()).finally(() => held.lent.discard());
    return true;
  }

  /** A simulator's device controls, as fleetd last set them (`state`) when the node before held it. */
  private device(udid: string, device: string, runner: Runner, state?: DeviceState): SimDevice {
    const dev = new SimDevice(udid, device, simctlControls(this.simulators.simctl, this.helpers, (args) => runCommand(runner, args), join(iosDir(this.home), "shots")));
    if (state) dev.state = state;
    return dev;
  }

  /** Writes who holds which simulator, and their screens, for the next node (`adopt`). */
  save(): void {
    const screens = this.screens?.kept() ?? new Map<string, KeptScreen>();
    const kept: Kept[] = [...this.held].map(([agent, h]) => ({
      agent,
      udid: h.lent.udid,
      home: h.lent.home,
      runner: h.lent.runner,
      scale: h.lent.scale,
      device: h.device,
      project: h.project,
      sinceMs: h.sinceMs,
      used: h.used,
      ...(screens.has(agent) ? { screen: screens.get(agent)! } : {}),
      state: h.dev.state,
      ...(h.label !== undefined ? { label: h.label } : {}),
    }));
    try {
      mkdirSync(iosDir(this.home), { recursive: true });
      writeAtomic(heldPath(this.home), `${JSON.stringify(kept, null, 2)}\n`);
    } catch (e) {
      console.warn(`${new Date().toISOString()} WARN the held iOS simulators were not written {"error":${JSON.stringify(String(e))}}`);
    }
  }

  /**
   * Takes over the simulators a stopped node left held (held.json), then starts the pool, which deletes every other
   * clone. Each is its agent's again at once, its screen too, so a step or a sweep meanwhile finds it; one whose clone
   * isn't booted any more, or that the pool's start deleted, then goes, and its agent is told why.
   */
  async adopt(): Promise<void> {
    let kept: Kept[] = [];
    try {
      kept = JSON.parse(readFileSync(heldPath(this.home), "utf8")) as Kept[];
    } catch {
      // None held, or a node before this file.
    }
    for (const k of kept) {
      if (this.held.has(k.agent)) continue;
      const lent = new Lent(k.udid, k.home, this.simulators.simctl);
      lent.runner = k.runner;
      lent.scale = k.scale;
      const runner = this.runner(k.agent, k.udid);
      const dev = this.device(k.udid, k.device, runner, k.state);
      this.held.set(k.agent, { lent, device: k.device, project: k.project, sinceMs: k.sinceMs, used: k.used, dev, ...(k.label !== undefined ? { label: k.label } : {}) });
      if (k.screen) {
        this.screens?.resume(
          {
            screen: { sessionId: k.screen.sessionId, hostKey: k.screen.hostKey },
            agent: k.agent,
            udid: k.udid,
            device: k.device,
            scale: k.scale,
            runner,
            controlFile: controlPath(this.home, simKey(k.agent)),
            dev,
            ...(k.label !== undefined ? { label: k.label } : {}),
          },
          k.screen,
        );
      }
    }
    const adopted = kept.filter((k) => this.held.get(k.agent)?.lent.udid === k.udid);
    const left = await this.simulators.start(adopted.map((k) => k.udid));
    let booted: Set<string> | string;
    try {
      booted = new Set((await this.simulators.simctl.devices()).filter((d) => d.state === "Booted").map((d) => d.udid));
    } catch (e) {
      booted = `simctl didn't list it: ${(e as Error).message}`;
    }
    let taken = 0;
    for (const k of adopted) {
      if (this.held.get(k.agent)?.lent.udid !== k.udid) continue;
      const why = !left.has(k.udid)
        ? "the Mac made its golden simulator again"
        : typeof booted === "string"
          ? booted
          : !booted.has(k.udid)
            ? "it wasn't running any more"
            : undefined;
      if (why === undefined) {
        taken++;
        continue;
      }
      this.lose(k.agent, why);
    }
    this.save();
    if (taken > 0) console.info(`${new Date().toISOString()} INFO took over ${taken} iOS simulators agents held through the node's restart`);
  }

  /** The agent's simulator went with the node's restart: it ends, and the agent's next agent-device says why. */
  private lose(agent: string, why: string): void {
    const at = new Date().toISOString().slice(11, 19);
    const message = `Your iOS simulator ended when the agents' Mac's fleetd node restarted (${at} UTC): ${why}. Run \`mac sim start\` again, then retry.`;
    console.warn(`${new Date().toISOString()} WARN an iOS simulator held through the node's restart went {"agent":${JSON.stringify(agent)},"why":${JSON.stringify(why)}}`);
    try {
      mkdirSync(endedBin(this.home), { recursive: true });
      writeAtomic(join(endedBin(this.home), "agent-device"), ENDED_SCRIPT);
      chmodSync(join(endedBin(this.home), "agent-device"), 0o755);
      mkdirSync(sessionDir(this.home, simKey(agent)), { recursive: true });
      writeAtomic(endedPath(this.home, agent), `${message}\n`);
    } catch (e) {
      console.warn(`${new Date().toISOString()} WARN why an iOS simulator went was not written {"error":${JSON.stringify(String(e))}}`);
    }
    this.end(agent, `the simulator ended with the node's restart: ${why}`);
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

  /**
   * A device control on the agent's simulator (`mac sim <control>`): refused while a person has control of its screen;
   * a screenshot comes back as its PNG.
   */
  async control(agent: string, control: ScreenControl, value?: string): Promise<{ shot?: Shot; device: string }> {
    const held = this.held.get(agent);
    if (!held) throw new ToolError("invalid", "You hold no simulator on the Mac.", "mac sim start first");
    held.used = Date.now();
    if (this.screens?.of(agent)?.control() === "human") {
      throw new ToolError(
        "invalid",
        "A person has control of your simulator now.",
        "carry on with other work, or end your turn: you are told the moment they hand it back",
      );
    }
    const started = performance.now();
    try {
      const shot = await held.dev.apply(control, value);
      this.save();
      this.screens?.controlled(agent, control, true, undefined, Math.round(performance.now() - started));
      return { ...(shot ? { shot } : {}), device: held.device };
    } catch (e) {
      this.screens?.controlled(agent, control, false, (e as Error).message, Math.round(performance.now() - started));
      throw e;
    }
  }

  /** The models a person may start here, and how many of the budget are booted (the Mac's `ios` host check). */
  async models(): Promise<SimModels> {
    return { models: modelsOf(await this.simulators.simctl.runtimes()), live: this.held.size, max: this.budget() };
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
    if (!held) {
      // Its simulator went with a node restart: its agent-device says so, rather than that there is none.
      const ended = endedPath(this.home, agent);
      if (!existsSync(ended)) return undefined;
      return [["PATH", path ? `${endedBin(this.home)}:${path}` : endedBin(this.home)], ["FLEETD_MAC_SIM_ENDED", ended]];
    }
    return [...iosEnv(this.home, simKey(agent), path), ["FLEETD_MAC_SIM", held.lent.udid], ["FLEETD_MAC_SIM_SET", setDir(this.home)]];
  }

  /** The simulators agents hold now, oldest first (the menu bar's activity). */
  activity(): { agent: string; projectId: string; device: string; sinceMs: number }[] {
    return [...this.held]
      .map(([agent, h]) => ({ agent, projectId: h.project, device: h.device, sinceMs: h.sinceMs }))
      .sort((a, b) => a.sinceMs - b.sinceMs || a.agent.localeCompare(b.agent));
  }

  /**
   * The node stops: the pool's waiting clones go, and every held simulator runs on, its screen's live view stopped, for
   * the next node to take over (`adopt`).
   */
  async stop(): Promise<void> {
    this.save();
    this.screens?.letGo();
    await this.simulators.shutdown();
  }

  /** Every held simulator goes, and the pool's. */
  async shutdown(): Promise<void> {
    await this.screens?.shutdown();
    for (const agent of [...this.held.keys()]) this.end(agent);
    await this.simulators.shutdown();
  }
}

/**
 * The iPhones and iPads Xcode's runtimes run, each with its runtimes newest first: plain iPhones first (the newest
 * number first), then the rest of the iPhones, the foldables and the iPads, as simctl lists them.
 */
export function modelsOf(runtimes: Runtime[]): SimModel[] {
  const byId = new Map<string, SimModel>();
  for (const r of [...runtimes].reverse()) {
    for (const t of r.supportedDeviceTypes) {
      const family = t.productFamily === "iPad" ? "ipad" : t.productFamily === "iPhone" ? (foldable(t.name) ? "foldable" : "iphone") : undefined;
      if (!family) continue;
      const m = byId.get(t.identifier) ?? { id: t.identifier, name: t.name, family, runtimes: [] };
      m.runtimes.push({ id: r.identifier, name: r.name });
      byId.set(t.identifier, m);
    }
  }
  const order = (m: SimModel) => (m.family === "iphone" ? (isPlainIphone(m.name) ? 0 : 1) : m.family === "foldable" ? 2 : 3);
  const number = (m: SimModel) => Number(/\d+/.exec(m.name)?.[0] ?? 0);
  return [...byId.values()]
    .map((m, i) => [m, i] as const)
    .sort(([a, i], [b, j]) => order(a) - order(b) || (order(a) === 0 ? number(b) - number(a) : 0) || i - j)
    .map(([m]) => m);
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
