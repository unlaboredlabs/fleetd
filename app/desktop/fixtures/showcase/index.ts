// fleetd.sh's showcase (qa/showcase.spec.ts records it): a busy storefront, and one request through it, from the message
// you send to its merge. Three orders are already at work when it opens: seven agents, a PR in review and one ready. QA
// types REQUEST and sends it; chat_send's answer then plays the rest as a hub would send it: the lead splits it into
// three parts and starts a writer on each, the first PR opens and its review passes, the web writer tests the change in
// a live browser screen and the iPhone writer boots a simulator and taps through the app, until its sign-in texts a
// code and the lead asks you to take over (QA takes over, types the code and hands back), the browser's recording lands
// as the second PR's proof, and the train merges four PRs as one batch.
//
// The board, the PR list and the merge line move in STEPS: each step's rows carry its own updatedAt, and a "rows" frame
// swaps one step's rows for the next one's (src/main/hub/fixture.ts) before the event that makes the app read them again.
// The screens' rows change hands the same way, by their state and control; their pages are media/ (media.ts).
import { readFileSync } from "node:fs";
import path from "node:path";
import { Fixture } from "../kit/fixture.ts";
import { defineGroup } from "../kit/group.ts";
import { firstProject, writeChat } from "../kit/chat.ts";
import { asText, type JsonObject, type JsonValue } from "../kit/json.ts";
import type { Change } from "../../src/shared/contracts";
import { changesAnswers } from "../../src/renderer/screens/train/fixture.ts";
import { CODE, PHONE_FRAME } from "./pages.ts";

export const REQUEST = "Let shoppers save their cart and pick it up on the web or the iPhone app.";

/** The two screens, as the node names sessions: "B" and 32 hex digits. */
export const SCREEN = { web: "B3f0c9a1d5e7b2468ac0e1f2d3c4b5a69", phone: "B7d2e4f6a8c0b1d3e5f7a9c1e3b5d7f90" } as const;

/** When each step lands, in ms after the send; QA moves between the views on its own times (qa/showcase.spec.ts). */
export const STEPS = {
  reply: 1300,
  split: 1400,
  pr231: 3800,
  screens: 5000,
  approve229: 6500,
  approve231: 8000,
  ci229: 9000,
  merged229: 12_000,
  phoneAsks: 13_600,
  phoneBack: 18_000,
  pr232: 19_000,
  pr233: 20_800,
  approved: 21_800,
  batch: 22_600,
  merged: 25_000,
  end: 27_600,
} as const;

/** The web screen's pages, by when each shows. */
const WEB_PAGES: ReadonlyArray<readonly [number, string, string]> = [
  [STEPS.screens, "webSignIn", "/account/sign-in"],
  [6900, "webProduct", "/products/linen-shirt"],
  [7800, "webAdded", "/products/linen-shirt"],
  [8700, "webCart", "/cart"],
];
/** The phone's, up to its sign-in code; the person types the code and the rest follows the hand back. */
const PHONE_PAGES: ReadonlyArray<readonly [number, string]> = [
  [STEPS.screens, "boot1"],
  [9000, "boot2"],
  [10_000, "home"],
  [10_900, "appHome"],
  [11_800, "appSignedOut"],
  [12_700, "appSignIn"],
  [13_500, "appCode0"],
];
/** After Take over: each digit of the code as the person types it (QA types on the same beat). */
export const DIGIT_MS = { first: 500, every: 250 } as const;

const REPO = "acme/storefront";
const ORDER = "W21";
const TITLE = "Saved carts on the web and the iPhone app";
const url = (n: number) => `https://github.com/${REPO}/pull/${String(n)}`;
const MEDIA = path.join(import.meta.dirname, "media");
const b64 = (name: string) => readFileSync(path.join(MEDIA, `${name}.jpg`)).toString("base64");

/** The steps that change rows: the lead's reply and the end are only times. */
type Step = Exclude<keyof typeof STEPS, "reply" | "end">;
const ORDERED = (Object.keys(STEPS) as Array<keyof typeof STEPS>).filter((s): s is Step => s !== "reply" && s !== "end");
/** The step in force at `ms` after the send; undefined before the first. */
const stepAt = (ms: number): Step | undefined => ORDERED.filter((s) => STEPS[s] <= ms).at(-1);
const BEFORE = "before" as const;
type When = Step | typeof BEFORE;
const index = (s: When) => (s === BEFORE ? -1 : ORDERED.indexOf(s));
/** Whether `s` is at or past `from` (and before `to`). */
const within = (s: When, from: When, to?: When) => index(s) >= index(from) && (to === undefined || index(s) < index(to));

// ---- the agents ----
type Role = "implementer" | "reviewer" | "verifier";
interface Agent {
  readonly id: string;
  readonly order: string;
  readonly role: Role;
  readonly title: string;
  /** The steps it works between; `to` it is done. */
  readonly from: When;
  readonly to?: When;
  /** What it does, a step at a time: the live feed walks through these. */
  readonly doing: readonly JsonObject[];
}
const cmd = (text: string): JsonObject => ({ kind: "command", text });
const edit = (p: string): JsonObject => ({ kind: "edit", path: p });
const read = (p: string): JsonObject => ({ kind: "read", path: p });
const AGENTS: readonly Agent[] = [
  { id: "T51", order: "W19", role: "implementer", title: "Add a price filter to search", from: BEFORE, doing: [edit("src/search/filters.tsx"), cmd("pnpm test search"), read("src/search/query.ts"), edit("src/search/query.ts")] },
  { id: "T52", order: "W19", role: "reviewer", title: "Review #229", from: BEFORE, to: "approve229", doing: [read("src/search/facets.ts"), cmd("gh pr diff 229"), { kind: "thinking" }] },
  { id: "T55", order: "W20", role: "implementer", title: "Translate the order emails", from: BEFORE, doing: [edit("emails/order/de.json"), edit("emails/order/fr.json"), cmd("pnpm emails:build"), edit("emails/order/nl.json")] },
  { id: "T56", order: "W20", role: "verifier", title: "Check the German order email", from: BEFORE, doing: [cmd("pnpm emails:preview de"), read("emails/order/de.json"), { kind: "thinking" }] },
  { id: "T58", order: "W18", role: "implementer", title: "Apply gift cards before tax", from: BEFORE, doing: [read("src/checkout/tax.ts"), edit("src/checkout/giftCards.ts"), cmd("pnpm test checkout/tax")] },
  { id: "T59", order: "W18", role: "implementer", title: "Show the gift card balance at checkout", from: BEFORE, doing: [edit("web/checkout/GiftCard.tsx"), cmd("pnpm test checkout/gift"), read("src/checkout/giftCards.ts")] },
  { id: "T57", order: "W20", role: "implementer", title: "Pick the email language from the order", from: BEFORE, doing: [read("src/orders/locale.ts"), edit("src/orders/locale.ts"), cmd("pnpm test orders/locale")] },
  { id: "T61", order: ORDER, role: "implementer", title: "Save carts per shopper", from: "split", to: "pr231", doing: [read("src/cart/store.ts"), edit("src/cart/store.ts"), cmd("pnpm test cart/store")] },
  { id: "T62", order: ORDER, role: "implementer", title: "Bring the saved cart back on the web", from: "split", to: "pr232", doing: [read("web/cart/page.tsx"), edit("web/cart/restore.ts"), cmd("pnpm test web/cart")] },
  { id: "T63", order: ORDER, role: "implementer", title: "Bring the saved cart back in the iPhone app", from: "split", to: "pr233", doing: [read("ios/Cart/CartView.swift"), edit("ios/Cart/CartStore.swift"), cmd("xcodebuild test -scheme Linen")] },
  { id: "T64", order: ORDER, role: "reviewer", title: "Review #231", from: "pr231", to: "approve231", doing: [cmd("gh pr diff 231"), read("src/cart/store.ts")] },
  { id: "T65", order: ORDER, role: "reviewer", title: "Review #232", from: "pr232", to: "approved", doing: [cmd("gh pr diff 232"), read("web/cart/restore.ts")] },
  { id: "T66", order: ORDER, role: "reviewer", title: "Review #233", from: "pr233", to: "approved", doing: [cmd("gh pr diff 233"), read("ios/Cart/CartStore.swift")] },
];
/** While a screen is open, its agent is in it. */
const ON_SCREEN: Readonly<Record<string, { from: number; to: number; activity: JsonObject }>> = {
  T62: { from: STEPS.screens, to: STEPS.pr232, activity: { kind: "tool", name: "in a browser", detail: "localhost:3000/cart" } },
  T63: { from: STEPS.screens, to: STEPS.pr233, activity: { kind: "tool", name: "on an iPhone", detail: "iPhone 17 simulator" } },
};

// ---- the orders ----
const ORDERS: ReadonlyArray<{ id: string; title: string; prs: readonly number[] }> = [
  { id: ORDER, title: TITLE, prs: [231, 232, 233] },
  { id: "W19", title: "Filter search results by price", prs: [229] },
  { id: "W20", title: "Order emails in the shopper’s language", prs: [230] },
  { id: "W18", title: "Gift cards apply before tax", prs: [] },
];

// ---- the PRs: each one's state from a step on ----
type PrState = "reviewing" | "ready" | "ci" | "merged";
interface Pr {
  readonly n: number;
  readonly order: string;
  readonly task: string;
  readonly title: string;
  readonly branch: string;
  readonly states: ReadonlyArray<readonly [When, PrState]>;
}
const PRS: readonly Pr[] = [
  { n: 229, order: "W19", task: "T50", title: "Search filters by price range", branch: "fleetd/T50-price-filter", states: [[BEFORE, "reviewing"], ["approve229", "ready"], ["ci229", "ci"], ["merged229", "merged"]] },
  { n: 230, order: "W20", task: "T54", title: "Order emails speak the shopper’s language", branch: "fleetd/T54-email-locale", states: [[BEFORE, "ready"], ["batch", "ci"], ["merged", "merged"]] },
  { n: 231, order: ORDER, task: "T61", title: "Carts are saved per shopper", branch: "fleetd/T61-saved-carts", states: [["pr231", "reviewing"], ["approve231", "ready"], ["batch", "ci"], ["merged", "merged"]] },
  { n: 232, order: ORDER, task: "T62", title: "The web cart comes back at sign-in", branch: "fleetd/T62-web-cart", states: [["pr232", "reviewing"], ["approved", "ready"], ["batch", "ci"], ["merged", "merged"]] },
  { n: 233, order: ORDER, task: "T63", title: "The iPhone app picks up the saved cart", branch: "fleetd/T63-ios-cart", states: [["pr233", "reviewing"], ["approved", "ready"], ["batch", "ci"], ["merged", "merged"]] },
];
const prState = (pr: Pr, s: When): PrState | undefined => pr.states.filter(([from]) => within(s, from)).at(-1)?.[1];

const build = (base: Fixture): Fixture => {
  const f = Fixture.from(base, "showcase-order", "storefront at work on three orders; sending the showcase's request plays it from the lead's reply, through its screens, to its batch merged.");
  const ref = firstProject(f);
  const now = Date.parse(f.now);
  const iso = (ms: number) => new Date(now + ms).toISOString();
  const projectRef = { ...ref };
  // The hub serves screens: the Agents section has its Screens view.
  if (f.state.phase !== "live") throw new Error("typical's hub isn't live");
  f.state = { ...f.state, features: ["presence", "browser_sessions"] };
  // Every step's rows carry its own updatedAt, so one `where` picks out one step's rows in any answer.
  const STEPPED: readonly When[] = [BEFORE, ...ORDERED];
  const stamp = (s: When) => iso(-60_000 + (index(s) + 1) * 1000);

  writeChat(f, ref, [
    { author: "human", text: "Order emails should go out in the shopper’s language.", minutesAgo: 42 },
    { author: "lead", text: "On it: one writer translates the order emails, and a QA agent checks the German one in a real inbox. #230 is up for the first part.", minutesAgo: 41 },
  ]);
  const FIRST = 3;

  // ---- the board, as each step leaves it ----
  const lane = (a: Agent, s: When): JsonObject | undefined => {
    if (!within(s, a.from)) return undefined;
    const done = a.to !== undefined && within(s, a.to);
    const pr = PRS.find((p) => p.task === a.id || (a.role === "reviewer" && a.title.endsWith(`#${String(p.n)}`)));
    const asks = a.id === "T63" && within(s, "phoneAsks", "phoneBack");
    return {
      laneId: a.id,
      role: a.role,
      taskId: a.id,
      threadRef: { machineId: ref.machineId, threadId: `s-${a.id}` },
      title: a.title,
      model: "claude-opus-5-5",
      profile: "high",
      status: done ? "done" : asks ? "waiting" : "working",
      ...(asks ? { statusReason: "take over its iPhone; the sign-in texts a code to a test number" } : {}),
      startedAt: iso(a.from === BEFORE ? -1_500_000 : -40_000),
      ...(pr === undefined || prState(pr, s) === undefined ? {} : { pr: prRef(pr, s) }),
    };
  };
  const prRef = (pr: Pr, s: When): JsonObject => {
    const state = prState(pr, s) ?? "reviewing";
    return { changeId: `X${String(pr.n)}`, repo: REPO, number: pr.n, url: url(pr.n), state, reviewsDone: state === "reviewing" ? 0 : 1, reviewsNeeded: 1, taskId: pr.task };
  };
  const card = (o: (typeof ORDERS)[number], s: When): JsonObject | undefined => {
    if (o.id === ORDER && !within(s, "split")) return undefined;
    const lanes = AGENTS.filter((a) => a.order === o.id)
      .map((a) => lane(a, s))
      .filter((l): l is JsonObject => l !== undefined && l["status"] !== "done");
    const prs = PRS.filter((p) => p.order === o.id && prState(p, s) !== undefined);
    return {
      workstreamId: o.id,
      projectRef,
      title: o.title,
      state: "open",
      phase: "working",
      needsYou: lanes.some((l) => l["status"] === "waiting") ? 1 : 0,
      settled: prs.filter((p) => prState(p, s) === "merged").length,
      total: Math.max(o.prs.length, 1),
      lanes,
      prs: prs.map((p) => prRef(p, s)),
      createdAt: iso(o.id === ORDER ? -55_000 : -3_000_000),
      updatedAt: stamp(s),
    };
  };
  const orders = STEPPED.flatMap((s) => ORDERS.map((o) => card(o, s)).filter((c): c is JsonObject => c !== undefined));
  f.drop("orders_board");
  f.answer("orders_board", {}, { orders, trains: [], at: f.now });
  f.answer("orders_board", { projectRef }, { orders, trains: [], at: f.now });
  f.drop("order_get");
  for (const o of ORDERS) f.answer("order_get", { workstreamId: o.id }, { order: card(o, "split") ?? {}, doneLanes: [], requests: [] });

  // ---- the PRs and the merge line ----
  const PASSING = { state: "passing", passed: 6, failed: 0, pending: 0 };
  const IN_CI = { state: "pending", passed: 4, failed: 0, pending: 2 };
  const mergedAt = (pr: Pr) => (pr.n === 229 ? iso(-50_000) : iso(-30_000));
  const batchSha = "b".repeat(40);
  const prRow = (pr: Pr, s: When): JsonObject | undefined => {
    const state = prState(pr, s);
    if (state === undefined) return undefined;
    const position = state === "ready" ? PRS.filter((p) => prState(p, s) === "ready").indexOf(pr) : undefined;
    return {
      repo: REPO,
      number: pr.n,
      url: url(pr.n),
      title: pr.title,
      branch: pr.branch,
      state: state === "merged" ? "merged" : "open",
      author: { role: "implementer", profile: "high", title: pr.title, login: "acme-fleet" },
      review: state === "reviewing" ? { state: "pending", done: 0, needed: 1 } : { state: "approved", done: 1, needed: 1 },
      checks: state === "ci" ? IN_CI : PASSING,
      createdAt: iso(-30_000),
      updatedAt: stamp(s),
      ...(state === "merged" ? { mergedAt: mergedAt(pr) } : {}),
      queue: { changeId: `X${String(pr.n)}`, state, ...(position === undefined ? {} : { position }), length: state === "merged" ? 0 : 1 },
    };
  };
  const change = (pr: Pr, s: When): JsonObject | undefined => {
    const state = prState(pr, s);
    if (state === undefined) return undefined;
    const ready = PRS.filter((p) => prState(p, s) === "ready");
    return {
      changeId: `X${String(pr.n)}`,
      projectRef,
      repo: REPO,
      prNumber: pr.n,
      prUrl: url(pr.n),
      branch: pr.branch,
      headSha: String(pr.n).padStart(40, "a"),
      state,
      reviews: [],
      workstreamId: pr.order,
      taskId: pr.task,
      createdAt: iso(-30_000),
      updatedAt: stamp(s),
      ...(state === "ready" ? { position: ready.indexOf(pr) } : {}),
      ...(state === "merged" ? { mergedSha: pr.n === 229 ? "c".repeat(40) : batchSha } : {}),
    };
  };
  // What merged before: the merge line's Recent, and the PR list's older rows.
  const earlier = (n: number, title: string, branch: string, agoMs: number, sha: string) => ({
    pr: {
      repo: REPO,
      number: n,
      url: url(n),
      title,
      branch,
      state: "merged",
      author: { role: "implementer", profile: "high", title, login: "acme-fleet" },
      review: { state: "approved", done: 1, needed: 1 },
      checks: PASSING,
      createdAt: iso(-agoMs - 600_000),
      updatedAt: iso(-agoMs),
      mergedAt: iso(-agoMs),
      queue: { changeId: `X${String(n)}`, state: "merged", length: 0 },
    },
    change: {
      changeId: `X${String(n)}`,
      projectRef,
      repo: REPO,
      prNumber: n,
      prUrl: url(n),
      branch,
      headSha: String(n).padStart(40, "a"),
      state: "merged",
      reviews: [],
      workstreamId: "W17",
      createdAt: iso(-agoMs - 600_000),
      updatedAt: iso(-agoMs),
      mergedSha: sha,
    },
  });
  const before = [
    earlier(228, "Product pages lazy-load their reviews", "fleetd/T44-lazy-reviews", 3_600_000, "d".repeat(40)),
    earlier(227, "Search suggests as you type", "fleetd/T43-search-suggest", 3_600_000, "d".repeat(40)),
  ];
  const prs = [...STEPPED.flatMap((s) => PRS.map((p) => prRow(p, s)).filter((r): r is JsonObject => r !== undefined)), ...before.map((b) => b.pr)];
  f.drop("pr_list");
  f.answer("pr_list", { projectRef }, { at: f.now, prs: prs as JsonValue });
  const changes = [...STEPPED.flatMap((s) => PRS.map((p) => change(p, s)).filter((r): r is JsonObject => r !== undefined)), ...before.map((b) => b.change)];
  f.drop("changes_list");
  for (const a of changesAnswers(projectRef, changes as unknown as Change[])) f.answer("changes_list", a.input, a.output);
  // #229's checks, as pr_get has them while it is in CI on its own.
  const check = (name: string, done: boolean): JsonObject => ({ name, state: done ? "passing" : "pending", ...(done ? { conclusion: "success", completedAt: iso(-50_000) } : {}), startedAt: iso(-90_000) });
  const lone = PRS[0] as Pr;
  f.answer("pr_get", { repo: REPO, number: 229 }, {
    pr: prRow(lone, "ci229") ?? {},
    body: "Shoppers can narrow search results to a price range.",
    checks: [check("build", true), check("lint", true), check("typecheck", true), check("unit tests", false), check("e2e (chromium)", false), check("licenses", true)],
    reviews: [],
    history: [],
    links: { pr: url(229), checks: `${url(229)}/checks`, files: `${url(229)}/files` },
  });

  // ---- the screens ----
  const sessionRow = (id: string, task: string, purpose: string, kind: string, startMs: number, more: JsonObject): JsonObject => ({
    sessionId: id,
    projectRef,
    threadId: `s-${task}`,
    taskId: task,
    purpose,
    kind,
    state: "live",
    control: "agent",
    startedAt: iso(startMs),
    files: [],
    ...more,
  });
  const files = [
    { file: "actions", bytes: 4_812 },
    { file: "dom", bytes: 61_230 },
    { file: "video", bytes: 402_118 },
  ];
  const WEB = "Check a signed-in shopper’s cart is saved";
  const PHONE = "Tap through the saved cart in the iPhone app";
  const ASKS = "The sign-in texts a code to a test number, which I can’t read. Enter the code, then hand back.";
  const web = {
    live: sessionRow(SCREEN.web, "T62", WEB, "browser", STEPS.screens - 1000, {}),
    saving: sessionRow(SCREEN.web, "T62", WEB, "browser", STEPS.screens - 1000, { state: "uploading", endedAt: iso(STEPS.pr232 - 600) }),
    ended: sessionRow(SCREEN.web, "T62", WEB, "browser", STEPS.screens - 1000, { state: "recorded", endedAt: iso(STEPS.pr232 - 600), files }),
  };
  const phone = {
    live: sessionRow(SCREEN.phone, "T63", PHONE, "ios", STEPS.screens - 1000, {}),
    // Without files, so a `where` for the plain live row (files: []) never matches it.
    asking: (({ files: _, ...r }) => r)(sessionRow(SCREEN.phone, "T63", PHONE, "ios", STEPS.screens - 1000, { takeoverReason: ASKS })),
    yours: sessionRow(SCREEN.phone, "T63", PHONE, "ios", STEPS.screens - 1000, { control: "human" }),
    handing: sessionRow(SCREEN.phone, "T63", PHONE, "ios", STEPS.screens - 1000, { control: "handing_back" }),
    saving: sessionRow(SCREEN.phone, "T63", PHONE, "ios", STEPS.screens - 1000, { state: "uploading", endedAt: iso(STEPS.pr233 - 600) }),
    ended: sessionRow(SCREEN.phone, "T63", PHONE, "ios", STEPS.screens - 1000, { state: "recorded", endedAt: iso(STEPS.pr233 - 600), files }),
  };
  // Screens that ended before: the list's Recent.
  const recent = [
    sessionRow("B1c4e7a0d3f6b9c2e5a8d1f4b7c0e3a6d", "T56", "Check the German order email in a real inbox", "browser", -900_000, { state: "recorded", endedAt: iso(-810_000), files }),
    sessionRow("B9e2b5d8a1c4f7e0b3d6a9c2f5e8b1d4a", "T50", "Check the price filter on a phone-sized screen", "android", -2_400_000, { state: "recorded", endedAt: iso(-2_310_000), files }),
  ];
  const sessions = [web.live, web.saving, web.ended, phone.live, phone.asking, phone.yours, phone.handing, phone.saving, phone.ended, ...recent];
  f.answer("browser_sessions", { projectRef }, { sessions, retention: { retentionDays: 30, maxGbPerProject: 20 } });
  // One row of a screen, by what sets it apart from its others.
  const where = (r: JsonObject) => ({
    tool: "browser_sessions",
    field: "sessions",
    where: { sessionId: r["sessionId"] ?? "", state: r["state"] ?? "", control: r["control"] ?? "", ...(r["takeoverReason"] === undefined ? { files: r["files"] ?? [] } : { takeoverReason: r["takeoverReason"] }) },
  });
  const session = (r: JsonObject): JsonObject => ({
    seq: 0,
    at: f.now,
    type: "browser.session",
    summary: `browser session ${asText(r["state"])} ${asText(r["control"])}`,
    ...ref,
    data: { projectRef, sessionId: r["sessionId"] ?? "", state: r["state"] ?? "", control: r["control"] ?? "", taskId: r["taskId"] ?? "" },
  });
  const frame = (sessionId: string, seq: number, image: string, control: string, address?: string): JsonObject => ({
    sessionId,
    seq,
    jpegB64: b64(image),
    ...(sessionId === SCREEN.phone ? PHONE_FRAME : { width: 960, height: 600 }),
    ...(address === undefined ? {} : { url: `http://localhost:3000${address}` }),
    control,
  });

  // Hidden until their step: every step's rows, every agent but those at work from the start, and the live screens.
  const rowsOf = (s: When) => [
    { tool: "orders_board", field: "orders", where: { updatedAt: stamp(s) } },
    { tool: "pr_list", field: "prs", where: { updatedAt: stamp(s) } },
    { tool: "changes_list", field: "changes", where: { updatedAt: stamp(s) } },
  ];
  const agent = (laneId: string) => ({ tool: "agents_list", field: "agents", where: { laneId } });
  f.hidden = [
    ...ORDERED.flatMap(rowsOf),
    ...AGENTS.filter((a) => a.from !== BEFORE).map((a) => agent(a.id)),
    ...[web.live, web.saving, web.ended, phone.live, phone.asking, phone.yours, phone.handing, phone.saving, phone.ended].map(where),
  ];

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
  // Seven at work from the start, so its max is 12, not 6: kit/agents.ts gives storefront the same.
  const slots = (running: number): JsonObject => ({
    cap: 12,
    used: running,
    queued: 0,
    perProject: projects.map((p) => {
      const own = p["projectId"] === ref.projectId;
      return { projectRef: { machineId: p["machineId"] ?? "", projectId: p["projectId"] ?? "" }, maxAgents: 12, running: own ? running : 0, queued: 0 };
    }),
  });
  const machines = f.live.findLast((l) => l["full"] === true)?.["machines"];
  const withMachines = machines === undefined ? {} : { machines };
  // The live feed at `ms` after the send (negative: before it): every agent at work, each a step further along its
  // work every 1.8 s, staggered so that one or two of them move each time.
  const live = (ms: number): JsonObject => {
    const s: When = stepAt(ms) ?? BEFORE;
    const lanes = AGENTS.flatMap((a, i) => {
      const l = lane(a, s);
      if (l === undefined || l["status"] === "done") return [];
      if (l["status"] === "waiting") return [{ laneId: a.id, status: "waiting" }];
      const screen = ON_SCREEN[a.id];
      const activity = screen !== undefined && ms >= screen.from && ms < screen.to ? screen.activity : (a.doing[Math.floor((ms + 4000 + i * 700) / 1800) % a.doing.length] ?? { kind: "thinking" });
      return [
        {
          laneId: a.id,
          status: "working",
          activity: { activity, since: iso(-2000) },
          tokens: { input: 4200 + i * 311, output: 1100 + i * 57, cacheRead: 0, live: true },
          spark: { endAt: iso(-(now % 2000)), samples: Array.from({ length: 12 }, (_, k) => ((k * 7 + i * 13) % 50) + 4) },
        },
      ];
    });
    // The idle ones are named too, so a lane the board starts later doesn't count before it starts.
    const idle = AGENTS.filter((a) => !lanes.some((l) => l.laneId === a.id)).map((a) => ({ laneId: a.id, status: "idle" }));
    return { at: f.now, full: true, lanes: [...lanes, ...idle], slots: slots(lanes.filter((l) => l.status === "working").length), ...withMachines };
  };
  f.live = [live(-1)];

  const swap = (from: When, to: Step): JsonObject => {
    const started = AGENTS.filter((a) => a.from === to).map((a) => agent(a.id));
    const ended = AGENTS.filter((a) => a.to === to).map((a) => agent(a.id));
    return { hide: [...rowsOf(from), ...ended], show: [...rowsOf(to), ...started] };
  };
  const task = (type: string, id: string, summary: string, order = ORDER) => event(type, summary, { taskId: id, workstreamId: order }, { threadId: `s-${id}` });
  const changeEvent = (type: string, n: number, from: string, to: string, order = ORDER) =>
    event(type, `X${String(n)} ${to}: ${REPO}#${String(n)}`, { changeId: `X${String(n)}`, repo: REPO, prNumber: n, from, to, workstreamId: order });
  const merged = (n: number, order = ORDER) => event("pr.merged", `X${String(n)} merged: ${REPO}#${String(n)}`, { changeId: `X${String(n)}`, prNumber: n, repo: REPO, workstreamId: order });
  const verdict = (n: number, order = ORDER) => event("review.verdict", `#${String(n)} approved: no blocking findings`, { changeId: `X${String(n)}`, prNumber: n, repo: REPO, workstreamId: order, blocking: 0, nonBlocking: 0 });
  const rows = (hide: JsonObject[], show: JsonObject[]) => ({ hide, show });

  type Frame = { ms: number; kind: "event" | "live" | "rows" | "browser_frame"; payload: JsonObject };
  const frames: Frame[] = [];
  const at = (ms: number, kind: Frame["kind"], payload: JsonObject) => frames.push({ ms, kind, payload });
  // A step: its rows, then what makes the app read them.
  const step = (to: Step, ...events: JsonObject[]) => {
    const from = ORDERED[ORDERED.indexOf(to) - 1] ?? BEFORE;
    at(STEPS[to], "rows", swap(from, to));
    for (const e of events) at(STEPS[to], "event", e);
  };
  let m = FIRST;
  const lead = (ms: number, text: string) => {
    const n = ++m;
    at(ms - 500, "event", said(n, "", "streaming", ms - 500));
    at(ms, "event", said(n, text, "final", ms));
  };

  at(0, "event", waiting(FIRST, true));
  lead(
    STEPS.reply,
    "On it, in three parts, each with its own writer: carts saved per shopper, the web cart, and the iPhone app’s cart. Each PR gets a reviewer, and the web and iPhone parts are tested on a screen first.",
  );
  step("split", event("workstream.created", `${ORDER} created: ${TITLE}`, { workstreamId: ORDER }), ...["T61", "T62", "T63"].map((id) => task("task.started", id, `${id} started`)));
  step("pr231", changeEvent("change.queued", 231, "queued", "reviewing"), task("task.completed", "T61", "T61 completed: opened #231"), task("task.started", "T64", "T64 started: review #231"));
  lead(4300, "#231 is up: carts are saved per shopper. A reviewer is on it.");
  at(STEPS.screens, "rows", rows([], [where(web.live), where(phone.live)]));
  step("screens", session(web.live), session(phone.live));
  step("approve229", verdict(229, "W19"), task("task.completed", "T52", "T52 completed: #229 approved", "W19"));
  step("approve231", verdict(231), task("task.completed", "T64", "T64 completed: #231 approved"));
  step("ci229", changeEvent("change.state", 229, "ready", "ci", "W19"));
  step("merged229", merged(229, "W19"));
  // The phone's sign-in wants a code: its screen asks for you, and the lead says so.
  at(STEPS.phoneAsks, "rows", rows([where(phone.live)], [where(phone.asking)]));
  step("phoneAsks", session(phone.asking));
  lead(STEPS.phoneAsks + 400, "The iPhone app’s sign-in texts a code to a test number, so its agent can’t go on alone. Take over its screen, enter the code, then hand back.");
  step("phoneBack");
  // The web screen ends; its recording lands, and goes on #232 as its proof.
  at(STEPS.pr232 - 600, "rows", rows([where(web.live)], [where(web.saving)]));
  at(STEPS.pr232 - 600, "event", session(web.saving));
  at(STEPS.pr232, "rows", rows([where(web.saving)], [where(web.ended)]));
  step("pr232", session(web.ended), changeEvent("change.queued", 232, "queued", "reviewing"), task("task.completed", "T62", "T62 completed: opened #232"), task("task.started", "T65", "T65 started: review #232"));
  lead(STEPS.pr232 + 400, "#232 is up: the web cart, with its screen’s recording on the PR as proof: a shopper signs in, adds a shirt, and the cart is saved to their account.");
  at(STEPS.pr233 - 600, "rows", rows([where(phone.live)], [where(phone.saving)]));
  at(STEPS.pr233 - 600, "event", session(phone.saving));
  at(STEPS.pr233, "rows", rows([where(phone.saving)], [where(phone.ended)]));
  step("pr233", session(phone.ended), changeEvent("change.queued", 233, "queued", "reviewing"), task("task.completed", "T63", "T63 completed: opened #233"), task("task.started", "T66", "T66 started: review #233"));
  step("approved", verdict(232), verdict(233), task("task.completed", "T65", "T65 completed: #232 approved"), task("task.completed", "T66", "T66 completed: #233 approved"));
  step("batch", ...[230, 231, 232, 233].map((n) => changeEvent("change.state", n, "ready", "ci", n === 230 ? "W20" : ORDER)));
  step("merged", ...[230, 231, 232, 233].map((n) => merged(n, n === 230 ? "W20" : ORDER)));
  lead(STEPS.merged + 500, "#230 to #233 merged as one batch. Saved carts now follow shoppers between the web and the iPhone app.");
  // The live feed, every 600 ms, from the send to the end.
  for (let ms = 300; ms <= STEPS.end; ms += 600) at(ms, "live", live(ms));
  // The screens' pages.
  WEB_PAGES.forEach(([ms, image, address], i) => at(ms, "browser_frame", frame(SCREEN.web, i + 1, image, "agent", address)));
  PHONE_PAGES.forEach(([ms, image], i) => at(ms, "browser_frame", frame(SCREEN.phone, i + 1, image, "agent")));

  f.answer("chat_send", { text: REQUEST }, { message: message(FIRST, "human", REQUEST, "final", 0, { by: "laptop", clientRequestId: "showcase-1", delivery: "turn" }) });
  f.then("chat_send", { text: REQUEST }, { frames });

  // Taking over the phone and handing it back answer as the hub does: the row changes hands, its event says so, and the
  // page follows: the code a digit at a time as the person types it, then, handed back, the saved cart.
  const control = (to: "human" | "agent", row: JsonObject, then: Parameters<Fixture["then"]>[2]) => {
    const input = { sessionId: SCREEN.phone, control: to };
    f.answer("browser_control", input, { session: row });
    f.then("browser_control", input, then);
  };
  const shown = PHONE_PAGES.length;
  control("human", phone.yours, {
    hide: [where(phone.asking)],
    show: [where(phone.yours)],
    frames: [
      { ms: 50, kind: "event", payload: session(phone.yours) },
      ...Array.from(CODE, (_, i) => ({ ms: DIGIT_MS.first + i * DIGIT_MS.every, kind: "browser_frame" as const, payload: frame(SCREEN.phone, shown + i + 1, `appCode${String(i + 1)}`, "human") })),
    ],
  });
  control("agent", phone.handing, {
    hide: [where(phone.yours)],
    show: [where(phone.handing)],
    frames: [
      { ms: 50, kind: "event", payload: session(phone.handing) },
      { ms: 700, kind: "browser_frame", payload: frame(SCREEN.phone, shown + CODE.length + 1, "appCart", "handing_back") },
      { ms: 900, kind: "rows", payload: rows([where(phone.handing)], [where(phone.live)]) },
      { ms: 900, kind: "event", payload: session(phone.live) },
    ],
  });

  // Reads after the chat's newest message, as the app makes once a message lands: nothing more.
  const state = { projectRef, needsYou: false, leadWorking: true, lastSeq: m, lastMessageAt: f.now };
  for (let after = 0; after <= m; after++) f.answer("chat_history", { projectRef, after }, { messages: [], moreBefore: after > 0, moreAfter: false, state });
  return f.settleAt(0);
};

export default defineGroup({
  fixtures: (base) => [build(base("typical"))],
});
