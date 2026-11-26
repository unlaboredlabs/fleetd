// The watcher of a restart onto a new build. Whoever put the new binary in place
// writes a Plan and starts `fleetd update-finish <plan>` from the binary it replaced, outside the service it restarts,
// so the watcher works whatever the new build does. It restarts the service, waits for it to come up healthy on the
// new build, and if it doesn't, puts the previous binary back and restarts that. Its Verdict goes to `plan.verdict`.
import { existsSync, mkdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import type { UpdateStage, UpdateState } from "../shared/contracts.ts";
import { errText, replaceFile, restore } from "./index.ts";
import { cpuTimeMs, mainPid, restart as restartService, type Service, spawnOutside } from "./service.ts";
import { versionShown } from "./version.ts";

/**
 * How long a restarted hub or node gets to come up healthy before the previous build goes back: in the time its process
 * ran on a CPU, not on the clock, so a busy machine that leaves it a quarter of a core doesn't roll a good build back
 * (0.9.37 on the devbox, Nov 26: 21 s of CPU in 92 s at load 60, not up yet, put back).
 */
export const HEALTH_WAIT_SECS = 90;
/** Whatever its CPU time says, a build not up in this many times the wait on the clock goes back: one stuck idle. */
const CAP_TIMES = 3;
const POLL_MS = 100;
/** How often the watcher asks the service manager about the process: a spawn each time, so not at every poll. */
const PROBE_MS = 1000;
/** The longest the restart waits for `plan.answered`. */
export const ANSWER_WAIT_MS = 2000;
/** The longest the watcher waits with the default wait: for `answered`, then the cap on the new build and on the one
 * put back, each judged by the same CPU-time rules. */
export const WATCH_MAX_MS = ANSWER_WAIT_MS + 2 * HEALTH_WAIT_SECS * CAP_TIMES * 1000;

export type Health = { kind: "hub"; url: string } | { kind: "node"; up: string };

export type Plan = {
  exe: string;
  prev: string;
  service: Service;
  from: string;
  to: string;
  health: Health;
  waitSecs: number;
  verdict: string;
  answered?: string | null;
};

export type Verdict = { state: UpdateState; stage?: UpdateStage | null; message: string };

export type Ran = { pid: number; cpuMs: number };

/** What the watcher does to the world; tests stand in fakes. */
export interface Ports {
  restart(service: Service): void;
  /** The service answers on `version` now, and did so after `sinceMs`. */
  healthy(health: Health, version: string, sinceMs: number): Promise<boolean>;
  /** The service's process and the CPU time it used; "down" with none running, undefined when that can't be told. */
  ran(service: Service): Ran | "down" | undefined;
  sleep(ms: number): Promise<void>;
  nowMs(): number;
}

/** Restarts onto `plan.to`, or back onto `plan.from` when it doesn't come up. */
export async function finish(plan: Plan, ports: Ports): Promise<Verdict> {
  const to = versionShown(plan.to);
  const from = versionShown(plan.from);
  if (plan.answered) {
    const deadline = ports.nowMs() + ANSWER_WAIT_MS;
    while (!existsSync(plan.answered) && ports.nowMs() < deadline) await ports.sleep(POLL_MS);
  }
  const old = pidOf(ports.ran(plan.service));
  const started = ports.nowMs();
  try {
    ports.restart(plan.service);
  } catch (e) {
    // The service manager refused: nothing restarted, so only the binary at the path goes back.
    const said = (e as Error).message;
    let message: string;
    try {
      restore(plan.exe, plan.prev);
      message = `${said}, so it never restarted onto ${to} and still runs ${from}; its previous binary was put back`;
    } catch (back) {
      message = `${said}, so it never restarted onto ${to} and still runs ${from}, but its previous binary couldn't be put back (${errText(back)}): run \`fleetd update\` on that machine`;
    }
    return { state: "failed", stage: "restart", message };
  }
  const missed = await up(plan, ports, plan.to, started, old);
  if (missed === undefined) return { state: "done", stage: null, message: `runs ${to}` };
  const why = `${to} ${missed}`;
  try {
    restore(plan.exe, plan.prev);
  } catch (e) {
    return { state: "failed", stage: "health", message: `${why}, and putting ${from} back failed (${errText(e)}): run \`fleetd update\` on that machine` };
  }
  const bad = pidOf(ports.ran(plan.service));
  const again = ports.nowMs();
  let back = false;
  try {
    ports.restart(plan.service);
    back = (await up(plan, ports, plan.from, again, bad)) === undefined;
  } catch {
    back = false;
  }
  return {
    state: "rolled_back",
    stage: "health",
    message: back ? `${why}, so ${from} was put back and runs again` : `${why}, so ${from} was put back, but it didn't come up either: check the ${plan.service.name} service`,
  };
}

const pidOf = (ran: Ran | "down" | undefined) => (ran === undefined || ran === "down" ? undefined : ran.pid);

/**
 * Undefined once the service answers on `version`; else why it is taken as not coming up: its process exited, it ran
 * `plan.waitSecs` on a CPU, or it isn't up CAP_TIMES that on the clock. Where the process can't be read, its clock
 * time stands in for its CPU time. `old`, the process before the restart, is never taken for the new one: a service
 * manager that answers before it ended (launchd's kickstart, maybe) would have it read as exiting once it's gone.
 */
async function up(plan: Plan, ports: Ports, version: string, sinceMs: number, old?: number): Promise<string | undefined> {
  const wait = plan.waitSecs * 1000;
  let pid: number | undefined;
  let cpuMs: number | undefined;
  let probed = -Infinity;
  for (;;) {
    if (await ports.healthy(plan.health, version, sinceMs)) return undefined;
    const now = ports.nowMs();
    if (now - probed >= PROBE_MS) {
      probed = now;
      const read = ports.ran(plan.service);
      const ran = read !== undefined && read !== "down" && read.pid === old ? undefined : read;
      // None now, or another one the service manager started after it: the build exited as it started.
      if (pid !== undefined && (ran === "down" || (ran !== undefined && ran.pid !== pid))) return "stopped before it came up healthy";
      if (ran !== undefined && ran !== "down") [pid, cpuMs] = [ran.pid, ran.cpuMs];
    }
    if (cpuMs !== undefined && cpuMs >= wait) return `didn't come up healthy in ${plan.waitSecs} s of CPU time`;
    if (cpuMs === undefined && now - sinceMs >= wait) return `didn't come up healthy within ${plan.waitSecs} s`;
    if (now - sinceMs >= wait * CAP_TIMES) return `didn't come up healthy within ${plan.waitSecs * CAP_TIMES} s`;
    await ports.sleep(POLL_MS);
  }
}

/** `<node home>/update/up`: the node's version once its hub welcomed it, for the watcher of its restart. */
export const upPath = (nodeHome: string) => join(nodeHome, "update", "up");

/** Called by the node on every welcome; a failure only costs a needless rollback, so it is logged. */
export function markUp(nodeHome: string, version: string): void {
  const path = upPath(nodeHome);
  try {
    mkdirSync(dirname(path), { recursive: true });
    replaceFile(path, version);
  } catch (e) {
    console.warn(`couldn't write ${path}: ${errText(e)}`);
  }
}

/** Called by the node once its answer to the hub is on the link: its watcher restarts it now. */
export function markAnswered(path: string): void {
  try {
    replaceFile(path, "");
  } catch (e) {
    console.warn(`couldn't write ${path}: ${errText(e)}`);
  }
}

export function readVerdict(path: string): Verdict | undefined {
  try {
    const v = JSON.parse(readFileSync(path, "utf8")) as Verdict;
    return typeof v?.state === "string" && typeof v.message === "string" ? v : undefined;
  } catch {
    return undefined;
  }
}

/** The plan as serde writes it, pretty: its fields in the struct's order. */
export const planText = (plan: Plan) =>
  JSON.stringify(
    {
      exe: plan.exe,
      prev: plan.prev,
      service: { name: plan.service.name, unit: plan.service.unit },
      from: plan.from,
      to: plan.to,
      health: plan.health.kind === "hub" ? { kind: "hub", url: plan.health.url } : { kind: "node", up: plan.health.up },
      waitSecs: plan.waitSecs,
      verdict: plan.verdict,
      answered: plan.answered ?? null,
    },
    null,
    2,
  );

const verdictText = (v: Verdict) => JSON.stringify({ state: v.state, stage: v.stage ?? null, message: v.message }, null, 2);

/** Writes `plan` beside its verdict and starts the watcher from `from` (`plan.prev` by default), outside the service. */
export function start(plan: Plan, planPath: string, from: string = plan.prev): void {
  mkdirSync(dirname(planPath), { recursive: true });
  rmSync(plan.verdict, { force: true });
  if (plan.answered) rmSync(plan.answered, { force: true });
  replaceFile(planPath, planText(plan));
  spawnOutside(from, ["update-finish", planPath]);
}

/** The real world: the service manager, `/healthz`, the node's up file and `ps`. */
export const realPorts: Ports = {
  restart: restartService,
  async healthy(health, version, sinceMs) {
    if (health.kind === "hub") {
      try {
        const answer = await fetch(`${health.url}/healthz`, { signal: AbortSignal.timeout(5000) });
        const body = (await answer.json().catch(() => ({}))) as { version?: unknown };
        return body.version === version;
      } catch {
        return false;
      }
    }
    try {
      return statSync(health.up).mtimeMs >= sinceMs && readFileSync(health.up, "utf8").trim() === version;
    } catch {
      return false;
    }
  },
  ran(service) {
    const pid = mainPid(service);
    if (pid === null) return "down";
    const cpuMs = pid === undefined ? undefined : cpuTimeMs(pid);
    return pid === undefined || cpuMs === undefined ? undefined : { pid, cpuMs };
  },
  sleep: (ms) => Bun.sleep(ms),
  nowMs: () => Date.now(),
};

/** `fleetd update-finish <plan>`: the watcher itself. Its verdict is its output; exit 0 unless the plan can't be read. */
export async function run(planPath: string | undefined, ports: Ports = realPorts): Promise<number> {
  let plan: Plan;
  try {
    if (planPath === undefined) throw new Error("usage: fleetd update-finish <plan>");
    plan = JSON.parse(readFileSync(planPath, "utf8")) as Plan;
  } catch (e) {
    process.stderr.write(`fleetd update-finish: ${planPath ?? ""}: ${errText(e)}\n`);
    return 2;
  }
  const verdict = await finish(plan, ports);
  process.stdout.write(`${verdict.message}\n`);
  try {
    replaceFile(plan.verdict, verdictText(verdict));
  } catch (e) {
    process.stderr.write(`fleetd update-finish: ${plan.verdict}: ${errText(e)}\n`);
  }
  return 0;
}
