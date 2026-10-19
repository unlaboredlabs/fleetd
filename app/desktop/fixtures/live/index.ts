// The live strip's fixtures: the typical lab hub with one order in its first project, and 0, 3 or 20 agents at work
// on it (writers, then reviewers and verifiers on two PRs), with their live activity.
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
  const prs = [pr(221, "reviewing", "T1"), pr(222, "reviewing", "T2")];
  const lanes: JsonObject[] = [];
  const live: JsonObject[] = [];
  for (let i = 0; i < agents; i++) {
    const id = `T${i + 1}`;
    const role: Role = i < Math.ceil(agents / 3) ? "implementer" : i % 2 === 0 ? "reviewer" : "verifier";
    const onPr = role === "implementer" ? undefined : prs[i % 2];
    const status = i === 4 ? "waiting" : i === agents - 1 && agents > 3 ? "queued" : "working";
    lanes.push({
      laneId: id,
      role,
      taskId: id,
      threadRef: { machineId: projectRef.machineId, threadId: `s-${id}` },
      title: role === "implementer" ? `write part ${i + 1} of the rounding change` : `${role === "reviewer" ? "review" : "verify"} #${i % 2 === 0 ? 221 : 222}`,
      model: "claude-haiku-5-5",
      status,
      ...(status === "waiting" ? { statusReason: "approve npm install" } : {}),
      startedAt: iso(now - (20 + i * 7) * 1000),
      ...(onPr ? { pr: onPr } : {}),
    });
    if (status === "queued") continue;
    live.push({
      laneId: id,
      status,
      activity: { activity: ACTIVITIES[i % ACTIVITIES.length] ?? { kind: "thinking" }, since: iso(now - 4000) },
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
