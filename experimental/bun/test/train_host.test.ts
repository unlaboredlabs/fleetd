// The hub's `TrainHost` on a real hub, and what the train fills in on tasks (crates/fleetd/src/hub/train/
// hub_host_tests.rs, tasks/ci_wait.rs `HubReads`): which writers' ready PRs the train takes as their own (#1271), a
// removed project's branch prefix skipped and an unread one warned of hourly (#1300), and agents' `wait_ci` reads, a
// merge wait's among them, through the train's GitHub reader and its upstream reads.
import { afterEach, expect, setDefaultTimeout, test } from "bun:test";
import { Hub } from "../src/hub/api/hub.ts";
import { withReviews } from "../src/hub/reviews/service.ts";
import { hubReads, targetOf } from "../src/hub/tasks/ci_wait.ts";
import { hubTaskPorts, taskHooks } from "../src/hub/tasks/ports.ts";
import { HubHost } from "../src/hub/train/hub_host.ts";
import { start } from "../src/hub/train/loops.ts";
import { REPEAT_EVERY_MS } from "../src/hub/train/repeats.ts";
import type { ProjectRef } from "../src/shared/contracts.ts";
import { Kit, PROJECT, REPO } from "./train_kit.ts";

let kits: Kit[] = [];
afterEach(() => {
  for (const k of kits) k.done();
  kits = [];
});
setDefaultTimeout(30_000);

/** A hub whose train runs over the kit's fake GitHub and host. */
function lab() {
  const k = new Kit();
  kits.push(k);
  const hub = new Hub({ home: k.dir, listen: { host: "127.0.0.1", port: 0 } }, k.db, k.clock);
  const reviews = withReviews(k.train, k.host);
  hub.area("merge_train", () => ({ train: k.train, reviews, host: new HubHost(hub) }));
  return { k, hub };
}

const project = (projectId: string): ProjectRef => ({ machineId: "devbox", projectId });

function addProject(hub: Hub, r: ProjectRef): void {
  hub.db.conn
    .query("INSERT INTO projects (machine_id, project_id, search, last_activity_at, data) VALUES (?, ?, '', '', ?)")
    .run(r.machineId, r.projectId, JSON.stringify({ machineId: r.machineId, projectId: r.projectId, title: r.projectId, workspaceRoot: `/lab/${r.projectId}` }));
}

function order(hub: Hub, r: ProjectRef): string {
  const n = hub.db.conn
    .query<{ n: number }, [string, string]>("INSERT INTO workstreams (machine_id, project_id, state, data) VALUES (?, ?, 'open', '{}') RETURNING n")
    .get(r.machineId, r.projectId)!.n;
  return `W${n}`;
}

/** A task of `order`, numbered in turn; a writer gets its branch `fleetd/T<n>-work`. */
function task(hub: Hub, r: ProjectRef, workstreamId: string, kind: string, state: string): string {
  const n = hub.db.conn
    .query<{ n: number }, [string, string, string, string]>(
      "INSERT INTO tasks (machine_id, project_id, workstream_id, state, data) VALUES (?, ?, ?, ?, '{}') RETURNING n",
    )
    .get(r.machineId, r.projectId, workstreamId, state)!.n;
  const taskId = `T${n}`;
  const data = { taskId, projectRef: r, workstreamId, title: "work", kind, state, ...(kind === "write" ? { branch: `fleetd/${taskId}-work` } : {}) };
  hub.db.conn.query("UPDATE tasks SET data = ? WHERE n = ?").run(JSON.stringify(data), n);
  return taskId;
}

test("a long-running writer behind a hundred newer tasks is still the train's writer", () => {
  const { hub } = lab();
  const p = project("p1");
  const [open, closed] = [order(hub, p), order(hub, p)];
  const writer = task(hub, p, open, "write", "running");
  const failed = task(hub, p, open, "write", "failed");
  task(hub, p, open, "write", "cancelled");
  task(hub, p, closed, "write", "done");
  for (let i = 0; i < 150; i++) task(hub, p, open, "review", "done");
  hub.db.conn.query("UPDATE workstreams SET state = 'done' WHERE n = ?").run(Number(closed.slice(1)));

  const host = new HubHost(hub);
  expect(host.writers(p).sort()).toEqual([
    [writer, `fleetd/${writer}-work`],
    [failed, `fleetd/${failed}-work`],
  ]);
  expect(host.writers(project("p2"))).toEqual([]);
});

test("the branch prefix of a removed project is skipped, and an unread one warns once, then hourly", async () => {
  const { k, hub } = lab();
  const offline = project("offline");
  addProject(hub, offline);
  hub.area("policy", () => ({
    get: async () => {
      throw new Error("Machine devbox has no live node link.");
    },
  }));
  const host = new HubHost(hub);
  const lines: string[] = [];
  const warn = console.warn;
  console.warn = (...a: unknown[]) => void lines.push(a.join(" "));
  try {
    for (let i = 0; i < 5; i++) {
      expect(await host.branchPrefix(project("removed"))).toBeUndefined();
      expect(await host.branchPrefix(offline)).toBeUndefined();
    }
    expect(lines.filter((l) => l.includes("removed")).length).toBe(0);
    expect(lines.filter((l) => l.includes("policy of devbox/offline not read")).length).toBe(1);
    k.clock.ms += REPEAT_EVERY_MS;
    expect(await host.branchPrefix(offline)).toBeUndefined();
  } finally {
    console.warn = warn;
  }
  expect(lines.filter((l) => l.includes("policy of devbox/offline not read")).length).toBe(2);
  expect(lines.filter((l) => l.includes("(4 like it held back)")).length).toBe(1);
});

test("a failed project read never takes a PR off the train", async () => {
  const { k, hub } = lab();
  const live = project("live");
  addProject(hub, live);
  k.pr(7, "fleetd/T7-app", { "a.md": "a\n" }, { labels: ["hold"] });
  const change = await k.enqueue(7);
  k.train.records.put({ ...k.train.records.get(change.changeId)!, projectRef: live });
  const train = k.restarted();
  // The hub's own host, on the kit's train.
  Object.assign(train, { host: new HubHost(hub) });
  const state = () => train.records.get(change.changeId)!.state;
  const before = state();
  expect(before).not.toBe("abandoned");

  hub.db.conn.run("ALTER TABLE projects RENAME TO projects_away");
  expect(new HubHost(hub).projectRemoved(live)).toBe(false);
  train.dropRemoved();
  expect(state()).toBe(before);

  // Read again, the store has no such project: now it leaves.
  hub.db.conn.run("ALTER TABLE projects_away RENAME TO projects");
  hub.db.conn.run("DELETE FROM projects");
  train.dropRemoved();
  expect(state()).toBe("abandoned");
});

test("the train fills in tasks' hooks: wait_ci reads its GitHub, a merge wait its upstream reads, PR lookups and reviewers", async () => {
  const { k, hub } = lab();
  expect(taskHooks(hub).train).toBeUndefined();
  start(hub);
  k.train.stop();
  // The kit's clean review, not a reviewer task, approves its PR.
  k.train.gate = k.gate;
  const hooks = taskHooks(hub);
  expect(hooks.train?.github).toBe(k.train.github);
  expect(hooks.reviews?.isReviewer("T1")).toBe(false);
  expect(hooks.reviews?.openBlocking(`https://github.com/${REPO}/pull/7`)).toBe("");

  const url = k.pr(7, "fleetd/T7-pricing", { "pricing.md": "pricing\n" });
  const done = new Date(k.clock.ms).toISOString();
  k.gh.runs = () => [{ id: 1, name: "ci", status: "completed", conclusion: "success", completed_at: done, html_url: `https://github.com/${REPO}/actions/runs/1/job/1` }];
  const reads = hubReads(hub, hooks.train!.github, hooks.train!.merges);
  const target = targetOf(url)!;
  // A writer's own PR: found by its branch through the train's reader.
  expect(await hubTaskPorts(hub).branchPr(`git@github.com:${REPO}.git`, "fleetd/T7-pricing")).toBe(url);

  // Its checks just finished: they settle first, then the wait is done.
  expect(await reads.read(target)).toEqual({ kind: "running" });
  k.clock.ms += 3 * 60_000;
  expect(await reads.read(target)).toMatchObject({ kind: "finished", failing: [], total: 1 });

  // Not on the train yet, then on it, then merged by it.
  expect(await reads.merge(PROJECT, target)).toEqual({ kind: "pending" });
  await k.enqueue(7);
  expect(await reads.merge(PROJECT, target)).toEqual({ kind: "pending" });
  await k.settle();
  expect(k.change(7).state).toBe("merged");
  expect(await reads.merge(PROJECT, target)).toEqual({ kind: "merged" });
  expect(await reads.read(target)).toEqual({ kind: "over", why: "was merged" });
  hub.shutdown.abort();
});
