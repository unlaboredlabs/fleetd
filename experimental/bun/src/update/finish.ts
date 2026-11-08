// The watcher of a restart onto a new build (crates/fleetd/src/update/finish.rs). Whoever put the new binary in place
// writes a Plan and starts `fleetd update-finish <plan>` from the binary it replaced, outside the service it restarts,
// so the watcher works whatever the new build does. It restarts the service, waits for it to come up healthy on the
// new build, and if it doesn't, puts the previous binary back and restarts that. Its Verdict goes to `plan.verdict`.
import { existsSync, mkdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import type { UpdateStage, UpdateState } from "../shared/contracts.ts";
import { errText, replaceFile, restore } from "./index.ts";
import { restart as restartService, type Service, spawnOutside } from "./service.ts";
import { versionShown } from "./version.ts";

/** How long a restarted hub or node gets to come up healthy before the previous build goes back. */
export const HEALTH_WAIT_SECS = 90;
const POLL_MS = 100;
/** The longest the restart waits for `plan.answered`. */
export const ANSWER_WAIT_MS = 2000;

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

/** What the watcher does to the world; tests stand in fakes. */
export interface Ports {
  restart(service: Service): void;
  /** The service answers on `version` now, and did so after `sinceMs`. */
  healthy(health: Health, version: string, sinceMs: number): Promise<boolean>;
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
  if (await up(plan, ports, plan.to, started)) return { state: "done", stage: null, message: `runs ${to}` };
  const why = `${to} didn't come up healthy within ${plan.waitSecs} s`;
  try {
    restore(plan.exe, plan.prev);
  } catch (e) {
    return { state: "failed", stage: "health", message: `${why}, and putting ${from} back failed (${errText(e)}): run \`fleetd update\` on that machine` };
  }
  const again = ports.nowMs();
  let back = false;
  try {
    ports.restart(plan.service);
    back = await up(plan, ports, plan.from, again);
  } catch {
    back = false;
  }
  return {
    state: "rolled_back",
    stage: "health",
    message: back ? `${why}, so ${from} was put back and runs again` : `${why}, so ${from} was put back, but it didn't come up either: check the ${plan.service.name} service`,
  };
}

async function up(plan: Plan, ports: Ports, version: string, sinceMs: number): Promise<boolean> {
  const deadline = sinceMs + plan.waitSecs * 1000;
  for (;;) {
    if (await ports.healthy(plan.health, version, sinceMs)) return true;
    if (ports.nowMs() >= deadline) return false;
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

/** Writes `plan` beside its verdict and starts the watcher from `plan.prev`, outside the service. */
export function start(plan: Plan, planPath: string): void {
  mkdirSync(dirname(planPath), { recursive: true });
  rmSync(plan.verdict, { force: true });
  if (plan.answered) rmSync(plan.answered, { force: true });
  replaceFile(planPath, planText(plan));
  spawnOutside(plan.prev, ["update-finish", planPath]);
}

/** The real world: the service manager, `/healthz` and the node's up file. */
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
