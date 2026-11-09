// Placement on cloud machines (crates/fleetd/src/hub/pool/place.rs, D306), deterministic: a task goes to a cloud
// machine only when its project's own machine is at its agent limit. In order: its own machine while it has room;
// an awake cloud machine, caught up, with room (hydrated first, then the busiest); waking a sleeping one, one at a
// time; else it queues, its line saying why. Each cloud machine holds a pool checkout of each opted-in project's repos,
// registered there under the home checkout's project id, so `(boat-2, <id>)` is the home checkout's twin.
import type { ProjectRef, ProjectRepo, Task } from "../../shared/contracts.ts";
import { seal } from "../../shared/sealed_box.ts";
import type { Hub } from "../api/hub.ts";
import { sessionCall } from "../cloud/node.ts";
import { executors } from "../executor/index.ts";
import { projectEnv, projectUpsert } from "../executor/projects.ts";
import { githubApps } from "../github_app/index.ts";
import { get as repoGet, of as reposOf } from "../repos/store.ts";
import { store } from "../store/hub_store.ts";
import { isoMs } from "../store/time.ts";
import { scopeOf } from "../work/store.ts";
import { budgetLine, type Pool } from "./index.ts";

/** The cloud machines a new task may run on now, as placement sees them. */
export type Room = {
  /** Whether it may run on one at all; `{ no: why }` when it may not (why undefined: nothing to say). */
  eligible: { yes: true } | { no?: string };
  /** Awake, caught up and holding its checkout: the hydrated ones first. */
  awake: string[];
  warm: number;
  cloning?: string;
  cloneFailed?: string;
  closed?: string;
};

export const emptyRoom = (): Room => ({ eligible: { no: undefined }, awake: [], warm: 0 });

/** Why no work may go to a cloud machine now, even an awake one; undefined: it may. */
export function closed(pool: Pool): string | undefined {
  if (!pool.ready()) return "cloud machines wait for the hub's first check of boat.dev";
  try {
    const s = pool.ledger.settings();
    if (!s.enabled) return "cloud machines are off";
    return budgetLine(pool.budget(s, pool.now()));
  } catch (e) {
    return `the pool's ledger can't be read: ${(e as Error).message}`;
  }
}

/** The awake cloud machines caught up for work: those whose disk is hydrated first, each part in slot order. */
export function awake(pool: Pool): string[] {
  const slots = pool.ledger
    .slots()
    .filter((r) => r.state === "awake" && pool.fleet.ready(r.slot))
    .map((r) => r.slot);
  return [...slots.filter((s) => pool.hydrated(s)), ...slots.filter((s) => !pool.hydrated(s))];
}

/**
 * Wakes a cloud machine for work, off the caller: `slot`, a task's own; else none while one is waking already (named
 * instead), else the first asleep one. Returns the machine coming; throws the one line why none does.
 */
export function wakeForWork(pool: Pool, slot?: string): string {
  const rows = pool.ledger.slots();
  let pick: string;
  if (slot !== undefined) {
    const row = rows.find((r) => r.slot === slot);
    if (!row) throw new Error(`${slot} is no longer a cloud machine`);
    if (row.state === "awake" || row.state === "waking" || row.state === "creating") return slot;
    if (row.state === "broken") throw new Error(`${slot} doesn't come back: Reset it in Settings › Hub › Machines`);
    if (row.state === "failed" || row.state === "gone") throw new Error(`${slot} has no machine: Reset it in Settings › Hub › Machines`);
    pick = slot;
  } else {
    const coming = [...pool.waking][0] ?? rows.find((r) => r.state === "waking" || r.state === "creating")?.slot;
    if (coming !== undefined) return coming;
    const asleep = rows.find((r) => r.state === "asleep" && r.sandboxId !== undefined);
    if (!asleep) throw new Error(`the cloud machines are busy (${rows.filter((r) => r.state === "awake").length} of ${rows.length} awake)`);
    pick = asleep.slot;
  }
  const line = closed(pool) ?? pool.startHeld();
  if (line !== undefined) throw new Error(line);
  if (pool.waking.has(pick)) return pick;
  pool.waking.add(pick);
  void pool
    .wake(pick, "need")
    .catch((e) => console.warn(`pool: wake of ${pick} for work refused: ${(e as Error).message}`))
    .finally(() => pool.waking.delete(pick));
  return pick;
}

/** A github.com repo key's `owner/name`, which the hub's App gives a token for; undefined for another host. */
export const githubRepo = (key: string) => {
  const r = key.startsWith("github.com/") ? key.slice(11) : undefined;
  return r !== undefined && r.includes("/") ? r : undefined;
};

/** The checkout's twin on cloud machine `m`: the clone registered there under the home checkout's project id. */
export const twin = (m: string, checkout: ProjectRef): ProjectRef => ({ machineId: m, projectId: checkout.projectId });

const sameRef = (a: ProjectRef, b: ProjectRef) => a.machineId === b.machineId && a.projectId === b.projectId;

/** The cloud machines a new task working in `checkout` may run on now. */
export function room(hub: Hub, pool: Pool, cloning: Cloning, task: Task, checkout: ProjectRef): Room {
  const r: Room = { ...emptyRoom(), eligible: eligible(hub, pool, task, checkout) };
  if (!("yes" in r.eligible)) return r;
  const c = closed(pool);
  if (c !== undefined) return { ...r, closed: c };
  const now = pool.now();
  const failed = cloning.failedAnywhere(checkout, now);
  if (failed !== undefined) r.cloneFailed = failed;
  for (const m of awake(pool)) {
    if (!executors(hub).isConnected(m)) continue;
    if (store(hub).projectGet(twin(m, checkout))) {
      if (pool.hydrated(m)) r.warm++;
      r.awake.push(m);
    } else if (r.cloning === undefined && cloning.due(m, checkout, now)) {
      // Opted in while it was awake: cloned now, and the task waits for that.
      cloning.ensure(hub, pool, m);
      r.cloning = m;
    }
  }
  return r;
}

/** Whether the task may run on a cloud machine at all. */
function eligible(hub: Hub, pool: Pool, task: Task, checkout: ProjectRef): Room["eligible"] {
  let s;
  try {
    s = pool.ledger.settings();
  } catch {
    return { no: undefined };
  }
  if (!s.enabled || !s.hasKey || !s.projects.some((p) => sameRef(p, task.projectRef))) return { no: undefined };
  const secrets = hub.db.conn.query("SELECT 1 FROM project_env WHERE machine_id = ? AND project_id = ? AND kind = 'secret'").get(checkout.machineId, checkout.projectId);
  if (secrets !== null) return { no: "not for cloud: its project's secret variables are only on its own machine" };
  return { yes: true };
}

/** A checkout whose clone failed is tried there again after this, doubling up to CLONE_BACKOFF_MAX_MS. */
export const CLONE_BACKOFF_MS = 10 * 60_000;
export const CLONE_BACKOFF_MAX_MS = 6 * 60 * 60_000;

type Failed = { until: number; step: number; why: string };

/** The checkouts each cloud machine is cloning now, and those whose clone failed, until tried again. In memory. */
export class Cloning {
  private readonly running = new Set<string>();
  private readonly failed = new Map<string, Failed & { machine: string; checkout: ProjectRef }>();

  private key = (m: string, c: ProjectRef) => `${m}\u0000${c.machineId}/${c.projectId}`;

  due(m: string, checkout: ProjectRef, now: number): boolean {
    const f = this.failed.get(this.key(m, checkout));
    return !f || now >= f.until;
  }

  /** While `checkout`'s clone waits out a failure on some cloud machine: the line its tasks' queue shows. */
  failedAnywhere(checkout: ProjectRef, now: number): string | undefined {
    const f = [...this.failed.values()].filter((x) => sameRef(x.checkout, checkout) && now < x.until).sort((a, b) => (a.machine < b.machine ? -1 : 1))[0];
    if (!f) return undefined;
    const why = [...f.why].slice(0, 90).join("");
    return `its repo didn't clone on ${f.machine}, a cloud machine (${why}); tried again at ${isoMs(f.until).slice(11, 16)} UTC`;
  }

  settled(m: string, checkout: ProjectRef, result: string | undefined, now: number): void {
    const k = this.key(m, checkout);
    if (result === undefined) {
      this.failed.delete(k);
      return;
    }
    const before = this.failed.get(k);
    const step = before ? before.step + 1 : 0;
    const wait = Math.min(CLONE_BACKOFF_MS * 2 ** Math.min(step, 10), CLONE_BACKOFF_MAX_MS);
    this.failed.set(k, { until: now + wait, step, why: result, machine: m, checkout });
  }

  /** `ensureCheckouts` on `m`, off the caller; once at a time per machine. */
  ensure(hub: Hub, pool: Pool, m: string, retrySoon?: () => void): void {
    if (this.running.has(m)) return;
    this.running.add(m);
    void ensureCheckouts(hub, pool, this, m)
      .then((problems) => {
        for (const p of problems) console.warn(`cloud machine ${m}: pool checkout: ${p}`);
      })
      .finally(() => {
        this.running.delete(m);
        retrySoon?.();
      });
  }
}

/** Every opted-in project's checkouts on cloud machine `m`: each missing one cloned and given its plain variables. */
export async function ensureCheckouts(hub: Hub, pool: Pool, cloning: Cloning, m: string): Promise<string[]> {
  const problems: string[] = [];
  let s;
  try {
    s = pool.ledger.settings();
  } catch {
    return ["the pool's ledger can't be read"];
  }
  for (const project of s.projects) {
    let repos: ProjectRepo[];
    try {
      repos = reposOf(hub.db.conn, project);
    } catch (e) {
      problems.push(`${project.projectId}'s repos not read: ${(e as Error).message}`);
      continue;
    }
    for (const repo of repos) {
      if (!cloning.due(m, repo.checkout, pool.now())) continue;
      let result: string | undefined;
      try {
        await ensureCheckout(hub, m, repo);
      } catch (e) {
        result = (e as Error).message;
      }
      cloning.settled(m, repo.checkout, result, pool.now());
      if (result !== undefined) problems.push(`${repo.name}: ${result}`);
    }
  }
  return problems;
}

/** A token sealed to machine `m`'s box key (github_app/sessions.rs `sealed_to`). */
function sealedTo(hub: Hub, m: string, token: string): string {
  const key = store(hub).machineGet(m)?.boxPubKey;
  if (!key) throw new Error(`${m}'s node takes no secrets: it publishes no box key`);
  const pub = Buffer.from(key, "base64");
  if (pub.length !== 32) throw new Error(`${m}'s box key isn't one`);
  return Buffer.from(seal(new Uint8Array(pub), new TextEncoder().encode(token))).toString("base64");
}

async function ensureCheckout(hub: Hub, m: string, repo: ProjectRepo): Promise<void> {
  const home = repo.checkout;
  const at = twin(m, home);
  if (!store(hub).projectGet(at)) {
    const byRepo = repoGet(hub.db.conn, repo.repoId)?.repo;
    const scope = byRepo?.repoKey !== undefined && byRepo.base !== undefined ? { repoKey: byRepo.repoKey } : scopeOf(hub.db.conn, home);
    if (!scope) throw new Error("it has no remote to clone from");
    const key = scope.repoKey;
    const title = store(hub).projectGet(home)?.title ?? repo.name;
    const scan = await sessionCall(hub, m, { op: "repo_scan" });
    const root = String(scan.cloneRoot ?? "");
    const tail = key.includes("/") ? key.slice(key.indexOf("/") + 1) : key;
    const path = `${root.replace(/\/+$/, "")}/${tail}`;
    const other = store(hub)
      .projectsList(m)
      .find((p) => p.workspaceRoot === path);
    if (other && other.projectId !== home.projectId) throw new Error(`${path} on ${m} is another project's checkout`);
    const facts = await sessionCall(hub, m, { op: "repo_inspect", path });
    if (facts.exists !== true) {
      // A private repo clones with the hub's App's token for it, sealed to the machine.
      const gh = githubRepo(key);
      const token = gh !== undefined ? await githubApps(hub).tokenFor(gh) : undefined;
      const sealed = token !== undefined ? sealedTo(hub, m, token) : undefined;
      try {
        await sessionCall(hub, m, { op: "repo_clone", addId: `C${Date.now()}`, url: `https://${key}`, dest: path, ...(sealed !== undefined ? { token: sealed } : {}) });
      } catch (e) {
        throw new Error(sealed !== undefined ? (e as Error).message : `${(e as Error).message} (the hub's GitHub App doesn't reach it, so it cloned with no token)`);
      }
    }
    await projectUpsert(hub, m, home.projectId, title, path);
  }
  const plain = hub.db.conn
    .query<{ name: string; value: string }, [string, string]>("SELECT name, value FROM project_env WHERE machine_id = ? AND project_id = ? AND kind = 'plain' AND value IS NOT NULL ORDER BY name")
    .all(home.machineId, home.projectId)
    .map((v) => ({ kind: "plain" as const, name: v.name, value: v.value }));
  if (plain.length > 0) await projectEnv(hub, m, home.projectId, plain, []);
}
