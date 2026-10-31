// The lead chat on the wire (crates/fleetd-contracts/src/chat.rs): chat_history pages, the snapshot's per-project
// chat state, the inline secret and command items, the live strip under the lead's message, and status_get
// rows. What the messages say lives in chatText.ts.
import type { Fixture } from "./fixture.ts";
import { at, sha, uuid } from "./ids.ts";
import { asText, isObject, type JsonObject } from "./json.ts";
import { agentLane, arr, obj } from "./stress.ts";
import { type Line, MIGRATED } from "./chatText.ts";
import { LONG_TITLES } from "./text.ts";

/** chat_history's default page; the app pages back with `before` = the first seq it holds. */
export const PAGE = 50;

export type Ref = { readonly machineId: string; readonly projectId: string };

/** A message before seq and ids are given; `item` and `history` as the contract names them. */
export interface Draft {
  readonly author: "human" | "lead" | "system";
  readonly text: string;
  readonly attachments?: ReadonlyArray<Attachment>;
  readonly state?: "streaming" | "final";
  readonly item?: JsonObject;
  /** More of the message's fields, as the hub sets them on a line of its own (a Navi's `skillSaved`). */
  readonly extra?: JsonObject;
  readonly history?: "order" | "note" | "steer" | "lead_message" | "order_outcome";
  /** A lead message's bubbles, as the hub splits it (ChatPart: start, end, block). */
  readonly parts?: ReadonlyArray<JsonObject>;
  /** Written this many minutes before the fixture's now, rather than spaced evenly back from it. */
  readonly minutesAgo?: number;
}

/** A file sent with a message; `data` is what attachment_get returns for it. */
export interface Attachment {
  readonly name: string;
  readonly mime: "image/png" | "text/plain";
  readonly data: Buffer;
}

/** A 2×2 PNG (a real one, so an <img> decodes it) and a short log, the two kinds a screen renders differently. */
export const SCREENSHOT: Attachment = {
  name: "receipt-on-mobile.png",
  mime: "image/png",
  data: Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAF0lEQVR4nGPwqr3x4t0nhhfvPnnV3gAAPIAIz2Y7aggAAAAASUVORK5CYII=", "base64"),
};
export const LOG: Attachment = {
  name: "checkout-tests.log",
  mime: "text/plain",
  data: Buffer.from("FAIL storefront-checkout > receipt > wraps the date under the total at 360px\n  expected one line, got two\n"),
};

export const fromLines = (lines: ReadonlyArray<Line>): Array<Draft> => lines.map((l) => ({ author: l.from === "you" ? "human" : "lead", text: l.text }));

/** Each past order as the migration reads it back: what was asked, the lead's reply, and how it ended. */
export const migrated = (): Array<Draft> =>
  MIGRATED.flatMap((m): Array<Draft> => [
    { author: "human", text: m.asked, history: "order" },
    { author: "lead", text: "On it. One writer per change, a reviewer on each PR.", history: "lead_message" },
    { author: "system", text: m.outcome, history: "order_outcome" },
  ]);

/** The project the fixture's screens open first: the snapshot's first project. */
export const firstProject = (f: Fixture): Ref => {
  const p = obj(arr(f.snapshot?.["projects"])[0]);
  return { machineId: typeof p["machineId"] === "string" ? p["machineId"] : "devbox", projectId: typeof p["projectId"] === "string" ? p["projectId"] : uuid("storefront") };
};

const chats = (f: Fixture): Array<JsonObject> => {
  if (f.snapshot === undefined) return [];
  const list = Array.isArray(f.snapshot["chats"]) ? f.snapshot["chats"] : (f.snapshot["chats"] = []);
  return list.filter(isObject);
};

/** Sets a project's chat state in the snapshot (the sidebar's needs-you dot and running mark). */
export const setChatState = (f: Fixture, ref: Ref, state: { needsYou: boolean; leadWorking: boolean; lastSeq: number; lastMessageAt?: string }): JsonObject => {
  const value: JsonObject = { projectRef: { ...ref }, needsYou: state.needsYou, leadWorking: state.leadWorking, lastSeq: state.lastSeq, ...(state.lastMessageAt === undefined ? {} : { lastMessageAt: state.lastMessageAt }) };
  const list = chats(f);
  const i = list.findIndex((c) => obj(c["projectRef"])["projectId"] === ref.projectId);
  if (f.snapshot !== undefined) {
    const all = arr(f.snapshot["chats"]);
    if (i >= 0) all[all.indexOf(list[i] ?? {})] = value;
    else all.push(value);
  }
  return value;
};

/**
 * A project's whole chat, answered as chat_history pages of PAGE: the newest page for a plain read, each older page
 * for `before` its successor's first seq, and an empty page after the last. Messages are spaced back from `now`.
 */
export const writeChat = (f: Fixture, ref: Ref, drafts: ReadonlyArray<Draft>, opts: { needsYou?: boolean; leadWorking?: boolean } = {}): Array<JsonObject> => {
  // A copied fixture may hold this project's earlier chat: its pages go, so no stale page answers a request.
  for (const a of f.answers("chat_history").filter((x) => obj(x.input?.["projectRef"])["projectId"] === ref.projectId)) f.drop("chat_history", a.input);
  const projectRef = { ...ref };
  for (const a of f.answers("attachment_get").filter((x) => obj(x.input?.["projectRef"])["projectId"] === ref.projectId)) f.drop("attachment_get", a.input);
  const end = Date.parse(f.now) - 20_000;
  const step = 95_000;
  let request = 0;
  let file = 0;
  const messages = drafts.map((d, i): JsonObject => {
    const seq = i + 1;
    const createdAt = new Date(d.minutesAgo === undefined ? end - (drafts.length - seq) * step : Date.parse(f.now) - d.minutesAgo * 60_000).toISOString();
    const item = d.item === undefined ? undefined : { ...d.item, requestId: d.item["requestId"] ?? `Q${String(++request)}` };
    const attachments = (d.attachments ?? []).map((a) => {
      const attachmentId = `F${String(++file)}`;
      const ref = { attachmentId, name: a.name, mime: a.mime, bytes: a.data.length };
      f.answer("attachment_get", { projectRef: { ...projectRef }, attachmentId }, { ...ref, dataB64: a.data.toString("base64") });
      return ref;
    });
    return {
      messageId: `m${String(seq)}`,
      projectRef: { ...ref },
      seq,
      author: d.author,
      text: d.text,
      attachments,
      createdAt,
      state: d.state ?? "final",
      ...(d.state === "streaming" ? { updatedAt: at(f.now, -2000) } : {}),
      ...(d.author === "human" && d.history === undefined ? { delivery: "turn", by: "laptop", clientRequestId: `c-${sha(`${ref.projectId} ${String(seq)}`).slice(0, 12)}` } : {}),
      ...(d.history === undefined ? {} : { history: d.history }),
      ...(item === undefined ? {} : { item }),
      ...(d.parts === undefined ? {} : { parts: d.parts.map((p) => ({ ...p })) }),
      ...(d.extra ?? {}),
    };
  });
  const last = messages.at(-1);
  const state = setChatState(f, ref, {
    needsYou: opts.needsYou ?? false,
    leadWorking: opts.leadWorking ?? false,
    lastSeq: messages.length,
    ...(typeof last?.["createdAt"] === "string" ? { lastMessageAt: last["createdAt"] } : {}),
  });
  for (let endIndex = messages.length; endIndex > 0 || messages.length === 0; endIndex -= PAGE) {
    const page = messages.slice(Math.max(0, endIndex - PAGE), endIndex);
    const out = { messages: page, moreBefore: endIndex - PAGE > 0, moreAfter: endIndex < messages.length, state };
    if (endIndex === messages.length) f.answer("chat_history", { projectRef }, out);
    else f.answer("chat_history", { projectRef, before: endIndex + 1 }, out);
    if (messages.length === 0) break;
  }
  f.answer("chat_history", { projectRef, after: messages.length }, { messages: [], moreBefore: messages.length > 0, moreAfter: false, state });
  return messages;
};

// ---- inline items ----

export const secretRequest = (state: "open" | "stored", f: Fixture): JsonObject => ({
  kind: "secret_request",
  name: "stripe.test_key",
  text: "The checkout tests charge a test card; they need the Stripe test key.",
  sink: "env:devbox:/home/dev/src/storefront/.env.test",
  envName: "STRIPE_TEST_KEY",
  state,
  ...(state === "stored" ? { fingerprint: "9f2c4e1a", answeredAt: at(f.now, -3_600_000), by: "laptop" } : {}),
});

/** A gated command (the exact argv), or with `permission` an agent's tool prompt; ran and denied ones are answered. */
export const commandApproval = (state: "open" | "ran" | "denied", f: Fixture, permission = false): JsonObject => ({
  kind: "command_approval",
  ...(permission
    ? { permission: { requestId: "perm-1", toolName: "Bash", summary: "rm -rf build/ && pnpm build --filter storefront", threadId: uuid("permission thread") } }
    : {
        gated: {
          argv: ["pnpm", "--filter", "storefront", "db:migrate", "--env", "production"],
          cwd: "/home/dev/src/storefront",
          class: "irreversible",
          reason: "Adds the share snapshots table to the production database.",
          secretEnv: [{ name: "DATABASE_URL", secretKey: "storefront.database_url" }],
          timeoutSec: 600,
        },
      }),
  machineId: "devbox",
  state,
  ...(state === "ran" ? { exitCode: 0, outputTail: "Applying 20261019_share_snapshots... done\n1 migration applied.", answeredAt: at(f.now, -7_200_000), by: "laptop" } : {}),
  ...(state === "denied" ? { answeredAt: at(f.now, -5_400_000), by: "laptop" } : {}),
});

// ---- the live strip ----

/**
 * `n` agents working for the project under the lead's message: one full live frame with their lanes, and the
 * project's orders on the board and in order_get (a hub order holds at most 12 lanes, so 20 agents span two).
 */
export const liveStrip = (f: Fixture, ref: Ref, n: number): Fixture => agentsAt(f, [{ ref, n }]);

// Left out of a scene agent's branch name, as a writer names its branch for what it changes.
const FILLER = new Set(["a", "an", "the", "at", "to", "from", "how", "use", "of", "in", "on"]);

/** One agent of a scene: its role, its task and what it's doing now. */
export interface SceneAgent {
  readonly role: "implementer" | "reviewer" | "qa" | "reader";
  readonly title: string;
  readonly activity: JsonObject;
}

/**
 * The agents at work on what a chat asked for: one order named `title` with these agents, all working, so the panel
 * beside the chat and the strip under it show that work and no other.
 */
export const sceneStrip = (f: Fixture, ref: Ref, title: string, agents: ReadonlyArray<SceneAgent>): Fixture =>
  agentsAt(f, [{ ref, n: agents.length, scene: { title, agents } }], true);

/**
 * Agents at work in several projects at once: each project's `n` lanes on its own orders (a hub order holds at
 * most 12), on the board and in order_get, and one full live frame with every lane. With `allWorking` every lane is
 * "working", so a project's running count is exactly `n` (as a status row's agentsRunning says).
 */
export const agentsAt = (
  f: Fixture,
  projects: ReadonlyArray<{ ref: Ref; n: number; scene?: { title: string; agents: ReadonlyArray<SceneAgent> } }>,
  allWorking = false,
): Fixture => {
  const start = at(f.now, -30 * 60_000);
  const orders: Array<JsonObject> = [];
  const live: Array<JsonObject> = [];
  let next = 0;
  for (const { ref, n, scene } of projects) {
    const lanes = Array.from({ length: n }, (_, i) => {
      const generic = agentLane(f, next++, false, ref.machineId, start);
      const own = scene?.agents[i];
      const lane =
        own === undefined
          ? generic
          : {
              ...generic,
              role: own.role,
              title: own.title,
              branch: `fleetd/${asText(generic["taskId"], "T1")}-${own.title
                .toLowerCase()
                .split(/[^a-z0-9]+/u)
                .filter((w) => w !== "" && !FILLER.has(w))
                .slice(0, 3)
                .join("-")}`,
              live: { ...obj(generic["live"]), activity: { activity: own.activity, since: at(f.now, -(i + 1) * 4000) } },
            };
      return allWorking ? { ...lane, status: "working", live: { ...obj(lane["live"]), status: "working" } } : lane;
    });
    live.push(...lanes.map((l) => obj(l["live"])));
    for (let k = 0; k * 12 < n; k++) {
      const own = lanes.slice(k * 12, (k + 1) * 12).map((l) => {
        const { live: _live, ...rest } = l;
        return rest;
      });
      orders.push({
        workstreamId: `W${String(orders.length + 1)}`,
        title: scene?.title ?? LONG_TITLES[orders.length % LONG_TITLES.length] ?? "",
        projectRef: { ...ref },
        createdAt: at(f.now, -40 * 60_000),
        updatedAt: at(f.now, -5_000),
        phase: "working",
        state: "open",
        lanes: own,
        prs: [],
        needsYou: 0,
        settled: 0,
        total: own.length,
      });
    }
  }
  f.drop("orders_board");
  f.answer("orders_board", {}, { orders, trains: [], at: f.now });
  for (const { ref } of projects) {
    const own = orders.filter((o) => obj(o["projectRef"])["projectId"] === ref.projectId);
    f.answer("orders_board", { projectRef: { ...ref } }, { orders: own, trains: [], at: f.now });
  }
  f.drop("order_get");
  for (const order of orders) f.answer("order_get", { workstreamId: order["workstreamId"] ?? "W1" }, { order, doneLanes: [], requests: [] });
  const machines = arr(obj(f.live.findLast((l) => l["full"] === true))["machines"]);
  f.live = [{ at: f.now, full: true, lanes: live, text: [], ...(machines.length > 0 ? { machines } : {}) }];
  return f;
};

// ---- status rows ----

export type RowState = "working" | "waiting_on_you" | "blocked" | "idle";

/** A row's work for its state, as the hub groups it: what each state usually has in flight. */
const workOf = (f: Fixture, state: RowState, agents: number): JsonObject => {
  const item = (group: string, title: string, minutesAgo: number, extra: JsonObject = {}): JsonObject => ({ group, title, at: at(f.now, -minutesAgo * 60_000), ...extra });
  const pr = (n: number): JsonObject => ({ repo: "acme/storefront", number: n, url: `https://github.com/acme/storefront/pull/${String(n)}` });
  const titles = ["Checkout totals use integer minor units", "Receipt dates use Intl", "Search index warms on deploy", "Nightly export resumes after a crash"];
  const working = Array.from({ length: Math.min(agents, 3) }, (_, i) => item("working", titles[i % titles.length] ?? "Work", 4 + i, { taskId: `T${String(41 + i)}` }));
  const items: JsonObject[] =
    state === "working"
      ? [...working, item("in_review", "Cart page keeps its scroll", 9, { taskId: "T38", pr: pr(212) }), item("landing", "fleetd/T35-totals", 14, { pr: pr(209) }), item("done", "Receipt dates use Intl", 50, { taskId: "T30", pr: pr(214) })]
      : state === "waiting_on_you"
        ? [item("waiting_on_you", "The lead's question in chat", 2), ...working, item("idle", "Read the export job's logs", 40, { taskId: "T27" })]
        : state === "blocked"
          ? [item("idle", "fleetd/T31-ci", 25, { pr: pr(207), why: "CI failed" })]
          : [item("done", "Quick start opens a project's chat", 300, { taskId: "T12", pr: pr(198) })];
  const count = (g: string) => items.filter((i) => i["group"] === g).length;
  return {
    counts: { waitingOnYou: count("waiting_on_you"), inReview: count("in_review"), working: Math.max(count("working"), agents), landing: count("landing"), idle: count("idle"), done: count("done") },
    items,
  };
};

export const statusRow = (f: Fixture, ref: Ref, title: string, state: RowState, extra: { agents?: number; blocked?: string; warning?: string; merged?: string; mergedAgoMs?: number; stale?: string } = {}): JsonObject => ({
  projectRef: { ...ref },
  title,
  state,
  ...(extra.blocked === undefined ? {} : { blockedReason: extra.blocked }),
  ...(extra.warning === undefined ? {} : { warning: extra.warning }),
  ...workOf(f, state, extra.agents ?? 0),
  agentsRunning: extra.agents ?? 0,
  ...(extra.merged === undefined ? {} : { lastMerged: { title: extra.merged, prNumber: 214, prUrl: "https://github.com/acme/storefront/pull/214", at: at(f.now, -(extra.mergedAgoMs ?? 2_700_000)) } }),
  asOf: f.now,
  ...(extra.stale === undefined ? {} : { stale: { reason: extra.stale, since: at(f.now, -900_000) } }),
});

export const answerRows = (f: Fixture, rows: ReadonlyArray<JsonObject>): Fixture =>
  f.answer("status_get", {}, { rows: [...rows].sort((a, b) => asText(a["title"]).localeCompare(asText(b["title"]))) });

/**
 * The chat's last message, a lead reply in state "streaming", grows by `appends` over the live chat feed: one
 * chat_delta every `everyMs` after the app subscribes, each at the offset (UTF-16 length) the text has reached. It
 * stays unfinished, as a screenshot mid-reply needs; the fixture settles on the last frame.
 */
export const streamReply = (f: Fixture, ref: Ref, appends: ReadonlyArray<string>, everyMs = 400): Fixture => {
  const page = obj(f.output("chat_history", { projectRef: { ...ref } }));
  const last = arr(page["messages"]).filter(isObject).at(-1);
  if (last?.["state"] !== "streaming") throw new Error("streamReply needs the chat's last message to be streaming");
  let offset = asText(last["text"]).length;
  appends.forEach((append, i) => {
    f.later((i + 1) * everyMs, "chat_delta", { projectRef: { ...ref }, messageId: last["messageId"] ?? "m1", seq: last["seq"] ?? 1, offset, append });
    offset += append.length;
  });
  return f;
};
