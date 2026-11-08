// Automations (src/hub/automations), after crates/fleetd/src/hub/automations/tests.rs: schedules on a fake clock, runs
// one at a time, kept webhook calls, the webhook route, the lead's calls and approvals' confirm hooks. The orders'
// intake is the leads area's (T2255); these tests give the hub one over the leads' own records.
import { afterEach, expect, test } from "bun:test";
import type { Hub } from "../src/hub/api/hub.ts";
import type { Registry } from "../src/hub/api/registry.ts";
import { approvals } from "../src/hub/approvals/index.ts";
import { answer } from "../src/hub/automations/calls.ts";
import { automations, type IntakeInput, type IntakePort, type NewAutomation, orderText, QUEUED_MAX } from "../src/hub/automations/index.ts";
import { start } from "../src/hub/automations/loops.ts";
import { register } from "../src/hub/automations/tools.ts";
import { hook } from "../src/hub/automations/webhook.ts";
import type { RouteContext } from "../src/hub/http/route.ts";
import type { LeadCall, LeadCaller } from "../src/hub/leads/seams.ts";
import { LeadRecords } from "../src/hub/leads/records.ts";
import { put as putNavi } from "../src/hub/navi/store.ts";
import { workstreamGet, workstreamsList } from "../src/hub/orders/workstreams.ts";
import { events } from "../src/hub/store/events.ts";
import { store } from "../src/hub/store/hub_store.ts";
import { isoMs } from "../src/hub/store/time.ts";
import type { AutomationRun, AutomationSchedule, HubEventType, ProjectRef } from "../src/shared/contracts.ts";
import { ToolError } from "../src/shared/errors.ts";
import { caller, PROJECT, testHub } from "./hub-helpers.ts";

const MIN = 60_000;
const START = Date.parse("2026-10-17T10:00:00Z");

let cleanup: (() => void) | undefined;
afterEach(() => {
  cleanup?.();
  cleanup = undefined;
});

/** A hub at 10:00 UTC on 17 Oct 2026 with an intake over the leads' records, as T2255's opens orders. */
function setup(at = START) {
  const t = testHub(at);
  cleanup = t.done;
  const records = new LeadRecords(t.hub.db);
  const opened: IntakeInput[] = [];
  t.hub.area<IntakePort>("intake", () => ({
    intake(input) {
      opened.push(input);
      const { workstream } = records.workstreamCreate({
        projectRef: input.projectRef,
        title: input.text.split("\n")[0] ?? "",
        text: input.text,
        channel: input.channel,
        by: input.by,
        at: isoMs(t.clock.now()),
        clientRequestId: input.clientRequestId,
      });
      return { workstreamId: workstream.workstreamId };
    },
    async close(_r, id) {
      close(t.hub, id);
    },
  }));
  const advance = async (ms: number) => {
    t.clock.ms += ms;
    automations(t.hub).signal();
    await settle(t.hub);
  };
  return { ...t, records, opened, advance };
}

/** Closes order `id` as done, as the leads area does: its row and its `workstream.done`. */
function close(hub: Hub, id: string): void {
  const records = new LeadRecords(hub.db);
  const w = records.workstreamGet(id);
  if (!w) throw new Error(`no ${id}`);
  const at = isoMs(hub.clock.now());
  records.workstreamPut({ ...w, state: "done", updatedAt: at });
  events(hub).append({ at, type: "workstream.done", machineId: w.projectRef.machineId, projectId: w.projectRef.projectId, summary: `${id} done`, data: { workstreamId: id } });
}

async function settle(hub: Hub): Promise<void> {
  for (let i = 0; i < 5; i++) {
    await Bun.sleep(2);
    await automations(hub).settled();
  }
}

const schedule = (cron: string, tz: string): AutomationSchedule => ({ cron, tz });

const fresh = (r: ProjectRef, s: AutomationSchedule | undefined, webhook: boolean): NewAutomation => ({
  projectRef: r,
  name: "Nightly dependency check",
  prompt: "Check the dependencies for updates and open a PR for safe ones.",
  ...(s === undefined ? {} : { schedule: s }),
  webhook,
  by: "human",
  confirmed: true,
});

const eventsOf = (hub: Hub, type: HubEventType) => events(hub).page(0, [type]).events;

const lead: LeadCaller = { projectRef: PROJECT, by: `lead:${PROJECT.machineId}/${PROJECT.projectId}`, agent: { kind: "lead" } };
const call = (hub: Hub, op: string, args: Record<string, unknown>) => answer(hub, lead, { op, ...args } as LeadCall);

test("a schedule fires at its cron time and opens the automation's order", async () => {
  const { hub, advance } = setup();
  const autos = automations(hub);
  // 12:30 in Berlin is 10:30 UTC in October (CEST).
  const [a, secret] = autos.create(fresh(PROJECT, schedule("30 12 * * *", "Europe/Berlin"), false));
  expect(secret).toBeUndefined();
  expect(a.nextRunAt).toBe("2026-10-17T10:30:00.000Z");
  autos.start();
  await settle(hub);

  await advance(29 * MIN);
  expect(autos.runs(a.automationId, 10)).toEqual([]);
  await advance(MIN);
  const runs = autos.runs(a.automationId, 10);
  expect(runs.length).toBe(1);
  const run = runs[0]!;
  expect([run.trigger, run.state]).toEqual(["schedule", "running"]);
  expect(run.scheduledAt).toBe("2026-10-17T10:30:00.000Z");
  expect(run.lateMin).toBeUndefined();
  const order = workstreamGet(hub.db.conn, run.workstreamId!)!;
  expect(order.source.channel).toBe("automation");
  expect(order.source.by).toBe(`automation:${a.automationId}`);
  expect(order.title).toBe("Nightly dependency check");
  expect(order.source.text).toContain("started by its schedule (30 12 * * *), due 2026-10-17 12:30 Europe/Berlin");

  const after = autos.get(a.automationId)!;
  expect(after.nextRunAt).toBe("2026-10-18T10:30:00.000Z");
  expect(after.lastRun?.runId).toBe(run.runId);
  const ran = eventsOf(hub, "automation.run");
  expect(ran.length).toBe(1);
  expect(ran[0]!.summary).toContain("on schedule");
});

test("runs missed while the hub was down run once, late", async () => {
  const { hub, clock } = setup();
  const [a] = automations(hub).create(fresh(PROJECT, schedule("0 * * * *", "UTC"), false));
  // Down from 10:00 to 13:20: the 11:00, 12:00 and 13:00 runs were missed.
  clock.ms += 200 * MIN;
  automations(hub).start();
  await settle(hub);
  const runs = automations(hub).runs(a.automationId, 10);
  expect(runs.length).toBe(1);
  expect(runs[0]!.scheduledAt).toBe("2026-10-17T11:00:00.000Z");
  expect(runs[0]!.lateMin).toBe(140);
  expect(workstreamGet(hub.db.conn, runs[0]!.workstreamId!)!.source.text).toContain("140 min late, once");
  expect(automations(hub).get(a.automationId)!.nextRunAt).toBe("2026-10-17T14:00:00.000Z");
});

test("a trigger while a run is open is skipped and recorded", async () => {
  const { hub } = setup();
  const autos = automations(hub);
  const [a] = autos.create(fresh(PROJECT, undefined, false));
  const id = a.automationId;
  const first = await autos.run(id, { kind: "manual", by: "human" });
  expect(first.state).toBe("running");
  const w = first.workstreamId!;
  const second = await autos.run(id, { kind: "schedule", dueMs: 1_792_231_200_000 });
  expect(second.state).toBe("skipped");
  expect(second.workstreamId).toBeUndefined();
  expect(second.why).toContain(w);
  expect((await autos.run(id, { kind: "schedule", dueMs: 1_792_231_200_000 })).state).toBe("skipped");
  expect((await autos.run(id, { kind: "manual", by: "human" })).state).toBe("skipped");
  expect(workstreamsList(hub.db.conn, { limit: 100 }).length).toBe(1);

  close(hub, w);
  const third = await autos.run(id, { kind: "manual", by: "human" });
  expect(third.state).toBe("running");
  const runs = autos.runs(id, 10);
  expect(runs.map((r) => r.state)).toEqual(["running", "skipped", "skipped", "skipped", "done"]);
  expect(runs[4]!.endedAt).toBeDefined();
});

test("a paused automation runs only on Run now and resumes from now", async () => {
  const { hub, advance } = setup();
  const autos = automations(hub);
  const [a] = autos.create(fresh(PROJECT, schedule("0 * * * *", "UTC"), false));
  const id = a.automationId;
  autos.start();
  const paused = autos.pause(id, true, "human");
  expect(paused.paused).toBe(true);
  expect(paused.nextRunAt).toBeUndefined();
  await advance(150 * MIN);
  expect(autos.runs(id, 10)).toEqual([]);
  const hooked = await autos.run(id, { kind: "webhook", payload: "x" });
  expect(hooked.state).toBe("skipped");
  expect(hooked.why).toBe("the automation is paused");
  expect((await autos.run(id, { kind: "manual", by: "human" })).state).toBe("running");
  // 12:30 now: the next run is 13:00, and the missed 11:00 and 12:00 don't run.
  expect(autos.pause(id, false, "human").nextRunAt).toBe("2026-10-17T13:00:00.000Z");
  expect(eventsOf(hub, "automation.changed").map((e) => (e.data as { change: string }).change)).toEqual(["created", "paused", "resumed"]);
});

test("schedules that never run or don't parse are refused", () => {
  const { hub } = setup();
  const refusal = (s: AutomationSchedule) => {
    try {
      automations(hub).create(fresh(PROJECT, s, false));
    } catch (e) {
      return e as ToolError;
    }
    throw new Error("not refused");
  };
  expect(refusal(schedule("0 9 * *", "UTC")).message).toContain("doesn't parse");
  expect(refusal(schedule("0 9 31 2 *", "UTC")).message).toContain("never runs");
  expect(refusal(schedule("0 9 * * *", "Mars/Olympus")).message).toContain("is not an IANA time zone");
  expect(refusal({ cron: "0 9 * * *", at: "2026-11-03T18:00", tz: "UTC" }).message).toBe("A schedule has a cron or an at, one of the two.");
  expect(refusal({ at: "2026-10-17T09:00", tz: "UTC" }).message).toBe("2026-10-17T09:00 in UTC has passed: it is 2026-10-17 10:00 UTC there now.");
  expect(refusal({ at: "2026-10-17T09:00", tz: "UTC" }).code).toBe("invalid");
});

test("a long webhook body is cut to fit the order and points at the whole one", () => {
  const { hub } = setup();
  const [a] = automations(hub).create(fresh(PROJECT, undefined, true));
  const run = { runId: "ar_abcdefgh", automationId: a.automationId, trigger: "webhook", at: isoMs(START), state: "running" } as const;
  const body = "x".repeat(10_000);
  const text = orderText(a, run, body);
  expect([...text].length).toBe(4000);
  expect(text).toContain("The webhook's body (10000 bytes):\n```\n");
  expect(text.endsWith("```\nCut here; automation_runs with runId ar_abcdefgh has the whole body.")).toBe(true);
  const fenced = orderText(a, run, "a ```` b");
  expect(fenced).toContain("`````\na ```` b\n`````");
});

test("a webhook post with its secret runs with the body; a wrong secret gets the same 404", async () => {
  const { hub } = setup();
  const [a, secret] = automations(hub).create(fresh(PROJECT, undefined, true));
  expect(secret).toMatch(/^[A-Za-z0-9_-]{43}$/);
  const ctx = (id: string, s: string) => ({ hub, params: { automation_id: id, secret: s } }) as unknown as RouteContext;
  const post = (body: string) => new Request("http://hub/hooks", { method: "POST", body });
  const ok = (await hook(post('{"mail":"m-1"}'), ctx(a.automationId, secret!)))!;
  expect(ok.status).toBe(202);
  const answer = (await ok.json()) as { ok: boolean; runId: string; state: string; workstreamId: string };
  expect(answer.ok).toBe(true);
  expect(answer.state).toBe("running");
  const order = workstreamGet(hub.db.conn, answer.workstreamId)!;
  expect(order.source.text).toContain('The webhook\'s body (14 bytes):\n```\n{"mail":"m-1"}\n```');
  const [run, payload] = automations(hub).runWithPayload(a.automationId, answer.runId)!;
  expect(run.payloadBytes).toBe(14);
  expect(payload).toBe('{"mail":"m-1"}');

  const wrong = (await hook(post("x"), ctx(a.automationId, `${secret}x`)))!;
  const unknown = (await hook(post("x"), ctx("au_nothere1", secret!)))!;
  expect([wrong.status, unknown.status]).toEqual([404, 404]);
  expect(await wrong.json()).toEqual(await unknown.json());
  const big = (await hook(post("y".repeat(16 * 1024 + 1)), ctx(a.automationId, secret!)))!;
  expect(big.status).toBe(413);
  // The secret is kept as its hash only.
  const row = hub.db.all<{ h: string; data: string }>("SELECT webhook_hash AS h, data FROM automations")[0]!;
  expect(row.h).toBe(new Bun.CryptoHasher("sha256").update(secret!).digest("hex"));
  expect(row.data).not.toContain(secret!);

  // Rotated, the old URL stops working at once.
  const [, next] = automations(hub).rotate(a.automationId, "human");
  expect((await hook(post("z"), ctx(a.automationId, secret!)))!.status).toBe(404);
  expect((await hook(post("z"), ctx(a.automationId, next)))!.status).toBe(202);
});

test("webhook calls while a run is open go in one follow-up order once it ends", async () => {
  const { hub, advance } = setup();
  const autos = automations(hub);
  autos.start();
  await settle(hub);
  const [a] = autos.create(fresh(PROJECT, undefined, true));
  const id = a.automationId;
  const first = await autos.run(id, { kind: "webhook", payload: '{"mail":"m-1"}' });
  const w1 = first.workstreamId!;
  await advance(MIN);
  const second = await autos.run(id, { kind: "webhook", payload: '{"mail":"m-2"}' });
  await advance(MIN);
  const third = await autos.run(id, { kind: "webhook", payload: "```m-3```" });
  for (const kept of [second, third]) {
    expect(kept.state).toBe("queued");
    expect(kept.workstreamId).toBeUndefined();
    expect(kept.endedAt).toBeUndefined();
    expect(kept.why).toContain(w1);
  }
  expect((await autos.run(id, { kind: "schedule", dueMs: 1_792_231_200_000 })).state).toBe("skipped");
  await settle(hub);
  expect(workstreamsList(hub.db.conn, { limit: 100 }).length).toBe(1);

  close(hub, w1);
  await settle(hub);
  const runs = autos.runs(id, 10);
  expect(runs.map((r) => r.state)).toEqual(["skipped", "running", "running", "done"]);
  const w2 = runs[1]!.workstreamId!;
  expect(runs[2]!.workstreamId).toBe(w2);
  expect(w2).not.toBe(w1);
  const text = workstreamGet(hub.db.conn, w2)!.source.text;
  for (const needle of ["2 calls to its webhook", '{"mail":"m-2"}', "```m-3```", second.runId, third.runId, "Check the dependencies for updates"]) {
    expect(text).toContain(needle);
  }
  expect(text.indexOf("m-2")).toBeLessThan(text.indexOf("m-3"));
  // With the follow-up's order open, the next call waits for it.
  expect((await autos.run(id, { kind: "webhook", payload: "m-4" })).state).toBe("queued");
});

test("kept webhook calls are bounded, and every one is named in the follow-up", async () => {
  const { hub } = setup();
  const autos = automations(hub);
  autos.start();
  const [a] = autos.create(fresh(PROJECT, undefined, true));
  const id = a.automationId;
  const first = await autos.run(id, { kind: "webhook", payload: "first" });
  const kept: AutomationRun[] = [];
  for (let i = 0; i < QUEUED_MAX; i++) kept.push(await autos.run(id, { kind: "webhook", payload: `mail-${String(i).padStart(2, "0")} ${"x".repeat(400)}` }));
  expect(kept.every((r) => r.state === "queued")).toBe(true);
  const over = await autos.run(id, { kind: "webhook", payload: "one too many" });
  expect(over.state).toBe("skipped");
  expect(over.why).toContain(`${QUEUED_MAX} webhook calls already wait for it`);
  close(hub, first.workstreamId!);
  await settle(hub);
  const follow = autos.runs(id, 100).find((r) => r.runId === kept[0]!.runId)!;
  const text = workstreamGet(hub.db.conn, follow.workstreamId!)!.source.text;
  expect([...text].length).toBeLessThanOrEqual(4000);
  for (const r of kept) expect(text).toContain(r.runId);
  expect(text).toContain("mail-00");
  expect(text).toContain("No room for bodies");
});

test("a one-time schedule runs once at its time in the person's zone and is done", async () => {
  const { hub, advance } = setup();
  hub.db.conn.query("UPDATE people SET tz = 'America/New_York'").run();
  const owner = hub.db.all<{ n: number }>("SELECT COUNT(*) AS n FROM people")[0]!.n;
  if (owner === 0) {
    hub.db.conn
      .query("INSERT INTO people (person_id, name, role, created_ms, tz) VALUES ('pe_owner1', 'Ada', 'owner', 0, 'America/New_York')")
      .run();
  }
  const made = await call(hub, "automation_create", { name: "Call mom", prompt: "Remind them to call mom.", schedule: { at: "2026-10-17T18:00" } });
  const a = made.automation as { automationId: string; schedule: AutomationSchedule; nextRunAt: string; doneAt?: string };
  expect(a.schedule).toEqual({ at: "2026-10-17T18:00", tz: "America/New_York" });
  // 18:00 in New York is 22:00 UTC in October (EDT).
  expect(a.nextRunAt).toBe("2026-10-17T22:00:00.000Z");
  expect(made.next).toContain("It runs once, at 2026-10-17T18:00 America/New_York");
  automations(hub).start();
  await settle(hub);
  await advance(12 * 60 * MIN - MIN);
  expect(automations(hub).runs(a.automationId, 10)).toEqual([]);
  await advance(MIN);
  const runs = automations(hub).runs(a.automationId, 10);
  expect(runs.length).toBe(1);
  const text = workstreamGet(hub.db.conn, runs[0]!.workstreamId!)!.source.text;
  expect(text).toContain("its one-time schedule, due 2026-10-17 18:00 America/New_York; it runs only this once");
  const done = automations(hub).get(a.automationId)!;
  expect(done.nextRunAt).toBeUndefined();
  expect(done.doneAt).toBe("2026-10-17T22:00:00.000Z");
  await advance(24 * 60 * MIN);
  expect(automations(hub).runs(a.automationId, 10).length).toBe(1);
  const [renamed] = automations(hub).update(a.automationId, { name: "Called mom" }, "human");
  expect(renamed.doneAt).toBeDefined();
  expect(renamed.nextRunAt).toBeUndefined();
});

test("a one-time schedule is kept on its zone's clock", () => {
  const { hub } = setup();
  const [a] = automations(hub).create(fresh(PROJECT, { at: "2026-11-03T17:00:00Z", tz: "Europe/Berlin" }, false));
  expect(a.schedule).toEqual({ at: "2026-11-03T18:00", tz: "Europe/Berlin" });
  const [b] = automations(hub).create(fresh(PROJECT, { at: "2026-11-03T18:00:30", tz: "Europe/Berlin" }, false));
  expect(b.schedule?.at).toBe("2026-11-03T18:00:30");
});

test("a one-time run due while another run is open waits and runs once that ends", async () => {
  const { hub, advance } = setup();
  const autos = automations(hub);
  autos.start();
  const [a] = autos.create(fresh(PROJECT, { at: "2026-10-17T10:30", tz: "UTC" }, false));
  const first = await autos.run(a.automationId, { kind: "manual", by: "human" });
  await advance(30 * MIN);
  const runs = autos.runs(a.automationId, 10);
  expect(runs[0]!.state).toBe("skipped");
  expect(runs[0]!.why).toContain("this one-time run goes once that ends");
  expect(autos.get(a.automationId)!.doneAt).toBeUndefined();
  await advance(10 * MIN);
  close(hub, first.workstreamId!);
  await settle(hub);
  const after = autos.runs(a.automationId, 10);
  expect(after[0]!.state).toBe("running");
  expect(after[0]!.lateMin).toBe(10);
  expect(autos.get(a.automationId)!.doneAt).toBeDefined();
});

test("a full project makes room with its oldest done reminder", async () => {
  const { hub, advance } = setup();
  const autos = automations(hub);
  autos.start();
  const [reminder] = autos.create(fresh(PROJECT, { at: "2026-10-17T10:05", tz: "UTC" }, false));
  for (let i = 1; i < 50; i++) autos.create({ ...fresh(PROJECT, undefined, false), name: `n${i}` });
  expect(() => autos.create(fresh(PROJECT, undefined, false))).toThrow("The project has 50 automations");
  await advance(5 * MIN);
  expect(autos.get(reminder.automationId)!.doneAt).toBeDefined();
  autos.create({ ...fresh(PROJECT, undefined, false), name: "new" });
  expect(autos.get(reminder.automationId)).toBeUndefined();
  expect(autos.list(PROJECT).length).toBe(50);
});

test("the lead makes, lists, edits, pauses, runs and deletes its project's automations", async () => {
  const { hub } = setup();
  const made = await call(hub, "automation_create", {
    name: "Weekly report",
    prompt: "Every Friday, email the report.",
    schedule: { cron: "0 9 * * 5", tz: "Europe/Berlin" },
  });
  const a = made.automation as { automationId: string; confirmed: boolean; createdBy: string; webhook: boolean };
  expect(a.confirmed).toBe(false);
  expect(a.createdBy).toBe(lead.by);
  expect(a.webhook).toBe(false);
  expect(made.next).toContain("Its first run is at 2026-10-23T07:00:00.000Z");
  const listed = await call(hub, "automation_list", {});
  expect((listed.automations as unknown[]).length).toBe(1);
  const paused = await call(hub, "automation_update", { automationId: a.automationId, paused: true, name: "Friday report" });
  expect((paused.automation as { name: string; paused: boolean }).name).toBe("Friday report");
  expect(paused.next).toContain("Paused");
  const ran = await call(hub, "automation_run", { automationId: a.automationId });
  expect(ran.next).toMatch(/^It opened W\d+; it reaches you as a new order\.$/);
  const runs = await call(hub, "automation_runs", { automationId: a.automationId, runId: (ran.run as { runId: string }).runId });
  expect((runs.runs as unknown[]).length).toBe(1);
  expect(runs.payload).toBeUndefined();
  await expect(call(hub, "automation_runs", { automationId: a.automationId, runId: "ar_nothere1" })).rejects.toThrow("has no run ar_nothere1");
  // Another project's automation is refused.
  store(hub).projectsUpsertMany(PROJECT.machineId, [{ ...store(hub).projectGet(PROJECT)!, projectId: "p2" }, store(hub).projectGet(PROJECT)!]);
  const [theirs] = automations(hub).create(fresh({ machineId: PROJECT.machineId, projectId: "p2" }, undefined, false));
  await expect(call(hub, "automation_delete", { automationId: theirs.automationId })).rejects.toThrow("belongs to another project");
  const gone = await call(hub, "automation_delete", { automationId: a.automationId });
  expect(gone).toEqual({ automationId: a.automationId, next: "Deleted; orders its runs opened stay open." });
});

test("only the person marks an automation as their go-ahead, through approvals' hooks", async () => {
  const { hub } = setup();
  start(hub);
  const made = await call(hub, "automation_create", { name: "Weekly report", prompt: "Every Friday, email the report.", schedule: { cron: "0 9 * * 5", tz: "Europe/Berlin" } });
  const id = (made.automation as { automationId: string }).automationId;
  const confirmed = async () => ((await call(hub, "automation_confirm", { automationId: id })).automation as { confirmed: boolean }).confirmed;
  expect(await confirmed()).toBe(false);
  const hooks = approvals(hub).deps.hooks;
  const shown = await hooks.naviAutomation(PROJECT, id);
  expect(shown?.automationId).toBe(id);
  expect(await hooks.naviAutomation({ ...PROJECT, projectId: "elsewhere" }, id)).toBeUndefined();
  const card = { automationId: id, name: shown!.name, prompt: shown!.prompt, schedule: shown!.schedule, what: "…" };
  expect(await hooks.naviAutomationConfirm(PROJECT, card, "human:desk")).toBe(true);
  expect(await confirmed()).toBe(true);
  // A rename keeps it; a prompt the person never saw unmarks it, and the old card marks nothing.
  await call(hub, "automation_update", { automationId: id, name: "Friday report" });
  expect(await confirmed()).toBe(true);
  await call(hub, "automation_update", { automationId: id, prompt: "Every Friday, email the report to ben." });
  expect(await confirmed()).toBe(false);
  expect(await hooks.naviAutomationConfirm(PROJECT, card, "human:desk")).toBe(false);
  expect(automations(hub).running(PROJECT)).toEqual([]);
});

test("a removed project's automations go, and their webhook URL is refused", async () => {
  const { hub } = setup();
  automations(hub).start();
  const [a, secret] = automations(hub).create(fresh(PROJECT, schedule("0 * * * *", "UTC"), true));
  hub.db.conn.query("DELETE FROM projects WHERE machine_id = ? AND project_id = ?").run(PROJECT.machineId, PROJECT.projectId);
  events(hub).append({ at: isoMs(START), type: "project.removed", machineId: PROJECT.machineId, projectId: PROJECT.projectId, summary: "removed" });
  await settle(hub);
  expect(automations(hub).get(a.automationId)).toBeUndefined();
  expect(automations(hub).webhookTarget(a.automationId, secret!)).toBeUndefined();
  expect(eventsOf(hub, "automation.changed").at(-1)?.summary).toContain("deleted with its project");
});

test("a run a stop left without its order opens it at start, once", async () => {
  const { hub, opened } = setup();
  const [a] = automations(hub).create(fresh(PROJECT, undefined, false));
  const run = { runId: "ar_leftover1", automationId: a.automationId, trigger: "manual", at: isoMs(START), state: "running", by: "human" };
  hub.db.conn
    .query("INSERT INTO automation_runs (run_id, automation_id, at_ms, state, workstream_id, payload, data) VALUES (?, ?, ?, 'running', NULL, NULL, ?)")
    .run(run.runId, a.automationId, START, JSON.stringify(run));
  automations(hub).start();
  await settle(hub);
  const [recovered] = automations(hub).runs(a.automationId, 10);
  expect(recovered!.workstreamId).toBeDefined();
  expect(opened.map((o) => o.clientRequestId)).toEqual(["ar_leftover1"]);
  expect(eventsOf(hub, "automation.run")[0]!.summary).toContain("after a hub restart");
});

test("without the leads' intake a run fails and says why", async () => {
  const t = testHub(START);
  cleanup = t.done;
  const [a] = automations(t.hub).create(fresh(PROJECT, undefined, false));
  const run = await automations(t.hub).run(a.automationId, { kind: "manual", by: "human" });
  expect(run.state).toBe("failed");
  expect(run.why).toContain("can't open orders yet");
});

test("the tools: grants, the webhook URL shown once, rotate", async () => {
  const { hub } = setup();
  const tools = { handlers: new Map<string, (hub: Hub, c: unknown, input: unknown) => unknown>() };
  register({ add: (n: string, h: never) => tools.handlers.set(n, h) } as unknown as Registry);
  const run = (name: string, c: unknown, input: unknown) => tools.handlers.get(name)!(hub, c, input) as Record<string, unknown> | Promise<Record<string, unknown>>;
  const human = caller("operate", true);
  const made = (await run("automation_create", human, {
    projectRef: PROJECT,
    name: "Mail in",
    prompt: "Triage the mail.",
    webhook: true,
    clientRequestId: "req-1",
  })) as { automation: { automationId: string; confirmed: boolean }; webhookUrl: string; next: string };
  expect(made.automation.confirmed).toBe(true);
  expect(made.webhookUrl).toStartWith(`${hub.url()}/hooks/${made.automation.automationId}/`);
  const again = (await run("automation_create", human, { projectRef: PROJECT, name: "Mail in", prompt: "Triage the mail.", webhook: true, clientRequestId: "req-1" })) as {
    webhookUrl?: string;
    next: string;
  };
  expect(again.webhookUrl).toBeUndefined();
  expect(again.next).toContain("Already made by this request");
  const reader = caller("read");
  expect(() => run("automation_delete", reader, { automationId: made.automation.automationId })).toThrow("no operate grant");
  const elsewhere = { ...caller("operate"), grants: [{ role: "operate" as const, machines: ["other"] }] };
  expect(() => run("automation_runs", elsewhere, { automationId: made.automation.automationId, limit: 10 })).toThrow(`There is no automation ${made.automation.automationId}.`);
  const rotated = (await run("automation_rotate", human, { automationId: made.automation.automationId })) as { webhookUrl: string; next: string };
  expect(rotated.webhookUrl).not.toBe(made.webhookUrl);
  expect(rotated.next).toContain("The old URL no longer works.");
});

test("a Navi's run closes once its turn ends, and the next scheduled run starts; a code project's stays open", async () => {
  const { hub, clock, advance } = setup();
  putNavi(hub.db.conn, PROJECT, { keyId: "key_h", name: "Ada's phone" }, undefined, START);
  const records = new LeadRecords(hub.db);
  records.leadPut({ projectRef: PROJECT, threadId: "th-lead", startedAt: isoMs(START + 31 * MIN), sessionGeneration: 1 });
  const thread = (status: string) =>
    store(hub).threadUpsert({
      thread: { machineId: PROJECT.machineId, threadId: "th-lead", projectId: PROJECT.projectId, status, lastProgressAt: isoMs(clock.now()) } as never,
      lastRunId: "r-start",
    });
  const ended = (status: string) => {
    thread(status);
    events(hub).append({ at: isoMs(clock.now()), type: "thread.completed", machineId: PROJECT.machineId, threadId: "th-lead", summary: "done", data: { threadId: "th-lead", runId: "r-start" } });
  };
  const autos = automations(hub);
  const [a] = autos.create(fresh(PROJECT, schedule("*/30 * * * *", "UTC"), false));
  autos.start();
  await settle(hub);
  await advance(30 * MIN);
  const first = autos.runs(a.automationId, 1)[0]!;
  expect(first.state).toBe("running");

  // An earlier turn's end while the one with the order still runs closes nothing.
  await advance(MIN);
  ended("running");
  await settle(hub);
  expect(workstreamGet(hub.db.conn, first.workstreamId!)!.state).toBe("open");
  ended("completed");
  await settle(hub);
  expect(workstreamGet(hub.db.conn, first.workstreamId!)!.state).toBe("done");
  expect(autos.runs(a.automationId, 1)[0]!.state).toBe("done");
  expect(eventsOf(hub, "automation.run").at(-1)!.summary).toContain("once the lead's turn ended");

  await advance(29 * MIN);
  expect(autos.runs(a.automationId, 10).map((r) => r.state)).toEqual(["running", "done"]);

  // Not a Navi: its lead closes its own orders.
  hub.db.conn.query("UPDATE project_settings SET only_me = 0").run();
  ended("completed");
  await settle(hub);
  expect(autos.runs(a.automationId, 1)[0]!.state).toBe("running");
});
