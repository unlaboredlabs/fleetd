import { expect, test } from "bun:test";
import { registerAll } from "../src/hub/serve/areas.ts";
import { Hub } from "../src/hub/api/hub.ts";
import { type Caller, Registry } from "../src/hub/api/registry.ts";
import { chat } from "../src/hub/chat/index.ts";
import { Fresh } from "../src/hub/status/fresh.ts";
import { agentGroup, grouped, STATUS_ITEMS_PER_GROUP } from "../src/hub/status/groups.ts";
import { status, statusRows } from "../src/hub/status/index.ts";
import { clock, readChanges, stateOf, statusInputs } from "../src/hub/status/rows.ts";
import { start as startMetrics } from "../src/hub/metrics/loops.ts";
import { noSources } from "../src/hub/metrics/source.ts";
import { slots } from "../src/hub/slots/index.ts";
import { start as startSlots } from "../src/hub/slots/loops.ts";
import { trainArea } from "../src/hub/train/index.ts";
import { start as startTrain } from "../src/hub/train/loops.ts";
import { start as startUsage } from "../src/hub/usage/loops.ts";
import { usage } from "../src/hub/usage/wire.ts";
import { HubDb } from "../src/hub/store/db.ts";
import { store } from "../src/hub/store/hub_store.ts";
import { events } from "../src/hub/store/events.ts";
import { isoMs } from "../src/hub/store/time.ts";
import type { StatusItem } from "../src/shared/contracts.ts";

const NOW = 1_792_000_000_000;

function setup() {
  const hub = new Hub({ home: "", listen: { host: "127.0.0.1", port: 0 } }, HubDb.memory(), { now: () => NOW });
  store(hub).projectsUpsertMany("devbox", [
    { machineId: "devbox", projectId: "app", title: "app", workspaceRoot: "/work/app", lastActivityAt: "2026-10-19T10:00:00.000Z" } as never,
  ]);
  const tools = new Registry();
  registerAll(tools);
  return { hub, tools, r: { machineId: "devbox", projectId: "app" } };
}

const reader: Caller = { keyId: "k", name: "k", prefix: "fld_x", grants: [{ role: "read", machines: "*" }], createdAt: isoMs(0) };

test("the state word puts you first, then blocked, then work", () => {
  const f = (needsYou: boolean, blocked: string | undefined, agents: number, inFlight: number, leadWorking = false) => ({
    needsYou,
    ...(blocked === undefined ? {} : { blocked }),
    agents,
    inFlight,
    leadWorking,
  });
  expect(stateOf(f(true, "devbox is offline", 3, 0))).toBe("waiting_on_you");
  expect(stateOf(f(false, "devbox is offline", 3, 0))).toBe("blocked");
  expect(stateOf(f(false, undefined, 2, 0))).toBe("working");
  expect(stateOf(f(false, undefined, 0, 1))).toBe("working");
  expect(stateOf(f(false, undefined, 0, 0))).toBe("idle");
  expect(stateOf(f(false, undefined, 0, 0, true))).toBe("working");
});

test("an agent is grouped by what it does, then its PR, then how it ended; lists stop at the cap", () => {
  expect(agentGroup("waiting", "ci", true)).toBe("waiting_on_you");
  expect(agentGroup("working", "ci_failed", true)).toBe("working");
  expect(agentGroup("done", "reviewing", true)).toBe("in_review");
  expect(agentGroup("idle", "ci", true)).toBe("landing");
  expect(agentGroup("done", "merged", true)).toBe("done");
  expect(agentGroup("done", "ci_failed", true)).toBe("idle");
  expect(agentGroup("done", undefined, true)).toBe("idle");
  expect(agentGroup("done", undefined, false)).toBe("done");
  expect(agentGroup("parked", undefined, true)).toBe("idle");
  const item = (group: StatusItem["group"], at: number): StatusItem => ({ group, title: "x", at: isoMs(at) });
  const [counts, listed] = grouped([...Array.from({ length: 10 }, (_, i) => item("done", i)), item("working", 0)]);
  expect([counts.done, counts.working]).toEqual([10, 1]);
  expect(listed[0]?.group).toBe("working");
  expect(listed.length).toBe(1 + STATUS_ITEMS_PER_GROUP);
  expect(listed[1]?.at).toBe(isoMs(9));
});

test("waiting on you is the lead chat's needs-you, and reading the rows writes no events", async () => {
  const { hub, tools, r } = setup();
  expect(statusRows(hub)[0]?.state).toBe("idle");
  chat(hub).add(r, { author: "lead", text: "1. Public link or image only? I'd pick the link." });
  const head = events(hub).head();
  const out = (await tools.call(hub, reader, "status_get", {})) as { output: { rows: { state: string; items: StatusItem[] }[] } };
  expect(out.output.rows[0]?.state).toBe("waiting_on_you");
  expect(out.output.rows[0]?.items.map((i) => i.title)).toEqual(["The lead's question in chat"]);
  expect(events(hub).head()).toBe(head);
  chat(hub).add(r, { author: "human", text: "1 rec" });
  expect(status(hub).project(reader, r)?.state).toBe("idle");
  const missing = await tools.call(hub, reader, "status_get", { projectRef: { machineId: "devbox", projectId: "nope" } });
  expect(missing).toMatchObject({ error: { kind: "tool", error: { code: "not_found", message: "There is no project devbox/nope." } } });
});

test("an offline machine blocks its rows and marks them stale; agents come from the slots area", () => {
  const { hub, r } = setup();
  store(hub).machineUpsert({ machineId: "devbox", name: "devbox", status: "offline", lastSeenAt: isoMs(NOW - 60_000) } as never);
  Object.assign(statusInputs(hub), { agentsRunning: () => 2 });
  const row = statusRows(hub)[0];
  expect(row?.state).toBe("blocked");
  expect(row?.blockedReason).toBe("devbox is offline");
  expect(row?.stale?.reason).toStartWith("no heartbeat from devbox since ");
  expect(row?.agentsRunning).toBe(2);
  expect(row?.projectRef).toEqual(r);
});

test("the latest merge per project is titled by its writer task, else its order; PRs in flight are counted", () => {
  const db = HubDb.memory();
  const c = db.conn;
  const change = (n: number, task: string | null, state: string) =>
    c
      .query(
        `INSERT INTO changes (n, repo, pr_number, state, machine_id, project_id, train_order, data)
         VALUES (?1, 'acme/web', ?2, ?3, 'devbox', 'p1', ?1, ?4)`,
      )
      .run(n, 10 + n, state, JSON.stringify({ changeId: `X${n}`, taskId: task, workstreamId: "W1", prNumber: 10 + n, prUrl: `https://github.com/acme/web/pull/${10 + n}` }));
  change(1, "T1", "merged");
  change(2, null, "merged");
  change(3, "T3", "ci");
  change(4, "T4", "reviewing");
  c.run(`INSERT INTO tasks (n, machine_id, project_id, workstream_id, state, data) VALUES (1, 'devbox', 'p1', 'W1', 'done', '{"title":"Add the login page"}')`);
  c.run(`INSERT INTO workstreams (n, machine_id, project_id, state, data) VALUES (1, 'devbox', 'p1', 'open', '{"title":"Accounts"}')`);
  const merged = (at: number, n: number) =>
    c
      .query("INSERT INTO events (created_ms, type, machine_id, data) VALUES (?1, 'pr.merged', 'devbox', ?2)")
      .run(at, JSON.stringify({ type: "pr.merged", machineId: "devbox", projectId: "p1", data: { changeId: `X${n}`, prNumber: 10 + n } }));
  merged(1000, 1);
  let [merges, inFlight] = readChanges(c);
  expect(merges.get("devbox/p1")).toEqual({ atMs: 1000, title: "Add the login page", prNumber: 11, prUrl: "https://github.com/acme/web/pull/11" });
  expect(inFlight.get("devbox/p1")).toBe(2);
  merged(2000, 2);
  [merges] = readChanges(c);
  expect([merges.get("devbox/p1")?.title, merges.get("devbox/p1")?.atMs]).toEqual(["Accounts", 2000]);
});

test("a source flips stale at its deadline and fresh on touch", () => {
  const f = new Fresh();
  const s = "github:acme/storefront";
  f.expect(s, 180_000, 0);
  expect(f.view(s, 1000)?.stale?.reason).toBe("not checked since the hub started");
  expect(f.nextDeadline()).toBeUndefined();
  f.touch(s, 10_000);
  expect(f.check(10_000)).toEqual([{ kind: "fresh", source: s, staleMs: 10_000 }]);
  expect(f.nextDeadline()).toBe(190_000);
  expect(f.check(190_000)).toEqual([]);
  f.touch(s, 100_000);
  expect(f.check(190_001)).toEqual([]);
  f.fail(s, "gh: connect: network is unreachable");
  const flips = f.check(280_001);
  expect(flips.length).toBe(1);
  expect(flips[0]).toMatchObject({ kind: "stale", sinceMs: 100_000 });
  expect((flips[0] as { reason: string }).reason).toContain("unreachable");
  expect(f.check(400_000)).toEqual([]);
  f.touch(s, 400_000);
  expect(f.check(400_000)).toEqual([{ kind: "fresh", source: s, staleMs: 300_000 }]);
  expect(f.view(s, 400_000)?.stale).toBeUndefined();
});

test("the status loop turns flips into source events", () => {
  const { hub } = setup();
  const f = new Fresh();
  hub.area("status_fresh", () => f);
  f.expect("train:acme/web", 120_000, NOW);
  f.touch("train:acme/web", NOW);
  status(hub).tick();
  const [ev] = hub.db.all<{ data: string }>("SELECT data FROM events WHERE type = 'source.fresh'").map((x) => JSON.parse(x.data));
  expect(ev).toMatchObject({ summary: "train:acme/web live again", data: { source: "train:acme/web", staleMs: 0 } });
  expect(clock(NOW, NOW, "UTC")).toMatch(/^\d\d:\d\d$/);
  expect(clock(NOW - 2 * 86_400_000, NOW, "UTC")).toMatch(/^[A-Z][a-z]{2} \d\d:\d\d$/);
  expect(clock(NOW - 30 * 86_400_000, NOW, "UTC")).toMatch(/^[A-Z][a-z]{2} \d{1,2} \d\d:\d\d$/);
});

test("a project's PRs show in its groups: in review, landing and done", () => {
  const { hub, r } = setup();
  const put = (n: number, state: string) =>
    hub.db.conn
      .query(
        `INSERT INTO changes (n, repo, pr_number, state, machine_id, project_id, train_order, data)
         VALUES (?1, 'acme/web', ?2, ?3, 'devbox', 'app', ?1, ?4)`,
      )
      .run(
        n,
        10 + n,
        state,
        JSON.stringify({
          changeId: `X${n}`, projectRef: r, repo: "acme/web", prNumber: 10 + n, prUrl: `https://github.com/acme/web/pull/${10 + n}`,
          branch: `b${n}`, workstreamId: "W1", headSha: "a".repeat(40), state, reviews: [],
          createdAt: isoMs(NOW - 1000), updatedAt: isoMs(NOW - 1000),
        }),
      );
  put(1, "reviewing");
  put(2, "ci");
  put(3, "merged");
  const row = statusRows(hub)[0];
  expect(row?.state).toBe("working");
  expect([row?.counts.inReview, row?.counts.landing, row?.counts.done]).toEqual([1, 1, 1]);
  expect(row?.items.map((i) => [i.group, i.title, i.pr?.number])).toEqual([
    ["in_review", "b1", 11],
    ["landing", "b2", 12],
    ["done", "b3", 13],
  ]);
});

test("the status area hands factory_status its rows through the inbox bridge's hooks", async () => {
  const { hub } = setup();
  const { start } = await import("../src/hub/status/loops.ts");
  const { found } = await import("../src/hub/project_lead/bridge.ts");
  start(hub);
  expect(found.statusRows?.(hub, NOW).map((r) => r.title)).toEqual(["app"]);
  hub.shutdown.abort();
});

test("the areas the hub starts give a row its running agents, a red main, a usage pause and the week's merges", async () => {
  const { hub, r } = setup();
  const other = { machineId: "lab-b", projectId: "docs" };
  store(hub).projectsUpsertMany("lab-b", [{ ...other, title: "docs", workspaceRoot: "/work/docs", lastActivityAt: "2026-10-19T10:00:00.000Z" } as never]);
  for (const m of ["devbox", "lab-b"]) store(hub).machineUpsert({ machineId: m, name: m, status: "online", lastSeenAt: isoMs(NOW) } as never);
  startSlots(hub);
  startUsage(hub);
  startMetrics(hub, noSources());
  startTrain(hub);
  // Usage's replay of the log so far is done: what follows reaches it live.
  await usage(hub).drain();
  const row = (p: typeof r) => statusRows(hub).find((x) => x.projectRef.projectId === p.projectId)!;
  const quiet = (p: typeof r) => {
    const x = row(p);
    return [x.agentsRunning, x.warning, x.usagePausedOn, x.merged7d];
  };
  expect(quiet(r)).toEqual([0, undefined, undefined, undefined]);

  // A task holds a slot in the project.
  slots(hub).acquire({ holder: "T1", projectRef: r, priority: "work" });
  // The project's train repo, its main red, and a PR merged there outside the train yesterday.
  hub.db.conn.run("INSERT INTO trains (repo, machine_id, project_id, watch_since_ms) VALUES ('acme/app', 'devbox', 'app', 0)");
  trainArea(hub).train.sync.record("acme/app", "a".repeat(40), "red", ["fleetd"], NOW);
  events(hub).append({ at: isoMs(NOW - 86_400_000), type: "pr.merged_outside", machineId: "devbox", summary: "merged", data: { repo: "acme/app", prNumber: 9 } });
  // Two limits on devbox's login trip its breaker.
  for (const [i, thread] of ["w1", "w2"].entries()) {
    events(hub).append({
      at: isoMs(NOW - 2000 + i * 1000),
      type: "thread.usage_limited",
      machineId: "devbox",
      threadId: thread,
      summary: "hit the usage limit",
      data: { usageClass: "usage_limit", resumeAt: isoMs(NOW + 3_600_000) },
    });
  }
  await usage(hub).drain();

  const app = row(r);
  expect(app.agentsRunning).toBe(1);
  expect(app.warning).toBe("`fleetd` is red on main, no fix under way");
  expect(app.usagePausedOn).toBe("devbox");
  expect(app.usagePausedReason).toContain("usage limit on devbox's login");
  expect(app.merged7d).toBe(1);
  expect(quiet(other)).toEqual([0, undefined, undefined, undefined]);
  hub.shutdown.abort();
  await Bun.sleep(10);
});
