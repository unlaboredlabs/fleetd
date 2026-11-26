// Settings › Workspace › Usage (`workspace_usage`): on a workspace seeded with history (usage-seed.ts), each figure
// matches what the tables hold, counted here the plain way from their rows; only owners and admins may read it; and a
// period reads fast on a year of a busy workspace's history.
import { expect, test } from "bun:test";
import type { WorkspaceUsageOutput } from "../src/shared/contracts.ts";
import { fold } from "../src/hub/workspace_usage/fold.ts";
import { refusal, testHub } from "./people-kit.ts";
import { MACHINE, PEOPLE, seed } from "./usage-seed.ts";

const DAY = 86_400_000;

type Row = Record<string, unknown>;
const json = (s: unknown) => JSON.parse(String(s)) as Row;
const ms = (iso: unknown) => Date.parse(String(iso));
const zero = () => ({ messages: 0, orders: 0, agents: 0, agentMs: 0, merged: 0, approvals: 0, failed: 0 });

function seeded(opts: { days?: number; seed?: number; scale?: number } = {}) {
  const kit = testHub();
  const now = kit.clock.now();
  kit.hub.db.transaction((c) => seed(c, now, { days: opts.days ?? 120, seed: opts.seed ?? 3, queued: 2, waiting: 1, ...(opts.scale === undefined ? {} : { scale: opts.scale }) }));
  const owner = kit.device([{ role: "admin", machines: "*" }], "p_maya", "laptop");
  return { ...kit, now, owner };
}

/** What the tables say, read row by row: the figures the page must show. */
function expected(kit: ReturnType<typeof seeded>, since: number, until: number) {
  const db = kit.hub.db;
  const starter = new Map<string, string | undefined>();
  for (const r of db.all<{ data: string }>("SELECT data FROM workstreams")) {
    const w = json(r.data);
    starter.set(String(w.workstreamId), (w.startedBy as { personId?: string } | undefined)?.personId);
  }
  const by = new Map<string, ReturnType<typeof zero>>();
  const total = zero();
  const of = (who: string | undefined) => {
    if (who === undefined) return undefined;
    let c = by.get(who);
    if (!c) by.set(who, (c = zero()));
    return c;
  };
  const inside = (t: number) => t >= since && t < until;
  for (const r of db.all<{ data: string; created_ms: number }>("SELECT data, created_ms FROM chat_messages")) {
    const m = json(r.data);
    if (m.author !== "human" || m.history !== undefined || !inside(r.created_ms)) continue;
    total.messages++;
    const c = of((m.person as { personId: string } | undefined)?.personId);
    if (c) c.messages++;
  }
  for (const r of db.all<{ data: string; state: string }>("SELECT data, state FROM workstreams")) {
    const w = json(r.data);
    const who = starter.get(String(w.workstreamId));
    if (inside(ms(w.createdAt))) {
      total.orders++;
      const c = of(who);
      if (c) c.orders++;
    }
    if (r.state === "stopped" && inside(ms(w.updatedAt))) {
      total.failed++;
      const c = of(who);
      if (c) c.failed++;
    }
  }
  for (const r of db.all<{ data: string; state: string; workstream_id: string }>("SELECT data, state, workstream_id FROM tasks")) {
    const t = json(r.data);
    const c = of(starter.get(r.workstream_id));
    if (inside(ms(t.createdAt))) {
      total.agents++;
      if (c) c.agents++;
    }
    if (r.state === "failed" && inside(ms(t.endedAt))) {
      total.failed++;
      if (c) c.failed++;
    }
  }
  for (const r of db.all<{ data: string }>("SELECT data FROM requests")) {
    const q = json(r.data);
    if (q.state === "open" || q.answeredAt === undefined || !String(q.answeredBy).startsWith("human:") || !inside(ms(q.answeredAt))) continue;
    total.approvals++;
    const c = of((q.answeredByPerson as { personId: string } | undefined)?.personId);
    if (c) c.approvals++;
  }
  for (const r of db.all<{ merged_ms: number; workstream_id: string; route: string }>("SELECT merged_ms, workstream_id, route FROM metric_merges")) {
    if (!inside(r.merged_ms) || (r.route !== "train" && r.route !== "fleetd_by_hand")) continue;
    total.merged++;
    const c = of(starter.get(r.workstream_id));
    if (c) c.merged++;
  }
  // Agent time by UTC day, each on the calendar day its midday falls on: thinking, tools and starting up, not the waits.
  const end = until === kit.now ? since + 30 * DAY : until;
  for (const r of db.all<{ day: number; scope: string; scope_id: string; cat: number; kind: number; ms: number }>("SELECT * FROM time_rollups")) {
    const midday = r.day * DAY + DAY / 2;
    if (midday < since || midday >= end || r.cat > 2 || [1, 20, 21, 25].includes(r.kind)) continue;
    if (r.scope === "fleet") total.agentMs += r.ms;
    if (r.scope === "order") {
      const c = of(starter.get(r.scope_id));
      if (c) c.agentMs += r.ms;
    }
  }
  return { total, by };
}

const call = (kit: ReturnType<typeof seeded>, days: 7 | 30 | 90, tz = "UTC") => kit.call<WorkspaceUsageOutput>(kit.owner, "workspace_usage", { days, tz });

test("each figure matches what the workspace's tables hold, per person, per bot, per day and in total", async () => {
  const kit = seeded();
  const out = await call(kit, 30);
  const today = new Date(kit.now);
  const since = Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate()) - 29 * DAY;
  expect(out.since).toBe(new Date(since).toISOString());
  const want = expected(kit, since, kit.now);
  const { askToMergeMs: _ask, ...total } = out.total;
  expect(total).toEqual(want.total);
  expect(want.total.messages).toBeGreaterThan(100);
  expect(want.total.failed).toBeGreaterThan(0);
  expect(want.total.approvals).toBeGreaterThan(0);
  // Some requests were closed by the workspace with no person's answer: they are in the tables and not in the figures.
  expect(kit.hub.db.all<{ n: number }>("SELECT COUNT(*) AS n FROM requests WHERE json_extract(data, '$.answeredBy') = 'hub'")[0]!.n).toBeGreaterThan(0);
  for (const m of out.members) {
    const { askToMergeMs: _a, ...got } = m.counts;
    expect({ who: m.person.name, ...got }).toEqual({ who: m.person.name, ...(want.by.get(m.person.personId) ?? zero()) });
  }
  // Everyone on the workspace is listed, and a removed person while they did something in the period.
  const listed = new Set(out.members.map((m) => m.person.personId));
  for (const p of PEOPLE.filter((p) => p.removedDaysAgo === undefined)) expect(listed.has(p.id)).toBe(true);
  expect(out.members.find((m) => m.person.personId === "p_dan")?.removed).toBe(true);
  // What no person started is the rest of the total.
  for (const f of ["orders", "agents", "agentMs", "merged", "failed"] as const) {
    expect(out.unattributed[f]).toBe(out.total[f] - out.members.reduce((s, m) => s + m.counts[f], 0));
  }
  expect(out.unattributed.orders).toBeGreaterThan(0);
  expect(out.unattributed.messages).toBe(0);
  // The bots add up to the total; so do the days, one per calendar day.
  for (const f of ["messages", "orders", "agents", "merged", "approvals", "failed"] as const) {
    expect(out.bots.reduce((s, b) => s + b.counts[f], 0)).toBe(out.total[f]);
  }
  expect(out.days.length).toBe(30);
  expect(out.days.at(-1)?.date).toBe(today.toISOString().slice(0, 10));
  for (const f of ["orders", "merged", "failed", "agentMs"] as const) expect(out.days.reduce((s, d) => s + d[f], 0)).toBe(out.total[f]);
  // The period before is counted the same way.
  const prev = expected(kit, since - 30 * DAY, since);
  const { askToMergeMs: _p, ...previous } = out.previous;
  expect(previous).toEqual(prev.total);
  expect(out.now).toEqual({
    queued: 2,
    running: kit.hub.db.all<{ n: number }>("SELECT COUNT(*) AS n FROM tasks WHERE state = 'running'")[0]!.n,
    waiting: kit.hub.db.all<{ n: number }>("SELECT COUNT(*) AS n FROM requests WHERE state = 'open'")[0]!.n,
  });
  // Self-hosted: no spend and no computer time.
  expect(out.currency).toBeUndefined();
  expect(out.total.spendCents).toBeUndefined();
  expect(out.total.computerMs).toBeUndefined();
});

test("a day is a calendar day in the viewer's zone", async () => {
  const kit = seeded({ days: 40 });
  const tz = "Asia/Kolkata";
  const out = await call(kit, 7, tz);
  const day = (t: number) => new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(t);
  const orders = new Map<string, number>();
  for (const r of kit.hub.db.all<{ data: string }>("SELECT data FROM workstreams")) {
    const at = ms(json(r.data).createdAt);
    if (at >= Date.parse(out.since)) orders.set(day(at), (orders.get(day(at)) ?? 0) + 1);
  }
  expect(day(Date.parse(out.since))).toBe(out.days[0]!.date);
  // Agent time is kept by UTC day: each counts once, on the calendar day its midday falls on, in the total as in the days.
  expect(out.days.reduce((s, d) => s + d.agentMs, 0)).toBe(out.total.agentMs);
  for (const zone of ["UTC", "Europe/Amsterdam", "America/Los_Angeles"]) {
    const o = await call(kit, 7, zone);
    expect(o.days.reduce((s, d) => s + d.agentMs, 0)).toBe(o.total.agentMs);
  }
  expect(Object.fromEntries(out.days.map((d) => [d.date, d.orders]))).toEqual(Object.fromEntries(out.days.map((d) => [d.date, orders.get(d.date) ?? 0])));
});

test("the median from ask to merge is the middle of the period's merges that know their ask", async () => {
  const kit = seeded({ days: 20 });
  const out = await call(kit, 7);
  const waits = kit.hub.db
    .all<{ w: number }>(
      "SELECT merged_ms - requested_ms AS w FROM metric_merges WHERE merged_ms >= ?1 AND merged_ms < ?2 AND route IN ('train', 'fleetd_by_hand') ORDER BY w",
      [Date.parse(out.since), kit.now],
    )
    .map((r) => r.w);
  const mid = Math.floor(waits.length / 2);
  expect(waits.length).toBeGreaterThan(10);
  expect(out.total.askToMergeMs).toBe(Math.round(waits.length % 2 === 1 ? waits[mid]! : (waits[mid - 1]! + waits[mid]!) / 2));
});

test("what is new counts at the next read, and an approval waiting since long ago counts once it is answered", async () => {
  const kit = seeded({ days: 10 });
  const first = await call(kit, 7);
  const key = `${MACHINE}/prj-payments`;
  const c = kit.hub.db.conn;
  c.query("INSERT INTO requests (project_key, kind, state, created_ms, data) VALUES (?1, 'approval', 'open', ?2, ?3)").run(
    key,
    kit.now - DAY,
    JSON.stringify({ requestId: "Qnew", kind: "approval", state: "open" }),
  );
  c.query("INSERT INTO chat_messages (machine_id, project_id, seq, created_ms, data) VALUES (?1, 'prj-payments', 100000, ?2, ?3)").run(
    MACHINE,
    kit.now - 1000,
    JSON.stringify({ author: "human", person: { personId: "p_tom", name: "Tom Okafor" } }),
  );
  // An order's own words copied into the chat from before it are no one's message.
  c.query("INSERT INTO chat_messages (machine_id, project_id, seq, created_ms, data) VALUES (?1, 'prj-payments', 100001, ?2, ?3)").run(
    MACHINE,
    kit.now - 1000,
    JSON.stringify({ author: "human", history: "order" }),
  );
  const second = await call(kit, 7);
  expect(second.total.messages).toBe(first.total.messages + 1);
  expect(second.now.waiting).toBe(first.now.waiting + 1);
  // More requests come and are answered after it, then it is answered too.
  const answered = (who: string) =>
    JSON.stringify({ state: "denied", answeredAt: new Date(kit.now - 500).toISOString(), answeredBy: "human:laptop", answeredByPerson: { personId: who, name: who } });
  for (let i = 0; i < 3; i++) c.query("INSERT INTO requests (project_key, kind, state, created_ms, data) VALUES (?1, 'approval', 'denied', ?2, ?3)").run(key, kit.now, answered("p_tom"));
  expect((await call(kit, 7)).total.approvals).toBe(first.total.approvals + 3);
  // Closed by the workspace (its run ended), approved by a no-ask rule, withdrawn by a lead: no person answered them.
  for (const by of ["hub", "fleetd:no-ask", `lead:${MACHINE}/prj-payments`]) {
    c.query("INSERT INTO requests (project_key, kind, state, created_ms, data) VALUES (?1, 'approval', 'denied', ?2, ?3)").run(
      key,
      kit.now,
      JSON.stringify({ state: "denied", answeredAt: new Date(kit.now - 400).toISOString(), answeredBy: by }),
    );
  }
  expect((await call(kit, 7)).total.approvals).toBe(first.total.approvals + 3);
  c.query("UPDATE requests SET state = 'ran', data = ?1 WHERE json_extract(data, '$.requestId') = 'Qnew'").run(answered("p_maya"));
  const last = await call(kit, 7);
  expect(last.total.approvals).toBe(first.total.approvals + 4);
  expect(last.now.waiting).toBe(first.now.waiting);
});

test("only the workspace's owners and admins may read it", async () => {
  const kit = seeded({ days: 5 });
  const admin = kit.device([{ role: "admin", machines: "*" }], "p_tom", "tom");
  expect((await kit.call<WorkspaceUsageOutput>(admin, "workspace_usage", { days: 7, tz: "UTC" })).members.length).toBeGreaterThan(0);
  // A member's device, even one holding admin grants, and an agent's key are refused.
  const member = kit.device([{ role: "admin", machines: "*" }], "p_priya", "priya");
  expect((await refusal(kit.call(member, "workspace_usage", { days: 7, tz: "UTC" }))).code).toBe("forbidden");
  expect((await refusal(kit.call(kit.agent(), "workspace_usage", { days: 7, tz: "UTC" }))).code).toBe("forbidden");
  // An admin made a member loses it at once.
  kit.hub.db.conn.run("UPDATE people SET role = 'member' WHERE person_id = 'p_tom'");
  expect((await refusal(kit.call(admin, "workspace_usage", { days: 7, tz: "UTC" }))).code).toBe("forbidden");
});

test("a year of a busy workspace's history folds once, and each period then reads fast", async () => {
  // Four times the seeded team's work over a year: about 10,000 orders, 38,000 agents and 25,000 messages.
  const kit = seeded({ days: 365, seed: 11, scale: 4 });
  const orders = kit.hub.db.all<{ n: number }>("SELECT COUNT(*) AS n FROM workstreams")[0]!.n;
  expect(orders).toBeGreaterThan(8_000);
  let t = performance.now();
  while (kit.hub.db.transaction((c) => fold(c))) {}
  const folded = performance.now() - t;
  for (const days of [7, 30, 90] as const) {
    t = performance.now();
    const out = await call(kit, days, "America/New_York");
    const took = performance.now() - t;
    expect(out.days.length).toBe(days);
    expect(took).toBeLessThan(300);
  }
  expect(folded).toBeLessThan(10_000);
});
