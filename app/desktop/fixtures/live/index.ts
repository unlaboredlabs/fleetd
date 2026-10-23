// The live strip's fixtures: the typical lab hub with one order in its first project, and 0, 3 or 20 agents at work
// on it (writers, then reviewers and verifiers on two PRs), with their live activity. Twenty fill more than a third
// of the window, so the opened strip scrolls.
import { Fixture } from "../kit/fixture.ts";
import { defineGroup } from "../kit/group.ts";
import type { JsonObject, JsonValue } from "../kit/json.ts";

type Role = "implementer" | "reviewer" | "verifier";

const ACTIVITIES: readonly JsonObject[] = [
  { kind: "edit", path: "src/cart/total.ts" },
  { kind: "command", text: "npm test -- cart --reporter=dot --run src/cart/total.test.ts src/cart/discounts.test.ts" },
  { kind: "thinking" },
  { kind: "read", path: "src/checkout/summary/rounding/half-cent-edge-cases.ts" },
  { kind: "writing" },
  { kind: "read", pattern: "fn roundTotal" },
  { kind: "tool", name: "WebFetch", detail: "developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Intl/NumberFormat" },
];

const fromBase = (base: Fixture, agents: number): Fixture => {
  const f = Fixture.from(base, `live-${agents}`, `The lead's live strip with ${agents} agents at work on one order.`);
  const now = Date.parse(f.now);
  const iso = (ms: number) => new Date(ms).toISOString();
  const projects = f.snapshot?.["projects"];
  const first = Array.isArray(projects) ? (projects[0] as JsonObject | undefined) : undefined;
  const text = (v: JsonValue | undefined, fallback: string) => (typeof v === "string" ? v : fallback);
  const projectRef = { machineId: text(first?.["machineId"], "devbox"), projectId: text(first?.["projectId"], "storefront") };
  const pr = (n: number, state: string, taskId: string): JsonObject => ({
    changeId: `X${n}`,
    repo: "acme/storefront",
    number: n,
    url: `https://github.com/acme/storefront/pull/${n}`,
    state,
    reviewsDone: 1,
    reviewsNeeded: 3,
    taskId,
  });
  // Each PR's writer finished before the reviews began: the cards leave them out; the order's detail lists them.
  const prs = [pr(221, "reviewing", "T90"), pr(222, "reviewing", "T91")];
  const writer = (id: string, title: string, n: number, ago: number): JsonObject => ({
    laneId: id,
    role: "implementer",
    taskId: id,
    threadRef: { machineId: projectRef.machineId, threadId: `s-${id}` },
    title,
    model: "claude-opus-5-5",
    profile: id === "T90" ? "medium" : "high",
    status: "done",
    startedAt: iso(now - ago - 140_000),
    endedAt: iso(now - ago),
    pr: pr(n, "reviewing", id),
  });
  const done = agents === 0 ? [] : [writer("T90", "round in cart/total.ts", 221, 300_000), writer("T91", "use it in discounts", 222, 280_000)];
  const lanes: JsonObject[] = [];
  const live: JsonObject[] = [];
  for (let i = 0; i < agents; i++) {
    const id = `T${i + 1}`;
    const role: Role = i < Math.ceil(agents / 3) ? "implementer" : i % 2 === 0 ? "reviewer" : "verifier";
    const onPr = role === "implementer" ? undefined : prs[i % 2];
    // At 20: one waits on you, one is paused at a usage limit (on hold), and the last waits for a free slot (a long
    // reason, cut with an ellipsis).
    const status = i === 4 ? "waiting" : i === 5 && agents > 3 ? "parked" : i === agents - 1 && agents > 3 ? "queued" : "working";
    lanes.push({
      laneId: id,
      role,
      taskId: id,
      threadRef: { machineId: projectRef.machineId, threadId: `s-${id}` },
      title: role === "implementer" ? `write part ${i + 1} of the rounding change` : `${role === "reviewer" ? "review" : "verify"} #${i % 2 === 0 ? 221 : 222}`,
      model: "claude-opus-5-5",
      // The first writer does the mechanical part on medium; the rest, reviews included, run high.
      profile: i === 0 ? "medium" : "high",
      status,
      ...(status === "waiting"
        ? { statusReason: "approve npm install" }
        : status === "parked"
          ? { statusReason: "usage limit: resumes 14:05" }
          : status === "queued"
            ? { statusReason: "waiting for a free slot: every one is held by work on #221 and #222, so this starts as soon as one of their reviews finishes" }
            : {}),
      startedAt: iso(now - (20 + i * 7) * 1000),
      ...(onPr ? { pr: onPr } : {}),
    });
    if (status === "queued") continue;
    live.push({
      laneId: id,
      status,
      ...(status === "parked" ? {} : { activity: { activity: ACTIVITIES[i % ACTIVITIES.length] ?? { kind: "thinking" }, since: iso(now - 4000) } }),
      tokens: { input: 3000 + i * 211, output: 900 + i * 37, cacheRead: 0, live: true },
      spark: { endAt: iso(now - (now % 2000)), samples: Array.from({ length: 12 }, (_, k) => ((k * 7 + i * 13) % 50) + 4) },
    });
  }
  // A card lists at most 12 agents: twenty run as two orders of the same project, which the strip counts together.
  const orders: JsonObject[] = [];
  for (let k = 0; k * 12 < lanes.length; k++) {
    const mine = lanes.slice(k * 12, k * 12 + 12);
    orders.push({
      workstreamId: `W${14 + k}`,
      projectRef,
      title: k === 0 ? "Round cart totals once, in one place" : "Receipts show the rounded total",
      state: "running",
      phase: "working",
      needsYou: 0,
      settled: 0,
      total: mine.length,
      lanes: mine,
      prs: k === 0 ? prs : [],
      createdAt: iso(now - 600_000),
      updatedAt: iso(now - 2000 - k),
    });
  }
  for (const [k, o] of orders.entries()) {
    f.answer("order_get", { workstreamId: `W${14 + k}` }, { order: o, doneLanes: k === 0 ? done : [], requests: [] });
  }
  for (const { input } of f.answers("orders_board")) f.drop("orders_board", input);
  f.answer("orders_board", {}, { orders, trains: [], at: iso(now) });
  f.live = [{ at: iso(now), full: true, lanes: live.slice(0, 64) }];
  // The project's chat: the human's order and the lead's reply, under which the strip sits.
  const message = (seq: number, author: string, text: string, ago: number): JsonObject => ({
    messageId: `m${seq}`,
    projectRef,
    seq,
    author,
    text,
    attachments: [],
    createdAt: iso(now - ago),
    state: "final",
  });
  const messages =
    agents === 0
      ? [message(1, "human", "Round the cart totals once, in one place.", 900_000), message(2, "lead", "Done: all three PRs merged. Nothing is running.", 60_000)]
      : [
          message(1, "human", "Round the cart totals once, in one place.", 600_000),
          message(2, "lead", "On it. Writers are splitting the change into three PRs; reviews start as each one opens.", 540_000),
        ];
  f.answer("chat_history", { projectRef }, {
    messages,
    moreBefore: false,
    moreAfter: false,
    state: { projectRef, needsYou: false, leadWorking: agents > 0, lastSeq: messages.length, lastMessageAt: iso(now - 60_000) },
  });
  return f;
};

export default defineGroup({
  fixtures: (base) => [fromBase(base("typical"), 0), fromBase(base("typical"), 3), fromBase(base("typical"), 20)],
});
