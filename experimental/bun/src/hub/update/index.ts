// `hub_update` (crates/fleetd/src/hub/update/mod.rs): the hub updates itself to the newest build of its channel,
// then tells every connected node to do the same, with src/update's pieces. The hub restarts at once; a node waits
// for its agents first, for a while at most (`drain`), holding their tool calls that haven't started until none runs.
// Update now doesn't wait.
//
// Every 2 minutes the hub downloads the channel's newest build ahead and asks its nodes to do the same (`prefetch`),
// so pressing Update only swaps and restarts. With automatic updates on, the same look starts an update by itself as
// soon as a build is ready, but at most one in 10 minutes (`autoTick`), so the builds edge publishes merge after merge
// go as one update to the newest; the last one's result stays in `<hub home>/update/last-auto.json`.
//
// The run lives in `<hub home>/update/run.json`, so the hub that comes up after the watcher's restart, new or put
// back, takes it from there (`resume`): it reads the watcher's verdict, then updates the nodes, all at once, and
// learns how each came back from the version it reconnects with. Each machine whose node runs the new build then
// brings its Claude Code to the version that build was tested with.
import { mkdirSync, readFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import type {
  AutoUpdateResult,
  HubChannel,
  LastAutoUpdate,
  UpdatePart,
  UpdatePartKind,
  UpdateRun,
  UpdateSettings,
  UpdateStage,
  UpdateState,
} from "../../shared/contracts.ts";
import type { Clock } from "../../shared/clock.ts";
import { checkedTo, channelOf, type Channel, Failure, type Feed, isBuild, release, replaceFile, restore, sums, swap, updateHelper } from "../../update/index.ts";
import { HEALTH_WAIT_SECS, type Plan, readVerdict, type Verdict } from "../../update/finish.ts";
import type { Service } from "../../update/service.ts";
import { atLeast, versionCmp, versionLabel } from "../../update/version.ts";
import { pause } from "../cloud/every.ts";
import { isoMs } from "../store/time.ts";

export const DRAIN_MINUTES = 10;
export const DRAIN_MINUTES_MAX = 240;
export const UPDATE_PARTS_MAX = 401;
const OFFLINE = "offline: press Update again once it's online, or run `fleetd update` on it";
/** How the node's answer to a Claude Code install begins when it's left as it is, or already there (install.rs). */
const CLAUDE_LEFT = "Claude Code is";
const CLAUDE_ALREADY = "already runs Claude Code";

/** A machine as the update sees it. */
export type NodeFacts = {
  machineId: string;
  name: string;
  version: string;
  /** When its current link went live, ms; undefined while offline. */
  liveSince?: number;
  canUpdate: boolean;
  canFetch: boolean;
  canHold: boolean;
  /** Its Claude Code, as `claude --version` printed it at the node's last probe. */
  claude?: string;
  canInstallClaude: boolean;
  agentsMac: boolean;
  /** What runs on it that can't carry on through its node's restart, in words. */
  busy?: string;
};

/** A node's answer to a `node_action` (node_link.rs `NodeActionResult`). */
export type NodeActionResult = { ok: boolean; message: string; stage?: UpdateStage; steps?: number };
export type NodeUpdate = { version: string; channel: HubChannel };
/** A node's answer to its update, and its second, sent only when its restart was refused. */
export type NodeAnswer = [NodeActionResult, { tryTake(): NodeActionResult | undefined }];

/** What the update does to the hub's machine and its nodes; tests stand in fakes. */
export interface UpdatePorts {
  feed(channel: Channel): Feed;
  running(): string;
  releaseBuild(): boolean;
  exe(): string;
  asset(): string;
  hubService(exe: string): Service | undefined;
  previous(): Uint8Array;
  healthUrl(): string;
  startWatcher(plan: Plan, planPath: string): void;
  nodes(): NodeFacts[];
  fetchOnNode(machineId: string, update: NodeUpdate): void;
  holdNode(machineId: string): Promise<number>;
  /** Resolves once the machine's link goes live or drops after this call. */
  nodeChanged(machineId: string): Promise<void>;
  claudeTarget(): string;
  installClaude(machineId: string, version: string): Promise<NodeActionResult>;
  updateNode(machineId: string, update: NodeUpdate): Promise<NodeAnswer>;
}

/** How long the update waits on things, in ms; tests shorten them. */
export type Timing = {
  poll: number;
  nodePoll: number;
  verdict: number;
  nodeBack: number;
  restart: number;
  prefetchEvery: number;
  drainPoll: number;
  drain: number;
  /**
   * Automatic updates: how long after the last update started the next may start, at the earliest: the window that
   * gathers builds published close together into one update.
   */
  autoGap: number;
};

export const defaultTiming = (): Timing => ({
  poll: 100,
  nodePoll: 1000,
  verdict: HEALTH_WAIT_SECS * 2 * 1000,
  nodeBack: HEALTH_WAIT_SECS * 3 * 1000,
  restart: HEALTH_WAIT_SECS * 3 * 1000,
  // Downloads from the release CDN, not GitHub's API: no rate limit to mind.
  prefetchEvery: 120_000,
  drainPoll: 5000,
  drain: DRAIN_MINUTES * 60_000,
  autoGap: 600_000,
});

export type Refused = { kind: "not_wired" } | { kind: "nothing_to_retry" } | { kind: "hub_moved_on"; running: string };

/** The part has its result. */
export const settled = (s: UpdateState) => s !== "waiting" && s !== "downloading" && s !== "restarting";

/** `head_text`: at most `max` UTF-16 units, never cut inside a pair. */
function head(text: string, max: number): string {
  if (text.length <= max) return text;
  let out = "";
  for (const c of text) {
    if (out.length + c.length > max) break;
    out += c;
  }
  return out;
}

const hhmm = (ms: number) => {
  const d = new Date(ms);
  return Number.isNaN(d.getTime()) ? "" : `${String(d.getUTCHours()).padStart(2, "0")}:${String(d.getUTCMinutes()).padStart(2, "0")} UTC`;
};

/** `<hub home>/update/settings.json`, written by `hub_update_settings` (or a person); every field optional. */
type Settings = { auto?: boolean; drainMinutes?: number };

function readSettings(dir: string): Settings {
  try {
    const v = JSON.parse(readFileSync(join(dir, "settings.json"), "utf8")) as Settings;
    return v !== null && typeof v === "object" ? v : {};
  } catch {
    return {};
  }
}

/** How long a node waits for its agents at most by the settings in `<hub home>/update`, else `defaultMs`. */
export function drainIn(hubHome: string, defaultMs: number): number {
  const m = readSettings(join(hubHome, "update")).drainMinutes;
  return typeof m === "number" && Number.isInteger(m) && m >= 0 ? Math.min(m, DRAIN_MINUTES_MAX) * 60_000 : defaultMs;
}

const pretty = (v: unknown) => JSON.stringify(v, null, 2);

/** UpdateRun as serde writes it: its fields in the struct's order, absent ones left out. */
function runText(run: UpdateRun): string {
  return pretty({
    id: run.id,
    channel: run.channel,
    ...(run.to !== undefined ? { to: run.to } : {}),
    startedAt: run.startedAt,
    ...(run.finishedAt !== undefined ? { finishedAt: run.finishedAt } : {}),
    parts: run.parts.map(partText),
    ...(run.now !== undefined ? { now: run.now } : {}),
    ...(run.auto !== undefined ? { auto: run.auto } : {}),
  });
}

const partText = (p: UpdatePart) => ({
  part: p.part,
  ...(p.machineId !== undefined ? { machineId: p.machineId } : {}),
  name: p.name,
  from: p.from,
  ...(p.to !== undefined ? { to: p.to } : {}),
  state: p.state,
  ...(p.stage !== undefined ? { stage: p.stage } : {}),
  ...(p.message !== undefined ? { message: p.message } : {}),
  ...(p.agents !== undefined ? { agents: p.agents } : {}),
  ...(p.installsBy !== undefined ? { installsBy: p.installsBy } : {}),
});

const part = (kind: UpdatePartKind, machineId: string | undefined, name: string, from: string, state: UpdateState): UpdatePart => ({
  part: kind,
  ...(machineId !== undefined ? { machineId } : {}),
  name: head(name === "" ? "a machine" : name, 200),
  from: head(from, 200),
  state,
});

/** The node's Claude Code number from `claude --version`'s output (install.rs `number`). */
const claudeNumber = (output: string) => output.trim().split(/\s+/)[0] ?? "";

/**
 * A machine's node part that refused its build in a way asking again won't change: its build didn't come up healthy,
 * it can't install or restart itself, or it was skipped other than offline.
 */
function refusedForGood(p: UpdatePart): boolean {
  if (p.state === "rolled_back") return true;
  if (p.state === "failed") return p.stage === "install" || p.stage === "restart";
  if (p.state === "skipped") return p.message === undefined || p.message !== OFFLINE;
  return false;
}

/** How a finished run went, as `lastAuto` keeps it. */
export function lastAutoOf(run: UpdateRun): LastAutoUpdate {
  const hubOk = run.parts.some((p) => p.part === "hub" && (p.state === "done" || p.state === "current"));
  const missed = (p: UpdatePart) =>
    p.part === "hub" ? false : p.part === "node" ? !(p.state === "done" || p.state === "current") : p.state === "failed" || p.state === "rolled_back";
  let result: AutoUpdateResult;
  let message: string | undefined;
  if (hubOk) {
    const all = run.parts.filter(missed);
    const first = all[0];
    if (!first) result = "done";
    else {
      result = "partial";
      const more = all.length === 1 ? "" : ` (${all.length - 1} more didn't update)`;
      message = `${first.name}: ${first.message ?? "didn't update"}${more}`;
    }
  } else {
    result = "failed";
    message = run.parts.find((p) => p.part === "hub")?.message;
  }
  return {
    at: run.startedAt,
    ...(hubOk && run.to !== undefined ? { to: run.to } : {}),
    result,
    ...(message !== undefined ? { message: head(message, 500) } : {}),
  };
}

/** The hub's update. */
export class Updates {
  private run: UpdateRun | undefined;
  private ports_: UpdatePorts | undefined;
  private ready_: string | undefined;
  /** The drives of this process (each a run id and its stop), for `startOver` to stop. */
  private readonly drives = new Set<{ id: string; stop: AbortController }>();
  private readonly hurry = new Set<() => void>();
  /** Held while a build downloads to `kept` and while Update installs it. */
  private fetching: Promise<void> = Promise.resolve();
  private nextCheck_: number | undefined;
  private checkFailed: string | undefined;

  constructor(
    readonly dir: string,
    private readonly clock: Clock,
    readonly timing: Timing,
    private readonly signal?: AbortSignal,
  ) {
    try {
      this.run = JSON.parse(readFileSync(join(dir, "run.json"), "utf8")) as UpdateRun;
    } catch {
      this.run = undefined;
    }
  }

  private now(): number {
    return this.clock.now();
  }

  /** How long a node waits for its agents at most: `drainMinutes` in the settings, read at each wait. */
  drain(): number {
    return drainIn(dirname(this.dir), this.timing.drain);
  }

  settings(): UpdateSettings {
    return { auto: readSettings(this.dir).auto === true, drainMinutes: Math.min(Math.floor(this.drain() / 60_000), DRAIN_MINUTES_MAX) };
  }

  setSettings(auto: boolean | undefined, drainMinutes: number | undefined): UpdateSettings {
    const s = readSettings(this.dir);
    if (auto !== undefined) s.auto = auto;
    if (drainMinutes !== undefined) s.drainMinutes = Math.min(drainMinutes, DRAIN_MINUTES_MAX);
    mkdirSync(this.dir, { recursive: true });
    replaceFile(join(this.dir, "settings.json"), pretty({ ...(s.auto !== undefined ? { auto: s.auto } : {}), ...(s.drainMinutes !== undefined ? { drainMinutes: s.drainMinutes } : {}) }));
    return this.settings();
  }

  private lastStarted(): number | undefined {
    const at = this.run ? Date.parse(this.run.startedAt) : Number.NaN;
    return Number.isNaN(at) ? undefined : at;
  }

  /** The build ready that the last update tried and put back: automatic updates skip it until a newer one is out. */
  autoSkips(): string | undefined {
    const ready = this.ready_;
    const run = this.run;
    if (ready === undefined || !run) return undefined;
    const putBack = run.parts.some((p) => p.part === "hub" && p.state === "rolled_back");
    return putBack && run.to === ready ? ready : undefined;
  }

  /** An online machine that can update runs an older build than the hub: an update left it behind. */
  private behind(): boolean {
    const ports = this.ports_;
    if (!ports) return false;
    const running = ports.running();
    const last = this.run?.to === running ? this.run : undefined;
    return (
      ports.releaseBuild() &&
      ports.nodes().some((n) => {
        const refused = last?.parts.some((p) => p.part === "node" && p.machineId === n.machineId && refusedForGood(p)) ?? false;
        return n.liveSince !== undefined && n.canUpdate && !refused && !atLeast(n.version, running);
      })
    );
  }

  /** With automatic updates on and something to do: when the update starts by itself, ms. */
  autoAt(): number | undefined {
    if (!this.settings().auto || this.autoSkips() !== undefined) return undefined;
    if (this.ready_ === undefined && !this.behind()) return undefined;
    if (this.run && this.going(this.run)) return undefined;
    const now = this.now();
    const last = this.lastStarted();
    return last === undefined ? now : Math.max(last + this.timing.autoGap, now);
  }

  /**
   * Automatic updates: downloads ahead, and starts an update when one is due: once the last update started 10 minutes
   * ago or more (`Timing.autoGap`). Builds that come out within those 10 minutes aren't installed one by one: the one
   * update that follows takes the newest. The update it started, if any.
   */
  async autoTick(): Promise<UpdateRun | undefined> {
    await this.prefetch();
    const due = this.autoAt();
    if (due === undefined || due > this.now()) return undefined;
    const started = this.begin(undefined, false, true);
    return "run" in started ? started.run : undefined;
  }

  private hurried(): boolean {
    return this.run?.now === true;
  }

  setPorts(ports: UpdatePorts): void {
    this.ports_ = ports;
  }

  ports(): UpdatePorts | undefined {
    return this.ports_;
  }

  /** Runs `work` driving the run `id`: counted while it lives, stopped by `startOver`. */
  private drive(id: string, work: (d: Drive) => Promise<void>): Promise<void> {
    const entry = { id, stop: new AbortController() };
    this.drives.add(entry);
    const d = new Drive(this, id, entry.stop.signal);
    return work(d)
      .catch((e) => {
        if (!entry.stop.signal.aborted) console.error(`update: ${id}:`, e);
      })
      .finally(() => this.drives.delete(entry));
  }

  /** The last run isn't finished, yet nothing in this process drives it any more. */
  leftOver(): boolean {
    return !!this.run && this.run.finishedAt === undefined && !this.going(this.run);
  }

  private going(run: UpdateRun): boolean {
    return run.finishedAt === undefined && this.drives.size > 0;
  }

  status(): UpdateRun | undefined {
    return this.run ? structuredClone(this.run) : undefined;
  }

  /**
   * The machine's node is in the update going now and has no result yet: waiting its turn, downloading or restarting.
   * Its node being away then is the update's doing (hub/outage pages nobody for it).
   */
  updating(machineId: string): boolean {
    const run = this.run;
    return (
      run !== undefined &&
      this.going(run) &&
      run.parts.some((p) => p.part === "node" && p.machineId === machineId && !settled(p.state))
    );
  }

  /** For tests: `run` as an update this process drives now looks to the rest of the hub. */
  driveForTest(run: UpdateRun): void {
    this.run = run;
    this.drives.add({ id: run.id, stop: new AbortController() });
  }

  ready(): string | undefined {
    return this.ready_;
  }

  kept(): string {
    return join(this.dir, "fleetd.next");
  }

  /** `autoTick` now and every `prefetchEvery`, or sooner when a build ready is due to install by itself, until the hub stops. */
  async prefetchLoop(): Promise<void> {
    while (!this.signal?.aborted) {
      try {
        const run = await this.autoTick();
        if (run) console.info(`update: started ${run.id} by itself (automatic updates)`);
      } catch (e) {
        console.error("update: the automatic look failed:", e);
      }
      const now = this.now();
      const every = now + this.timing.prefetchEvery;
      // A second at least: an update due that didn't start (not wired yet) mustn't spin.
      const due = this.autoAt();
      const next = due === undefined ? every : Math.min(Math.max(due, now + 1000), every);
      this.nextCheck_ = next;
      await this.sleep(next - now, this.signal);
    }
  }

  sleep(ms: number, signal?: AbortSignal): Promise<void> {
    return signal ? pause(ms, signal) : Bun.sleep(ms);
  }

  nextCheck(): number | undefined {
    return this.settings().auto ? this.nextCheck_ : undefined;
  }

  /** With automatic updates on: why they hold back now, in a sentence. */
  skipReason(): string | undefined {
    if (!this.settings().auto) return undefined;
    if (this.ports_ && !this.ports_.releaseBuild()) {
      return "the hub runs a local build of fleetd, which never updates itself: install a release with curl -fsSL https://fleetd.sh | sh";
    }
    const build = this.autoSkips();
    if (build !== undefined) {
      return `${versionLabel(build)} was put back, as the hub didn't come up healthy on it: automatic updates skip it until a newer build is out (Update still installs it)`;
    }
    return this.checkFailed;
  }

  lastAuto(): LastAutoUpdate | undefined {
    try {
      return JSON.parse(readFileSync(join(this.dir, "last-auto.json"), "utf8")) as LastAutoUpdate;
    } catch {
      return undefined;
    }
  }

  private checked(failed: string | undefined): void {
    const same = (a: string, b: string) => a.split(" at ")[0] === b.split(" at ")[0];
    if (failed !== undefined && !(this.checkFailed !== undefined && same(this.checkFailed, failed))) console.info(`update: ${failed}`);
    this.checkFailed = failed;
  }

  /** Holds the download lock while `f` runs. */
  async withFetching<T>(f: () => Promise<T>): Promise<T> {
    const before = this.fetching;
    let release!: () => void;
    this.fetching = new Promise<void>((r) => (release = r));
    await before;
    try {
      return await f();
    } finally {
      release();
    }
  }

  /**
   * Downloads the channel's newest build when the hub doesn't run it, checks it against the release's SHA256SUMS and
   * keeps it for the update, and asks every online node that can to do the same. Nothing is installed.
   */
  async prefetch(): Promise<void> {
    const ports = this.ports_;
    if (!ports || (this.run && this.going(this.run)) || !ports.releaseBuild()) return;
    const running = ports.running();
    const channel = channelOf(running, true);
    const feed = ports.feed(channel);
    const at = hhmm(this.now());
    let to: string | undefined;
    try {
      to = (await release(feed)).cliVersion;
    } catch (e) {
      return this.checked(`couldn't look at the ${channel} channel at ${at}: ${(e as Error).message}`);
    }
    if (to === undefined) return this.checked(`the ${channel} channel had no fleetd build at ${at}`);
    if (to === running) {
      this.ready_ = undefined;
      return this.checked(undefined);
    }
    const label = versionLabel(to);
    let asset: string;
    let s: Map<string, string>;
    try {
      asset = ports.asset();
      s = await sums(feed);
    } catch (e) {
      return this.checked(`couldn't download ${label} ahead: ${(e as Error).message}`);
    }
    const failed = await this.withFetching(async () => {
      if (isBuild(this.kept(), s, asset)) return undefined;
      try {
        await checkedTo(feed, s, asset, this.kept());
        return undefined;
      } catch (e) {
        return `couldn't download ${label} ahead at ${at}: ${(e as Error).message}`;
      }
    });
    if (failed !== undefined) return this.checked(failed);
    this.checked(undefined);
    const update: NodeUpdate = { version: head(to, 200), channel: channel === "stable" ? "stable" : "edge" };
    for (const node of ports.nodes()) {
      if (node.liveSince !== undefined && node.canFetch && !atLeast(node.version, to)) ports.fetchOnNode(node.machineId, update);
    }
    this.ready_ = to;
  }

  /** Updates one machine of the last run again, when the hub still runs that run's build. */
  retry(machineId: string, now: boolean): { run: UpdateRun } | Refused {
    const ports = this.ports_;
    if (!ports) return { kind: "not_wired" };
    const run = this.run;
    if (!run) return { kind: "nothing_to_retry" };
    if (this.going(run)) return { run: structuredClone(run) };
    const hubUpdated = run.parts.some((p) => p.part === "hub" && (p.state === "done" || p.state === "current"));
    const ours = (p: UpdatePart) => p.machineId === machineId;
    if (run.to === undefined || !hubUpdated || !run.parts.some(ours)) return { kind: "nothing_to_retry" };
    // Never a build older than the hub's: the machine follows the hub, as in an update.
    const running = ports.running();
    if (run.to !== running) return { kind: "hub_moved_on", running };
    for (const p of run.parts.filter(ours)) {
      p.state = "waiting";
      delete p.stage;
      delete p.message;
    }
    delete run.finishedAt;
    if (now) run.now = true;
    else delete run.now;
    this.save(run);
    const to = run.to;
    void this.drive(run.id, async (d) => {
      const update: NodeUpdate = { version: to, channel: this.run?.channel ?? "edge" };
      await d.updateNode(ports, machineId, update);
      await d.updateClaude(ports, machineId);
      d.settleNodes("failed", "the update of this node stopped without a result");
    });
    return { run: structuredClone(run) };
  }

  start(channel: HubChannel | undefined, now: boolean): { run: UpdateRun } | Refused {
    return this.begin(channel, now, false);
  }

  /** `start`, or an automatic update's (`auto`). */
  private begin(channel: HubChannel | undefined, now: boolean, auto: boolean): { run: UpdateRun } | Refused {
    const ports = this.ports_;
    if (!ports) return { kind: "not_wired" };
    if (this.run && this.going(this.run)) {
      if (now && this.run.now === undefined) {
        this.run.now = true;
        this.save(this.run);
        for (const f of [...this.hurry]) f();
      }
      return { run: structuredClone(this.run) };
    }
    const running = ports.running();
    const chosen: HubChannel = channel === "edge" || channel === "stable" ? channel : channelOf(running, ports.releaseBuild()) === "edge" ? "edge" : "stable";
    const parts: UpdatePart[] = [part("hub", undefined, "the hub", running, "downloading")];
    const nodes = ports.nodes().sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const n of nodes.slice(0, Math.floor((UPDATE_PARTS_MAX - 1) / 2))) {
      const claude = n.claude !== undefined ? claudeNumber(n.claude) : "";
      for (const [kind, from] of [
        ["node", n.version],
        ["claude", claude],
      ] as const) {
        const p = part(kind, n.machineId, n.name, from, "waiting");
        // Offline now: not waited for. One online now is, through the hub's restart.
        if (n.liveSince === undefined) {
          p.state = "skipped";
          p.message = OFFLINE;
        }
        parts.push(p);
      }
    }
    const at = this.now();
    const run: UpdateRun = {
      id: `U${at}`,
      channel: chosen,
      startedAt: isoMs(at),
      parts,
      ...(now ? { now: true } : {}),
      ...(auto ? { auto: true } : {}),
    };
    this.save(run);
    this.run = run;
    void this.drive(run.id, (d) => d.driveHub(ports));
    return { run: structuredClone(run) };
  }

  /** Start over: ends the run going on, every part left skipped, and starts a new one, once the hub's part settled. */
  startOver(channel: HubChannel | undefined, now: boolean): { run: UpdateRun } | Refused {
    if (!this.ports_) return { kind: "not_wired" };
    const run = this.run;
    if (run && run.finishedAt === undefined) {
      if (!run.parts.some((p) => p.part === "hub" && settled(p.state))) return { run: structuredClone(run) };
      for (const d of [...this.drives]) {
        d.stop.abort();
        this.drives.delete(d);
      }
      for (const p of run.parts.filter((p) => !settled(p.state))) {
        p.state = "skipped";
        delete p.stage;
        p.message = "not asked: the update started over";
      }
      run.finishedAt = isoMs(this.now());
      this.save(run);
    }
    return this.start(channel, now);
  }

  /** Changes the run and writes it down; a drive's write reaches its own run only, while it is unfinished. */
  change(f: (run: UpdateRun) => void, driving?: string): void {
    const run = this.run;
    if (!run) return;
    if (driving !== undefined && (run.finishedAt !== undefined || driving !== run.id)) return;
    f(run);
    if (run.finishedAt === undefined && run.parts.every((p) => settled(p.state))) run.finishedAt = isoMs(this.now());
    this.save(run);
  }

  private save(run: UpdateRun): void {
    if (run.auto === true && run.finishedAt !== undefined) this.saveLastAuto(run);
    try {
      mkdirSync(this.dir, { recursive: true });
      replaceFile(join(this.dir, "run.json"), runText(run));
    } catch (e) {
      console.warn(`update: couldn't write ${join(this.dir, "run.json")}: ${(e as Error).message}`);
    }
  }

  private saveLastAuto(run: UpdateRun): void {
    const last = lastAutoOf(run);
    if (JSON.stringify(this.lastAuto()) === JSON.stringify(last)) return;
    const path = join(this.dir, "last-auto.json");
    try {
      mkdirSync(this.dir, { recursive: true });
      replaceFile(path, pretty(last));
    } catch (e) {
      console.warn(`update: couldn't write ${path}: ${(e as Error).message}`);
    }
    console.info(`update: ${run.id} (automatic) ended ${last.result}${last.message !== undefined ? `: ${last.message}` : ""}`);
  }

  /** At the hub's start: takes an unfinished update from where the previous process left it. */
  async resume(): Promise<void> {
    const ports = this.ports_;
    const run = this.run;
    if (!ports || !run || this.going(run) || run.finishedAt !== undefined) return;
    await this.drive(run.id, (d) => d.takeOn(ports, structuredClone(run)));
  }

  /** Update now was pressed: wakes a drive waiting for a node's agents. */
  onHurry(f: () => void): () => void {
    this.hurry.add(f);
    return () => this.hurry.delete(f);
  }

  /** A cloud machine's catch-up at its hello: one that slept through an update gets it now. */
  async catchUp(machineId: string): Promise<"current" | "restarting"> {
    const ports = this.ports_;
    if (!ports) throw new Error("the hub's updates aren't wired");
    if (!ports.releaseBuild() || (this.run && this.going(this.run))) return "current";
    const node = ports.nodes().find((n) => n.machineId === machineId);
    if (!node) throw new Error(`${machineId} isn't linked`);
    const running = ports.running();
    if (!atLeast(node.version, running)) {
      if (!node.canUpdate) throw new Error(`its fleetd ${versionLabel(node.version)} can't update itself: run \`fleetd update\` on it`);
      const [answer] = await ports.updateNode(machineId, { version: head(running, 200), channel: channelOf(running, true) === "edge" ? "edge" : "stable" });
      if (!answer.ok) throw new Error(answer.message);
      return "restarting";
    }
    const target = ports.claudeTarget();
    const have = node.claude !== undefined ? claudeNumber(node.claude) : undefined;
    if (node.agentsMac || !node.canInstallClaude || have === target) return "current";
    const answer = await ports.installClaude(machineId, target);
    if (!answer.ok) throw new Error(answer.message);
    return "current";
  }

  clockNow(): number {
    return this.now();
  }
}

/** One task driving one run: its writes reach that run only, and `startOver` stops it. */
class Drive {
  constructor(
    private readonly u: Updates,
    readonly id: string,
    readonly signal: AbortSignal,
  ) {}

  private change(f: (run: UpdateRun) => void): void {
    if (!this.signal.aborted) this.u.change(f, this.id);
  }

  private stopped(): boolean {
    return this.signal.aborted;
  }

  /** The hub's part (no machine), or a machine's node part. */
  setPart(machineId: string | undefined, state: UpdateState, stage: UpdateStage | undefined, message: string): void {
    this.change((run) => {
      const p = run.parts.find((p) => p.machineId === machineId && p.part !== "claude");
      if (!p) return;
      p.state = state;
      if (stage !== undefined) p.stage = stage;
      else delete p.stage;
      p.message = head(message, 500);
      delete p.agents;
      delete p.installsBy;
    });
  }

  /** A node part waiting for its agents (`agents` mid-step) and what else runs on it, until `by` at most. */
  private setWaiting(machineId: string, agents: number, busy: string | undefined, by: number): void {
    const what0 = agents === 0 ? undefined : agents === 1 ? "1 agent to finish its step" : `${agents} agents to finish their step`;
    const what = what0 !== undefined && busy !== undefined ? `${what0}, and for ${busy}` : (what0 ?? busy ?? "its agents");
    const message = `waits for ${what}; installs by ${hhmm(by)} whatever runs`;
    this.change((run) => {
      const p = run.parts.find((p) => p.machineId === machineId && p.part === "node");
      if (!p) return;
      p.state = "waiting";
      delete p.stage;
      p.message = head(message, 500);
      p.agents = agents;
      p.installsBy = isoMs(by);
    });
  }

  private setClaude(machineId: string, to: string | undefined, state: UpdateState, stage: UpdateStage | undefined, message: string): void {
    this.change((run) => {
      const p = run.parts.find((p) => p.machineId === machineId && p.part === "claude");
      if (!p) return;
      if (to !== undefined) p.to = head(to, 200);
      p.state = state;
      if (stage !== undefined) p.stage = stage;
      else delete p.stage;
      p.message = head(message, 500);
    });
  }

  /** Every machine's part not yet settled gets `state` with `message`. */
  settleNodes(state: UpdateState, message: string): void {
    this.change((run) => {
      for (const p of run.parts.filter((p) => p.part !== "hub" && !settled(p.state))) {
        p.state = state;
        p.message = head(message, 500);
      }
    });
  }

  private hubFailed(f: Failure): void {
    this.setPart(undefined, "failed", f.stage, f.message);
    this.settleNodes("skipped", "not asked: the hub didn't update, and nodes follow the hub");
  }

  async driveHub(ports: UpdatePorts): Promise<void> {
    const channel = this.u.status()?.channel;
    if (channel === undefined) return;
    let plan: Plan | undefined;
    try {
      plan = await this.stageHub(ports, channel);
    } catch (e) {
      return this.hubFailed(e instanceof Failure ? e : new Failure("install", (e as Error).message));
    }
    if (!plan) {
      const running = ports.running();
      this.change((run) => (run.to = head(running, 200)));
      this.setPart(undefined, "current", undefined, `already runs ${versionLabel(running)}`);
      return this.driveNodes(ports, running);
    }
    const p = plan;
    this.change((run) => (run.to = head(p.to, 200)));
    this.setPart(undefined, "restarting", undefined, `restarting on ${versionLabel(p.to)}`);
    try {
      ports.startWatcher(p, join(this.u.dir, "hub-plan.json"));
    } catch (e) {
      try {
        restore(p.exe, p.prev);
      } catch {}
      return this.hubFailed(new Failure("restart", `couldn't start the restart (${(e as Error).message}), so the previous binary was put back`));
    }
    // The watcher restarts this process; the hub that comes up goes on in `resume`. Still here past the deadline, the
    // restart never happened.
    await this.restartMissed(p);
  }

  private async restartMissed(plan: Plan): Promise<void> {
    const deadline = this.u.clockNow() + this.u.timing.restart;
    let verdict: Verdict | undefined;
    for (;;) {
      verdict = readVerdict(plan.verdict);
      if (verdict || this.u.clockNow() >= deadline || this.stopped()) break;
      await this.u.sleep(this.u.timing.poll, this.signal);
    }
    let state: UpdateState;
    let stage: UpdateStage | undefined;
    let message: string;
    if (verdict) [state, stage, message] = [verdict.state, verdict.stage ?? undefined, verdict.message];
    else {
      let back = true;
      try {
        restore(plan.exe, plan.prev);
      } catch {
        back = false;
      }
      [state, stage] = ["failed", "restart"];
      message =
        `the hub didn't restart onto ${versionLabel(plan.to)} within ${Math.ceil(this.u.timing.restart / 60_000)} min, so it kept running ${versionLabel(plan.from)}` +
        (back ? " and its previous binary was put back" : "; its previous binary couldn't be put back: run `fleetd update` on its machine");
    }
    // Only the new build writes this as it comes up; this process is the old one, about to go.
    if (state === "done") return;
    this.setPart(undefined, state, stage, message);
    this.settleNodes("skipped", "not asked: the hub kept its build, and nodes follow the hub");
  }

  /** Puts the channel's newest build in place for the watcher, or undefined when the hub already runs it. */
  private async stageHub(ports: UpdatePorts, channel: HubChannel): Promise<Plan | undefined> {
    const ch: Channel = channel === "stable" ? "stable" : "edge";
    const feed = ports.feed(ch);
    const running = ports.running();
    const to = (await release(feed)).cliVersion;
    if (to === undefined) throw new Failure("download", `the ${ch} channel has no fleetd build yet`);
    if (to === running) return undefined;
    if (!ports.releaseBuild()) {
      throw new Failure("install", "the hub runs a local build of fleetd: install a release with curl -fsSL https://fleetd.sh | sh");
    }
    let exe: string;
    try {
      exe = ports.exe();
    } catch (e) {
      throw new Failure("install", `couldn't find the hub's binary: ${(e as Error).message}`);
    }
    const service = ports.hubService(exe);
    if (!service) {
      throw new Failure(
        "restart",
        "the hub doesn't run as the service `fleetd init` sets up, so it can't restart itself: run `fleetd update` on its machine",
      );
    }
    let asset: string;
    try {
      asset = ports.asset();
    } catch (e) {
      throw new Failure("download", (e as Error).message);
    }
    this.fetchAhead(ports, to);
    // Downloaded ahead: checked against the sums again, else downloaded now.
    const kept = this.u.kept();
    const prev = join(this.u.dir, "fleetd.prev");
    await this.u.withFetching(async () => {
      const s = await sums(feed);
      if (!isBuild(kept, s, asset)) await checkedTo(feed, s, asset, kept);
      // The session host beside a Bun build moves with it.
      await updateHelper(feed, s, exe);
    });
    let previous: Uint8Array;
    try {
      previous = ports.previous();
    } catch (e) {
      rmSync(kept, { force: true });
      throw new Failure("install", `couldn't keep the running binary for a rollback: ${(e as Error).message}; nothing was changed`);
    }
    try {
      swap(exe, kept, previous, prev);
    } finally {
      rmSync(kept, { force: true });
    }
    return {
      exe,
      prev,
      service,
      from: running,
      to,
      health: { kind: "hub", url: ports.healthUrl() },
      waitSecs: HEALTH_WAIT_SECS,
      verdict: join(this.u.dir, "hub-verdict.json"),
      answered: null,
    };
  }

  /** Every node the run waits for, online, that can fetch and doesn't run `to`, downloads it now, alongside the hub. */
  private fetchAhead(ports: UpdatePorts, to: string): void {
    const run = this.u.status();
    if (!run) return;
    const waiting = run.parts.filter((p) => p.part === "node" && p.state === "waiting").map((p) => p.machineId);
    const update: NodeUpdate = { version: head(to, 200), channel: run.channel };
    for (const node of ports.nodes()) {
      if (waiting.includes(node.machineId) && node.liveSince !== undefined && node.canFetch && !atLeast(node.version, to)) {
        ports.fetchOnNode(node.machineId, update);
      }
    }
  }

  async takeOn(ports: UpdatePorts, run: UpdateRun): Promise<void> {
    const hub = run.parts.find((p) => p.part === "hub");
    if (!hub) return this.settleNodes("skipped", "not asked: the hub didn't update");
    if (hub.state === "downloading") {
      return this.hubFailed(new Failure("download", "the hub restarted before the new build was in place; nothing was changed"));
    }
    if (hub.state === "restarting") {
      const to = run.to ?? "";
      const v = await this.verdict(ports, to);
      if (v.state === "done") {
        this.setPart(undefined, "done", undefined, v.message);
        return this.driveNodes(ports, to);
      }
      this.setPart(undefined, v.state, v.stage ?? undefined, v.message);
      return this.settleNodes("skipped", "not asked: the hub kept its build, and nodes follow the hub");
    }
    if ((hub.state === "done" || hub.state === "current") && run.to !== undefined) return this.driveNodes(ports, run.to);
    this.settleNodes("skipped", "not asked: the hub didn't update");
  }

  /** The watcher's verdict on the hub's restart, waited for; without one, what this process runs says it. */
  private async verdict(ports: UpdatePorts, to: string): Promise<Verdict> {
    const path = join(this.u.dir, "hub-verdict.json");
    const deadline = this.u.clockNow() + this.u.timing.verdict;
    for (;;) {
      const v = readVerdict(path);
      if (v) return v;
      if (this.u.clockNow() >= deadline || this.stopped()) break;
      await this.u.sleep(this.u.timing.poll, this.signal);
    }
    const running = ports.running();
    return running === to
      ? { state: "done", stage: null, message: `runs ${versionLabel(to)}` }
      : { state: "rolled_back", stage: "health", message: `the hub came back on ${versionLabel(running)}, not ${versionLabel(to)}` };
  }

  /** Updates every node not settled yet to `to`, all at once. */
  private async driveNodes(ports: UpdatePorts, to: string): Promise<void> {
    const running = ports.running();
    if (running !== to) return this.settleNodes("skipped", `the hub moved on to ${versionLabel(running)}: press Update for the newest`);
    const run = this.u.status();
    if (!run) return;
    const waiting = run.parts.filter((p) => p.part === "node" && !settled(p.state)).map((p) => p.machineId!);
    const update: NodeUpdate = { version: head(to, 200), channel: run.channel };
    await Promise.allSettled(
      waiting.map(async (m) => {
        await this.updateNode(ports, m, update);
        await this.updateClaude(ports, m);
      }),
    );
    // A part a node's job couldn't settle still ends the run.
    this.settleNodes("failed", "the update of this node stopped without a result");
  }

  private nodeWait(changed: Promise<void>): Promise<void> {
    return Promise.race([changed, this.u.sleep(this.u.timing.nodePoll, this.signal)]);
  }

  async updateNode(ports: UpdatePorts, machineId: string, update: NodeUpdate): Promise<void> {
    const facts = () => ports.nodes().find((n) => n.machineId === machineId);
    const to = update.version;
    const label = versionLabel(to);
    // Never backwards: a node on `to` or newer is settled as it is, whenever it is looked at.
    const current = (node: NodeFacts) => {
      const at = atLeast(node.version, to);
      if (at) this.setPart(machineId, "current", undefined, `already runs ${versionLabel(node.version)}`);
      return at;
    };
    const forgotten = () => this.setPart(machineId, "skipped", undefined, "not asked: the hub no longer knows it");
    let changed = ports.nodeChanged(machineId);
    let node = facts();
    if (!node) return forgotten();
    if (current(node)) return;
    // It was online when the run started, and the hub's own restart dropped every link: it gets a while to reconnect.
    const deadline = this.u.clockNow() + this.u.timing.nodeBack;
    while (node.liveSince === undefined) {
      if (this.u.clockNow() >= deadline) return this.setPart(machineId, "skipped", undefined, OFFLINE);
      if (this.stopped()) return;
      await this.nodeWait(changed);
      changed = ports.nodeChanged(machineId);
      node = facts();
      if (!node) return forgotten();
    }
    if (current(node)) return;
    if (!node.canUpdate) {
      return this.setPart(
        machineId,
        "skipped",
        undefined,
        `its fleetd (${versionLabel(node.version)}) is too old to update from the hub: run \`fleetd update\` on ${node.name} once`,
      );
    }
    // The node holds its agents' tool calls that haven't started, and waits for those running to finish, so the
    // restart finds them between steps. At the deadline it updates whatever runs; Update now doesn't wait.
    const by = this.u.clockNow() + this.u.drain();
    let said: string | undefined;
    for (let now = facts(); now; now = facts()) {
      if (current(now)) return;
      if (this.u.status()?.now === true || this.u.clockNow() >= by || this.stopped()) break;
      const agents = now.canHold ? await ports.holdNode(machineId).catch(() => 0) : 0;
      if (agents === 0 && now.busy === undefined) break;
      const key = JSON.stringify([agents, now.busy ?? null]);
      if (said !== key) {
        this.setWaiting(machineId, agents, now.busy, by);
        said = key;
      }
      let wake!: () => void;
      const hurried = new Promise<void>((r) => (wake = r));
      const off = this.u.onHurry(wake);
      await Promise.race([this.u.sleep(this.u.timing.drainPoll, this.signal), hurried]);
      off();
    }
    if (this.stopped()) return;
    this.setPart(machineId, "downloading", undefined, `downloading ${label}`);
    const asked = this.u.clockNow();
    let refusal: NodeAnswer[1];
    try {
      const [r, second] = await ports.updateNode(machineId, update);
      if (!r.ok) return this.setPart(machineId, "failed", r.stage ?? "download", r.message);
      refusal = second;
    } catch (e) {
      return this.setPart(machineId, "failed", "download", (e as Error).message);
    }
    this.setPart(machineId, "restarting", undefined, `restarting on ${label}`);
    const back = asked + this.u.timing.nodeBack;
    for (;;) {
      const ch = ports.nodeChanged(machineId);
      const n = facts();
      if (n && n.liveSince !== undefined && n.liveSince > asked) {
        if (n.version === to) return this.setPart(machineId, "done", undefined, `runs ${label}`);
        return this.setPart(machineId, "rolled_back", "health", `${label} didn't come up healthy, so ${versionLabel(n.version)} was put back and runs again`);
      }
      const r = refusal.tryTake();
      if (r) return this.setPart(machineId, "failed", r.stage ?? "restart", r.message);
      if (this.u.clockNow() >= back) {
        return this.setPart(
          machineId,
          "failed",
          "health",
          `didn't come back within ${Math.floor(this.u.timing.nodeBack / 60_000)} min: check the fleetd node service on ${node.name}`,
        );
      }
      if (this.stopped()) return;
      await this.nodeWait(ch);
    }
  }

  /** Brings the machine's Claude Code to the version the hub's build was tested with, once its node runs that build. */
  async updateClaude(ports: UpdatePorts, machineId: string): Promise<void> {
    const run = this.u.status();
    if (!run) return;
    const node = run.parts.find((p) => p.part === "node" && p.machineId === machineId);
    if (!node) return;
    if (node.state !== "done" && node.state !== "current") {
      const why = node.state === "skipped" ? (node.message ?? "") : "not asked: its fleetd didn't update";
      return this.setClaude(machineId, undefined, "skipped", undefined, why);
    }
    const target = ports.claudeTarget();
    const facts = ports.nodes().find((n) => n.machineId === machineId);
    // Its fleetd is past the run's build: the Claude Code that build was tested with would be a step back.
    if (facts && run.to !== undefined && versionCmp(facts.version, run.to) === 1) {
      return this.setClaude(machineId, undefined, "skipped", undefined, `left as it is: its fleetd runs ${versionLabel(facts.version)}, newer than this update's`);
    }
    if (facts?.agentsMac) return this.setClaude(machineId, undefined, "skipped", undefined, "the agents' Mac runs no Claude Code: nothing to install");
    if (!facts?.canInstallClaude) {
      return this.setClaude(machineId, target, "skipped", undefined, `its fleetd doesn't install Claude Code: install ${target} on it by hand`);
    }
    this.setClaude(machineId, target, "downloading", undefined, `installing Claude Code ${target}`);
    try {
      const r = await ports.installClaude(machineId, target);
      if (r.ok && r.message.startsWith(CLAUDE_LEFT)) this.setClaude(machineId, undefined, "skipped", undefined, r.message);
      else if (r.ok && r.message.startsWith(CLAUDE_ALREADY)) this.setClaude(machineId, undefined, "current", undefined, r.message);
      else if (r.ok) this.setClaude(machineId, undefined, "done", undefined, r.message);
      else this.setClaude(machineId, undefined, "failed", r.stage ?? "install", r.message);
    } catch (e) {
      this.setClaude(machineId, undefined, "failed", "install", (e as Error).message);
    }
  }
}

/** The hub's and the nodes' parts by machine (the hub's under ""), for a quick look. */
export function byMachine(run: UpdateRun): Map<string, UpdatePart> {
  return new Map(run.parts.filter((p) => p.part !== "claude").map((p) => [p.machineId ?? "", p]));
}
