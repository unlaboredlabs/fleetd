// The lead at work in storefront's chat: its reply is in, its turn still runs, and the quiet line under the reply
// says what it is doing now (its live lane's open call) and what the turn did so far (the hub's events since the
// lead started working). lead-planning is the usual case; lead-long has a long file name and many events, to wrap.
import { Fixture } from "../kit/fixture.ts";
import { defineGroup } from "../kit/group.ts";
import { at } from "../kit/ids.ts";
import { setChatState } from "../kit/chat.ts";
import { arr, obj } from "../kit/stress.ts";
import type { JsonObject } from "../kit/json.ts";

const STOREFRONT = { machineId: "devbox", projectId: "dcffccea-c5a7-40a6-940d-7f70239ffa22" } as const;

interface Turn {
  readonly activity: JsonObject;
  readonly orders: number;
  readonly agents: number;
}

function leadAtWork(f: Fixture, turn: Turn): Fixture {
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
    msg(1, "human", "Build all of the approved checkout items, in parallel where they don’t collide.", 240),
    msg(2, "lead", "Reading the proposal and the current checkout code so I can slice the items into parallel PRs.", 200),
  ];
  const state = setChatState(f, STOREFRONT, { needsYou: false, leadWorking: true, lastSeq: 2, lastMessageAt: t(200) });
  for (const { input } of f.answers("chat_history")) if (obj(input?.["projectRef"])["projectId"] === STOREFRONT.projectId) f.drop("chat_history", input);
  f.answer("chat_history", { projectRef: STOREFRONT }, { messages, moreBefore: false, moreAfter: false, state });

  // The lead's lane, working on its open call.
  const lead = `lead:${STOREFRONT.machineId}/${STOREFRONT.projectId}`;
  f.live = f.live.map((frame) => ({
    ...frame,
    lanes: [
      ...arr(frame["lanes"]).filter((l) => obj(l)["laneId"] !== lead),
      { laneId: lead, status: "working", activity: { activity: turn.activity, since: t(4) } },
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
  f.events.push(event("chat.waiting", 600, "The lead is idle", { ...state, leadWorking: false }));
  f.events.push(event("chat.waiting", 240, "The lead is working", { ...state }));
  for (let i = 0; i < turn.orders; i++) {
    f.events.push(event("workstream.created", 120 - i, `New intent W${20 + i}`, { workstreamId: `W${20 + i}` }));
  }
  for (let i = 0; i < turn.agents; i++) {
    const taskId = `T${40 + i}`;
    f.events.push(event("task.started", 60 - i, `${taskId} started`, { taskId, workstreamId: "W20", createdAt: t(90 - i) }));
  }
  return f;
}

export default defineGroup({
  fixtures: (base) => [
    leadAtWork(
      Fixture.from(base("typical"), "lead-planning", "storefront's lead mid-turn: planning, after opening an order and starting 3 agents."),
      { activity: { kind: "tool", name: "mcp__fleetd__plan_add" }, orders: 1, agents: 3 },
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
  ],
});
