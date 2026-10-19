// The shared fixtures every screen is registered against (group.ts SHARED). `typical` and `empty` are real lab hub
// traffic (recorded/, see record.ts and sanitize.ts); the others are those with one thing pushed to its limit.
import fs from "node:fs";
import path from "node:path";
import type { FixtureFile } from "../../src/main/hub/fixture.ts";
import { Fixture, HUB, PROTOCOL } from "./fixture.ts";
import type { SharedName } from "./group.ts";
import { at } from "./ids.ts";
import { clone, isObject, type JsonObject, asText } from "./json.ts";
import { arr, busiestOrder, longText, manyAgents, manyPrompts, NODE_TOO_OLD, obj, streamedLines, timeSpans } from "./stress.ts";
import { explainLoss } from "../../src/main/hub/explain.ts";

const RECORDED = path.join(import.meta.dirname, "../recorded");

/** A recorded lab moment (recorded/<name>.json), as written by sanitize.ts. */
export const recorded = (name: string): Fixture =>
  Fixture.fromFile(JSON.parse(fs.readFileSync(path.join(RECORDED, `${name}.json`), "utf8")) as FixtureFile);

/** The ask-labels contract (feat/ask-labels) isn't on main yet; asks_list and order_get answers use it already. */
const ASK_LABELS = "labelled ask options (feat/ask-labels) not merged yet";

// ---- Needs you: the two questions from needs-you-clipped-20261019.jpg, rewritten with labels ----

const ask = (n: number, f: Fixture, workstreamId: string, projectRef: JsonObject, q: { key: string; blocks: string; text: string; context: string; options: Array<JsonObject>; why: string }): JsonObject => ({
  askId: `A${n}`,
  number: n,
  batchId: "B1",
  kind: "decide",
  class: "product",
  state: "open",
  key: q.key,
  blocks: q.blocks,
  text: q.text,
  context: q.context,
  options: q.options,
  recommendation: asText(q.options[0]?.["key"]),
  recommendationWhy: q.why,
  proceededOnRec: false,
  createdAt: at(f.now, -(14 - n) * 60_000),
  projectRef,
  workstreamId,
});

export const needsYouAsks = (f: Fixture, workstreamId: string, projectRef: JsonObject): Array<JsonObject> => [
  ask(1, f, workstreamId, projectRef, {
    key: "share.public_link",
    blocks: "the Copy link button",
    text: "Should Copy link publish a public snapshot of the share card?",
    context:
      "Copy link needs a URL people can open without your console's key. Clicking it would save the card's PNG on the console and serve it at /share/<random id>.png with no login: only that frozen image, with account names masked unless you turned them on. It only works for viewers who can reach your console's address.",
    options: [
      { key: "public-snapshot", label: "Public snapshot link", consequence: "Copy link saves a frozen PNG and copies an unguessable URL that anyone who can reach the console can open." },
      { key: "image-only", label: "Copy the image only", consequence: "No link and nothing served: Copy puts the PNG on the clipboard." },
    ],
    why: "It is what the order asked for, and only the frozen image is exposed, never the console itself.",
  }),
  ask(2, f, workstreamId, projectRef, {
    key: "share.pay_comparison",
    blocks: "the card's headline wording",
    text: "Which headline should the share card use?",
    context:
      "The console doesn't know what your plan costs, so you type your monthly total once (for example 200). The card covers the last 7 days.",
    options: [
      { key: "monthly-vs-week", label: "Monthly plan against this week", consequence: "The headline reads \"$200/mo plan → $1,840 of usage this week\", as in your example." },
      { key: "prorated", label: "Prorate the plan to the week", consequence: "The headline reads \"$46 of plan → $1,840 of usage, 40×\"." },
    ],
    why: "It matches the wording in the order; prorating changes the number people see.",
  }),
];

const withNeedsYou = (f: Fixture): Fixture => {
  const order = busiestOrder(f);
  const projectRef = obj(obj(order?.output["order"])["projectRef"]);
  const workstreamId = order?.workstreamId ?? "W1";
  const asks = needsYouAsks(f, workstreamId, projectRef);
  const batches = [{ batchId: "B1", createdAt: at(f.now, -12 * 60_000), state: "open", items: asks.map((a) => ({ askId: a["askId"] ?? "", number: a["number"] ?? 0 })) }];
  f.answer("asks_list", {}, { asks, batches });
  f.answer("asks_list", { state: "open" }, { asks, batches });
  if (order !== undefined) {
    order.output["asks"] = clone(asks);
    Object.assign(obj(order.output["order"]), { needsYou: asks.length, phase: "waiting_on_you", phaseDetail: "2 questions for you" });
  }
  f.update("orders_board", (board) => ({
    ...obj(board),
    orders: arr(obj(board)["orders"]).map((o) => (isObject(o) && o["workstreamId"] === workstreamId ? { ...o, needsYou: asks.length, phase: "waiting_on_you" } : o)),
  }));
  f.pendingContracts.set("asks_list", ASK_LABELS);
  f.pendingContracts.set("order_get", ASK_LABELS);
  return f;
};

// ---- The conversation from order-conversation-20261019.jpg ----

const WAKE_PROMPT = `## Answers since your last wake
- D5 share.public_link = public-snapshot: a frozen PNG at /share/<id>.png, no login (project, human)
- D4 share.pay_comparison = monthly-vs-week: "$200/mo plan → $1,840 of usage this week", literal as in the request (project, human)

## Decisions so far
- D3 share.w2_after_w1 = W2's writer starts after W1's PR merges (project, lead)
- D2 share.render = browser-side PNG render, the server only stores uploaded snapshots (project, lead)
- D1 share.window = rolling last 7 days (project, lead)

## Do not re-ask: keys already decided or asked
share.public_link, share.pay_comparison, share.w2_after_w1, share.render, share.window

## Why you are woken
- The human settled 2 of your asks; see "Answers since your last wake" above.`;

const withConversation = (f: Fixture): Fixture => {
  const order = busiestOrder(f);
  if (order === undefined) throw new Error("conversation needs a recorded order_get");
  const lead = obj(order.output["lead"]);
  const thread = obj(lead["threadRef"]);
  const workstreamId = order.workstreamId;
  const t = (s: number) => at(f.now, -s * 1000);
  // Newest first, as thread_tail returns them.
  const items: Array<JsonObject> = [
    { kind: "message", role: "assistant", at: t(20), text: "You approved both of my asks, so T1 keeps the literal headline and builds the public snapshot route. I told T2 to wait for W1's PR to merge before it starts (D3); nothing else is blocked." },
    { kind: "action", at: t(24), action: { at: t(24), kind: "command", status: "completed", failed: false, exitCode: 0, summary: "fleetd steer T2 --text \"Wait for W1's PR to merge (D3), then rebase and start.\"", outputTail: "S2 queued for T2" } },
    { kind: "message", role: "user", at: t(27), text: "S1 · the human steers T1 directly: 'Both pending asks are settled as you're building them: the public snapshot link at /share/<id>.png is approved (D5), and the headline stays literal: \"$200/mo plan → $1,840 of usage this week\" (D4). Drop the prorated variant: no switch is needed.'" },
    { kind: "action", at: t(31), action: { at: t(31), kind: "tool_call", status: "completed", failed: false, summary: "Read the digest: 2 answers, 3 decisions, no open asks" } },
    { kind: "message", role: "user", at: t(34), text: WAKE_PROMPT },
    { kind: "message", role: "assistant", at: t(600), text: "**Two questions** before T1 can finish the share card:\n\n1. Should *Copy link* publish a public snapshot? (A1)\n2. Which headline wording? (A2)\n\nT1 keeps building on my recommendations meanwhile." },
  ];
  f.answer("thread_tail", { machineId: asText(thread["machineId"], "devbox"), threadId: asText(thread["threadId"], "") }, {
    items,
    thread: {
      ...obj(f.answers("thread_tail")[0]?.output)["thread"] as JsonObject,
      machineId: asText(thread["machineId"], "devbox"),
      threadId: asText(thread["threadId"], ""),
      status: "idle",
      title: "storefront lead",
      headline: "Both asks answered; T1 builds the snapshot route, T2 waits for W1's PR",
    },
  });
  const steer = (id: string, s: number, target: JsonObject, by: JsonObject, text: string, ack: string): JsonObject => ({
    id,
    workstreamId,
    target,
    by,
    mode: "queue",
    text,
    queuedAt: t(s),
    deliveredAt: t(s - 2),
    seenAt: t(s - 2),
    ackedAt: t(s - 4),
    how: "turn",
    stage: "acknowledged",
    ackExcerpt: ack,
    runId: `run-${id}`,
    thread: { machineId: asText(thread["machineId"], "devbox"), threadId: asText(thread["threadId"], "") },
  });
  f.answer("steers_list", { workstreamId }, {
    steers: [
      steer("S2", 24, { taskId: "T2" }, { kind: "lead" }, "Wait for W1's PR to merge (D3), then rebase onto main and start the headline change.", "S2: Waiting for W1's PR to merge, then I'll rebase and start."),
      steer(
        "S1",
        27,
        { taskId: "T1" },
        { kind: "human", keyName: "laptop" },
        "Both pending asks are settled as you're building them: the public snapshot link at /share/<id>.png is approved (D5), and the headline stays literal: '$200/mo plan → $1,840 of usage this week' (D4). Drop the prorated variant: no switch is needed.",
        "S1: Keeping the literal headline (no prorated variant), keeping the public snapshot route, and rerunning the share card tests.",
      ),
    ],
  });
  return f;
};

/** Every shared fixture, by name, freshly built. */
export const buildShared = (): Map<SharedName, Fixture> => {
  const typical = Fixture.from(recorded("lab-demo"), "typical", "A real lab hub mid-order: one order fanned out to writers, reviewers and verifiers, three PRs in the train, live lanes, prompts and time.");
  const copy = (name: SharedName, note: string) => Fixture.from(typical, name, note);
  const shared: Array<Fixture> = [
    Fixture.from(recorded("lab-start"), "empty", "A real lab hub before anything happened: machines online, no projects, orders, asks or time."),
    typical,
    longText(copy("long-text", "Every title ~120 characters, a ~250-character judge criterion, long branches, paths, prose and prompt keys.")),
    manyPrompts(copy("many-prompts", "72 prompts with long dotted ids, every other one overridden for the project.")),
    manyAgents(copy("many-agents", "One order with 12 working and 14 finished agents (26 lanes), and a board of six orders.")),
    withNeedsYou(copy("needs-you", "The two questions from needs-you-clipped-20261019.jpg, with labelled options, consequences and the recommendation's reason.")),
    withConversation(copy("conversation", "The lead conversation from order-conversation-20261019.jpg: a markdown wake prompt, a human steer to T1 and a lead steer to T2, both acknowledged.")),
    (() => {
      const f = new Fixture("hub-unreachable", "The saved hub doesn't answer; the app retries.");
      // The words the real client gives a refused connect (src/main/hub/explain.ts).
      f.state = { phase: "retrying", hub: HUB, ...explainLoss(HUB, 1006, "", { code: "ECONNREFUSED", message: "connect ECONNREFUSED" }, false), retryAt: Date.parse(f.now) + 8000 };
      return f;
    })(),
    (() => {
      const f = new Fixture("pairing-failed", "The hub refused the saved key, and a new pairing code has expired.");
      f.state = { phase: "refused", hub: HUB, message: "The hub refused this app's key: it was revoked or belongs to another hub." };
      f.connect = { ok: false, message: "That pairing code has expired. Make a new one on the hub with `fleetd pair` and paste it again." };
      // A code typed into the form meets the same expired code at the hub.
      f.pair = { healthz: { ok: true, version: "0.5.0", protocol: PROTOCOL }, redeem: { status: 410, body: { code: "pair_code_expired", message: "That pairing code has expired.", fix: "Run `fleetd pair` on the hub for a new code." } } };
      return f;
    })(),
    (() => {
      const f = copy("node-too-old", "buildbox runs a node too old for the hub: it shows degraded, and finding, inspecting or cloning repos fails.");
      const old = (m: JsonObject) => (m["machineId"] === "buildbox" ? { ...m, status: "degraded", nodeVersion: "0.3.1", degradedReason: "node 0.3.1 is older than this hub needs (0.4.0)" } : m);
      if (f.snapshot !== undefined) f.snapshot["machines"] = arr(f.snapshot["machines"]).map((m) => (isObject(m) ? old(m) : m));
      for (const frame of f.live) if (Array.isArray(frame["machines"])) frame["machines"] = frame["machines"].map((m) => (isObject(m) ? (m["machineId"] === "buildbox" ? { ...m, status: "degraded" } : m) : m));
      f.drop("project_discover").drop("project_inspect");
      f.fail("project_discover", undefined, NODE_TOO_OLD).fail("project_inspect", undefined, NODE_TOO_OLD);
      return f;
    })(),
    timeSpans(copy("time-heavy", "15,000 time spans over the past week, paged 500 at a time.")),
  ];
  const conversation = shared.find((f) => f.name === "conversation");
  if (conversation === undefined) throw new Error("conversation is built above");
  const long = Fixture.from(conversation, "conversation-20k", "The conversation, with 20,000 lines streamed into the lead's lane over the live feed (F13's scroll budget).");
  const leadLane = asText(obj(busiestOrder(long)?.output["lead"])["laneId"], "lead");
  shared.push(streamedLines(long, leadLane));
  return new Map(shared.map((f) => [f.name as SharedName, f]));
};
