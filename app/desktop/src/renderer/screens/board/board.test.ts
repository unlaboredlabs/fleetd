import { describe as group, expect, it } from "vitest";
import { bars, unlived } from "./bars";
import { changedChars, checkText, mentionAt, projectPrefix, resolveTarget, templateFromPrefix, type Target } from "./composerLogic";
import type { AgentLane, AskSummary, LaneStatus, LiveFrame, LiveLane, OrderCard, OrdersBoardOutput, PrRef, TrainLive } from "./contracts";
import { finishHeadline, finished, fleet, groupLabel, hold, livePhase, phaseLabel, reviewProgress, stagePick, writtenIn } from "./fleet";
import { fmtElapsed, fmtTokens, middleEllipsis, shortModel } from "./format";
import { EMPTY, applyFrame, machines, needsClock, orderLanes, seenLanes, setBoard, setDone, slotUse, trains } from "./live";
import { type BoardModel, itemKey, listItems, stableOrder, stageItems, stagedOrder } from "./model";
import { heldLanes, stageDrawn } from "./presence";
import { visibleChips } from "./Strips";
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
  changeId: `C${number}`,
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
const board = (orders: OrderCard[], s = 0, trainsList: TrainLive[] = []): OrdersBoardOutput => ({ orders, trains: trainsList, at: at(s) });
const KEY = "devbox/storefront" as const;

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
    const c = card("W1", [lane("T1", "working")], { phase: "waiting_on_you" });
    const lanes = c.lanes;
    expect(livePhase(c, lanes, 1)).toBe("waiting_on_you");
    // The ask was answered: the amber goes with it, the lanes say what the order is doing.
    expect(livePhase(c, lanes, 0)).toBe("working");
    expect(livePhase(card("W2", [lane("T1", "working")]), [lane("T1", "waiting")], 0)).toBe("waiting_on_you");
    expect(phaseLabel("waiting_on_you", c, lanes, 2)).toBe("needs you · 2 questions");
  });

  it("puts the project that needs you first", () => {
    const asks: AskSummary[] = [{ askId: "A1", workstreamId: "W2", state: "open", text: "Which currency?" }];
    let s = setBoard(EMPTY, KEY, board([card("W1", [lane("T1", "working")], { updatedAt: at(9) })]));
    s = setBoard(s, "lab/other", board([card("W2", [], { projectRef: { machineId: "lab", projectId: "other" }, updatedAt: at(1) })]));
    const m: BoardModel = {
      conn: "live",
      snapshot: true,
      projects: [
        { key: KEY, machineId: "devbox", projectId: "storefront", title: "storefront", machine: "devbox", offline: false },
        { key: "lab/other", machineId: "lab", projectId: "other", title: "other", machine: "lab", offline: false },
      ],
      live: s,
      asks,
      loaded: new Set([KEY, "lab/other"]),
      errors: new Map(),
      sent: [],
    };
    const items = listItems(m, ms(10));
    expect(items.flatMap((i) => (i.kind === "project" ? [i.title] : []))).toEqual(["other", "storefront"]);
    const w2 = items.find((i) => i.kind === "card" && i.card.workstreamId === "W2");
    expect(w2?.kind === "card" && w2.phase).toBe("waiting_on_you");
  });
});

group("the board's rows", () => {
  const model = (orders: OrderCard[], extra: Partial<BoardModel> = {}): BoardModel => ({
    conn: "live",
      snapshot: true,
    projects: [{ key: KEY, machineId: "devbox", projectId: "storefront", title: "storefront", machine: "devbox", offline: false }],
    live: setBoard(EMPTY, KEY, board(orders)),
    asks: [],
    loaded: new Set([KEY]),
    errors: new Map(),
    sent: [],
    ...extra,
  });

  it("stages a lone open order with a header that counts the rows under it", () => {
    const m = model([card("W14", [lane("T1", "working"), lane("T2", "working"), lane("R1", "working", { role: "reviewer" })])]);
    const staged = stagedOrder(m, ms(30));
    expect(staged?.card.workstreamId).toBe("W14");
    if (!staged) return;
    const items = stageItems(m, staged, heldLanes(staged.lanes, ms(30)), seenLanes(m.live, "W14"));
    const head = items.find((i) => i.kind === "stageHead");
    expect(head?.kind === "stageHead" && head.text).toBe("2 writing · 1 reviewing");
    expect(items.filter((i) => i.kind === "lane")).toHaveLength(3);
  });

  it("shows the finish once every PR merged, with every agent the order had", () => {
    const merged = [pr(221, "merged", { taskId: "T1" }), pr(222, "merged", { taskId: "T2" })];
    const done = (id: string, end: number) => lane(id, "done", { taskId: id, startedAt: at(1), endedAt: at(end) });
    const m = model([card("W14", [done("T1", 60), done("T2", 111)], { prs: merged, phase: "merging" })]);
    const staged = stagedOrder(m, ms(200));
    if (!staged) throw new Error("not staged");
    const items = stageItems(m, staged, heldLanes(staged.lanes, ms(200)), seenLanes(m.live, "W14"));
    const finish = items.find((i) => i.kind === "finish");
    expect(finish?.kind === "finish" && finish.headline).toBe("merged 2/2 · lead closing · 1:51 · 2 agents");
    expect(items.filter((i) => i.kind === "finishPr")).toHaveLength(2);
    // No raw lead note under a finished order.
    const title = items[0];
    expect(title?.kind === "stageTitle" && title.note).toBeUndefined();
  });

  it("points an empty board at adding a project, and an idle one at the composer", () => {
    expect(listItems({ ...model([]), projects: [], loaded: new Set() }, ms(0))).toEqual([{ kind: "empty", why: "no-projects" }]);
    expect(listItems(model([]), ms(0))).toEqual([{ kind: "empty", why: "idle" }]);
    expect(listItems({ ...model([]), loaded: new Set() }, ms(0))).toEqual([{ kind: "empty", why: "loading" }]);
    // Before the snapshot says which projects there are, nothing is known to be empty.
    expect(listItems({ ...model([]), projects: [], loaded: new Set(), snapshot: false }, ms(0))).toEqual([{ kind: "empty", why: "loading" }]);
  });

  it("holds a finished lane with its check, then lets it go", () => {
    const l = lane("R1", "done", { endedAt: at(10) });
    expect(heldLanes([l], ms(17))).toHaveLength(1);
    expect(heldLanes([l], ms(18))).toHaveLength(0);
    expect(heldLanes([lane("X", "done")], ms(0))).toHaveLength(0);
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

group("live state", () => {
  it("merges live values over the snapshot and keeps sparks until replaced", () => {
    let s = setBoard(EMPTY, KEY, board([card("W1", [lane("T1", "starting"), lane("T2", "queued")])]));
    s = applyFrame(s, frame(1, true, [live("T1", "working", { spark: { endAt: at(1), samples: [1, 2] } })]), ms(1));
    s = applyFrame(s, frame(2, false, [live("T1", "working")]), ms(2));
    const lanes = orderLanes(s, "W1");
    expect(lanes[0]?.status).toBe("working");
    expect(lanes[0]?.live?.spark?.samples).toHaveLength(2);
    expect(lanes[1]?.live).toBeUndefined();
  });

  it("a snapshot that says ended beats a live value left behind", () => {
    let s = applyFrame(EMPTY, frame(1, true, [live("T1", "working")]), ms(1));
    s = setBoard(s, KEY, board([card("W1", [lane("T1", "done")])]));
    expect(orderLanes(s, "W1")[0]?.status).toBe("done");
  });

  it("a lane that leaves its card stays where it was while the feed says how it ended", () => {
    let s = setBoard(EMPTY, KEY, board([card("W1", [lane("T1", "working"), lane("T2", "working")])], 0));
    s = applyFrame(s, frame(1, true, [live("T1", "working"), live("T2", "working")]), ms(1));
    s = applyFrame(s, frame(5, false, [live("T1", "done")]), ms(5));
    s = setBoard(s, KEY, board([card("W1", [lane("T2", "working")])], 6));
    const lanes = orderLanes(s, "W1");
    expect(lanes.map((l) => [l.laneId, l.status])).toEqual([["T1", "done"], ["T2", "working"]]);
    expect(lanes[0]?.endedAt).toBe(at(5));
    // The finish counts it after the card has long forgotten it, and the detail's finished lanes too.
    s = setBoard(s, KEY, board([card("W1", [])], 200));
    s = setDone(s, "W1", [lane("T0", "done"), lane("T1", "done")]);
    expect(seenLanes(s, "W1").map((l) => [l.laneId, l.status]).sort()).toEqual([["T0", "done"], ["T1", "done"], ["T2", "working"]]);
  });

  it("a machine's running count is the agents the board draws there", () => {
    const on = (id: string, status: LaneStatus, machineId: string, role: AgentLane["role"] = "implementer") =>
      lane(id, status, { role, threadRef: { machineId, threadId: `s-${id}` } });
    let s = applyFrame(EMPTY, frame(0, true, [], { machines: [{ machineId: "devbox", name: "devbox", status: "online", running: 9, asOf: T0 }] }), ms(0));
    s = setBoard(s, KEY, board([card("W1", [on("T1", "working", "devbox"), on("T2", "queued", "devbox"), on("L", "working", "devbox", "lead")])]));
    expect(machines(s)[0]?.running).toBe(1);
  });

  it("one train per repo, the newest snapshot wins; merges seen on first load are old news", () => {
    const train = (merged: number, state: PrRef["state"] = "ci"): TrainLive => ({
      repo: "acme/storefront",
      frozen: false,
      chips: [{ changeId: "C9", number: 9, url: "u", workstreamId: "W1", state }],
      mergedToday: merged,
    });
    let s = setBoard(EMPTY, "lab/b", board([], 5, [train(2, "merged")]));
    s = setBoard(s, KEY, board([], 0, [train(1)]));
    expect(trains(s)).toHaveLength(1);
    expect(trains(s)[0]?.mergedToday).toBe(2);
    expect(s.mergedAt.get("C9")).toBe(0);
    expect(visibleChips(train(2, "merged").chips, s.mergedAt, ms(1))).toEqual([]);
    // A merge that happens while watching stays 10 s, then leaves.
    let t = setBoard(EMPTY, KEY, board([], 0, [train(0)]));
    t = setBoard(t, KEY, board([], 30, [train(1, "merged")]));
    expect(visibleChips(train(1, "merged").chips, t.mergedAt, ms(35)).map((c) => [c.chip.changeId, c.leaving])).toEqual([["C9", false]]);
    expect(visibleChips(train(1, "merged").chips, t.mergedAt, ms(41))).toEqual([]);
  });

  it("the clock runs only while something changes with time", () => {
    const s = setBoard(EMPTY, KEY, board([card("W1", [lane("T1", "done", { endedAt: at(10) })])]));
    expect(needsClock(s, ms(12))).toBe(true);
    expect(needsClock(s, ms(30))).toBe(false);
    expect(needsClock(setBoard(EMPTY, KEY, board([card("W1", [lane("T1", "working", { startedAt: T0 })])])), ms(99))).toBe(true);
  });

  it("skew takes the least delayed frame and resets on a full one", () => {
    let s = applyFrame(EMPTY, frame(0, true, []), ms(0) - 5000 + 300);
    s = applyFrame(s, frame(0, false, []), ms(0) - 5000 + 50);
    expect(s.skewMs).toBe(4950);
    s = applyFrame(s, frame(0, true, []), ms(0));
    expect(s.skewMs).toBe(0);
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
  const model = (orders: OrderCard[], live = setBoard(EMPTY, KEY, board(orders))): BoardModel => ({
    conn: "live",
    snapshot: true,
    projects: [
      { key: KEY, machineId: "devbox", projectId: "storefront", title: "storefront", machine: "devbox", offline: false },
      { key: "lab/other", machineId: "lab", projectId: "other", title: "other", machine: "lab", offline: false },
    ],
    live,
    asks: [],
    loaded: new Set([KEY, "lab/other"]),
    errors: new Map(),
    sent: [],
  });

  it("2: the slot count and each machine's running come from the same lanes, leads said apart", () => {
    const on = (id: string, status: LaneStatus) => lane(id, status, { threadRef: { machineId: "devbox", threadId: `s-${id}` } });
    let s = applyFrame(EMPTY, frame(0, true, [live("lead:devbox/storefront", "working")], { machines: [{ machineId: "devbox", name: "devbox", status: "online", running: 9, asOf: T0 }] }), ms(0));
    s = setBoard(s, KEY, board([card("W1", [on("T1", "working"), on("T2", "queued"), on("T3", "done")])]));
    const use = slotUse(s);
    expect(machines(s)[0]?.running).toBe(use.agents);
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

  it("4: a failed writer the header counts has its row, on the stage and after the hold", () => {
    const failed = lane("T1", "failed", { taskId: "T1", statusReason: "tests failed", endedAt: at(5), pr: pr(221, "reviewing", { taskId: "T1" }) });
    const m = model([card("W1", [failed, lane("R1", "working", { role: "reviewer", pr: pr(221, "reviewing") })], { prs: [pr(221, "reviewing", { taskId: "T1" })] })]);
    const staged = stagedOrder(m, ms(60));
    if (!staged) throw new Error("not staged");
    const seen = seenLanes(m.live, "W1");
    const drawn = stageDrawn(staged.lanes, seen, ms(60));
    const items = stageItems(m, staged, drawn, seen);
    const head = items.find((i) => i.kind === "stageHead");
    expect(head?.kind === "stageHead" && head.text).toBe("1 failed · 1 reviewing");
    expect(items.flatMap((i) => (i.kind === "lane" ? [i.lane.laneId] : []))).toEqual(["T1", "R1"]);
    // Gone from the card, the failure is still drawn from what the order has had.
    expect(stageDrawn([], [failed], ms(600)).map((l) => l.laneId)).toEqual(["T1"]);
  });

  it("5: a refetch that re-sorts by activity doesn't move the rows; a new question does", () => {
    const other = (updatedAt: string) => card("W2", [], { projectRef: { machineId: "lab", projectId: "other" }, updatedAt });
    const both = (a: string, b: string) => {
      let s = setBoard(EMPTY, KEY, board([card("W1", [], { updatedAt: a })]));
      s = setBoard(s, "lab/other", board([other(b)]));
      return model([], s);
    };
    const first = stableOrder(listItems(both(at(9), at(1)), ms(10)), undefined);
    const order = (r: ReturnType<typeof stableOrder>) => r.items.map(itemKey).filter((k) => k.startsWith("card:"));
    expect(order(first)).toEqual(["card:W1", "card:W2"]);
    // W2 is now the more recent: the fresh sort would swap them; the held order doesn't.
    const second = stableOrder(listItems(both(at(9), at(20)), ms(30)), first.held);
    expect(order(second)).toEqual(["card:W1", "card:W2"]);
    // W2 needs you: that change re-sorts, and it rises.
    const asked: BoardModel = { ...both(at(9), at(20)), asks: [{ askId: "A1", workstreamId: "W2", state: "open", text: "Which currency?" }] };
    const third = stableOrder(listItems(asked, ms(30)), second.held);
    expect(order(third)).toEqual(["card:W2", "card:W1"]);
  });
});
