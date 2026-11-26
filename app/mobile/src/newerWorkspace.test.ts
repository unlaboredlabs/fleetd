// A phone on an older build meets a newer workspace every time the workspace updates first (the person's TestFlight
// build 93 met 0.9.47 at 19:18 and ended 8 s later, its JavaScript's message lost with it). What a newer workspace
// sends, fields this build has never heard of, kinds it has no word for, the optional ones left out, goes through
// the session and what the screens draw from it (the chats list, a bot, the bar's word, a chat's bubbles) without a
// throw. Each frame here is today's shape with the newer workspace's additions on top.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { chatItems } from "./desktop";
import { fakeHub } from "./hub/fake";
import { botOf } from "./botState";
import { hubWord } from "./hubWord";
import { chatList, lists } from "./lists";
import { noPrefs } from "./prefs";
import { Session } from "./session";

const AT = "2026-11-26T19:18:19Z";
const REF = { machineId: "m1", projectId: "fleetd" };
const KEY = "m1/fleetd";
/** What a newer workspace adds to any object: fields this build ignores. */
const NEWER = { sinceBuild: 99, nested: { anything: [1, "two", null] } };

const project = (projectId: string, title: string) => ({
  ...NEWER,
  machineId: "m1",
  projectId,
  title,
  workspaceRoot: `/home/devbox/${projectId}`,
  lastActivityAt: AT,
  threads: { running: 1, waiting: 0, failed: 0, idle: 0, parked: 2 },
});

const snapshot = {
  t: "snapshot",
  ...NEWER,
  cursor: 1,
  attention: [{ seq: 1, at: AT, type: "watch.checkin_offer", summary: "A check-in", data: { ...NEWER } }],
  machines: [{ ...NEWER, machineId: "m1", name: "devbox", online: true, kind: "quantum" }],
  projects: [project("fleetd", "Fleetd"), project("shop", "storefront")],
  chats: [
    { ...NEWER, projectRef: REF, lastSeq: 3, leadWorking: true, needsYou: false, mood: "curious" },
    { projectRef: { machineId: "m1", projectId: "shop" }, lastSeq: 1, leadWorking: false, needsYou: true },
  ],
  update: { ...NEWER, auto: true, from: "0.9.46", to: "0.9.47", hub: "rebooting", machines: [{ name: "devbox", state: "teleporting" }], runId: "U1", startedAt: AT, state: "reticulating" },
};

const message = (seq: number, more: Record<string, unknown> = {}) => ({
  ...NEWER,
  messageId: `msg${String(seq)}`,
  projectRef: REF,
  seq,
  author: "lead",
  text: `Here is where things stand ${String(seq)}`,
  state: "final",
  createdAt: AT,
  ...more,
});

/** What the screens draw from the state: each must take a newer workspace's state without a throw. */
const drawn = (session: Session) => {
  const s = session.state;
  const rows = chatList(s, noPrefs, "all", []) ?? [];
  for (const row of rows) botOf(s, row.key);
  lists(s);
  hubWord({ hub: s.hub, restart: s.restart, run: null, update: s.hubUpdate, now: Date.parse(AT) });
  const chat = s.chats[KEY];
  if (chat !== undefined) chatItems(chat, s.sends[KEY] ?? []);
  return rows.length;
};

const flush = async () => {
  for (let i = 0; i < 10; i++) await Promise.resolve();
};

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("An older app on a newer workspace", () => {
  it("takes its snapshot, answers and events, unknown kinds and fields included, and draws them", async () => {
    const hub = fakeHub();
    const session = new Session({ hub: "http://devbox:4790", key: "key_abc", transport: hub.transport, now: () => Date.parse(AT), newId: () => "c1" });
    session.start();
    session.openChat(KEY);
    hub.ready(["deflate-not-asked", "some-future-feature"]);
    hub.link.frame(snapshot);
    expect(drawn(session)).toBe(2);
    /** Answers `tool` with a newer workspace's output, where the session asked for it. */
    const answered: string[] = [];
    const answer = (tool: string, output: unknown) => {
      if (!hub.sentOf("call").some((c) => c.tool === tool)) return;
      hub.answer(tool, output);
      answered.push(tool);
    };

    answer("hub_info", { ...NEWER, busy: [], protocol: 1, version: "0.9.47+20261126.6e5d851", admin: true, leftOut: ["a_tool_from_later"] });
    answer("requests_list", {
      requests: [
        { ...NEWER, requestId: "r1", kind: "hologram", state: "open", projectRef: REF, createdAt: AT, text: "Something new to answer" },
        { requestId: "r2", kind: "approval", state: "pondering", projectRef: REF, createdAt: AT, text: "An approval in a state from later" },
      ],
    });
    answer("orders_board", {
      orders: [
        { ...NEWER, workstreamId: "W1", projectRef: REF, title: "An order", state: "open", lanes: [{ ...NEWER, laneId: "a", role: "auditor", status: "levitating", title: "An agent of a new kind" }] },
      ],
    });
    answer("status_get", { rows: [{ ...NEWER, projectRef: REF, state: "dreaming", blockedReason: "x" }] });
    answer("chat_history", {
      messages: [
        message(1),
        message(2, { author: "checkin", parts: [{ kind: "offer", options: ["Pick it up", "Not now"] }] }),
        // A file without its type and size, which every row's preview reads (chatView.ts attachmentBubbles threw on it).
        message(3, { attachments: [{ attachmentId: "a1", kind: "hologram", name: "x" }], replyTo: { messageId: "msg1", part: 0, quote: "new" } }),
      ],
      moreBefore: false,
      moreAfter: false,
      state: snapshot.chats[0],
    });
    await flush();
    expect(answered).toEqual(expect.arrayContaining(["hub_info", "requests_list", "chat_history"]));
    expect(drawn(session)).toBeGreaterThan(0);

    // Events this build has no case for, and ones it knows carrying more than it knows.
    let seq = 1;
    const event = (type: string, data: Record<string, unknown> = {}) => hub.link.frame({ t: "event", seq: ++seq, at: AT, type, summary: type, ...NEWER, data: { ...NEWER, ...data } });
    event("watch.checkin_offer", { projectRef: REF });
    event("hub.update", { ...snapshot.update, state: "updated", hub: "done", finishedAt: AT });
    event("chat.message", { message: message(4, { kind: "offer", buttons: ["Yes"] }) });
    event("chat.waiting", { projectRef: REF, lastSeq: 4, leadWorking: false, needsYou: true, mood: "patient" });
    event("project.renamed_in_the_future", { projectRef: REF });
    hub.link.frame({ t: "chat_delta", ...NEWER, projectRef: REF, messageId: "msg5", append: "streamed", offset: 0, seq: 5, kind: "thought" });
    hub.link.frame({ t: "live", ...NEWER, lanes: [{ laneId: "a", doing: "flying" }] });
    hub.link.frame({ t: "frame_from_the_future", payload: NEWER });
    await flush();
    expect(drawn(session)).toBeGreaterThan(0);
  });

  it("takes a snapshot with every optional part left out", () => {
    const hub = fakeHub();
    const session = new Session({ hub: "http://devbox:4790", key: "key_abc", transport: hub.transport, now: () => Date.parse(AT), newId: () => "c1" });
    session.start();
    hub.ready();
    hub.link.frame({ t: "snapshot", cursor: 1, attention: [], machines: [], projects: [{ machineId: "m1", projectId: "bare", title: "bare", lastActivityAt: AT }] });
    expect(drawn(session)).toBe(1);
  });
});
