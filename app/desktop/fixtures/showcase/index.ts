// fleetd.sh's showcase (qa/showcase.spec.ts records it): one request on storefront, from the message you send to the
// merge. The chat starts empty and nothing runs. QA types REQUEST and sends it; chat_send's answer then plays the rest
// as a hub would send it: the lead's reply, two writers at work, the first PR opening and its reviewer, the review
// passing, the PR in CI on the merge line, and the merge. Each step is a "rows" frame that swaps the answers' rows for
// the next step's (src/main/hub/fixture.ts), then the event that makes the app read them again.
import { Fixture } from "../kit/fixture.ts";
import { defineGroup } from "../kit/group.ts";
import { firstProject, writeChat } from "../kit/chat.ts";
import type { JsonObject, JsonValue } from "../kit/json.ts";
import type { Change } from "../../src/shared/contracts";
import { changesAnswers } from "../../src/renderer/screens/train/fixture.ts";

export const REQUEST = "Let shoppers save their cart and pick it up on any device.";

const REPO = "acme/storefront";
const ORDER = "W21";
const TITLE = "Saved carts across devices";
const url = (n: number) => `https://github.com/${REPO}/pull/${String(n)}`;

/** When each step lands, in ms after the send. QA clicks the panel's tabs between them (qa/showcase.spec.ts). */
export const STEPS = { reply: 2400, writers: 2800, opened: 6600, reviewed: 10_200, ci: 11_400, merged: 15_400, end: 18_400 } as const;

type Step = "writers" | "opened" | "reviewed" | "ci" | "merged";
const ORDERED: readonly Step[] = ["writers", "opened", "reviewed", "ci", "merged"];

const build = (base: Fixture): Fixture => {
  const f = Fixture.from(base, "showcase-order", "storefront's empty chat; sending the showcase's request plays it from the lead's reply to its first PR merged.");
  const ref = firstProject(f);
  const now = Date.parse(f.now);
  const iso = (ms: number) => new Date(now + ms).toISOString();
  // Every step's rows carry its own updatedAt, so one `where` picks out one step's rows in any answer.
  const stamp = (s: Step) => iso(-60_000 + ORDERED.indexOf(s) * 1000);
  const projectRef = { ...ref };

  writeChat(f, ref, []);

  // ---- the order on the board, as each step leaves it ----
  const lane = (id: string, role: "implementer" | "reviewer", title: string, status: "working" | "done", started: number, pr?: JsonObject): JsonObject => ({
    laneId: id,
    role,
    taskId: id,
    threadRef: { machineId: ref.machineId, threadId: `s-${id}` },
    title,
    model: "claude-opus-5-5",
    profile: "high",
    status,
    startedAt: iso(started),
    ...(pr === undefined ? {} : { pr }),
  });
  const prRef = (state: string, reviewsDone: number): JsonObject => ({ changeId: "X231", repo: REPO, number: 231, url: url(231), state, reviewsDone, reviewsNeeded: 1, taskId: "T61" });
  const save = (status: "working" | "done") => lane("T61", "implementer", "save the cart for signed-in shoppers", status, -50_000);
  const restore = lane("T62", "implementer", "bring the saved cart back at sign-in", "working", -49_000);
  const review = (status: "working" | "done") => lane("T63", "reviewer", "review #231", status, -20_000, prRef("reviewing", 0));
  const cards: Record<Step, { lanes: JsonObject[]; prs: JsonObject[] }> = {
    writers: { lanes: [save("working"), restore], prs: [] },
    opened: { lanes: [restore, review("working")], prs: [prRef("reviewing", 0)] },
    reviewed: { lanes: [restore], prs: [prRef("ready", 1)] },
    ci: { lanes: [restore], prs: [prRef("ci", 1)] },
    merged: { lanes: [restore], prs: [prRef("merged", 1)] },
  };
  const card = (s: Step): JsonObject => ({
    workstreamId: ORDER,
    projectRef,
    title: TITLE,
    state: "open",
    phase: "working",
    needsYou: 0,
    settled: s === "merged" ? 1 : 0,
    total: 2,
    lanes: cards[s].lanes,
    prs: cards[s].prs,
    createdAt: iso(-55_000),
    updatedAt: stamp(s),
  });
  const orders = ORDERED.map(card);
  f.drop("orders_board");
  f.answer("orders_board", {}, { orders, trains: [], at: f.now });
  f.answer("orders_board", { projectRef }, { orders, trains: [], at: f.now });
  f.drop("order_get");
  f.answer("order_get", { workstreamId: ORDER }, { order: card("writers"), doneLanes: [], requests: [] });

  // ---- the PRs and the merge line ----
  const PASSING = { state: "passing", passed: 6, failed: 0, pending: 0 };
  const prRow = (n: number, title: string, branch: string, s: Step | undefined, over: JsonObject): JsonObject => ({
    repo: REPO,
    number: n,
    url: url(n),
    title,
    branch,
    state: "open",
    author: { role: "implementer", profile: "high", title, login: "acme-fleet" },
    review: { state: "approved", done: 1, needed: 1 },
    checks: PASSING,
    createdAt: iso(-30_000),
    updatedAt: s === undefined ? iso(-3_600_000) : stamp(s),
    ...over,
  });
  const SAVED = "Saved carts are stored per shopper";
  const savedPr = (s: Step, over: JsonObject) => prRow(231, SAVED, "fleetd/T61-saved-carts", s, over);
  // What merged before: the merge line's Recent, and the PR list's older rows.
  const earlier = [
    prRow(229, "Product pages lazy-load their reviews", "fleetd/T12-lazy-reviews", undefined, { state: "merged", mergedAt: iso(-3_600_000), queue: { changeId: "X229", state: "merged", length: 0 } }),
    prRow(228, "Search suggests as you type", "fleetd/T11-search-suggest", undefined, { state: "merged", mergedAt: iso(-7_200_000), updatedAt: iso(-7_200_000), queue: { changeId: "X228", state: "merged", length: 0 } }),
  ];
  const prs = [
    savedPr("opened", { review: { state: "pending", done: 0, needed: 1 }, checks: PASSING, queue: { changeId: "X231", state: "reviewing", length: 1 } }),
    savedPr("reviewed", { queue: { changeId: "X231", state: "ready", position: 0, length: 1 } }),
    savedPr("ci", { checks: { state: "pending", passed: 4, failed: 0, pending: 2 }, queue: { changeId: "X231", state: "ci", length: 1 } }),
    savedPr("merged", { state: "merged", mergedAt: stamp("merged"), queue: { changeId: "X231", state: "merged", length: 0 } }),
    ...earlier,
  ];
  f.drop("pr_list");
  f.answer("pr_list", { projectRef }, { at: f.now, prs: prs as JsonValue });
  const change = (n: number, state: string, updatedAt: string, extra: JsonObject = {}): JsonObject => ({
    changeId: `X${String(n)}`,
    projectRef,
    repo: REPO,
    prNumber: n,
    prUrl: url(n),
    branch: n === 231 ? "fleetd/T61-saved-carts" : `fleetd/T${String(n - 217)}-earlier`,
    headSha: String(n).padStart(40, "a"),
    state,
    reviews: [],
    workstreamId: n === 231 ? ORDER : "W19",
    createdAt: iso(-30_000 - (231 - n) * 3_600_000),
    updatedAt,
    ...extra,
  });
  const changes = [
    change(231, "reviewing", stamp("opened")),
    change(231, "ready", stamp("reviewed"), { position: 0 }),
    change(231, "ci", stamp("ci")),
    change(231, "merged", stamp("merged"), { mergedSha: "b".repeat(40) }),
    change(229, "merged", iso(-3_600_000), { mergedSha: "c".repeat(40) }),
    change(228, "merged", iso(-7_200_000), { mergedSha: "d".repeat(40) }),
  ];
  f.drop("changes_list");
  for (const a of changesAnswers(projectRef, changes as unknown as Change[])) f.answer("changes_list", a.input, a.output);
  // The head's checks, as pr_get has them while it is in CI.
  const check = (name: string, done: boolean, startedMs: number): JsonObject => ({
    name,
    state: done ? "passing" : "pending",
    ...(done ? { conclusion: "success", completedAt: iso(startedMs + 40_000) } : {}),
    startedAt: iso(startedMs),
  });
  f.answer("pr_get", { repo: REPO, number: 231 }, {
    pr: savedPr("ci", { checks: { state: "pending", passed: 4, failed: 0, pending: 2 }, queue: { changeId: "X231", state: "ci", length: 1 } }),
    body: "Signed-in shoppers keep their cart on the server, so it follows them to any device.",
    checks: [check("build", true, -90_000), check("lint", true, -90_000), check("typecheck", true, -90_000), check("unit tests", false, -90_000), check("e2e (chromium)", false, -90_000), check("licenses", true, -90_000)],
    reviews: [],
    history: [],
    links: { pr: url(231), checks: `${url(231)}/checks`, files: `${url(231)}/files` },
  });

  // Hidden until their step: every step's rows. The earlier merges stay.
  const rowsOf = (s: Step) => [
    { tool: "orders_board", field: "orders", where: { updatedAt: stamp(s) } },
    { tool: "pr_list", field: "prs", where: { updatedAt: stamp(s) } },
    { tool: "changes_list", field: "changes", where: { updatedAt: stamp(s) } },
  ];
  // The Agents tab's list (agents_list, which the kit makes from the board's lanes): each agent from its start to its end.
  const agent = (laneId: string) => ({ tool: "agents_list", field: "agents", where: { laneId } });
  const agents: Record<Step, { show: string[]; hide: string[] }> = {
    writers: { show: ["T61", "T62"], hide: [] },
    opened: { show: ["T63"], hide: ["T61"] },
    reviewed: { show: [], hide: ["T63"] },
    ci: { show: [], hide: [] },
    merged: { show: [], hide: [] },
  };
  f.hidden = [...ORDERED.flatMap(rowsOf), ...["T61", "T62", "T63"].map(agent)];

  // ---- the chat and the live feed ----
  let seq = 0;
  const event = (type: string, summary: string, data: JsonObject, over: JsonObject = {}): JsonObject => ({
    seq: ++seq,
    at: f.now,
    type,
    summary,
    machineId: ref.machineId,
    projectId: ref.projectId,
    data,
    ...over,
  });
  const message = (n: number, author: "human" | "lead", text: string, state: "final" | "streaming", ms: number, over: JsonObject = {}): JsonObject => ({
    messageId: `m${String(n)}`,
    projectRef,
    seq: n,
    author,
    text,
    attachments: [],
    createdAt: iso(-12_000 + ms / 10),
    state,
    ...over,
  });
  const said = (n: number, text: string, state: "final" | "streaming", ms: number) =>
    event("chat.message", "The lead in the chat", { projectRef, messageId: `m${String(n)}`, seq: n, author: "lead", state, message: message(n, "lead", text, state, ms) });
  const waiting = (lastSeq: number, leadWorking: boolean) => event("chat.waiting", "The lead's turn", { projectRef, needsYou: false, leadWorking, lastSeq, lastMessageAt: f.now });
  // Every project's slots, storefront's running `running`: the chat header's "agents n / 6".
  const projects = (Array.isArray(f.snapshot?.["projects"]) ? f.snapshot["projects"] : []) as JsonObject[];
  const slots = (running: number): JsonObject => ({
    cap: 12,
    used: running,
    queued: 0,
    perProject: projects.map((p) => {
      const own = p["projectId"] === ref.projectId;
      return { projectRef: { machineId: p["machineId"] ?? "", projectId: p["projectId"] ?? "" }, maxAgents: 6, running: own ? running : 0, queued: 0 };
    }),
  });
  // The kit counts every step's lanes at once (kit/agents.ts): the first live frame has them idle, so before the send
  // nothing runs, in the header, the slots and Status alike.
  // A full frame replaces the last one whole: the machines go along in each.
  const machines = f.live.findLast((l) => l["full"] === true)?.["machines"];
  const withMachines = machines === undefined ? {} : { machines };
  f.live = [{ at: f.now, full: true, lanes: ["T61", "T62", "T63"].map((laneId) => ({ laneId, status: "idle" })), ...withMachines }];
  const live = (lanes: ReadonlyArray<[string, JsonObject]>, running: number): JsonObject => ({
    at: f.now,
    full: true,
    lanes: lanes.map(([laneId, activity], i) => ({
      laneId,
      status: "working",
      activity: { activity, since: iso(-2000) },
      tokens: { input: 4200 + i * 311, output: 1100 + i * 57, cacheRead: 0, live: true },
      spark: { endAt: iso(-(now % 2000)), samples: Array.from({ length: 12 }, (_, k) => ((k * 7 + i * 13) % 50) + 4) },
    })),
    slots: slots(running),
    ...withMachines,
  });
  const swap = (from: Step | undefined, to: Step): JsonObject => ({
    hide: [...(from === undefined ? [] : rowsOf(from)), ...agents[to].hide.map(agent)],
    show: [...rowsOf(to), ...agents[to].show.map(agent)],
  });
  const task = (type: string, id: string, summary: string) => event(type, summary, { taskId: id, workstreamId: ORDER }, { threadId: `s-${id}` });
  const changeEvent = (type: string, summary: string, from: string, to: string) =>
    event(type, summary, { changeId: "X231", repo: REPO, prNumber: 231, from, to, workstreamId: ORDER });

  const frames: Array<{ ms: number; kind: "event" | "live" | "rows"; payload: JsonObject }> = [
    { ms: 0, kind: "event", payload: waiting(1, true) },
    { ms: 600, kind: "event", payload: said(2, "", "streaming", 600) },
    {
      ms: STEPS.reply,
      kind: "event",
      payload: said(2, "On it, in two parts: one writer saves the cart for signed-in shoppers, one brings it back at sign-in. Each PR gets its own reviewer before it merges.", "final", STEPS.reply),
    },
    { ms: STEPS.writers, kind: "rows", payload: swap(undefined, "writers") },
    { ms: STEPS.writers, kind: "event", payload: event("workstream.created", `${ORDER} created: ${TITLE}`, { workstreamId: ORDER }) },
    { ms: STEPS.writers, kind: "event", payload: task("task.started", "T61", "T61 started: save the cart for signed-in shoppers") },
    { ms: STEPS.writers, kind: "live", payload: live([["T61", { kind: "read", path: "src/cart/store.ts" }], ["T62", { kind: "thinking" }]], 2) },
    { ms: STEPS.writers + 1300, kind: "live", payload: live([["T61", { kind: "edit", path: "src/cart/store.ts" }], ["T62", { kind: "read", path: "src/auth/session.ts" }]], 2) },
    { ms: STEPS.writers + 2600, kind: "live", payload: live([["T61", { kind: "command", text: "npm test -- cart/store" }], ["T62", { kind: "edit", path: "src/auth/sign-in.ts" }]], 2) },
    { ms: STEPS.opened, kind: "rows", payload: swap("writers", "opened") },
    { ms: STEPS.opened, kind: "event", payload: changeEvent("change.queued", "X231 queued: acme/storefront#231", "queued", "reviewing") },
    { ms: STEPS.opened, kind: "event", payload: task("task.completed", "T61", "T61 completed: opened acme/storefront#231") },
    { ms: STEPS.opened, kind: "live", payload: live([["T62", { kind: "edit", path: "src/cart/restore.ts" }], ["T63", { kind: "read", path: "src/cart/store.ts" }]], 2) },
    { ms: STEPS.opened + 400, kind: "event", payload: said(3, "#231 is up: carts are stored per shopper. A reviewer is on it.", "final", STEPS.opened + 400) },
    { ms: STEPS.opened + 1800, kind: "live", payload: live([["T62", { kind: "edit", path: "src/cart/restore.ts" }], ["T63", { kind: "command", text: "npm test -- cart" }]], 2) },
    { ms: STEPS.reviewed, kind: "rows", payload: swap("opened", "reviewed") },
    { ms: STEPS.reviewed, kind: "event", payload: event("review.verdict", "#231 approved: no blocking findings", { changeId: "X231", prNumber: 231, repo: REPO, workstreamId: ORDER, blocking: 0, nonBlocking: 1 }) },
    { ms: STEPS.reviewed, kind: "event", payload: task("task.completed", "T63", "T63 completed: #231 approved") },
    { ms: STEPS.reviewed, kind: "live", payload: live([["T62", { kind: "command", text: "npm test -- cart/restore" }]], 1) },
    { ms: STEPS.ci, kind: "rows", payload: swap("reviewed", "ci") },
    { ms: STEPS.ci, kind: "event", payload: changeEvent("change.state", "X231 ci: acme/storefront#231", "ready", "ci") },
    { ms: STEPS.merged, kind: "rows", payload: swap("ci", "merged") },
    { ms: STEPS.merged, kind: "event", payload: event("pr.merged", "X231 merged: acme/storefront#231", { changeId: "X231", prNumber: 231, repo: REPO, workstreamId: ORDER }) },
    { ms: STEPS.merged + 500, kind: "event", payload: said(4, "#231 is merged. The second PR, bringing the cart back at sign-in, opens next.", "final", STEPS.merged + 500) },
  ];

  f.answer("chat_send", { text: REQUEST }, { message: message(1, "human", REQUEST, "final", 0, { by: "laptop", clientRequestId: "showcase-1", delivery: "turn" }) });
  f.then("chat_send", { text: REQUEST }, { frames });
  // Reads after the chat's newest message, as the app makes once a message lands: nothing more.
  const state = { projectRef, needsYou: false, leadWorking: true, lastSeq: 4, lastMessageAt: f.now };
  for (let after = 0; after <= 4; after++) f.answer("chat_history", { projectRef, after }, { messages: [], moreBefore: after > 0, moreAfter: false, state });
  return f.settleAt(0);
};

export default defineGroup({
  fixtures: (base) => [build(base("typical"))],
});

