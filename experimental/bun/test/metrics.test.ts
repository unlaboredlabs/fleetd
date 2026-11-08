// The metrics over a fresh hub (crates/fleetd/src/hub/metrics/tests.rs, touch_tests.rs): the projector's routes and
// stamps from the train's events, replays, the person's touches, metrics_get's figures by calendar day in a zone, its
// bounds and grants, and the prune.
import { afterEach, expect, test } from "bun:test";
import { registerAll } from "../src/gen/areas.ts";
import { Registry, type Caller } from "../src/hub/api/registry.ts";
import * as compute from "../src/hub/metrics/compute.ts";
import * as human from "../src/hub/metrics/human.ts";
import { weeks } from "../src/hub/metrics/index.ts";
import { start } from "../src/hub/metrics/loops.ts";
import { step } from "../src/hub/metrics/project.ts";
import * as store from "../src/hub/metrics/store.ts";
import { dayStart } from "../src/hub/metrics/zone.ts";
import { events } from "../src/hub/store/events.ts";
import { isoMs } from "../src/hub/store/time.ts";
import { cursor as readCursor } from "../src/hub/time/store.ts";
import type { HubEventType, MetricsGetOutput } from "../src/shared/contracts.ts";
import { testHub } from "./hub-helpers.ts";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const MIN = 60_000;
const NOW = "2026-10-25T12:00:00.000Z";
const REPO = "github.com/acme/web";
const ms = (t: string) => Date.parse(t);

let cleanup: (() => void) | undefined;
afterEach(() => {
  cleanup?.();
  cleanup = undefined;
});

function hub() {
  const t = testHub(ms(NOW));
  cleanup = t.done;
  return t;
}
type H = ReturnType<typeof hub>["hub"];

const caller = (grants: Caller["grants"]): Caller => ({
  keyId: "k1",
  name: "desk",
  prefix: "fld_abcdef",
  createdAt: NOW,
  grants,
  kind: "human",
});
const admin = () => caller([{ role: "admin", machines: "*" }]);

const sql = (h: H, statement: string, ...args: (string | number)[]) => h.db.conn.query(statement).run(...args);

/** W1 the person submitted in the app; W2 the lead opened from the chat. */
function orders(h: H) {
  for (const [n, channel, at] of [
    [1, "app", "2026-10-20T08:00:00.000Z"],
    [2, "lead", "2026-10-21T09:00:00.000Z"],
  ] as const) {
    const w = {
      workstreamId: `W${n}`,
      projectRef: { machineId: "devbox", projectId: "web" },
      title: "Checkout",
      source: { text: "Checkout", channel, by: "human", at },
      state: "open",
      createdAt: at,
      updatedAt: at,
    };
    sql(h, "INSERT INTO workstreams (n, machine_id, project_id, state, data) VALUES (?1, 'devbox', 'web', 'open', ?2)", n, JSON.stringify(w));
  }
}

function change(h: H, n: number, pr: number, w: string, task: string | undefined, state: string, created: string) {
  const c: Record<string, unknown> = {
    changeId: `X${n}`,
    projectRef: { machineId: "devbox", projectId: "web" },
    repo: "acme/web",
    prNumber: pr,
    prUrl: `https://github.com/acme/web/pull/${pr}`,
    branch: `fleetd/T${n}-x`,
    workstreamId: w,
    headSha: "b".repeat(40),
    state,
    reviews: [],
    createdAt: created,
    updatedAt: created,
  };
  if (task) c.taskId = task;
  sql(
    h,
    `INSERT INTO changes (n, repo, pr_number, state, machine_id, project_id, train_order, data)
     VALUES (?1, 'acme/web', ?2, ?3, 'devbox', 'web', ?1, ?4)`,
    n,
    pr,
    state,
    JSON.stringify(c),
  );
}

function event(h: H, at: string, type: string, data: unknown) {
  events(h).append({ at, type: type as HubEventType, machineId: "devbox", projectId: "web", summary: type, data });
}

/** Projects every page from `cursor`, as the projector's loop does; the cursor it ends on. */
function projectFrom(h: H, cursor: number): number {
  for (;;) {
    const [next, more] = step(h.db, events(h), cursor);
    cursor = next;
    if (!more) return cursor;
  }
}

const rows = (h: H) => store.merges(h.db.conn, 0, Number.MAX_SAFE_INTEGER);

async function get(h: H, who: Caller, input: unknown): Promise<MetricsGetOutput> {
  const r = new Registry();
  registerAll(r);
  const out = await r.call(h, who, "metrics_get", input);
  if ("output" in out) return out.output as MetricsGetOutput;
  throw out.error.kind === "tool" ? out.error.error : new Error(JSON.stringify(out.error));
}

/** A week on acme/web: the train's change, two fleetd PRs merged by hand, one from outside, and a bot's PR. */
function aWeek(h: H) {
  orders(h);
  sql(h, "INSERT INTO trains (repo, machine_id, project_id, watch_since_ms) VALUES ('acme/web', 'devbox', 'web', 0)");
  sql(h, "INSERT INTO tasks (n, machine_id, project_id, workstream_id, state, data) VALUES (3, 'devbox', 'web', 'W2', 'done', '{}')");
  change(h, 1, 7, "W1", "T1", "merged", "2026-10-20T09:00:00.000Z");
  change(h, 2, 8, "W2", undefined, "abandoned", "2026-10-21T10:00:00.000Z");
  const moved = (at: string, from: string, to: string) =>
    event(h, at, "change.state", { changeId: "X1", workstreamId: "W1", repo: "acme/web", prNumber: 7, from, to });
  event(h, "2026-10-20T08:00:00.000Z", "workstream.created", { workstreamId: "W1" });
  moved("2026-10-20T09:30:00.000Z", "queued", "reviewing");
  moved("2026-10-20T10:00:00.000Z", "reviewing", "ready");
  // A bounce back to ready later keeps the first pass.
  moved("2026-10-20T10:30:00.000Z", "ready", "rebasing");
  moved("2026-10-20T11:00:00.000Z", "rebasing", "ready");
  event(h, "2026-10-20T12:00:00.000Z", "pr.merged", {
    changeId: "X1",
    workstreamId: "W1",
    repo: "acme/web",
    prNumber: 7,
    taskId: "T1",
    mergedSha: "A".repeat(40),
    batchPr: 12,
  });
  // Reported an hour after it merged: the git host's time counts.
  event(h, "2026-10-21T15:00:00.000Z", "pr.merged_outside", { repo: "acme/web", prNumber: 8, changeId: "X2", mergedAt: "2026-10-21T14:00:00.000Z" });
  event(h, "2026-10-22T11:00:00.000Z", "pr.merged_outside", {
    repo: "acme/web",
    prNumber: 9,
    prCreatedAt: "2026-10-22T10:00:00.000Z",
    authorKind: "human",
    mergedByKind: "human",
  });
  event(h, "2026-10-23T10:00:00.000Z", "pr.merged_outside", { repo: "acme/web", prNumber: 10, head: "fleetd/T3-fix-totals" });
  event(h, "2026-10-23T12:00:00.000Z", "pr.merged_outside", { repo: "acme/web", prNumber: 11, head: "dependabot/npm/left-pad", authorKind: "bot" });
}

test("a week of merges reads as routes, rates and order times", async () => {
  const { hub: h } = hub();
  aWeek(h);
  projectFrom(h, 0);
  const out = await get(h, admin(), { since: "2026-10-19T00:00:00.000Z", tz: "UTC" });
  // 19th to the 25th: six whole days and half of today.
  expect(out.days.length).toBe(7);
  const merged = out.tiles.merged;
  expect(merged.n).toBe(4);
  expect(merged.byRoute).toEqual({ train: 1, fleetdByHand: 2, outside: 1, direct: 0 });
  expect(Math.abs(merged.perDay - 4 / 6.5)).toBeLessThan(1e-9);
  const lead = out.tiles.orderToMerged;
  expect([lead.n, lead.medianMs, lead.p90Ms]).toEqual([3, 5 * HOUR, 49 * HOUR]);
  expect([lead.fromOpened, lead.noOrder]).toEqual([2, 1]);
  expect(lead.prOpenMedianMs).toBe(HOUR);
  expect(lead.previousMedianMs).toBeUndefined();
  const share = out.tiles.throughFleetd;
  expect([share.pct, share.madeByFleetdPct]).toEqual([25, 75]);
  // Nothing before the projector's first event was read: no previous period to compare with.
  expect(merged.previousPerDay).toBeUndefined();
  expect(out.merges.map((m) => [m.prNumber, m.route])).toEqual([
    [10, "fleetd_by_hand"],
    [9, "outside"],
    [8, "fleetd_by_hand"],
    [7, "train"],
  ]);
  expect(out.mergesTotal).toBe(4);
  const train = out.merges[3]!;
  expect([train.batchPr, train.mergedBy, train.requestedBasis, train.firstPrAt, train.reviewPassedAt, train.sha]).toEqual([
    12,
    "train",
    "source",
    "2026-10-20T09:00:00.000Z",
    "2026-10-20T10:00:00.000Z",
    "a".repeat(40),
  ]);
  const byBranch = out.merges[0]!;
  expect([byBranch.taskId, byBranch.workstreamId, byBranch.requestedBasis]).toEqual(["T3", "W2", "opened"]);
  const outside = out.merges[1]!;
  expect([outside.workstreamId, outside.orderToMergedMs, outside.author]).toEqual([undefined, undefined, "human"]);
  // The bot's PR is counted on its day as not counted, never dropped.
  const the23rd = out.days.find((d) => d.day === "2026-10-23")!;
  expect(the23rd.merged.fleetdByHand).toBe(1);
  expect(the23rd.notCounted).toEqual([{ why: "bot", n: 1 }]);
  expect(out.repos!.map((r) => [r.repo, r.n])).toEqual([[REPO, 4]]);
  expect(out.coverage.repos[0]!.repo).toBe(REPO);
  expect(out.coverage.invisible.length).toBe(7);
});

test("a replay writes the same rows and the train has the last word", () => {
  const { hub: h } = hub();
  aWeek(h);
  const cursor = projectFrom(h, 0);
  const first = rows(h);
  expect(first.length).toBe(5);
  expect(projectFrom(h, 0)).toBe(cursor);
  expect(rows(h)).toEqual(first);
  // A report of the train's own merge as made outside it changes nothing that matters.
  event(h, "2026-10-24T09:00:00.000Z", "pr.merged_outside", { repo: "acme/web", prNumber: 7, mergedByKind: "human" });
  projectFrom(h, cursor);
  const pr7 = rows(h).find((r) => r.unitKey === "pr:7")!;
  expect([pr7.route, pr7.mergedMs, pr7.mergedByKind]).toEqual(["train", ms("2026-10-20T12:00:00.000Z"), "train"]);
});

function storeRow(h: H, unit: string, route: string, mergedMs: number, w?: string) {
  h.db.transaction((c) =>
    store.upsertMerge(c, {
      repo: REPO,
      unitKey: unit,
      machineId: "devbox",
      projectId: "web",
      mergedMs,
      route,
      ...(w ? { workstreamId: w } : {}),
      src: "event",
    }),
  );
}

test("an order known after its merge gets its request time", () => {
  const { hub: h } = hub();
  orders(h);
  storeRow(h, "pr:4", "train", ms("2026-10-22T08:00:00.000Z"), "W2");
  event(h, "2026-10-21T09:00:00.000Z", "workstream.created", { workstreamId: "W2" });
  projectFrom(h, 0);
  const row = rows(h).pop()!;
  expect([row.requestedMs, row.requestedBasis]).toEqual([ms("2026-10-21T09:00:00.000Z"), "opened"]);
});

test("days are the viewer's and a full retention range fits the day list", async () => {
  const { hub: h } = hub();
  // 23:30 UTC on the 20th is the 21st in Berlin.
  storeRow(h, "pr:1", "outside", ms("2026-10-20T23:30:00.000Z"));
  sql(h, "INSERT INTO time_cursors (source, value) VALUES (?1, 0)", store.KNOWN_SINCE);
  const berlin = await get(h, admin(), { since: "2026-10-19T22:00:00.000Z", until: "2026-10-22T22:00:00.000Z", tz: "Europe/Berlin" });
  expect(berlin.days.map((d) => [d.day, d.merged.outside])).toEqual([
    ["2026-10-20", 0],
    ["2026-10-21", 1],
    ["2026-10-22", 0],
  ]);
  expect(berlin.tiles.merged.perDay).toBe(1 / 3);
  // Merges were known from the start: the previous period is compared, at zero.
  expect(berlin.tiles.merged.previousPerDay).toBe(0);
  // The zone's name in any case, as chrono_tz reads it.
  const lower = await get(h, admin(), { since: "2026-10-19T22:00:00.000Z", until: "2026-10-22T22:00:00.000Z", tz: "europe/berlin" });
  expect(lower.days.map((d) => d.day)).toEqual(["2026-10-20", "2026-10-21", "2026-10-22"]);
  // 400 days back from mid-day, in zones on both sides of UTC: never more days than the list holds.
  for (const tz of ["America/Los_Angeles", "Pacific/Kiritimati", "Asia/Kolkata", "UTC"]) {
    const out = await get(h, admin(), { since: isoMs(ms(NOW) - 400 * DAY), tz, compare: true });
    expect(out.days.length, tz).toBeLessThanOrEqual(compute.MAX_DAYS);
    expect(out.compare!.days.length, tz).toBeLessThanOrEqual(compute.MAX_DAYS);
  }
  await expect(get(h, admin(), { since: "2026-10-26T00:00:00.000Z", tz: "UTC" })).rejects.toMatchObject({ code: "invalid" });
});

test("calendar days follow the zone through a clock change", () => {
  const berlin = "Europe/Berlin";
  // Summer time ends on the 25th: that day is 25 hours long.
  const from = dayStart({ y: 2026, m: 10, d: 24 }, berlin);
  const to = dayStart({ y: 2026, m: 10, d: 27 }, berlin);
  expect(compute.days(from, to, berlin).map((d) => d.len / HOUR)).toEqual([24, 25, 24]);
  expect(from).toBe(ms("2026-10-23T22:00:00.000Z"));
  // A range a few hours over 400 days is cut to the last 400 calendar days.
  const until = ms(NOW);
  const since = compute.clampSince(until - 400 * DAY - 5 * HOUR, until, berlin);
  expect(compute.days(since, until, berlin).length).toBe(compute.MAX_DAYS);
  expect(since).toBe(dayStart({ y: 2025, m: 9, d: 21 }, berlin));
  // Where a DST gap swallows midnight (Santiago, 2026-09-06), the day starts at its first hour.
  expect(isoMs(dayStart({ y: 2026, m: 9, d: 6 }, "America/Santiago"))).toBe("2026-09-06T04:00:00.000Z");
});

test("medians and p90 take the middle and the nearest rank", () => {
  expect(compute.median([])).toBeUndefined();
  expect(compute.median([5])).toBe(5);
  expect(compute.median([1, 3, 10, 40])).toBe(6);
  expect(compute.percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 0.9)).toBe(9);
  expect(compute.percentile([4, 5, 49], 0.9)).toBe(49);
  expect(compute.percentile([7], 0.9)).toBe(7);
});

test("reads need the machine, and the fleet shows only readable repos", async () => {
  const { hub: h } = hub();
  aWeek(h);
  projectFrom(h, 0);
  const elsewhere = caller([{ role: "read", machines: ["other"] }]);
  const project = { projectRef: { machineId: "devbox", projectId: "web" }, since: "2026-10-19T00:00:00.000Z", tz: "UTC" };
  await expect(get(h, elsewhere, project)).rejects.toMatchObject({ code: "forbidden" });
  const fleet = await get(h, elsewhere, { since: "2026-10-19T00:00:00.000Z", tz: "UTC" });
  expect([fleet.tiles.merged.n, fleet.repos!.length]).toEqual([0, 0]);
  const here = caller([{ role: "read", machines: ["devbox"] }]);
  const own = await get(h, here, project);
  expect(own.tiles.merged.n).toBe(4);
  expect(own.repos).toBeUndefined();
});

test("the prune keeps what the retention says, and the hourly loop prunes", async () => {
  const { hub: h, clock } = hub();
  const now = ms(NOW);
  for (const [unit, age] of [
    ["pr:1", 300],
    ["pr:2", 40],
    ["pr:3", 10],
  ] as const) {
    storeRow(h, unit, "outside", now - age * DAY);
  }
  const units = () => rows(h).map((r) => r.unitKey);
  // 400 days by default.
  expect(h.db.transaction((c) => store.prune(c, now))).toBe(false);
  expect(units().length).toBe(3);
  // A hub that set 30 days before the setting went keeps it.
  sql(h, "INSERT INTO time_settings (key, value) VALUES ('metrics_retention_days', 30)");
  expect(h.db.transaction((c) => store.prune(c, clock.now()))).toBe(false);
  expect(units()).toEqual(["pr:3"]);
  // The loops start and stop with the hub.
  start(h);
  h.shutdown.abort();
});

test("the saved cursor only moves forward", () => {
  const { hub: h } = hub();
  aWeek(h);
  const end = projectFrom(h, 0);
  expect(readCursor(h.db.conn, "metrics:events")).toBe(end);
  const before = rows(h);
  step(h.db, events(h), 0);
  expect(readCursor(h.db.conn, "metrics:events")).toBe(end);
  expect(rows(h)).toEqual(before);
});

test("the projector folds each append as it lands", async () => {
  const { hub: h } = hub();
  orders(h);
  start(h);
  event(h, "2026-10-24T09:00:00.000Z", "pr.merged_outside", { repo: "acme/web", prNumber: 21 });
  await Bun.sleep(5);
  expect(rows(h).map((r) => [r.unitKey, r.route])).toEqual([["pr:21", "outside"]]);
  // Each project's week, for its Status row.
  sql(h, "INSERT INTO metric_project_repos (repo, machine_id, project_id, checked_ms) VALUES (?1, 'devbox', 'web', 0)", REPO);
  expect(weeks(h.db.conn, h.clock.now(), "UTC").get("devbox/web")).toEqual({ merged: 1, throughFleetdPct: 0 });
  h.shutdown.abort();
});

// The person's minutes and touches.

const spans = (intervals: [number, number][]): human.Span[] => intervals.map(([start, end]) => ({ start, end, source: "chat" }));

test("acts under five minutes apart are one session, and overlaps count once", () => {
  const m = MIN;
  const near = spans([
    [0, m],
    [m + human.BRIDGE_MS - 1, 2 * m + human.BRIDGE_MS - 1],
  ]);
  expect(human.minutes(near)).toEqual({ totalMs: 2 * m + human.BRIDGE_MS - 1, lowMs: 2 * m });
  expect(human.minutes(spans([[0, m], [m + human.BRIDGE_MS, 2 * m + human.BRIDGE_MS]])).totalMs).toBe(2 * m);
  expect(human.minutes(spans([[2 * m, 4 * m], [0, 3 * m], [m, 2 * m]]))).toEqual({ totalMs: 4 * m, lowMs: 4 * m });
  expect(human.minutes([])).toEqual({ totalMs: 0, lowMs: 0 });
  const pieces = human.sessions(
    [
      { start: 0, end: m, source: "chat" },
      { start: 3 * m, end: 4 * m, source: "other" },
    ],
    human.BRIDGE_MS,
  );
  expect(pieces.map((p) => [p.source, p.end - p.start])).toEqual([
    ["chat", m],
    ["other", 3 * m],
  ]);
  expect(human.within(pieces, 0, 2 * m)).toBe(2 * m);
  expect(human.within(pieces, 2 * m, 10 * m)).toBe(2 * m);
  expect(human.clip(spans([[-m, m], [5 * m, 6 * m]]), 0, 5 * m)).toEqual(spans([[0, m]]));
});

test("each touch counts its stated minimum", () => {
  expect([human.typedMs(0), human.typedMs(150), human.typedMs(300)]).toEqual([MIN, MIN, 2 * MIN]);
  expect([human.reviewMs(), human.reviewMs(250), human.reviewMs(50_000)]).toEqual([3 * MIN, 5 * MIN, 20 * MIN]);
  const base = { src: "x", srcKey: "x", creditMs: 0, estimated: false, outside: false };
  const app = human.span({ ...base, kind: "app.use", atMs: 10 * MIN, endMs: 14 * MIN });
  expect([app.start, app.end]).toEqual([10 * MIN, 14 * MIN]);
  const steer = human.span({ ...base, kind: "steer", atMs: 10 * MIN, creditMs: human.STEER_MS });
  expect([steer.start, steer.source]).toEqual([9 * MIN, "other"]);
});

test("the person's identities are their logins and emails, in any case", () => {
  const ids = new human.Identities(["Ada", "12345+AdaL@users.noreply.github.com", " "]);
  expect(["ada", "ADA", "adal", "12345+adal@users.noreply.github.com"].map((x) => ids.has(x))).toEqual([true, true, true, true]);
  expect(ids.has("bob")).toBe(false);
  const review = { src: "host", srcKey: "r1", kind: "host.review", atMs: 0, creditMs: 0, estimated: true, outside: false };
  expect(human.attributed({ ...review, keyId: "ada" }, ids)).toBe(true);
  expect(human.attributed({ ...review, keyId: "bob" }, ids)).toBe(false);
  expect(human.attributed({ ...review, kind: "chat.message" }, new human.Identities([]))).toBe(true);
});

function message(n: number, author: string, text: string, at: string, extra: Record<string, unknown> = {}) {
  return {
    messageId: `m${n}`,
    projectRef: { machineId: "devbox", projectId: "web" },
    seq: n,
    author,
    text,
    createdAt: at,
    state: "final",
    by: "desk",
    ...extra,
  };
}

function chat(h: H, at: string, m: ReturnType<typeof message>, inline = true) {
  event(h, at, "chat.message", {
    projectRef: m.projectRef,
    messageId: m.messageId,
    seq: m.seq,
    author: m.author,
    state: "final",
    ...(inline ? { message: m } : {}),
  });
}

const request = (h: H, at: string, id: string, state: string, by: string) =>
  event(h, at, "request.updated", { requestId: id, kind: "approval", state, workstreamId: "W1", by });

function answered(h: H, n: number, at: string) {
  const data = JSON.stringify({ requestId: `Q${n}`, answeredAt: at, answeredBy: "human:desk" });
  sql(
    h,
    `INSERT INTO requests (n, project_key, kind, state, created_ms, data) VALUES (?1, 'devbox/web', 'approval', 'approved', 0, ?2)
     ON CONFLICT(n) DO UPDATE SET data = excluded.data`,
    n,
    data,
  );
}

test("each kind of touch is the person's act and nothing else", () => {
  const { hub: h } = hub();
  aWeek(h);
  chat(h, "2026-10-20T09:00:00.000Z", message(1, "human", "x".repeat(300), "2026-10-20T09:00:00.000Z", { client: "app" }));
  chat(h, "2026-10-20T09:00:01.000Z", message(2, "agent", "build is green", "2026-10-20T09:00:01.000Z"));
  chat(h, "2026-10-20T09:00:02.000Z", message(3, "human", "old note", "2026-10-01T09:00:00.000Z", { history: "note" }));
  answered(h, 1, "2026-10-20T09:03:00.000Z");
  request(h, "2026-10-20T09:03:00.000Z", "Q1", "approved", "human:desk");
  // A note on its run while it stays approved is the same answer.
  request(h, "2026-10-20T09:03:40.000Z", "Q1", "approved", "human:desk");
  request(h, "2026-10-20T09:04:00.000Z", "Q1", "ran", "human:desk");
  request(h, "2026-10-20T09:05:00.000Z", "Q2", "denied", "lead:devbox/web");
  request(h, "2026-10-20T09:06:00.000Z", "Q3", "withdrawn", "hub");
  event(h, "2026-10-20T09:03:20.000Z", "steer.queued", { steerId: "S1", workstreamId: "W1", stage: "queued", by: { kind: "human", keyName: "desk" } });
  event(h, "2026-10-20T09:30:00.000Z", "steer.queued", { steerId: "S2", workstreamId: "W1", stage: "queued", by: { kind: "lead" } });
  const scope = { kind: "project", projectRef: { machineId: "devbox", projectId: "web" } };
  event(h, "2026-10-20T10:00:00.000Z", "decision.recorded", { decisionId: "D1", key: "db", source: "human", scope });
  event(h, "2026-10-20T10:30:00.000Z", "decision.recorded", { decisionId: "D2", key: "db", source: "lead", scope });
  const cursor = projectFrom(h, 0);
  const all = store.touches(h.db.conn, 0, Number.MAX_SAFE_INTEGER);
  expect(all.map((t) => [t.kind, t.srcKey, t.creditMs, t.outside, t.projectId])).toEqual([
    ["order.submitted", "W1", MIN, false, "web"],
    ["chat.message", "m1", 2 * MIN, false, "web"],
    ["item.answered", `Q1@${ms("2026-10-20T09:03:00.000Z")}`, 30_000, false, "web"],
    ["steer", "S1", MIN, false, "web"],
    ["decision", "D1", MIN, false, "web"],
    // PR 9 from outside, merged by the person.
    ["merge.by_hand", `${REPO}#pr:9`, MIN, true, "web"],
  ]);
  expect(all[1]!.keyId).toBe("desk");
  expect(all[3]!.workstreamId).toBe("W1");
  expect([all[5]!.repo, all[5]!.prNumber]).toEqual([REPO, 9]);
  // A replay writes the same touches.
  expect(projectFrom(h, 0)).toBe(cursor);
  expect(store.touches(h.db.conn, 0, Number.MAX_SAFE_INTEGER)).toEqual(all);
});

test("a message too long for its event is read from the chat, and app use is an observed interval", () => {
  const { hub: h } = hub();
  const m = message(7, "human", "y".repeat(450), "2026-10-24T09:00:00.000Z");
  sql(
    h,
    "INSERT INTO chat_messages (n, machine_id, project_id, seq, created_ms, data) VALUES (7, 'devbox', 'web', 7, 0, ?1)",
    JSON.stringify(m),
  );
  chat(h, "2026-10-24T09:00:00.000Z", m, false);
  event(h, "2026-10-24T10:00:00.000Z", "app.presence", { fromMs: ms("2026-10-24T09:50:00.000Z"), toMs: ms("2026-10-24T10:00:00.000Z"), by: "desk" });
  projectFrom(h, 0);
  const all = store.touches(h.db.conn, 0, Number.MAX_SAFE_INTEGER);
  expect(all.map((t) => [t.kind, t.creditMs, t.endMs])).toEqual([
    ["chat.message", 3 * MIN, undefined],
    ["app.use", 10 * MIN, ms("2026-10-24T10:00:00.000Z")],
  ]);
});

test("minutes per merged PR are the sessions over fleetd work, with the low bound beside", async () => {
  const { hub: h } = hub();
  aWeek(h);
  chat(h, "2026-10-20T09:00:00.000Z", message(1, "human", "x".repeat(300), "2026-10-20T09:00:00.000Z"));
  event(h, "2026-10-20T09:03:20.000Z", "steer.queued", { steerId: "S1", workstreamId: "W1", stage: "queued", by: { kind: "human", keyName: "desk" } });
  projectFrom(h, 0);
  const out = await get(h, admin(), { since: "2026-10-19T00:00:00.000Z", tz: "UTC" });
  // The order (07:59–08:00) alone; the message (08:58–09:00) and steer (09:02:20–09:03:20) bridged: 5m20s.
  // The merge by hand of PR 9 is outside work, and its merger isn't one of the person's identities.
  expect([out.tiles.human.totalMs, out.tiles.human.lowMs, out.tiles.human.prs]).toEqual([MIN + 5 * MIN + 20_000, 4 * MIN, 3]);
  expect(out.tiles.human.perPrMs).toBe(Math.trunc((6 * MIN + 20_000) / 3));
  const the20th = out.days.find((d) => d.day === "2026-10-20")!;
  expect(the20th.human).toEqual([
    // A bridged gap goes to the touch after it: 09:00–09:02:20 is the steer's.
    { source: "chat", ms: 3 * MIN, touches: 2 },
    { source: "other", ms: 3 * MIN + 20_000, touches: 1 },
  ]);
});
