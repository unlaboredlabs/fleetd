import { describe as group, expect, it } from "vitest";
import type { HubEvent } from "../../../shared/contracts";
import { describe, groups, hubWideFor, inFeed, layout, linesOf, typesFor, unreadCount, type ActivityKind, type Row } from "./model";

const project = { machineId: "devbox", projectId: "storefront" } as const;
const NOW = Date.parse("2026-10-19T15:00:00.000Z");
const TZ = "UTC";

let seq = 0;
const ev = (type: string, at: string, data?: Record<string, unknown>, summary: string = type): HubEvent => ({
  seq: ++seq,
  at,
  type,
  summary,
  ...project,
  ...(data === undefined ? {} : { data }),
});
const today = (hhmm: string) => `2026-10-19T${hhmm}:00.000Z`;
const yesterday = (hhmm: string) => `2026-10-18T${hhmm}:00.000Z`;

const review = (at: string, pr: number, blocking = 0) =>
  ev("review.verdict", at, { taskId: `T${pr}0`, workstreamId: "W1", blocking, pr: `https://github.com/acme/storefront/pull/${pr}` });

/** The rows as short strings: "day:Today", "since", "line:<text>", "run:<label>" (+ "open"), "  child:<text>". */
const shape = (rows: readonly Row[]): string[] =>
  rows.map((r) =>
    r.t === "day" ? `day:${r.label}` : r.t === "since" ? "since" : r.t === "run" ? `run:${r.label}${r.open ? " open" : ""}` : `${r.child === true ? "  child" : "line"}:${r.line.text}`,
  );

group("describe", () => {
  it("words an agent's start and end, linking to the agent, with the title as the detail", () => {
    const started = describe(ev("task.started", today("10:00"), { taskId: "T12", workstreamId: "W3" }, "T12 started (high): Fix receipt dates"));
    expect(started).toMatchObject({ text: "T12 started", detail: "Fix receipt dates", link: { tab: "agents", agent: "T12" }, icon: "started" });
    const failed = describe(ev("task.failed", today("10:30"), { taskId: "T12" }, "T12 failed: Fix receipt dates"));
    expect(failed).toMatchObject({ text: "T12 failed", tone: "failed", detail: "Fix receipt dates" });
  });

  it("links reviews and merges to their PR", () => {
    expect(describe(review(today("10:00"), 31, 2))).toMatchObject({
      text: "Review of #31: 2 blocking findings",
      tone: "needs-you",
      link: { tab: "prs", pr: { repo: "acme/storefront", number: 31 } },
    });
    expect(describe(review(today("10:00"), 31))).toMatchObject({ text: "Review of #31 passed", tone: "done" });
    const merged = describe(ev("pr.merged", today("11:00"), { repo: "acme/storefront", prNumber: 31, base: "main" }));
    expect(merged).toMatchObject({ text: "Merged #31 into main", link: { tab: "prs", pr: { repo: "acme/storefront", number: 31 } } });
    const refused = describe(ev("change.refused", today("11:00"), { prUrl: "https://github.com/acme/storefront/pull/7", fix: "Open it from a fleetd/ branch." }));
    expect(refused).toMatchObject({ text: "#7 refused by the merge train", detail: "Open it from a fleetd/ branch.", tone: "failed" });
  });

  it("names a secret by its key and never anything else", () => {
    const asked = describe(ev("request.opened", today("09:00"), { requestId: "R4", kind: "secret", state: "open" }, "R4 open: secret STRIPE_KEY"));
    expect(asked).toMatchObject({ text: "Secret asked for", detail: "STRIPE_KEY", tone: "needs-you" });
    const stored = describe(ev("request.updated", today("09:05"), { requestId: "R4", kind: "secret", state: "stored" }, "R4 stored: secret STRIPE_KEY"));
    expect(stored).toMatchObject({ text: "Secret stored", detail: "STRIPE_KEY" });
  });

  it("words approvals asked and answered", () => {
    const asked = describe(ev("request.opened", today("09:00"), { requestId: "R5", kind: "approval", state: "open" }, "R5 open: pnpm publish"));
    expect(asked).toMatchObject({ text: "Approval asked", detail: "pnpm publish", icon: "approval" });
    const ran = describe(ev("request.updated", today("09:10"), { requestId: "R5", kind: "approval", state: "ran" }, "R5 ran: pnpm publish"));
    expect(ran).toMatchObject({ text: "Approved command ran" });
  });

  it("names a folded request by what it asks for", () => {
    const lines = linesOf([
      ev("request.opened", today("09:00"), { requestId: "R4", kind: "secret", state: "open" }, "R4 open: secret STRIPE_KEY"),
      ev("request.updated", today("09:05"), { requestId: "R4", kind: "secret", state: "stored" }, "R4 stored: secret STRIPE_KEY"),
      ev("request.opened", today("09:10"), { requestId: "R5", kind: "approval", state: "open" }, "R5 open: pnpm publish"),
      ev("request.updated", today("09:12"), { requestId: "R5", kind: "approval", state: "denied" }, "R5 denied: pnpm publish"),
    ]);
    expect(shape(layout(lines, { nowMs: NOW, timeZone: TZ }))).toEqual(["day:Today", "run:Approval: pnpm publish", "run:Secret STRIPE_KEY"]);
  });

  it("leaves out what isn't activity", () => {
    expect(describe(ev("chat.message", today("10:00")))).toBeUndefined();
    expect(describe(ev("app.presence", today("10:00")))).toBeUndefined();
  });
});

group("filters", () => {
  it("reads every kind's types when none is chosen, and only the chosen kinds' otherwise", () => {
    const all = typesFor(new Set());
    expect(all).toContain("task.started");
    expect(all).toContain("pr.merged");
    expect(all).toContain("key.paired");
    expect(typesFor(new Set<ActivityKind>(["reviews"]))).toEqual(["review.verdict"]);
    expect(typesFor(new Set<ActivityKind>(["merges", "reviews"]))).toEqual(typesFor(new Set<ActivityKind>(["reviews", "merges"])));
  });

  it("takes the hub's own events only while Other shows", () => {
    expect(hubWideFor(new Set())).toBe(true);
    expect(hubWideFor(new Set<ActivityKind>(["other"]))).toBe(true);
    expect(hubWideFor(new Set<ActivityKind>(["agents"]))).toBe(false);
  });

  it("keeps a streamed event when it is this project's and of a shown kind", () => {
    const started = ev("task.started", today("10:00"), { taskId: "T1" });
    expect(inFeed(started, project, new Set())).toBe(true);
    expect(inFeed(started, project, new Set<ActivityKind>(["agents"]))).toBe(true);
    expect(inFeed(started, project, new Set<ActivityKind>(["merges"]))).toBe(false);
    expect(inFeed({ ...started, projectId: "other" }, project, new Set())).toBe(false);
    expect(inFeed({ ...started, machineId: "laptop" }, project, new Set())).toBe(false);
    expect(inFeed(ev("chat.message", today("10:00")), project, new Set())).toBe(false);
    const { machineId: _m, projectId: _p, ...paired } = ev("key.paired", today("10:00"), { deviceName: "phone" });
    expect(inFeed(paired, project, new Set())).toBe(true);
    expect(inFeed(paired, project, new Set<ActivityKind>(["agents"]))).toBe(false);
  });
});

group("grouping and collapsing", () => {
  it("puts each day's name over its lines, newest first, and drops repeats", () => {
    const a = ev("task.started", yesterday("16:00"), { taskId: "T1" });
    const b = ev("task.completed", today("09:00"), { taskId: "T1" });
    const c = ev("pr.merged", today("10:00"), { prNumber: 4 });
    expect(shape(layout(linesOf([a, b, c, b]), { nowMs: NOW, timeZone: TZ }))).toEqual([
      "day:Today",
      "line:Merged #4",
      "line:T1 finished",
      "day:Yesterday",
      "line:T1 started",
    ]);
  });

  it("folds several reviews of one PR in a row into one row, and opens it", () => {
    const lines = linesOf([review(today("09:00"), 31, 2), review(today("09:20"), 31, 1), review(today("09:40"), 31), ev("pr.merged", today("10:00"), { prNumber: 31 })]);
    const folded = layout(lines, { nowMs: NOW, timeZone: TZ });
    expect(shape(folded)).toEqual(["day:Today", "line:Merged #31", "run:3 reviews of #31"]);
    const run = folded.find((r) => r.t === "run");
    expect(run?.t === "run" ? run.lines.map((l) => l.text) : []).toEqual(["Review of #31 passed", "Review of #31: 1 blocking finding", "Review of #31: 2 blocking findings"]);
    const opened = layout(lines, { nowMs: NOW, timeZone: TZ, open: new Set([run?.key ?? ""]) });
    expect(shape(opened)).toEqual([
      "day:Today",
      "line:Merged #31",
      "run:3 reviews of #31 open",
      "  child:Review of #31 passed",
      "  child:Review of #31: 1 blocking finding",
      "  child:Review of #31: 2 blocking findings",
    ]);
  });

  it("keeps a run's key when a newer event joins it, so an open run stays open", () => {
    const first = [review(today("09:00"), 8), review(today("09:10"), 8)];
    const before = groups(linesOf(first), NOW, undefined, TZ);
    const after = groups(linesOf([...first, review(today("09:20"), 8)]), NOW, undefined, TZ);
    expect(before).toHaveLength(1);
    expect(after).toHaveLength(1);
    const keyOf = (g: (typeof before)[number] | undefined) => (g !== undefined && "key" in g ? g.key : undefined);
    expect(keyOf(after[0])).toBeDefined();
    expect(keyOf(after[0])).toBe(keyOf(before[0]));
  });

  it("folds only neighbours: reviews of different PRs, or split by another event, stay apart", () => {
    const lines = linesOf([review(today("09:00"), 1), review(today("09:10"), 2), review(today("09:20"), 1), ev("task.completed", today("09:30"), { taskId: "T9" }), review(today("09:40"), 1)]);
    expect(shape(layout(lines, { nowMs: NOW, timeZone: TZ }))).toEqual([
      "day:Today",
      "line:Review of #1 passed",
      "line:T9 finished",
      "line:Review of #1 passed",
      "line:Review of #2 passed",
      "line:Review of #1 passed",
    ]);
  });

  it("never folds across a day", () => {
    const lines = linesOf([review(yesterday("23:50"), 5), review(today("00:10"), 5)]);
    expect(shape(layout(lines, { nowMs: NOW, timeZone: TZ }))).toEqual(["day:Today", "line:Review of #5 passed", "day:Yesterday", "line:Review of #5 passed"]);
  });

  it("folds agents started for one order, and the train sending one change back", () => {
    const lines = linesOf([
      ev("task.started", today("09:00"), { taskId: "T1", workstreamId: "W2" }),
      ev("task.started", today("09:01"), { taskId: "T2", workstreamId: "W2" }),
      ev("change.ci_failed", today("10:00"), { changeId: "C3", checks: ["test"] }),
      ev("change.needs_rebase", today("10:30"), { changeId: "C3" }),
    ]);
    expect(shape(layout(lines, { nowMs: NOW, timeZone: TZ }))).toEqual(["day:Today", "run:Sent back 2 times", "run:2 agents started"]);
  });
});

group("since you last looked", () => {
  it("sits above the first line already seen, with the newer ones over it", () => {
    const old = ev("task.started", yesterday("10:00"), { taskId: "T1" });
    const seen = ev("task.completed", today("08:00"), { taskId: "T1" });
    const fresh = ev("pr.merged", today("09:00"), { prNumber: 2 });
    const lines = linesOf([old, seen, fresh]);
    expect(shape(layout(lines, { nowMs: NOW, timeZone: TZ, seenSeq: seen.seq }))).toEqual([
      "day:Today",
      "line:Merged #2",
      "since",
      "line:T1 finished",
      "day:Yesterday",
      "line:T1 started",
    ]);
    expect(unreadCount(lines, seen.seq)).toBe(1);
  });

  it("isn't shown when nothing is new, or before the person ever looked", () => {
    const lines = linesOf([ev("task.started", today("08:00"), { taskId: "T1" }), ev("task.completed", today("09:00"), { taskId: "T1" })]);
    const newest = lines[0]?.seq ?? 0;
    expect(shape(layout(lines, { nowMs: NOW, timeZone: TZ, seenSeq: newest }))).not.toContain("since");
    expect(shape(layout(lines, { nowMs: NOW, timeZone: TZ }))).not.toContain("since");
    expect(unreadCount(lines, undefined)).toBe(0);
  });

  it("goes above a day's name when the first seen line starts an older day", () => {
    const seen = ev("task.started", yesterday("10:00"), { taskId: "T1" });
    const fresh = ev("task.completed", today("09:00"), { taskId: "T1" });
    expect(shape(layout(linesOf([seen, fresh]), { nowMs: NOW, timeZone: TZ, seenSeq: seen.seq }))).toEqual([
      "day:Today",
      "line:T1 finished",
      "since",
      "day:Yesterday",
      "line:T1 started",
    ]);
  });

  it("splits a run the divider falls in", () => {
    const a = review(today("09:00"), 3);
    const b = review(today("09:10"), 3);
    const c = review(today("09:20"), 3);
    expect(shape(layout(linesOf([a, b, c]), { nowMs: NOW, timeZone: TZ, seenSeq: b.seq }))).toEqual([
      "day:Today",
      "line:Review of #3 passed",
      "since",
      "run:2 reviews of #3",
    ]);
  });
});
