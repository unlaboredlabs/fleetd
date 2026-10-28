// The lead at work in storefront's chat: its reply is in, its turn still runs, and the quiet line under the reply
// says how long it has worked, what it is doing now (its live lane's open call) and what the turn did so far (the
// hub's events since the lead started working). lead-planning is the usual case; lead-long has a long file name and
// many events, to wrap; lead-counting has worked over an hour with nothing more known. lead-worked: the turn is over,
// and the line under the reply says how long it took. lead-memory: the night's memory refresh line, after the lead's
// reply, with the changes it made to MEMORY.md and a topic file.
import { Fixture } from "../kit/fixture.ts";
import { defineGroup } from "../kit/group.ts";
import { at } from "../kit/ids.ts";
import { setChatState } from "../kit/chat.ts";
import { arr, obj } from "../kit/stress.ts";
import type { JsonObject } from "../kit/json.ts";

const STOREFRONT = { machineId: "devbox", projectId: "dcffccea-c5a7-40a6-940d-7f70239ffa22" } as const;

interface Turn {
  /** The lead's open call; none: its lane says nothing. */
  readonly activity?: JsonObject;
  readonly orders: number;
  readonly agents: number;
  /** Seconds ago the turn began, and ended (none: it still runs). */
  readonly startS?: number;
  readonly endS?: number;
  /** Seconds ago the lead's reply was written. */
  readonly replyS?: number;
}

function leadAtWork(f: Fixture, turn: Turn): Fixture {
  const startS = turn.startS ?? 240;
  const replyS = turn.replyS ?? 200;
  const working = turn.endS === undefined;
  const t = (s: number) => at(f.now, -s * 1000);
  const msg = (seq: number, author: "human" | "lead", text: string, s: number): JsonObject => ({
    messageId: `m${seq}`,
    projectRef: STOREFRONT,
    seq,
    author,
    text,
    attachments: [],
    createdAt: t(s),
    state: "final",
    ...(author === "human" ? { by: "laptop", clientRequestId: `seed-${seq}`, delivery: "turn" } : {}),
  });
  const messages = [
    msg(1, "human", "Build all of the approved checkout items, in parallel where they don’t collide.", startS + 5),
    msg(
      2,
      "lead",
      working
        ? "Reading the proposal and the current checkout code so I can slice the items into parallel PRs."
        : "Sliced into three PRs: totals, discounts and receipts. Writers are on all three; I’ll say when each is up.",
      replyS,
    ),
  ];
  const state = setChatState(f, STOREFRONT, { needsYou: false, leadWorking: working, lastSeq: 2, lastMessageAt: t(replyS) });
  for (const { input } of f.answers("chat_history")) if (obj(input?.["projectRef"])["projectId"] === STOREFRONT.projectId) f.drop("chat_history", input);
  f.answer("chat_history", { projectRef: STOREFRONT }, { messages, moreBefore: false, moreAfter: false, state });

  // The lead's lane, working on its open call.
  const lead = `lead:${STOREFRONT.machineId}/${STOREFRONT.projectId}`;
  f.live = f.live.map((frame) => ({
    ...frame,
    lanes: [
      ...arr(frame["lanes"]).filter((l) => obj(l)["laneId"] !== lead),
      ...(working && turn.activity !== undefined ? [{ laneId: lead, status: "working", activity: { activity: turn.activity, since: t(4) } }] : []),
    ],
  }));

  // The turn's events, after the snapshot's cursor: it started working, opened orders and started agents.
  let seq = Math.max(Number(f.snapshot?.["cursor"] ?? 0), ...f.events.map((e) => Number(e["seq"] ?? 0)));
  const event = (type: string, s: number, summary: string, data: JsonObject): JsonObject => ({
    seq: ++seq,
    at: t(s),
    type,
    machineId: STOREFRONT.machineId,
    projectId: STOREFRONT.projectId,
    summary,
    data,
  });
  f.events.push(event("chat.waiting", startS + 360, "The lead is idle", { ...state, leadWorking: false }));
  f.events.push(event("chat.waiting", startS, "The lead is working", { ...state, leadWorking: true }));
  // What the turn did happens inside it: after its start, before its end (or now).
  const mid = turn.endS ?? 0;
  for (let i = 0; i < turn.orders; i++) {
    f.events.push(event("workstream.created", mid + (startS - mid) / 2 - i, `New intent W${20 + i}`, { workstreamId: `W${20 + i}` }));
  }
  for (let i = 0; i < turn.agents; i++) {
    const taskId = `T${40 + i}`;
    f.events.push(event("task.started", mid + (startS - mid) / 4 - i, `${taskId} started`, { taskId, workstreamId: "W20", createdAt: t(mid + (startS - mid) / 4 + 30 - i) }));
  }
  if (turn.endS !== undefined) f.events.push(event("chat.waiting", turn.endS, "The lead is idle", { ...state, leadWorking: false }));
  return f;
}

/** The night's refresh of storefront's memory, as its chat line carries it (the showcase's too). */
export const MEMORY_REFRESHED: JsonObject = {
  items: [
    {
      scope: "project",
      text: "PR screenshots live in the private repo storefront-shots (main branch, one folder per task branch, embedded via blob/main/...?raw=true). Never push extra branches to storefront: Vercel deploys every branch, and each images-only branch failed a deployment.",
      replaced: "PR screenshots live in the private repo storefront-shots (main branch, one folder per task branch); never push -shots branches to storefront, as Vercel builds them and fails.",
    },
    {
      scope: "project",
      text: "Never push extra branches to storefront: Vercel deploys every branch, and images-only `-shots` branches each failed a deployment.",
      forgotten: true,
      reason: "Merged into the storefront-shots entry.",
    },
    {
      scope: "project",
      topic: "deploys",
      text: "The checkout rewrite plan is in /tmp/checkout-plan.md on devbox; copy it into docs/design if it's still needed.",
      forgotten: true,
      reason: "Every checkout stage has merged; the plan is no longer needed.",
      undone: true,
    },
    { scope: "project", text: "`pnpm deploy` does nothing when staging already runs the newest build: restart it with `systemctl --user restart storefront`." },
    { scope: "project", text: "Agents can't run real Stripe payments: those flows are tested against fakes. Say so when they land." },
    { scope: "project", text: "Main's branch protection treats a skipped required check as passing." },
  ],
  undone: 1,
};

/** The night's memory refresh in storefront's chat: 3 entries added, 1 updated and 2 removed, one of them undone. */
function memoryRefreshed(f: Fixture): Fixture {
  const t = (s: number) => at(f.now, -s * 1000);
  const msg = (seq: number, author: "human" | "lead" | "system", text: string, s: number, extra: JsonObject = {}): JsonObject => ({
    messageId: `m${seq}`,
    projectRef: STOREFRONT,
    seq,
    author,
    text,
    attachments: [],
    createdAt: t(s),
    state: "final",
    ...(author === "human" ? { by: "laptop", clientRequestId: `seed-${seq}`, delivery: "turn" } : {}),
    ...extra,
  });
  const messages = [
    msg(1, "human", "Ship the receipts PR once its review is clean.", 9 * 3600),
    msg(2, "lead", "Receipts merged. Nothing else is open on checkout.", 8 * 3600),
    msg(3, "system", "Memory refreshed: +3 ~1 −2", 3600, { memoryRefreshed: MEMORY_REFRESHED }),
  ];
  const state = setChatState(f, STOREFRONT, { needsYou: false, leadWorking: false, lastSeq: 3, lastMessageAt: t(3600) });
  for (const { input } of f.answers("chat_history")) if (obj(input?.["projectRef"])["projectId"] === STOREFRONT.projectId) f.drop("chat_history", input);
  f.answer("chat_history", { projectRef: STOREFRONT }, { messages, moreBefore: false, moreAfter: false, state });
  f.answer("memory_undo", undefined, { ok: true });
  return f;
}

export default defineGroup({
  fixtures: (base) => [
    leadAtWork(
      Fixture.from(base("typical"), "lead-planning", "storefront's lead mid-turn: planning, after opening an order and starting 3 agents."),
      { activity: { kind: "tool", name: "plan", server: "fleetd" }, orders: 1, agents: 3 },
    ),
    leadAtWork(
      Fixture.from(base("typical"), "lead-long", "storefront's lead mid-turn reading a file with a very long name, after 2 orders and 12 agents."),
      {
        activity: {
          kind: "read",
          path: "src/checkout/summary/rounding/half-cent-edge-cases-for-every-currency-and-locale-the-storefront-supports-today.ts",
        },
        orders: 2,
        agents: 12,
      },
    ),
    leadAtWork(
      Fixture.from(base("typical"), "lead-counting", "storefront's lead has worked for over an hour, with nothing more known: the line only counts."),
      { orders: 0, agents: 0, startS: 4_330, replyS: 4_300 },
    ),
    leadAtWork(
      Fixture.from(base("typical"), "lead-worked", "storefront's lead finished its turn: under its reply, how long it worked."),
      { orders: 1, agents: 3, startS: 460, replyS: 250, endS: 240 },
    ),
    memoryRefreshed(Fixture.from(base("typical"), "lead-memory", "storefront's chat with the night's memory refresh line: 3 added, 1 updated, 2 removed.")),
  ],
});
