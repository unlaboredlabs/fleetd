// The lead at work in storefront's chat: its reply is in, its turn still runs, and the line in the composer's band
// says what it is doing now (its live lane's open call), what the turn did so far (the hub's events since the lead
// started working) and how long it has worked. lead-planning is the usual case; lead-long has a long file name and
// many events, to ellipsize; lead-counting has worked over an hour with nothing more known. lead-worked: the turn is
// over, and the reply wears how long it took. lead-memory: the night's memory refresh line, after the lead's
// reply, with the changes it made to MEMORY.md and a topic file. lead-worktrees: the night's cleanup line for the
// worktrees it kept, before the memory refresh's. lead-pictures: the lead thinking with no agents at work, after a reply
// ending in two pictures that load late.
import fs from "node:fs";
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

/** How long each picture's bytes take to come: they land after the chat has opened at its end. */
const LATE_MS = 1_500;

/**
 * The lead thinking again, no agents at work, after a reply that ends in two pictures with captions, a page of
 * conversation above it: the turn line has the band to itself, over the pictures once the chat is scrolled up. The
 * pictures come late, growing the reply after the chat has opened at its end.
 */
function leadPictures(f: Fixture): Fixture {
  leadAtWork(f, { activity: { kind: "thinking" }, orders: 0, agents: 0, startS: 15, replyS: 30 });
  f.update("orders_board", (out) => ({ ...obj(out), orders: arr(obj(out)["orders"]).filter((o) => obj(obj(o)["projectRef"])["projectId"] !== STOREFRONT.projectId) }));
  const t = (s: number) => at(f.now, -s * 1000);
  const shot = (name: string) => fs.readFileSync(new URL(`../sessions/media/${name}.jpg`, import.meta.url));
  const before = { v: 1, kind: "image", attachmentId: "F31", caption: "Before: the checkout total wraps under the price at 360 px" };
  const after = { v: 1, kind: "image", attachmentId: "F32", caption: "After: one line, the total beside the price" };
  const intro = "The receipt fix is up as #231. Here is the checkout before and after it.";
  let text = intro;
  const parts: JsonObject[] = [{ start: 0, end: intro.length }];
  for (const block of [before, after]) {
    text += "\n\n";
    const start = text.length;
    text += `\`\`\`fleetd-block\n${JSON.stringify(block)}\n\`\`\``;
    parts.push({ start, end: text.length, block });
  }
  const msg = (seq: number, author: "human" | "lead", body: string, s: number, extra: JsonObject = {}): JsonObject => ({
    messageId: `m${seq}`,
    projectRef: STOREFRONT,
    seq,
    author,
    text: body,
    attachments: [],
    createdAt: t(s),
    state: "final",
    ...(author === "human" ? { by: "laptop", clientRequestId: `seed-${seq}`, delivery: "turn" } : {}),
    ...extra,
  });
  const earlier = [
    "Fix the receipt: the total wraps under the price on a narrow phone.",
    "On it. One writer on the receipt layout, a reviewer on its PR.",
    "Send me before and after screenshots once it's up.",
    "Will do: the writer takes them on the 360 px checkout.",
  ];
  const messages = [
    ...earlier.map((body, i) => msg(i + 1, i % 2 === 0 ? "human" : "lead", body, 900 - i * 60)),
    msg(earlier.length + 1, "human", "How does it look now?", 40),
    msg(earlier.length + 2, "lead", text, 30, { parts }),
  ];
  const state = setChatState(f, STOREFRONT, { needsYou: false, leadWorking: true, lastSeq: messages.length, lastMessageAt: t(30) });
  for (const { input } of f.answers("chat_history")) if (obj(input?.["projectRef"])["projectId"] === STOREFRONT.projectId) f.drop("chat_history", input);
  f.answer("chat_history", { projectRef: STOREFRONT }, { messages, moreBefore: false, moreAfter: false, state });
  for (const [attachmentId, name] of [
    ["F31", "checkout"],
    ["F32", "checkoutApplied"],
  ] as const) {
    const data = shot(name);
    f.answer("attachment_get", { projectRef: { ...STOREFRONT }, attachmentId }, { attachmentId, name: `${name}.jpg`, mime: "image/jpeg", bytes: data.length, dataB64: data.toString("base64") }, LATE_MS);
  }
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

/** Six worktrees the nightly cleanup kept, under their project's folder of worktrees on devbox. */
const WORKTREES_KEPT: JsonObject = {
  items: [
    ["Browser sessions: 1Password logins agents can't read back", "uncommitted changes", "0e85c21b-2f52-4f85-43ac-d684d63072fd"],
    ["Agents can read their brief and the decisions", "1 unpushed commit", "1bf7fe11-81ed-4969-f43c-c35fa354b9f2"],
    ["Authors can read their PR's review findings", "2 unpushed commits", "1444af18-99a9-4cb7-c656-e1e382fc7d66"],
    ["Try it: tailnet port proxy with per-device check", "1 unpushed commit", "4e6cadda-3201-453a-6711-d57f0f0eee82"],
    ["Fix: worker join one-liner prompts again", "1 unpushed commit", "39237c80-2ac3-4401-eef2-61588a348b43"],
    ["Try it: the hub starts, tracks and ends previews", "9 unpushed commits", "e2d0818a-d1ff-4d9c-e20b-1df7e2fbbb46"],
  ].map(([title, unsaved, task]: string[]) => ({
    title: title ?? "",
    unsaved: unsaved ?? "",
    machineId: STOREFRONT.machineId,
    path: `/home/dev/.fleetd/node/worktrees/${STOREFRONT.projectId}/${task}`,
  })),
};

/** The night's cleanup in storefront's chat: one line for the six worktrees it kept, then the memory refresh's. */
function worktreesKept(f: Fixture): Fixture {
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
    msg(3, "system", "Cleanup kept 6 worktrees with unsaved work", 3660, { worktreesKept: WORKTREES_KEPT }),
    msg(4, "system", "Memory refreshed: +3 ~1 −2", 3600, { memoryRefreshed: MEMORY_REFRESHED }),
  ];
  const state = setChatState(f, STOREFRONT, { needsYou: false, leadWorking: false, lastSeq: 4, lastMessageAt: t(3600) });
  for (const { input } of f.answers("chat_history")) if (obj(input?.["projectRef"])["projectId"] === STOREFRONT.projectId) f.drop("chat_history", input);
  f.answer("chat_history", { projectRef: STOREFRONT }, { messages, moreBefore: false, moreAfter: false, state });
  return f;
}

/** storefront's lead set the project up as asked: a repo added, the project renamed, and a variable the person undid. */
function setupChanged(f: Fixture): Fixture {
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
    msg(1, "human", "Add our API repo to this project, call the project Storefront, and point agents at the staging API.", 600),
    msg(2, "system", "Added the repo api", 540, { setupChanged: { kind: "repo_added", names: ["api"] } }),
    msg(3, "system", "Renamed the project to Storefront", 530, { setupChanged: { kind: "title" } }),
    msg(4, "system", "Set the variable API_BASE", 520, { setupChanged: { kind: "env", names: ["API_BASE"], undone: true } }),
    msg(5, "lead", "The api repo is cloned and part of the project, and the project is called Storefront. Agents get API_BASE for staging.", 500),
  ];
  const state = setChatState(f, STOREFRONT, { needsYou: false, leadWorking: false, lastSeq: 5, lastMessageAt: t(500) });
  for (const { input } of f.answers("chat_history")) if (obj(input?.["projectRef"])["projectId"] === STOREFRONT.projectId) f.drop("chat_history", input);
  f.answer("chat_history", { projectRef: STOREFRONT }, { messages, moreBefore: false, moreAfter: false, state });
  f.answer("project_setup_undo", undefined, { ok: true });
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
      Fixture.from(base("typical"), "lead-worked", "storefront's lead finished its turn: beside its reply, how long it worked."),
      { orders: 1, agents: 3, startS: 460, replyS: 250, endS: 240 },
    ),
    leadPictures(Fixture.from(base("typical"), "lead-pictures", "storefront's lead thinking, no agents at work, after a reply that ends in two pictures whose bytes come late.")),
    memoryRefreshed(Fixture.from(base("typical"), "lead-memory", "storefront's chat with the night's memory refresh line: 3 added, 1 updated, 2 removed.")),
    worktreesKept(Fixture.from(base("typical"), "lead-worktrees", "storefront's chat with the night's cleanup line: 6 worktrees kept for unsaved work.")),
    setupChanged(Fixture.from(base("typical"), "lead-setup", "storefront's chat with its lead's setup changes: a repo added, the project renamed, a variable undone.")),
  ],
});
