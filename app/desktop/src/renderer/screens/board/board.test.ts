import { describe as group, expect, it } from "vitest";
import type { Ask, FleetStatus } from "../../../shared/contracts";
import { ask as askOf } from "../../src/data/fixtures.test-util";
import { type BoardData, selectBoardData } from "../../src/data/selectors";
import { applyFrame as frameIn, ingest, initialState } from "../../src/data/store";
import { bars, unlived } from "./bars";
import { changedChars, checkText, mentionAt, projectPrefix, resolveTarget, templateFromPrefix, type Target } from "./composerLogic";
import type { AgentLane, LaneStatus, LiveFrame, LiveLane, OrderCard, PrRef, TrainLive } from "./contracts";
import { finishHeadline, finished, fleet, groupLabel, hold, phaseLabel, reviewProgress, stagePick, writtenIn } from "./fleet";
import { fmtElapsed, fmtTokens, middleEllipsis, shortModel } from "./format";
import { machinesNow, needsClock, seenLanes, slotUse } from "./live";
import { type BoardModel, itemKey, listItems, stableOrder, stageItems, stagedOrder } from "./model";
import { heldLanes } from "./presence";
import { noteMerged, visibleChips } from "./Strips";
import { describe, fleetActivity, machineParts, slotsText } from "./words";

const T0 = "2026-10-18T10:00:00.000Z";
const at = (s: number) => new Date(Date.parse(T0) + s * 1000).toISOString();
const ms = (s: number) => Date.parse(T0) + s * 1000;

const lane = (laneId: string, status: LaneStatus, extra: Partial<AgentLane> = {}): AgentLane => ({
  laneId,
  role: "implementer",
  title: `task ${laneId}`,
  status,
  ...extra,
});
const live = (laneId: string, status: LaneStatus, extra: Partial<LiveLane> = {}): LiveLane => ({ laneId, status, ...extra });
const frame = (s: number, full: boolean, lanes: LiveLane[], extra: Partial<LiveFrame> = {}): LiveFrame => ({ at: at(s), full, lanes, ...extra });
const pr = (number: number, state: PrRef["state"], extra: Partial<PrRef> = {}): PrRef => ({
  changeId: `X${number}`,
  repo: "acme/storefront",
  number,
  url: `https://github.com/acme/storefront/pull/${number}`,
  state,
  reviewsDone: 0,
  reviewsNeeded: 3,
  ...extra,
});
const card = (workstreamId: string, lanes: AgentLane[], extra: Partial<OrderCard> = {}): OrderCard => ({
  workstreamId,
  projectRef: { machineId: "devbox", projectId: "storefront" },
  title: "Round cart totals once, in one place",
  state: "running",
  phase: "working",
  needsYou: 0,
  settled: 0,
  total: lanes.length,
  lanes,
  prs: [],
  createdAt: T0,
  updatedAt: T0,
  ...extra,
});
const KEY = "devbox/storefront";
const OTHER = { machineId: "lab", projectId: "other" } as const;

const snapshotOf = (projects: "none" | "one" | "two"): FleetStatus => {
  const p = (machineId: string, projectId: string, title: string) => ({
    machineId,
    projectId,
    title,
    workspaceRoot: `/srv/${projectId}`,
    lastActivityAt: T0,
    threads: { running: 0, waiting: 0, idle: 0, failed: 0 },
  });
  return {
    cursor: 0,
    attention: [],
    machines: [
      { machineId: "devbox", name: "devbox", nodeVersion: "1", status: "online", lastSeenAt: T0, tags: [] },
      { machineId: "lab", name: "lab", nodeVersion: "1", status: "online", lastSeenAt: T0, tags: [] },
    ],
    projects: projects === "none" ? [] : projects === "one" ? [p("devbox", "storefront", "storefront")] : [p("devbox", "storefront", "storefront"), p("lab", "other", "other")],
  };
};

interface World {
  readonly orders?: OrderCard[] | undefined;
  readonly trains?: TrainLive[];
  readonly asks?: Ask[];
  readonly frames?: LiveFrame[];
  /** order_get's finished lanes, per order. */
  readonly done?: Record<string, AgentLane[]>;
  readonly projects?: "none" | "one" | "two";
}

/** The data layer's board view of a world, through its own reducers and selector. */
const world = (w: World): BoardData => {
  let s = initialState();
  [s] = frameIn(s, { t: "state", state: { phase: "live", hub: "devbox:4710", protocol: 1 } }, 0);
  [s] = frameIn(s, { t: "snapshot", snapshot: snapshotOf(w.projects ?? "two") }, 0);
  if (w.orders !== undefined) s = ingest(s, { tool: "orders_board", input: {}, output: { orders: w.orders, trains: w.trains ?? [], at: T0 } });
  s = ingest(s, { tool: "asks_list", input: { state: "open" }, output: { batches: [], asks: w.asks ?? [] } });
  for (const f of w.frames ?? []) [s] = frameIn(s, { t: "live", frame: f }, Date.parse(f.at));
  for (const [id, doneLanes] of Object.entries(w.done ?? {})) {
    const order = w.orders?.find((o) => o.workstreamId === id);
    if (order) s = ingest(s, { tool: "order_get", input: { workstreamId: id }, output: { order, doneLanes, asks: [] } });
  }
  return selectBoardData(s);
};
const model = (w: World): BoardModel => ({ data: world(w), sent: [] });

group("formatters", () => {
  it("read like the spec", () => {
    expect(fmtElapsed(72_400)).toBe("1:12");
    expect(fmtElapsed(-5)).toBe("0:00");
    expect(fmtElapsed(3_900_000)).toBe("1h 05m");
    expect([840, 3_100, 9_960, 48_200, 999_499, 999_500, 12_400_000].map(fmtTokens)).toEqual(["840", "3.1k", "10k", "48k", "999k", "1.0M", "12M"]);
    expect(shortModel("claude-haiku-5-5")).toBe("haiku");
    expect(shortModel("gpt-x")).toBe("gpt-x");
  });

  it("cut a long command in the middle, never mid-word at the end", () => {
    const cut = middleEllipsis("npm run lint -- --fix src/cart/total.ts src/cart/discounts.ts", 30);
    expect(cut).toHaveLength(30);
    expect(cut.startsWith("npm run")).toBe(true);
    expect(cut.endsWith("discounts.ts")).toBe(true);
  });
});

group("the activity line", () => {
  it("is quiet while thinking and loud on tool work", () => {
    expect(describe(lane("T1", "working"))).toMatchObject({ words: "thinking", thinking: true });
    const edit = lane("T1", "working", { live: live("T1", "working", { activity: { activity: { kind: "edit", path: "src/a.ts" }, since: T0 } }) });
    expect(describe(edit)).toMatchObject({ words: "editing", machine: "src/a.ts", tone: "loud", thinking: false });
    expect(describe(lane("T1", "done", { startedAt: at(0), endedAt: at(18), pr: pr(221, "reviewing") })).words).toBe("done in 0:18 · #221");
    expect(describe(lane("T1", "waiting")).tone).toBe("warning");
  });

  it("counts running agents by what their role does, needing you first", () => {
    const lanes = [
      lane("a", "working"),
      lane("b", "starting"),
      lane("c", "done"),
      lane("d", "working", { role: "reviewer" }),
      lane("e", "working", { role: "verifier" }),
      lane("f", "queued", { role: "verifier" }),
    ];
    expect(fleetActivity(lanes)).toBe("2 writing · 1 reviewing · 1 verifying · 1 queued");
    expect(fleetActivity([lane("a", "waiting", { role: "reviewer" }), lane("b", "working")])).toBe("1 needs you · 1 writing");
    expect(fleetActivity([lane("a", "done")])).toBe("");
  });
});

group("the fleet grouped by PR", () => {
  const writer = (id: string, n: number, status: LaneStatus = "done") =>
    lane(id, status, { taskId: id, startedAt: at(0), ...(status === "done" ? { endedAt: at(15) } : {}), pr: pr(n, "reviewing") });
  const checker = (id: string, n: number, status: LaneStatus, role: AgentLane["role"] = "reviewer") =>
    lane(id, status, { role, pr: pr(n, "reviewing"), startedAt: at(16), ...(status === "done" ? { endedAt: at(24) } : {}) });

  it("puts each PR's checkers under it and counts checks from the lanes the rows show", () => {
    const seen = [writer("T1", 221), writer("T2", 222, "working"), checker("R1", 221, "done"), checker("R2", 221, "working"), checker("V1", 221, "working", "verifier")];
    const rows = seen.filter((l) => l.status !== "done");
    const f = fleet(rows, seen, [pr(222, "reviewing", { taskId: "T2" }), pr(221, "reviewing", { taskId: "T1" })]);
    expect(f.groups.map((g) => g.pr.number)).toEqual([221, 222]);
    const g221 = f.groups[0];
    expect(g221?.rows.map((l) => l.laneId)).toEqual(["R2", "V1"]);
    // "review 0/3 while 1 done" was the bug: the label counts the finished check.
    expect(g221 && groupLabel(g221)).toBe("review 1/3");
    expect(g221 && writtenIn(g221)).toBe("written in 0:15");
    // A writer still at work on its PR is grouped, not listed again as a loose writer.
    expect(f.writers).toEqual([]);
  });

  it("a ready PR's track and words agree", () => {
    const seen = [checker("R1", 117, "done"), checker("R2", 117, "done"), checker("R3", 117, "done")];
    const g = fleet([], seen, [pr(117, "ready", { reviewsDone: 1 })]).groups[0];
    expect(g && groupLabel(g)).toBe("reviewed");
    expect(g && reviewProgress(g)).toBe(1);
  });

  it("is finished once every PR merged and nobody is at work", () => {
    expect(finished([lane("a", "done")], [pr(1, "merged")])).toBe(true);
    expect(finished([lane("a", "working")], [pr(1, "merged")])).toBe(false);
    expect(finished([], [])).toBe(false);
    expect(finishHeadline(3, false, 111_000, 12)).toBe("merged 3/3 · lead closing · 1:51 · 12 agents");
    expect(finishHeadline(1, true, undefined, 1)).toBe("1 PR merged · 1 agent");
  });
});


group("needs you", () => {
  it("comes from the live ask state, not the card's last phase", () => {
    const c = card("W1", [lane("T1", "working")], { phase: "waiting_on_you", needsYou: 1 });
    const answered = world({ orders: [c] }).orders?.[0];
    expect(answered?.phase.phase).toBe("working");
    const asked = world({ orders: [c], asks: [askOf("A1", "W1")] }).orders?.[0];
    expect(asked?.phase.phase).toBe("waiting_on_you");
    expect(asked && phaseLabel(asked.phase, asked.lanes)).toBe("needs you · 1 question");
  });

  it("puts the project that needs you first", () => {
    const m = model({
      orders: [card("W1", [lane("T1", "working")], { updatedAt: at(9) }), card("W2", [], { projectRef: OTHER, updatedAt: at(1) })],
      asks: [askOf("A1", "W2")],
    });
    const items = listItems(m, ms(10));
    expect(items.flatMap((i) => (i.kind === "project" ? [i.title] : []))).toEqual(["other", "storefront"]);
  });
});

group("the board's rows", () => {
  it("stages a lone open order with a header that counts the rows under it", () => {
    const m = model({ orders: [card("W14", [lane("T1", "working"), lane("T2", "working"), lane("R1", "working", { role: "reviewer" })])] });
    const staged = stagedOrder(m, ms(30));
    expect(staged?.card.workstreamId).toBe("W14");
    if (!staged) return;
    const seen = seenLanes(m.data, staged.view);
    const items = stageItems(m, staged, heldLanes(seen, ms(30)), seen);
    const head = items.find((i) => i.kind === "stageHead");
    expect(head?.kind === "stageHead" && head.text).toBe("2 writing · 1 reviewing");
    expect(items.filter((i) => i.kind === "lane")).toHaveLength(3);
  });

  it("shows the finish once every PR merged, counting the agents only the order's detail lists", () => {
    const merged = [pr(221, "merged", { taskId: "T1" }), pr(222, "merged", { taskId: "T2" })];
    const done = (id: string, end: number) => lane(id, "done", { taskId: id, startedAt: at(1), endedAt: at(end) });
    const c = card("W14", [], { prs: merged, phase: "merging" });
    const m = model({ orders: [c], done: { W14: [done("T1", 60), done("T2", 111)] } });
    const staged = stagedOrder(m, ms(200));
    if (!staged) throw new Error("not staged");
    const seen = seenLanes(m.data, staged.view);
    const items = stageItems(m, staged, heldLanes(seen, ms(200)), seen);
    const finish = items.find((i) => i.kind === "finish");
    expect(finish?.kind === "finish" && finish.headline).toBe("merged 2/2 · lead closing · 1:51 · 2 agents");
    expect(items.filter((i) => i.kind === "finishPr")).toHaveLength(2);
    const title = items[0];
    expect(title?.kind === "stageTitle" && title.note).toBeUndefined();
  });

  it("is loading, never empty, until the data layer has the projects and the board", () => {
    expect(listItems(model({ projects: "none", orders: [] }), ms(0))).toEqual([{ kind: "empty", why: "no-projects" }]);
    expect(listItems(model({ orders: [] }), ms(0))).toEqual([{ kind: "empty", why: "idle" }]);
    expect(listItems(model({ orders: undefined }), ms(0))).toEqual([{ kind: "empty", why: "loading" }]);
  });

  it("holds a finished lane with its check, then lets it go; a failed one stays", () => {
    const l = lane("R1", "done", { endedAt: at(10) });
    expect(heldLanes([l], ms(17))).toHaveLength(1);
    expect(heldLanes([l], ms(18))).toHaveLength(0);
    expect(heldLanes([lane("X", "done")], ms(0))).toHaveLength(0);
    expect(heldLanes([lane("F", "failed", { endedAt: at(0) })], ms(600))).toHaveLength(1);
  });

  it("stage pick: the only open order, else the last to finish, none while two run", () => {
    const a = card("W1", [], { phase: "working" });
    const b = card("W2", [], { phase: "done", updatedAt: at(5) });
    const c = card("W3", [], { phase: "done", updatedAt: at(9) });
    expect(stagePick([a, b])?.workstreamId).toBe("W1");
    expect(stagePick([b, c])?.workstreamId).toBe("W3");
    expect(stagePick([a, { ...b, phase: "reviewing" }])).toBeUndefined();
  });

  it("keeps rows where the eye left them", () => {
    expect(hold(["a", "b", "c"], ["c", "x", "a"])).toEqual(["a", "c", "x"]);
  });
});

group("live lanes", () => {
  it("a lane the feed finished has an end time before the hub's own, so its check can hold", () => {
    const d = world({
      orders: [card("W1", [lane("T1", "working", { startedAt: T0 })])],
      frames: [frame(1, true, [live("T1", "working")]), frame(5, false, [live("T1", "done")])],
    });
    const t1 = d.orders?.[0]?.lanes[0];
    expect([t1?.status, t1?.endedAt]).toEqual(["done", at(5)]);
    expect(needsClock(d, ms(10))).toBe(true);
    expect(needsClock(d, ms(30))).toBe(false);
  });

  it("a machine's running count is the agents the board draws there", () => {
    const on = (id: string, status: LaneStatus, machineId: string, role: AgentLane["role"] = "implementer") =>
      lane(id, status, { role, threadRef: { machineId, threadId: `s-${id}` } });
    const d = world({ orders: [card("W1", [on("T1", "working", "devbox"), on("T2", "queued", "devbox"), on("L", "working", "devbox", "lead")])] });
    expect(machinesNow(d)?.find((m) => m.machineId === "devbox")?.running).toBe(1);
  });

  it("merged chips: old news on the first look, a new merge stays 10 s", () => {
    const chip = (state: PrRef["state"]) => ({ changeId: "X9", number: 9, url: "u", workstreamId: "W1", state });
    const first = noteMerged(undefined, [chip("merged")], ms(0));
    expect(visibleChips([chip("merged")], first, ms(1))).toEqual([]);
    const before = noteMerged(undefined, [chip("ci")], ms(0));
    const after = noteMerged(before, [chip("merged")], ms(30));
    expect(visibleChips([chip("merged")], after, ms(35)).map((c) => [c.chip.changeId, c.leaving])).toEqual([["X9", false]]);
    expect(visibleChips([chip("merged")], after, ms(41))).toEqual([]);
    expect(noteMerged(after, [chip("merged")], ms(50))).toBe(after);
  });
});

group("activity bars", () => {
  it("draw only the lane's own life, at one fixed scale", () => {
    const b = bars({ endAt: at(10), samples: [0, 64, 128] }, ms(4));
    expect(b.slots).toBe(15);
    expect(b.heights.slice(-3)).toEqual([0, 1, 1]);
    expect(b.heights.filter((h) => h < 0)).toHaveLength(12);
    expect(unlived(ms(60), undefined)).toBe(0);
  });
});

group("machine strip", () => {
  it("says only what the machine reports", () => {
    const parts = machineParts(
      {
        machineId: "devbox",
        name: "devbox",
        status: "online",
        running: 7,
        asOf: T0,
        load: { cpus: 32, load1: 3.24, memUsedPct: 41, limits: [{ limitType: "five_hour", utilization: 0.58, status: "allowed" }, { limitType: "seven_day", utilization: 0.41, status: "allowed_warning" }] },
      },
      ms(0),
    );
    expect(parts.map(([t]) => t)).toEqual(["7 running", "load 3.2/32", "mem 41%", "claude 58% 5h · 41% wk"]);
    expect(parts[3]?.[1]).toBe("warning");
    expect(machineParts({ machineId: "b", name: "buildbox", status: "offline", running: 0, asOf: T0 }, ms(720))).toEqual([["offline 12 m", "warning"]]);
  });
});

group("composer rules", () => {
  const targets: Target[] = [{ key: KEY, machineId: "devbox", projectId: "storefront", title: "storefront", machine: "devbox", offline: false }];

  it("reads a type prefix and an @project prefix like the hub", () => {
    expect(templateFromPrefix("fix: totals round twice")).toBe("bugfix");
    expect(templateFromPrefix("  research: why")).toBe("research");
    expect(templateFromPrefix("finish: all of it")).toBe("finish-all");
    expect(templateFromPrefix("round totals: once")).toBeUndefined();
    expect(projectPrefix("@storefront round totals", targets)?.key).toBe(KEY);
    expect(projectPrefix("@nope round", targets)).toBeUndefined();
  });

  it("picks the target in order: chosen, prefix, selected, guess, last used, any", () => {
    const base = { chosen: undefined, text: "x", targets, selected: undefined, guess: undefined, lastUsed: undefined };
    expect(resolveTarget(base)).toEqual({ key: undefined, source: "any" });
    expect(resolveTarget({ ...base, lastUsed: "a/b" })).toEqual({ key: "a/b", source: "last" });
    expect(resolveTarget({ ...base, lastUsed: "a/b", guess: "c/d" })).toEqual({ key: "c/d", source: "guess" });
    expect(resolveTarget({ ...base, guess: "c/d", selected: "e/f" })).toEqual({ key: "e/f", source: "selected" });
    expect(resolveTarget({ ...base, selected: "e/f", text: "@storefront go" })).toEqual({ key: KEY, source: "prefix" });
    expect(resolveTarget({ ...base, text: "@storefront go", chosen: null })).toEqual({ key: undefined, source: "any" });
  });

  it("finds the @query at the caret", () => {
    expect(mentionAt("see @src/ca", 11)).toEqual({ start: 4, query: "src/ca" });
    expect(mentionAt("mail a@b", 8)).toBeUndefined();
    expect(mentionAt("@x y", 4)).toBeUndefined();
  });

  it("refuses empty and over-long orders with the reason", () => {
    expect(checkText("  ")).toEqual({ ok: false, reason: "Write the order first." });
    expect(checkText("é".repeat(2001)).ok).toBe(false);
    expect(checkText(" go ")).toEqual({ ok: true, text: "go" });
    expect(changedChars("round totals", "round the totals")).toBe(4);
  });
});


group("review #188 regressions", () => {
  it("2: the slot count and each machine's running come from the same lanes, leads said apart", () => {
    const on = (id: string, status: LaneStatus) => lane(id, status, { threadRef: { machineId: "devbox", threadId: `s-${id}` } });
    const d = world({
      orders: [card("W1", [on("T1", "working"), on("T2", "queued")])],
      frames: [frame(0, true, [live("lead:devbox/storefront", "working")])],
    });
    const use = slotUse(d);
    expect(machinesNow(d)?.find((m) => m.machineId === "devbox")?.running).toBe(use.agents);
    expect(slotsText(40, use)).toBe("slots 2/40 (1 lead) · 1 queued");
    expect(slotsText(40, { agents: 0, leads: 0, queued: 0 })).toBe("slots 0/40");
  });

  it("3: a command reaches the row whole, and the row's cut is one ellipsis in the middle", () => {
    const text = "npm test -- cart --reporter=dot --run src/cart/total.test.ts src/cart/discounts.test.ts";
    const l = lane("T1", "working", { live: live("T1", "working", { activity: { activity: { kind: "command", text }, since: T0 } }) });
    expect(describe(l).machine).toBe(text);
    const cut = middleEllipsis(text, 40);
    expect(cut.split("…")).toHaveLength(2);
    expect(cut.startsWith("npm test")).toBe(true);
    expect(cut.endsWith("discounts.test.ts")).toBe(true);
  });

  it("4: a failed writer the header counts has its row, from the card or the order's detail", () => {
    const p = pr(221, "reviewing", { taskId: "T1" });
    const failed = lane("T1", "failed", { taskId: "T1", statusReason: "tests failed", endedAt: at(5), pr: p });
    const reviewer = lane("R1", "working", { role: "reviewer", pr: pr(221, "reviewing") });
    const m = model({ orders: [card("W1", [reviewer], { prs: [p] })], done: { W1: [failed] } });
    const staged = stagedOrder(m, ms(600));
    if (!staged) throw new Error("not staged");
    const seen = seenLanes(m.data, staged.view);
    const items = stageItems(m, staged, heldLanes(seen, ms(600)), seen);
    const head = items.find((i) => i.kind === "stageHead");
    expect(head?.kind === "stageHead" && head.text).toBe("1 failed · 1 reviewing");
    expect(items.flatMap((i) => (i.kind === "lane" ? [i.lane.laneId] : []))).toEqual(["T1", "R1"]);
  });

  it("5: a refetch that re-sorts by activity doesn't move the rows; a new question does", () => {
    const w1 = (u: string) => card("W1", [], { updatedAt: u });
    const w2 = (u: string) => card("W2", [], { projectRef: OTHER, updatedAt: u });
    const order = (r: ReturnType<typeof stableOrder>) => r.items.map(itemKey).filter((k) => k.startsWith("card:"));
    const first = stableOrder(listItems(model({ orders: [w1(at(9)), w2(at(1))] }), ms(10)), undefined);
    expect(order(first)).toEqual(["card:W1", "card:W2"]);
    // W2 is now the more recent: the fresh sort would swap them; the held order doesn't.
    const second = stableOrder(listItems(model({ orders: [w1(at(9)), w2(at(20))] }), ms(30)), first.held);
    expect(order(second)).toEqual(["card:W1", "card:W2"]);
    // W2 needs you: that change re-sorts, and it rises.
    const third = stableOrder(listItems(model({ orders: [w1(at(9)), w2(at(20))], asks: [askOf("A1", "W2")] }), ms(30)), second.held);
    expect(order(third)).toEqual(["card:W2", "card:W1"]);
  });
});
