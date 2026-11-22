// A cloud bot waking (W792): its computer asleep, and what the chat shows from your message to its lead's first words
// while fleetd cloud starts it (fleetd-cloud src/hosted/start.ts: image, box, files, session, message), at the times
// measured on the cloud on Nov 22 (the box ~11.5 s, files ~2.4 s, the session ~1 s, first words ~20 s after the send).
// The bot is storefront, blue, on acme's cloud hub; no order is at work in it, so the wait is the whole picture.
// - wake-asleep: at rest, asleep; type the ask and send, and its hub plays a normal start: the computer up in ~15 s,
//   the lead thinking, then writing, the reply at ~20 s.
// - wake-slow-send: the same, but the box takes 36 s.
// - wake-failed-send: fleetd's computers refuse the box at 9 s (the cloud tries again in 10 s by itself); Try again starts it
//   at once and the rest plays as a normal start.
// - wake-starting, wake-slow, wake-failed: one moment each for the screen checks: 5 s into the box, 34 s into it, and a
//   failed try that goes again in 9 s.
// - wake-stale: you asked 3 s ago, and the hub's start says it began 42 min before (W836, a start it kept from long
//   before your message): the wait counts from your message, never "Still waking up 42m 40s".
import { firstProject, writeChat, type Ref } from "../kit/chat.ts";
import { Fixture } from "../kit/fixture.ts";
import { defineGroup } from "../kit/group.ts";
import { at } from "../kit/ids.ts";
import { isObject, type JsonObject } from "../kit/json.ts";
import { arr, obj } from "../kit/stress.ts";

export const ASK = "Why is checkout slow on phones?";
const REPLY =
  "The product photos on checkout load at full size on phones, about 4 MB each. I’ll serve them sized to the screen and load the ones below the fold later. A writer starts on it now.";

/** The cloud's words for each step (fleetd-cloud src/hosted/start.ts WORDS), the `text` an older app reads. */
const WORDS = {
  image: "Getting its computer's image ready",
  box: "Starting its computer",
  files: "Putting its files on its computer",
  session: "Starting the agent on its computer",
  message: "Handing it your message",
} as const;
type Step = keyof typeof WORDS;

/** When each step begins, ms after the send (or after Try again); `think` the lead thinking, `words` its first words. */
interface Timeline {
  readonly image: number;
  readonly box: number;
  readonly files: number;
  readonly session: number;
  readonly message: number;
  readonly think: number;
  readonly words: number;
  readonly reply: number;
}
export const NORMAL: Timeline = { image: 0, box: 300, files: 11_800, session: 14_200, message: 15_200, think: 15_500, words: 18_600, reply: 20_200 };
export const SLOW: Timeline = { image: 0, box: 300, files: 36_300, session: 38_700, message: 39_700, think: 40_000, words: 43_100, reply: 44_700 };
/** fleetd's computers refuse the box this long after the send, and the cloud tries again 10 s later. */
export const FAILED_AT = 9_000;
const REASON = "No computer was free";

const leadLane = (ref: Ref) => `lead:${ref.machineId}/${ref.projectId}`;

/** A bot of acme's cloud hub, asleep at rest, its earlier chat and what its hub answers. */
const scene = (base: Fixture, name: string, note: string) => {
  const f = Fixture.from(base, name, note);
  f.state = { phase: "live", hub: "https://acme.fleetd.dev", protocol: f.state.phase === "live" ? f.state.protocol : 1 };
  const ref = firstProject(f);
  // Each bot in its own color, as people pick them.
  const COLORS = ["blue", "orange", "green", "purple"];
  if (f.snapshot !== undefined) f.snapshot = { ...f.snapshot, projects: arr(f.snapshot["projects"]).filter(isObject).map((p, i) => ({ ...p, avatarColor: COLORS[i % COLORS.length] ?? "blue" })) };
  const board = f.output("orders_board", {});
  if (isObject(board)) f.answer("orders_board", {}, { ...board, orders: arr(board["orders"]).filter(isObject).filter((o) => obj(o["projectRef"])["projectId"] !== ref.projectId) });
  const baseLanes = (f.live.findLast((l) => l["full"] === true)?.["lanes"] ?? []) as JsonObject[];
  const machines = f.live.findLast((l) => l["full"] === true)?.["machines"];
  const others = baseLanes.filter((l) => l["laneId"] !== leadLane(ref) && l["status"] !== "working").map((l) => ({ laneId: l["laneId"] ?? "", status: "idle" }));
  // Each frame stamped with the hub's clock when it goes, as a hub's are: the app's skew, and so its countdowns, by it.
  const frame = (lane: JsonObject | undefined, ms = 0): JsonObject => ({ at: at(f.now, ms), full: true, lanes: lane === undefined ? others : [...others, { laneId: leadLane(ref), ...lane }], ...(machines === undefined ? {} : { machines }) });
  const iso = (ms: number) => at(f.now, ms);
  return { f, ref, frame, iso };
};

/** The chat as it stands: the earlier talk, then `more`; the chat state asleep, or at work. */
const chatOf = (f: Fixture, ref: Ref, more: { text: string; author: "human" }[], state: { asleep: boolean; working: boolean }) => {
  const written = writeChat(
    f,
    ref,
    [
      { author: "human", text: "Morning. Is the receipts fix out?", minutesAgo: 62 },
      { author: "lead", text: "Yes, #84 merged at 9:12 and receipts show the VAT number under the total.", minutesAgo: 61 },
      ...more,
    ],
    { leadWorking: state.working },
  );
  // writeChat's state is one object, in the snapshot and in every page: its computer asleep, in all of them.
  const chats = arr(f.snapshot?.["chats"]).filter(isObject);
  const mine = chats.find((c) => obj(c["projectRef"])["projectId"] === ref.projectId);
  if (mine !== undefined && state.asleep) mine["leadAsleep"] = true;
  return written;
};

const starting = (iso: (ms: number) => string, step: Step, startedMs: number, sinceMs: number, failed?: JsonObject): JsonObject => ({
  status: "starting",
  activity: {
    activity: { kind: "starting", text: failed === undefined ? WORDS[step] : `${WORDS[step]}: fleetd's computers have no free computers right now. Trying again in 10 s, by itself.`, step, startedAt: iso(startedMs), ...(failed === undefined ? {} : { failed }) },
    since: iso(sinceMs),
  },
});

/** You send the ask, and its hub plays the start: `shape` normal, slow, or failed at FAILED_AT until Try again. */
const send = (base: Fixture, name: string, note: string, shape: "normal" | "slow" | "failed"): Fixture => {
  const { f, ref, frame, iso } = scene(base, name, note);
  const earlier = chatOf(f, ref, [], { asleep: true, working: false });
  f.live = [frame(undefined)];
  const projectRef = { ...ref };
  let seq = earlier.length;
  const message = (n: number, author: "human" | "lead", text: string, state: "final" | "streaming", ms: number, over: JsonObject = {}): JsonObject => ({
    messageId: `m${String(n)}`,
    projectRef: { ...projectRef },
    seq: n,
    author,
    text,
    attachments: [],
    createdAt: iso(ms),
    state,
    ...over,
  });
  let events = 900;
  const event = (type: string, summary: string, data: JsonObject, ms: number): JsonObject => ({ seq: ++events, at: iso(ms), type, summary, ...ref, data });
  const said = (m: JsonObject, ms: number) =>
    event("chat.message", "In the chat", { projectRef: { ...projectRef }, messageId: m["messageId"] ?? "", seq: m["seq"] ?? 0, author: m["author"] ?? "", state: m["state"] ?? "", message: m }, ms);
  const mine = message(++seq, "human", ASK, "final", 0, { by: "laptop", clientRequestId: "wake-1", delivery: "queued" });
  const lead = ++seq;
  const waiting = (leadWorking: boolean, ms: number): JsonObject =>
    event("chat.waiting", "The lead's turn", { projectRef: { ...projectRef }, needsYou: false, leadWorking, lastSeq: seq, lastMessageAt: iso(ms) }, ms);
  type Frame = { ms: number; kind: "event" | "live"; payload: JsonObject };
  /** A whole start from `from` (ms after the send) and the reply after it, its start begun at `began`. */
  const start = (from: number, began: number, t: Timeline): Frame[] => [
    ...(["image", "box", "files", "session", "message"] as const).map((step): Frame => ({ ms: from + t[step], kind: "live", payload: frame(starting(iso, step, began, from + t[step]), from + t[step]) })),
    { ms: from + t.think, kind: "live", payload: frame({ status: "working", activity: { activity: { kind: "thinking" }, since: iso(from + t.think) } }, from + t.think) },
    { ms: from + t.words, kind: "event", payload: said(message(lead, "lead", "", "streaming", from + t.words), from + t.words) },
    { ms: from + t.words, kind: "live", payload: frame({ status: "working", activity: { activity: { kind: "writing" }, since: iso(from + t.words) } }, from + t.words) },
    { ms: from + t.reply, kind: "event", payload: said(message(lead, "lead", REPLY, "final", from + t.reply), from + t.reply) },
    { ms: from + t.reply + 100, kind: "event", payload: waiting(false, from + t.reply + 100) },
    { ms: from + t.reply + 100, kind: "live", payload: frame({ status: "idle" }, from + t.reply + 100) },
  ];
  const frames: Frame[] = [{ ms: 0, kind: "event", payload: waiting(true, 0) }];
  if (shape === "failed") {
    frames.push({ ms: 0, kind: "live", payload: frame(starting(iso, "image", 0, 0), 0) });
    frames.push({ ms: 300, kind: "live", payload: frame(starting(iso, "box", 0, 300), 300) });
    frames.push({ ms: FAILED_AT, kind: "live", payload: frame(starting(iso, "box", 0, FAILED_AT, { reason: REASON, retryAt: iso(FAILED_AT + 10_000) }), FAILED_AT) });
    // Try again: the waiting try goes at once, and the start runs as a normal one from its box.
    f.answer("chat_start_now", { projectRef: { ...projectRef } }, { started: true });
    f.then("chat_start_now", { projectRef: { ...projectRef } }, { frames: start(0, 0, { ...NORMAL, image: 0, box: 0 }) });
  } else frames.push(...start(0, 0, shape === "slow" ? SLOW : NORMAL));
  f.answer("chat_send", { text: ASK }, { message: mine });
  f.then("chat_send", { text: ASK }, { frames });
  const state = { projectRef: { ...projectRef }, needsYou: false, leadWorking: false, lastSeq: lead, lastMessageAt: f.now };
  for (let after = 0; after <= lead; after++) f.answer("chat_history", { projectRef: { ...projectRef }, after }, { messages: [], moreBefore: after > 0, moreAfter: false, state });
  return f;
};

/** One moment of a start, for the screen checks: you asked, and its computer is starting. */
const moment = (base: Fixture, name: string, note: string, lane: (iso: (ms: number) => string) => JsonObject, askedMinutesAgo?: number): Fixture => {
  const { f, ref, frame, iso } = scene(base, name, note);
  chatOf(f, ref, [{ author: "human", text: ASK, ...(askedMinutesAgo === undefined ? {} : { minutesAgo: askedMinutesAgo }) }], { asleep: false, working: true });
  f.live = [frame(lane(iso))];
  return f;
};

export default defineGroup({
  fixtures: (base) => [
    send(base("typical"), "wake-asleep", "A cloud bot asleep with its computer; send the ask and its computer starts in about 15 s, then its lead replies at about 20 s.", "normal"),
    send(base("typical"), "wake-slow-send", "A cloud bot whose computer takes 36 s to start after you send.", "slow"),
    send(base("typical"), "wake-failed-send", "A cloud bot whose computer fleetd's computers refuse to start 9 s after you send; Try again starts it at once.", "failed"),
    moment(base("typical"), "wake-starting", "A cloud bot's computer starting, 5 s after you asked.", (iso) => starting(iso, "box", -5_000, -4_700)),
    moment(base("typical"), "wake-slow", "A cloud bot's computer still starting 34 s after you asked.", (iso) => starting(iso, "box", -34_000, -33_700)),
    moment(base("typical"), "wake-failed", "A cloud bot's computer that fleetd's computers refused; the cloud tries again in 9 s by itself.", (iso) =>
      starting(iso, "box", -10_000, -1_000, { reason: REASON, retryAt: iso(9_000) }),
    ),
    moment(base("typical"), "wake-stale", "A cloud bot waking for an ask sent 3 s ago, whose hub says its start began 42 min before.", (iso) => starting(iso, "box", -(42 * 60 + 40) * 1000, -3_000), 0.05),
  ],
});
