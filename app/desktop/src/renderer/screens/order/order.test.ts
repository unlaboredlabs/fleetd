import { describe, expect, it } from "vitest";
import { sendModeFor, type KeyLike } from "./composer";
import type { AgentLane, HubEvent, Steer, TailItem } from "./contracts";
import { buildConversation, entryIndexAt, fanOut, foldLabel, mentions, rollup, systemHeadline, type ConversationInput } from "./conversation";
import { jumpFromHash } from "./data";
import { doneRows, doneSummary } from "./doneWhen";
import { clock } from "./format";
import { mergeSteer, receipt, waitingLine } from "./receipts";
import { toldView } from "./told";

const at = (mmss: string) => `2026-10-18T10:${mmss}.000Z`;
const msg = (mmss: string, role: "user" | "assistant" | "system", text: string): TailItem => ({ kind: "message", at: at(mmss), role, text });
const act = (mmss: string, kind: "command" | "file_change", summary: string, failed = false): TailItem => ({
  kind: "action",
  at: at(mmss),
  action: { at: at(mmss), kind, status: failed ? "failed" : "completed", summary, failed },
});
const steer = (id: string, stage: Steer["stage"], over: Partial<Steer> = {}): Steer => ({
  id,
  target: { workstreamId: "W41" },
  workstreamId: "W41",
  thread: { machineId: "devbox", threadId: "t-lead" },
  runId: `run-${id}`,
  by: { kind: "human", keyName: "your console" },
  mode: "queue",
  text: "skip the docs page",
  stage,
  queuedAt: "2026-10-18T14:02:07.120Z",
  ...over,
});
const lane = (laneId: string, status: AgentLane["status"], pr?: number): AgentLane => ({
  laneId,
  role: "implementer",
  taskId: laneId,
  title: laneId,
  status,
  ...(pr === undefined
    ? {}
    : {
        pr: {
          changeId: "X1",
          repo: "acme/storefront",
          number: pr,
          url: `https://github.com/acme/storefront/pull/${pr}`,
          state: "merged",
          reviewsDone: 1,
          reviewsNeeded: 1,
        },
      }),
});
const input = (over: Partial<ConversationInput>): ConversationInput => ({
  tail: [],
  workstreamId: "W14",
  events: [],
  leadWorking: false,
  steers: [],
  sending: [],
  lanes: [],
  ...over,
});

describe("the conversation", () => {
  it("folds finished turns and runs about other orders", () => {
    const conv = buildConversation(
      input({
        tail: [
          msg("02:00", "assistant", "Starting W14."),
          act("02:05", "command", "cargo test"),
          act("02:20", "file_change", "hub/leads/digest.rs"),
          act("02:53", "command", "cargo clippy", true),
          msg("02:55", "assistant", "Froze the brief for W14: 2 checks, tier M."),
          msg("03:00", "assistant", "W12 is in CI."),
          act("03:01", "command", "gh pr checks 208"),
          msg("03:02", "assistant", "W12 rebased."),
          msg("03:10", "assistant", "Waiting on T33's review."),
        ],
      }),
    );
    expect(conv.map((e) => e.kind)).toEqual(["say", "fold", "say", "others", "say"]);
    expect(conv[1]).toMatchObject({ secs: 48, commands: 2, failed: 1 });
    expect(conv[3]).toMatchObject({ n: 2, about: "W12" });
    expect(foldLabel(53, 2, 1, 3)).toBe("Worked for 53s · ran 2 commands (1 failed)");
    expect(foldLabel(125, 0, 0, 1)).toBe("Worked for 2m 05s · 1 tool call");
  });

  it("collapses fleetd's wake to one line that says why, and keeps its text", () => {
    const wake = [
      "# fleetd digest: project storefront (devbox/p1), 08:15",
      "## Do not re-ask: keys already decided or asked",
      "share.window",
      "",
      "## Why you are woken",
      "- The human settled 2 of your asks; see \"Answers since your last wake\" above.",
      "- T31 finished: the share card",
    ].join("\n");
    const conv = buildConversation(input({ tail: [msg("01:00", "user", wake), msg("01:05", "assistant", "On it.")] }));
    expect(conv[0]).toMatchObject({ kind: "system", headline: "Woken: you settled 2 of its asks (+1 more)", text: wake });
    expect(conv[1]).toMatchObject({ kind: "say", author: { kind: "lead" } });
    expect(systemHeadline("You are the lead of project storefront (devbox/p1) in fleetd.")).toBe(
      "Started: fleetd's first message to the lead",
    );
    expect(systemHeadline("You seem stalled; continue the task from where you stopped.")).toBe(
      "From fleetd: You seem stalled; continue the task from where you stopped.",
    );
  });

  it("names a steer's real author: the lead's message to a task is not yours", () => {
    const toTask = steer("S2", "acknowledged", { target: { taskId: "T1" }, by: { kind: "lead" }, queuedAt: at("04:00") });
    const yours = steer("S3", "queued", { target: { taskId: "T1" }, queuedAt: at("05:00") });
    const conv = buildConversation(input({ steers: [toTask, yours] }));
    expect(conv[0]).toMatchObject({ kind: "say", author: { kind: "lead" }, to: "T1" });
    expect(conv[1]).toMatchObject({ kind: "say", author: { kind: "you", keyName: "your console" }, to: "T1" });
    expect(conv[1]?.kind === "say" && conv[1].receipt?.act).toEqual({ kind: "withdraw", steerId: "S3" });
  });

  it("shows a steer to the lead where the lead received it, with your words rather than fleetd's wrapper", () => {
    const s = steer("S12", "delivered", { queuedAt: at("00:30"), how: "boundary", deliveredAt: at("01:00") });
    const conv = buildConversation(
      input({ steers: [s], tail: [msg("01:00", "user", "S12 · the human steers you (W14): 'skip the docs page'\nBegin your next…")] }),
    );
    expect(conv).toHaveLength(1);
    expect(conv[0]).toMatchObject({ kind: "say", text: "skip the docs page", author: { kind: "you" } });
  });

  it("merges events between messages, shows a working lead's latest calls and its streaming message", () => {
    const ev = (seq: number, mmss: string, type: string, data: Record<string, unknown>): HubEvent => ({ seq, at: at(mmss), type, summary: type, data });
    const conv = buildConversation(
      input({
        tail: [
          msg("02:00", "assistant", "Starting W14's writers."),
          msg("05:00", "assistant", "T31 is editing the digest."),
          act("05:10", "command", "a"),
          act("05:11", "command", "b"),
          act("05:12", "command", "c"),
          act("05:13", "command", "d"),
        ],
        events: [
          ev(1, "03:00", "task.started", { taskId: "T31" }),
          ev(2, "03:01", "task.started", { taskId: "T33" }),
          ev(3, "03:02", "pr.merged", { prNumber: 211 }),
        ],
        leadWorking: true,
        streaming: { messageId: "m9", text: "You approved both of my" },
      }),
    );
    expect(conv[1]).toMatchObject({ kind: "events", text: "T31 started, T33 started, #211 merged" });
    expect(conv[3]).toEqual({ kind: "working", key: "working", calls: ["b", "c", "d"].map((summary) => ({ summary, failed: false })) });
    expect(conv[4]).toMatchObject({ kind: "say", streaming: true, text: "You approved both of my" });
  });

  it("marks a message the hub cut at 2,000 characters", () => {
    const long = `${"x".repeat(1999)}…`;
    expect(buildConversation(input({ tail: [msg("01:00", "assistant", long)] }))[0]).toMatchObject({ clipped: true });
  });

  it("keeps keys stable as the log grows, so measured rows survive", () => {
    const tail = [msg("01:00", "assistant", "one"), msg("01:00", "assistant", "two")];
    const a = buildConversation(input({ tail })).map((e) => e.key);
    const b = buildConversation(input({ tail: [...tail, msg("02:00", "assistant", "three")] })).map((e) => e.key);
    expect(b.slice(0, 2)).toEqual(a);
    expect(new Set(b).size).toBe(3);
  });

  it("opens a transcript jump at the row holding the item", () => {
    expect(jumpFromHash("#/order/W1?thread=t-lead&item=toolu_01")).toEqual({ thread: "t-lead", item: "toolu_01" });
    expect(jumpFromHash("#/order/W1")).toBeUndefined();
    const conv = buildConversation(
      input({ tail: [msg("01:00", "assistant", "one"), act("01:10", "command", "a"), act("01:20", "command", "b"), msg("02:00", "assistant", "two")] }),
    );
    expect(conv.map((e) => e.kind)).toEqual(["say", "fold", "say"]);
    expect(entryIndexAt(conv, at("01:20"))).toBe(1);
    expect(entryIndexAt(conv, at("02:00"))).toBe(2);
    expect(entryIndexAt(conv, at("00:10"))).toBe(0);
  });

  it("reads order ids as whole words", () => {
    expect(mentions("W14 and W12, not W0 or AW3 or W5x")).toEqual(["W14", "W12"]);
  });

  it("builds a 20k-item log fast enough to rebuild on every change", () => {
    const tail: TailItem[] = [];
    for (let i = 0; i < 20_000; i++) {
      const t = new Date(Date.UTC(2026, 9, 18, 0, 0, i)).toISOString();
      tail.push(i % 4 === 0 ? { kind: "message", at: t, role: "assistant", text: `line ${i}` } : { kind: "action", at: t, action: { at: t, kind: "command", status: "completed", summary: `cmd ${i}`, failed: false } });
    }
    const t0 = performance.now();
    const conv = buildConversation(input({ tail }));
    expect(performance.now() - t0).toBeLessThan(200);
    expect(conv.length).toBeGreaterThan(9_000);
  });
});

describe("the fleet", () => {
  it("leads the pill with the most urgent state, and rolls up once every agent settled", () => {
    const l = [lane("T31", "working"), lane("T33", "working"), lane("T34", "queued"), lane("T30", "done", 211)];
    expect(fanOut(l, 1)).toBe("1 needs you · 2 working · 1 queued · 1 done");
    expect(rollup(l)).toBeUndefined();
    expect(rollup([lane("T30", "done", 211), lane("T31", "done", 212)])).toBe("All 2 agents finished: #211 #212");
    expect(rollup([lane("T30", "done"), lane("T31", "done"), lane("T32", "failed")])).toBe("2 of 3 finished; T32 failed");
    expect(fanOut([], 0)).toBeUndefined();
  });
});

describe("receipts", () => {
  it("only move forward, in steer-number order", () => {
    let rows: readonly Steer[] = [steer("S12", "queued")];
    rows = mergeSteer(rows, steer("S12", "acknowledged"));
    rows = mergeSteer(rows, steer("S12", "delivered"));
    rows = mergeSteer(rows, steer("S9", "queued"));
    rows = mergeSteer(rows, steer("S10", "queued"));
    expect(rows.map((s) => `${s.id}:${s.stage}`)).toEqual(["S9:queued", "S10:queued", "S12:acknowledged"]);
  });

  it("say how a steer landed and admit a miss", () => {
    expect(clock("2026-10-18T14:02:07.143Z", "UTC")).toBe("14:02:07");
    const stopped = receipt(steer("S12", "delivered", { how: "stopped", stoppedTool: "cargo test --workspace", deliveredAt: "2026-10-18T14:02:07.143Z" }));
    expect(stopped.line).toMatch(/^S12 · delivered \d\d:\d\d:07 · stopped cargo test --workspace$/);
    const missed = receipt(steer("S12", "unacknowledged", { ackExcerpt: "Continuing with the docs page." }));
    expect(missed).toMatchObject({ line: "S12 · not acknowledged · its reply: “Continuing with the docs page.”", tone: "warn", act: { kind: "redirect" } });
    expect(receipt(steer("S12", "failed", { detail: "devbox refused the send" })).line).toBe("S12 · failed: devbox refused the send");
    expect(receipt(steer("S12", "queued", { by: { kind: "lead" } })).act).toBeUndefined();
    expect(receipt(steer("S12", "delivered")).act).toBeUndefined();
  });

  it("name the running step a queued steer waits for", () => {
    const lead: AgentLane = {
      laneId: "lead",
      role: "lead",
      title: "lead",
      status: "working",
      live: { laneId: "lead", status: "working", activity: { activity: { kind: "command", text: "cargo test" }, since: "2026-10-18T14:00:00.000Z" } },
    };
    const now = Date.parse("2026-10-18T14:01:12.000Z");
    const rows = [steer("S11", "delivered"), steer("S12", "queued")];
    expect(waitingLine(rows, lead, "the lead’s", now)).toBe("S12 waits for the lead’s next step (running cargo test for 1m12s)");
    expect(waitingLine(rows, { ...lead, status: "idle" }, "the lead’s", now)).toBeUndefined();
  });
});

describe("the composer", () => {
  const key = (over: Partial<KeyLike>): KeyLike => ({ key: "Enter", metaKey: false, ctrlKey: false, shiftKey: false, altKey: false, isComposing: false, ...over });
  it("Enter queues, the platform's modifier interrupts, Shift+Enter and IME stay in the text", () => {
    expect(sendModeFor(key({}), "darwin")).toBe("queue");
    expect(sendModeFor(key({ metaKey: true }), "darwin")).toBe("now");
    expect(sendModeFor(key({ ctrlKey: true }), "darwin")).toBe("queue");
    expect(sendModeFor(key({ ctrlKey: true }), "linux")).toBe("now");
    expect(sendModeFor(key({ shiftKey: true }), "darwin")).toBeUndefined();
    expect(sendModeFor(key({ isComposing: true }), "darwin")).toBeUndefined();
    expect(sendModeFor(key({ key: "a" }), "darwin")).toBeUndefined();
  });
});

describe("done when", () => {
  it("shows the judge's verdict with its reason, and pending checks as pending", () => {
    const rows = doneRows(
      [
        { type: "pr_merged", repo: "acme/storefront" },
        { type: "judge", criteria: "The console shows a share card with last-7-days tokens." },
        { type: "cmd", machineId: "buildbox", argv: ["pnpm", "test"], expectExit: 0 },
      ],
      {
        claimId: "C1",
        workstreamId: "W1",
        by: "human",
        at: at("09:00"),
        outcome: "fail",
        results: [
          { checkIndex: 0, spec: { type: "pr_merged", repo: "acme/storefront" }, result: "pass", evidence: "#211 merged", ranBy: "hub", at: at("09:00") },
          { checkIndex: 1, spec: { type: "judge", criteria: "x" }, result: "fail", evidence: "The card shows 30 days, not 7.", ranBy: "judge", at: at("09:00") },
        ],
      },
    );
    expect(rows.map((r) => r.state)).toEqual(["passed", "failed", "pending"]);
    expect(rows[0]?.reason).toBeUndefined();
    expect(rows[1]).toMatchObject({ kind: "Judge", verdict: "failed", reason: "The card shows 30 days, not 7." });
    expect(doneSummary(rows)).toBe("1 of 3 passed");
  });
});

describe("what an agent was told", () => {
  it("groups prompts by the registry, folds the defaults and spells out the overrides", () => {
    const view = toldView(
      {
        machineId: "devbox",
        threadId: "t1",
        startedAt: at("00:00"),
        text: "### Task\nShip it.",
        textSha: "0123456789abcdef",
        refs: [
          { id: "task.brief.write", ref: "task.brief.write@0123456789", scope: "default" },
          { id: "steer.message", ref: "steer.message@aaaaaaaaaa", scope: "project" },
          { id: "wake.task_result", ref: "wake.task_result@bbbbbbbbbb", scope: "default" },
          { id: "instructions", ref: "instructions@cccccccccc", scope: "global" },
        ],
        disallowedTools: ["Task", "Workflow", "CronCreate", "Bash"],
      },
      [
        { id: "task.brief.write", title: "Writer's brief", group: "tasks", sentWhen: "", scope: "default", defaultRef: "task.brief.write@0123456789", stale: false },
        { id: "steer.message", title: "A steer", group: "wakes_and_messages", sentWhen: "", scope: "project", defaultRef: "steer.message@dddddddddd", stale: false },
      ],
      { project: "storefront", orderId: "W1", orderTitle: "Share card", role: "writer T1" },
    );
    expect(view.context).toBe("storefront · W1 Share card · writer T1");
    expect(view.defaultCount).toBe(2);
    expect(view.defaults.map((g) => [g.label, g.rows.map((r) => r.title)])).toEqual([
      ["Tasks", ["Writer's brief"]],
      ["Wakes and messages", ["Wake: task result"]],
    ]);
    expect(view.overrides.map((g) => [g.label, g.rows.map((r) => r.level)])).toEqual([
      ["Wakes and messages", ["your edit for this project"]],
      ["Your instructions", ["your instructions for every project"]],
    ]);
    expect(view.tools.map((t) => [t.label, t.names])).toEqual([
      ["Subagents and workflows", ["Task", "Workflow"]],
      ["Scheduling", ["CronCreate"]],
      ["Kept from this project", ["Bash"]],
    ]);
  });
});
