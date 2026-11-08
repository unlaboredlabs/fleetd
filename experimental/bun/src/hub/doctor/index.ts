// The doctor (M11): every setup check, live (crates/fleetd/src/hub/doctor/service.rs). Runs on demand (doctor_list
// with rerun) and each minute from its loop: every check when the last full run is 15 min old, else those of the
// machines whose status moved since. Emits one doctor.changed per machine (and one for the hub) whose checks changed
// status since the last run. Every fix is a command for a person to run; doctor_fix answers with it.
import type { DoctorCheck, DoctorStatus } from "../../shared/contracts.ts";
import type { Hub } from "../api/hub.ts";
import { events } from "../store/events.ts";
import { isoMs } from "../store/time.ts";
import { Mutex } from "../train/mutex.ts";
import * as checks from "./checks.ts";
import { type MachineSetup, readHubSetup, restartCommand } from "./config.ts";
import { type DoctorSources, hubSources } from "./sources.ts";

export const DOCTOR_EVERY_MS = 15 * 60_000;
/** How often the loop looks: a moved machine is checked again within this. */
export const DOCTOR_TICK_MS = 60_000;

/** A refusal in the tools' `{ code, message, fix }` shape. */
export type DoctorRefused = { code: "invalid"; message: string; fix?: string };

export type DoctorResults = {
  checks: DoctorCheck[];
  /** When the last group ran: the hub's own checks or any machine's. */
  checkedAt: string;
  /** When each machine's checks last ran: a machine's own time, which another's run doesn't move. */
  machinesCheckedAt: Map<string, string>;
};

/** A loopback URL for a listen address: a wildcard host is reached on loopback. */
export function selfUrl(host: string, port: number): string {
  const h = host === "0.0.0.0" || host === "" ? "127.0.0.1" : host === "::" ? "::1" : host;
  return h.includes(":") ? `http://[${h}]:${port}` : `http://${h}:${port}`;
}

/** The machine a check id names: its scope before the first `/`, unless that is the hub. */
export function machineOf(checkId: string): string | undefined {
  const slash = checkId.indexOf("/");
  const scope = slash < 0 ? "" : checkId.slice(0, slash);
  return scope === "hub" ? undefined : scope;
}

/** `<cmd> <args>` with a 30 s timeout. */
export async function runCmd(cmd: string, args: string[]): Promise<checks.CmdOutcome> {
  if (Bun.which(cmd) === null) return { ran: false, error: "ENOENT" };
  let proc: ReturnType<typeof Bun.spawn<"ignore", "pipe", "pipe">>;
  try {
    proc = Bun.spawn([cmd, ...args], { stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  } catch (error) {
    const code = (error as { code?: string }).code;
    return { ran: false, error: code === "ENOENT" ? "ENOENT" : (error as Error).message };
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<"timeout">((resolve) => (timer = setTimeout(() => resolve("timeout"), 30_000)));
  const done = Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  const result = await Promise.race([done, timeout]);
  clearTimeout(timer);
  if (result === "timeout") {
    proc.kill();
    return { ran: false, error: `${cmd} timed out after 30 s` };
  }
  const [stdout, stderr, exitCode] = result;
  return { ran: true, exitCode: exitCode ?? 1, stdout, stderr };
}

/** GET `<url>/healthz`, following no redirect: a refused connection, a timeout and a non-2xx answer all fail. */
export async function health(url: string): Promise<checks.Probe> {
  try {
    const r = await fetch(`${url}/healthz`, { redirect: "manual", signal: AbortSignal.timeout(5000) });
    await r.body?.cancel();
    return r.ok ? { ok: true } : { ok: false, why: `HTTP ${r.status}` };
  } catch (error) {
    const e = error as { name?: string; code?: string };
    if (e.name === "TimeoutError" || e.name === "AbortError") return { ok: false, why: "TimeoutError" };
    if (e.code === "ConnectionRefused" || e.code === "ECONNREFUSED") return { ok: false, why: "ECONNREFUSED" };
    return { ok: false, why: "error" };
  }
}

type State = {
  /** Latest check per id, hub checks first, then machines in id order. */
  latest: DoctorCheck[];
  checkedAt?: string;
  /** When each machine's checks last ran. */
  machinesAt: Map<string, string>;
  lastRunMs?: number;
  /** Each machine's status when its checks last ran: one that has changed since is checked again at the next tick. */
  checkedAs: Map<string, string>;
};

/** At most 8 at once, outputs in order. */
async function chunked<T, U>(items: T[], fn: (item: T) => Promise<U[]>): Promise<U[]> {
  const out: U[] = [];
  for (let i = 0; i < items.length; i += 8) {
    for (const part of await Promise.all(items.slice(i, i + 8).map(fn))) out.push(...part);
  }
  return out;
}

export class Doctor {
  /** Where the checks read the hub's state; an area not ported yet keeps its default, its owner sets its own. */
  readonly sources: DoctorSources;
  /** Held by every run and fix, so they never overlap. */
  private readonly lock = new Mutex();
  private readonly state: State = { latest: [], machinesAt: new Map(), checkedAs: new Map() };
  /** The probes of URLs and commands; tests replace them. */
  health = health;
  runCmd = runCmd;

  constructor(private readonly hub: Hub) {
    this.sources = hubSources(hub);
  }

  private now(): number {
    return this.hub.clock.now();
  }

  private config() {
    return readHubSetup(this.hub.config.home);
  }

  private async hubChecks(): Promise<DoctorCheck[]> {
    const [config, problem] = this.config();
    const { host, port } = this.hub.config.listen;
    const own = selfUrl(host, port);
    const pub = config.url?.startsWith("https://") && problem === undefined ? config.url : undefined;
    const [reachable, gh, https] = await Promise.all([
      this.health(own),
      this.runCmd("gh", ["auth", "status"]),
      pub === undefined ? Promise.resolve(undefined) : this.health(pub.replace(/\/+$/, "")),
    ]);
    const hubSetup: MachineSetup = {
      sshHost: "",
      local: true,
      platform: process.platform === "darwin" ? "darwin" : "linux",
      uid: process.getuid?.() ?? 0,
    };
    const out = [
      checks.hubReachable(`${own}/healthz`, reachable, restartCommand("hub", hubSetup)),
      checks.ghAuth(gh),
      checks.httpsReachable(config, problem, port, https),
      checks.repoCi(this.sources.reposWithoutCi()),
    ];
    const claude = this.sources.claudeSetup();
    if (claude) out.push(checks.claudeKey(claude), checks.claudeOwner(claude));
    out.push(...checks.setupChecks(this.sources.setupFacts()));
    return out;
  }

  /** The setup checks read from the hub's own state, as it is now: cheap, so setup reads them fresh. */
  setupChecks(): DoctorCheck[] {
    const out = checks.setupChecks(this.sources.setupFacts());
    const claude = this.sources.claudeSetup();
    if (claude) out.push(checks.claudeKey(claude), checks.claudeOwner(claude));
    return out;
  }

  private async machineChecks(machine: checks.MachineView): Promise<DoctorCheck[]> {
    const id = machine.machineId;
    const [config] = this.config();
    const setup = config.machines[id];
    const s = this.sources;
    const online = machine.status !== "offline";
    // The agents' Mac runs no claude and commits nothing: its own setup's checks stand in for those, from its
    // heartbeat. Its node isn't asked about a runner.
    if (machine.agentsMac === true) {
      const out = [checks.machineOnline(machine, setup)];
      out.push(...checks.macSetup(id, !online, s.load(id)?.mac));
      out.push(checks.macOneNode(id, s.sameComputer(id)));
      out.push(checks.diskSpace(id, !online, s.load(id)?.disk, undefined));
      const ios = checks.iosSessions(id, !online, s.load(id)?.ios);
      if (ios) out.push(ios);
      return out;
    }
    const [runner, breaker, probe] = await Promise.all([
      online ? s.runnerInfo(id) : Promise.resolve(undefined),
      s.usageBreaker(id),
      online ? s.probe(id) : Promise.resolve<checks.ProbeRead>({ ok: false, why: `${id} is offline.` }),
    ]);
    const claude = s.claudeSetup();
    const out = [checks.machineOnline(machine, setup, runner)];
    if (runner) {
      out.push(...checks.runnerChecks(id, runner));
      const override = checks.claudeAccountOverride(id, runner, claude?.configured ?? false);
      if (override) out.push(override);
    }
    out.push(checks.commitIdentity(id, probe, config));
    const load = s.load(id);
    out.push(checks.diskSpace(id, !online, load?.disk, s.paused(id)));
    for (const c of [
      checks.androidSessions(id, !online, load?.android),
      checks.iosSessions(id, !online, load?.ios),
      checks.desktopSessions(id, !online, load?.desktop),
    ]) {
      if (c) out.push(c);
    }
    out.push(checks.usageBreaker(id, breaker));
    const bases = s.bases(id);
    const now = isoMs(this.now());
    for (const c of [checks.gitFetch(id, bases, now), checks.forkBehind(id, bases)]) if (c) out.push(c);
    out.push(checks.recoveryBreaker(id, s.recoveryPaused(id)));
    out.push(checks.unownedSessions(id, !online, s.unownedSessions(id)));
    return out;
  }

  /** Changed statuses per machine ("hub" for hub checks); new checks count only after the first run. */
  private emitChanges(before: Map<string, DoctorCheck>, after: DoctorCheck[], baseline: boolean): void {
    const groups = new Map<string, { id: string; to: DoctorStatus; from?: DoctorStatus }[]>();
    for (const check of after) {
      const from = before.get(check.id)?.status;
      if (from === check.status || (from === undefined && (baseline || check.status === "ok"))) continue;
      const key = check.machineId ?? "hub";
      let group = groups.get(key);
      if (!group) groups.set(key, (group = []));
      group.push(from === undefined ? { id: check.id, to: check.status } : { id: check.id, to: check.status, from });
    }
    const at = isoMs(this.now());
    for (const [key, changes] of groups) {
      const text = changes.map((c) => `${c.id} ${c.from ?? "new"} → ${c.to}`);
      events(this.hub).append({
        at,
        type: "doctor.changed",
        ...(key === "hub" ? {} : { machineId: key }),
        summary: checks.clip(`doctor: ${text.join(", ")}`, 200),
        data: { changes: changes.slice(0, 20) },
      });
    }
  }

  /**
   * Replaces the checks of the groups just run (all of them when `machineIds` is undefined, the hub's when it is
   * empty) and emits changes.
   */
  private record(fresh: DoctorCheck[], machineIds?: string[]): void {
    const state = this.state;
    const before = new Map(state.latest.map((c) => [c.id, c]));
    const replaced = (c: DoctorCheck) =>
      machineIds === undefined
        ? true
        : machineIds.length === 0
          ? c.scope === "hub"
          : c.scope !== "hub" && machineIds.some((m) => m === c.machineId);
    const merged = [...state.latest.filter((c) => !replaced(c)), ...fresh];
    const hub = merged.filter((c) => c.scope === "hub");
    // A stable sort by machine id, as Rust's sort_by (a check without one sorts first).
    const machines = merged
      .filter((c) => c.scope !== "hub")
      .map((c, i) => [c, i] as const)
      .sort(([a, i], [b, j]) => {
        const x = a.machineId ?? "";
        const y = b.machineId ?? "";
        return x < y ? -1 : x > y ? 1 : i - j;
      })
      .map(([c]) => c);
    state.latest = [...hub, ...machines];
    this.emitChanges(before, fresh, state.checkedAt === undefined);
    const at = isoMs(this.now());
    let ran: string[];
    if (machineIds === undefined) {
      // Every machine there is now: one gone keeps no time.
      state.machinesAt.clear();
      ran = fresh.flatMap((c) => (c.machineId === undefined ? [] : [c.machineId]));
    } else {
      ran = machineIds;
    }
    for (const id of ran) state.machinesAt.set(id, at);
    state.checkedAt = at;
  }

  private results(): DoctorResults {
    const s = this.state;
    return { checks: [...s.latest], checkedAt: s.checkedAt ?? isoMs(0), machinesCheckedAt: new Map(s.machinesAt) };
  }

  private async runAll(): Promise<void> {
    const machines = this.sources.machines();
    const [hubChecks, perMachine] = await Promise.all([this.hubChecks(), chunked(machines, (m) => this.machineChecks(m))]);
    this.record([...hubChecks, ...perMachine]);
    this.state.lastRunMs = this.now();
    this.state.checkedAs = new Map(machines.map((m) => [m.machineId, m.status]));
  }

  /** Checks again each machine whose status moved since its checks ran: its checks said how it was then. */
  private async runMoved(): Promise<void> {
    const moved = this.sources.machines().filter((m) => this.state.checkedAs.get(m.machineId) !== m.status);
    if (moved.length === 0) return;
    const fresh = await chunked(moved, (m) => this.machineChecks(m));
    this.record(
      fresh,
      moved.map((m) => m.machineId),
    );
    for (const m of moved) this.state.checkedAs.set(m.machineId, m.status);
  }

  private async locked<T>(fn: () => Promise<T>): Promise<T> {
    const release = await this.lock.lock();
    try {
      return await fn();
    } finally {
      release();
    }
  }

  /** Runs the hub's own checks now, leaving the machines' as they were; every check when nothing has run yet. */
  rerunHub(): Promise<DoctorResults> {
    return this.locked(async () => {
      if (this.state.checkedAt === undefined) await this.runAll();
      else this.record(await this.hubChecks(), []);
      return this.results();
    });
  }

  /** The latest results; runs every check first when `rerun` is set or nothing has run yet. */
  list(rerun: boolean): Promise<DoctorResults> {
    return this.locked(async () => {
      if (rerun || this.state.checkedAt === undefined) await this.runAll();
      return this.results();
    });
  }

  /** The loop's hook, each minute: every check when the last run is 15 min old, else the moved machines'. */
  runIfDue(): Promise<void> {
    return this.locked(async () => {
      const last = this.state.lastRunMs;
      if (last === undefined || this.now() - last >= DOCTOR_EVERY_MS) await this.runAll();
      else await this.runMoved();
    });
  }

  /** Re-runs a check and answers with the command that fixes it: every fix needs a person, so it always refuses. */
  fix(checkId: string): Promise<DoctorRefused> {
    return this.locked(async () => {
      const refused = (message: string, fix?: string): DoctorRefused => ({
        code: "invalid",
        message,
        ...(fix === undefined ? {} : { fix }),
      });
      const listFix = "Call doctor_list for the current checks.";
      const machineId = machineOf(checkId);
      const machine = machineId === undefined ? undefined : this.sources.machines().find((m) => m.machineId === machineId);
      if (machineId !== undefined && !machine) return refused(`No machine ${machineId}.`, listFix);
      const now = machine ? await this.machineChecks(machine) : await this.hubChecks();
      const check = now.find((c) => c.id === checkId);
      if (!check) return refused(`No doctor check ${checkId}.`, listFix);
      if (!check.fix) return refused(`${checkId} has nothing to fix (${check.status}).`);
      return refused(`${checkId} needs a person: ${check.fix.label}.`, check.fix.command);
    });
  }
}

/** The hub's one doctor. */
export const doctor = (hub: Hub) => hub.area("doctor", (h) => new Doctor(h));
