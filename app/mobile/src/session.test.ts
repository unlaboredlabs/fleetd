import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { chatItems, type ChatMessage, type HumanRequest } from "./desktop";
import { fakeHub } from "./hub/fake";
import { lists } from "./lists";
import { memoryPins } from "./pins";
import { controlOf, PageTouches } from "./screen";
import { memorySections } from "./sections";
import { Session, type SessionOptions } from "./session";

const REF = { machineId: "m1", projectId: "inbox" };
const KEY = "m1/inbox";
const AT = "2026-10-28T10:00:00Z";

const project = (projectId: string, title: string) => ({
  machineId: "m1",
  projectId,
  title,
  workspaceRoot: `/home/devbox/${projectId}`,
  lastActivityAt: AT,
  threads: { running: 0, waiting: 0, failed: 0, idle: 0 },
});

const snapshot = {
  t: "snapshot",
  cursor: 1,
  attention: [],
  machines: [],
  projects: [project("inbox", "Ada"), project("shop", "storefront")],
  chats: [{ projectRef: REF, lastSeq: 2, leadWorking: false, needsYou: false }],
};

const message = (seq: number, text: string, extra: Partial<ChatMessage> = {}): ChatMessage => ({
  messageId: `msg${String(seq)}`,
  projectRef: REF,
  seq,
  author: "lead",
  text,
  state: "final",
  createdAt: AT,
  ...extra,
});

const page = (messages: ChatMessage[]) => ({ messages, moreBefore: false, moreAfter: false, state: snapshot.chats[0] });

const approval = (requestId: string): HumanRequest => ({
  requestId,
  kind: "approval",
  state: "open",
  projectRef: REF,
  createdAt: AT,
  text: "Send the lease to the landlord",
  permission: {
    requestId,
    threadId: "t1",
    toolName: "mcp__lettings__send_lease",
    summary: "Send the signed lease",
    preview: { title: "Use send_lease on lettings", input: '{"to":"landlord@example.com"}', server: "lettings", tool: "send_lease", action: "send" },
  },
});

const setup = (options: Partial<SessionOptions> = {}) => {
  const hub = fakeHub();
  let id = 0;
  const session = new Session({ hub: "http://devbox:4790", key: "key_abc", transport: hub.transport, now: () => Date.parse(AT), newId: () => `c${String(++id)}`, ...options });
  session.start();
  hub.ready();
  hub.link.frame(snapshot);
  return { hub, session };
};

/** Lets the calls answered so far reach the state. */
const flush = async () => {
  for (let i = 0; i < 10; i++) await Promise.resolve();
};

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("Session", () => {
  it("lists what needs you on top, then every other chat", async () => {
    const { hub, session } = setup();
    expect(lists(session.state)).toMatchObject({ needsYou: [], chats: [{ key: KEY }, { key: "m1/shop" }] });
    hub.answer("requests_list", { requests: [approval("r1")] });
    await flush();
    expect(lists(session.state)).toMatchObject({ needsYou: [{ key: KEY, want: "1 approval waiting" }], chats: [{ key: "m1/shop" }] });
    hub.link.frame({ t: "event", seq: 2, type: "chat.waiting", at: AT, data: { projectRef: { machineId: "m1", projectId: "shop" }, lastSeq: 5, leadWorking: false, needsYou: true } });
    expect(lists(session.state)?.needsYou.map((r) => r.want)).toEqual(["1 approval waiting", "Waiting for your reply"]);
  });

  it("asks the hub whether this phone's person is an admin, and reads an admin's update", async () => {
    const calls = (tool: string) => hub.sentOf("call").filter((c) => c.tool === tool);
    const { hub, session } = setup();
    expect(session.state.admin).toBeUndefined();
    hub.answer("hub_info", { busy: [], protocol: 1, version: "0.9.0", admin: true });
    await flush();
    expect(session.state.admin).toBe(true);
    expect(calls("hub_update_status")).toHaveLength(1);
    expect(session.state.machines).toEqual([]);

    const member = setup();
    member.hub.answer("hub_info", { busy: [], protocol: 1, version: "0.9.0" });
    await flush();
    expect(member.session.state.admin).toBe(false);
    expect(member.hub.sentOf("call").filter((c) => c.tool === "hub_update_status")).toEqual([]);
  });

  it("asks fleetd cloud, which leaves its update and restart out, for no update: an admin keeps what hub_info left out", async () => {
    const { hub, session } = setup();
    const leftOut = ["hub_update", "hub_update_status", "hub_restart", "machine_add"];
    hub.answer("hub_info", { busy: [], protocol: 1, version: "0.9.0", admin: true, leftOut });
    await flush();
    expect(session.state.admin).toBe(true);
    expect(session.state.leftOut).toEqual(leftOut);
    expect(hub.sentOf("call").filter((c) => c.tool === "hub_update_status")).toEqual([]);
  });

  it("reads who the person is again when the hub's people change: a new name shows without a restart", async () => {
    const { hub, session } = setup();
    const sam = { personId: "p_sam", role: "member", createdAt: AT };
    hub.answer("hub_info", { busy: [], protocol: 1, version: "0.9.0", me: { ...sam, name: "Sam Rivera" } });
    await flush();
    expect(session.state.meName).toBe("Sam Rivera");
    // Renamed here or on the desktop: the hub says so to every open app.
    hub.link.frame({ t: "event", seq: 2, type: "people.changed", at: AT, summary: "Sam Rivera changed their name to Sam R. Rivera", data: { change: "renamed" } });
    hub.answer("hub_info", { busy: [], protocol: 1, version: "0.9.0", me: { ...sam, name: "Sam R. Rivera" } });
    await flush();
    expect(session.state).toMatchObject({ me: "p_sam", meName: "Sam R. Rivera", meRole: "member" });
  });

  it("previews each chat from its newest messages, read after the snapshot and kept by events", async () => {
    const { hub, session } = setup();
    const reads = () => hub.sentOf("call").filter((c) => c.tool === "chat_history");
    // A few chats at once, not one round trip after another.
    expect(reads().map((c) => c.input)).toEqual([
      { projectRef: REF, limit: 3 },
      { projectRef: { machineId: "m1", projectId: "shop" }, limit: 3 },
    ]);
    hub.link.frame({ t: "result", id: reads()[0]?.id, output: page([message(1, "Morning."), message(2, "Two **emails** need you.")]) });
    await flush();
    expect(lists(session.state)?.chats.find((r) => r.key === KEY)?.preview).toEqual("Two emails need you.");
    hub.link.frame({ t: "event", seq: 2, type: "chat.message", at: AT, data: { projectRef: REF, messageId: "msg3", seq: 3, author: "lead", state: "final", message: message(3, "Sent both.") } });
    expect(lists(session.state)?.chats.find((r) => r.key === KEY)?.preview).toEqual("Sent both.");
  });

  it("keeps the preview and count of a chat opened earlier true after the link comes back", async () => {
    const { hub, session } = setup();
    session.openChat(KEY);
    hub.answer("chat_history", page([message(1, "Morning."), message(2, "Two emails need you.")]));
    await flush();
    session.openChat(null);
    hub.link.close(1006);
    vi.advanceTimersByTime(1000);
    hub.ready();
    hub.link.frame({ ...snapshot, chats: [{ ...snapshot.chats[0], lastSeq: 4 }] });
    // A chat opened here is read again too, as it is held from the link before.
    const read = hub.sentOf("call").find((c) => c.tool === "chat_history" && (c.input as { projectRef: { projectId: string } }).projectRef.projectId === "inbox");
    hub.link.frame({ t: "result", id: read?.id, output: page([message(2, "Two emails need you."), message(3, "Sent the first."), message(4, "Sent both.")]) });
    await flush();
    expect(lists(session.state)?.chats.find((r) => r.key === KEY)?.preview).toEqual("Sent both.");
    // A message after it lands aside in the held chat; the list still shows it.
    hub.link.frame({ t: "event", seq: 2, type: "chat.message", at: AT, data: { projectRef: REF, messageId: "msg5", seq: 5, author: "lead", state: "final", message: message(5, "All done.") } });
    expect(lists(session.state)?.chats.find((r) => r.key === KEY)?.preview).toEqual("All done.");
  });

  it("reads again only the previews that moved on while the link was down", async () => {
    const { hub, session } = setup();
    const reads = () => hub.sentOf("call").filter((c) => c.tool === "chat_history");
    for (const c of reads()) hub.link.frame({ t: "result", id: c.id, output: page([message(1, "Morning."), message(2, "Two emails need you.")]) });
    await flush();
    hub.link.close(1006);
    vi.advanceTimersByTime(1000);
    hub.ready();
    const ada = () => reads().filter((c) => (c.input as { projectRef: { projectId: string } }).projectRef.projectId === "inbox");
    // Nothing new in Ada's chat: it isn't read again.
    hub.link.frame(snapshot);
    await flush();
    expect(ada()).toEqual([]);
    expect(lists(session.state)?.chats.find((r) => r.key === KEY)?.preview).toEqual("Two emails need you.");
    // Ada's chat moved on: only it is read.
    hub.link.frame({ ...snapshot, cursor: 2, chats: [{ ...snapshot.chats[0], lastSeq: 3 }] });
    await flush();
    expect(ada()).toHaveLength(1);
  });

  it("lifts a chat with its time when a message comes, with no change of what it waits for", () => {
    const { hub, session } = setup();
    const later = "2026-10-28T11:00:00Z";
    hub.link.frame({
      t: "event",
      seq: 2,
      type: "chat.message",
      at: later,
      data: { projectRef: { machineId: "m1", projectId: "shop" }, messageId: "s1", seq: 1, author: "lead", state: "final", message: { ...message(1, "Deployed."), messageId: "s1", projectRef: { machineId: "m1", projectId: "shop" }, createdAt: later } },
    });
    expect(session.state.chatStates["m1/shop"]).toBeUndefined();
    hub.link.frame({ ...snapshot, cursor: 2, chats: [...snapshot.chats, { projectRef: { machineId: "m1", projectId: "shop" }, lastSeq: 1, leadWorking: false, needsYou: false, lastMessageAt: AT }] });
    hub.link.frame({
      t: "event",
      seq: 3,
      type: "chat.message",
      at: later,
      data: { projectRef: { machineId: "m1", projectId: "shop" }, messageId: "s2", seq: 2, author: "lead", state: "final", message: { ...message(2, "Live."), messageId: "s2", projectRef: { machineId: "m1", projectId: "shop" }, createdAt: later } },
    });
    expect(session.state.chatStates["m1/shop"]).toMatchObject({ lastSeq: 2, lastMessageAt: later });
    expect(lists(session.state)?.chats.find((r) => r.key === "m1/shop")?.at).toEqual(later);
  });

  it("opens a chat at its latest page, streams the lead's text and takes its final message", async () => {
    const { hub, session } = setup();
    session.openChat(KEY);
    expect(hub.sentOf("chat").at(-1)).toEqual({ t: "chat", project: REF });
    hub.answer("chat_history", page([message(1, "Morning."), message(2, "Two emails need you.")]));
    await flush();
    hub.link.frame({ t: "chat_delta", projectRef: REF, messageId: "msg3", seq: 3, offset: 0, append: "Draft" });
    hub.link.frame({ t: "chat_delta", projectRef: REF, messageId: "msg3", seq: 3, offset: 5, append: "ing…" });
    const items = () => chatItems(session.state.chats[KEY]!, session.state.sends[KEY] ?? []);
    expect(items().map((i) => [i.text, i.state])).toEqual([
      ["Morning.", "sent"],
      ["Two emails need you.", "sent"],
      ["Drafting…", "streaming"],
    ]);
    hub.link.frame({ t: "event", seq: 2, type: "chat.message", at: AT, data: { projectRef: REF, messageId: "msg3", seq: 3, author: "lead", state: "final", message: message(3, "Drafted both.") } });
    expect(items().at(-1)).toMatchObject({ text: "Drafted both.", state: "sent" });
  });

  it("sends a message, shows it pending, and settles it with the hub's copy", async () => {
    const { hub, session } = setup();
    session.openChat(KEY);
    hub.answer("chat_history", page([]));
    await flush();
    session.send(KEY, "Reply to both");
    expect(hub.sentOf("call").at(-1)).toMatchObject({ tool: "chat_send", input: { projectRef: REF, text: "Reply to both", clientRequestId: "c1" } });
    const items = () => chatItems(session.state.chats[KEY]!, session.state.sends[KEY] ?? []);
    expect(items()).toMatchObject([{ text: "Reply to both", state: "pending" }]);
    hub.answer("chat_send", { message: message(3, "Reply to both", { author: "human", clientRequestId: "key_abc:c1" }) });
    await flush();
    expect(items()).toMatchObject([{ id: "msg3", text: "Reply to both", state: "sent" }]);
  });

  it("queues a message written offline and sends it under the same id when the link is back", async () => {
    const { hub, session } = setup();
    hub.link.close(1006);
    session.send(KEY, "Later");
    await flush();
    expect(session.state.sends[KEY]).toMatchObject([{ clientRequestId: "c1", state: { t: "queued" } }]);
    vi.advanceTimersByTime(1000);
    hub.ready();
    hub.link.frame(snapshot);
    expect(hub.sentOf("call").filter((c) => c.tool === "chat_send")).toMatchObject([{ input: { text: "Later", clientRequestId: "c1" } }]);
  });

  it("opens on the chats as last seen, and sends what was on its way when the app was killed", async () => {
    const saved: unknown[] = [];
    const disk = { load: () => saved.at(-1) ?? null, save: (c: unknown) => void saved.push(JSON.parse(JSON.stringify(c))) };
    const { hub, session } = setup({ cache: disk });
    const read = hub.sentOf("call").find((c) => c.tool === "chat_history");
    hub.link.frame({ t: "result", id: read?.id, output: page([message(1, "Morning."), message(2, "Two emails need you.")]) });
    await flush();
    hub.link.close(1006);
    session.send(KEY, "Send both");
    await flush();
    // Going behind writes it at once: iOS may end the app there.
    session.sleep();
    session.stop();
    const next = new Session({ hub: "http://devbox:4790", key: "key_abc", transport: fakeHub().transport, cache: disk });
    expect(lists(next.state)?.chats.filter((r) => r.key === KEY).map((r) => [r.project.title, r.preview])).toEqual([["Ada", "You: Send both"]]);
    expect(next.state.sends[KEY]).toMatchObject([{ text: "Send both", state: { t: "queued" } }]);
    // Another hub's is never shown.
    expect(new Session({ hub: "http://lab:4790", key: "key_abc", transport: fakeHub().transport, cache: disk }).state.projects).toBeUndefined();
    const again = fakeHub();
    const relaunched = new Session({ hub: "http://devbox:4790", key: "key_abc", transport: again.transport, cache: disk });
    relaunched.start();
    again.ready();
    again.link.frame(snapshot);
    expect(again.sentOf("call").filter((c) => c.tool === "chat_send")).toMatchObject([{ input: { text: "Send both" } }]);
  });

  it("stops the open chat's stream behind, keeping the link, and follows it again back in front", () => {
    const { hub, session } = setup();
    session.openChat(KEY);
    expect(hub.sentOf("chat").at(-1)).toEqual({ t: "chat", project: REF });
    session.sleep();
    expect(hub.sentOf("chat").at(-1)).toEqual({ t: "chat" });
    expect(hub.sentOf("live").at(-1)).toEqual({ t: "live", board: false });
    session.wake();
    expect(hub.sentOf("chat").at(-1)).toEqual({ t: "chat", project: REF });
    expect(hub.sentOf("live").at(-1)).toEqual({ t: "live", board: false, agent: "lead:m1/inbox" });
    expect(hub.links).toHaveLength(1);
  });

  it("tries a refused send again under its own id, or deletes it", async () => {
    const { hub, session } = setup();
    session.send(KEY, "Ship it");
    hub.fail("chat_send", "invalid", "Too long.");
    await flush();
    expect(session.state.sends[KEY]).toMatchObject([{ clientRequestId: "c1", state: { t: "failed" } }]);
    session.resend(KEY, "c1");
    expect(hub.sentOf("call").filter((c) => c.tool === "chat_send").map((c) => (c.input as { clientRequestId: string }).clientRequestId)).toEqual(["c1", "c1"]);
    hub.fail("chat_send", "invalid", "Too long.");
    await flush();
    session.discard(KEY, "c1");
    expect(session.state.sends[KEY]).toEqual([]);
  });

  it("approves an open request and drops it from the list", async () => {
    const { hub, session } = setup();
    hub.answer("requests_list", { requests: [approval("r1"), approval("r2")] });
    await flush();
    const answer = session.answer("r1", "approve");
    expect(session.state.answering).toEqual({ r1: true });
    expect(hub.sentOf("call").at(-1)).toMatchObject({ tool: "approval_answer", input: { requestId: "r1", decision: "approve" } });
    hub.answer("approval_answer", { request: { ...approval("r1"), state: "approved" } });
    expect(await answer).toBe(true);
    expect(session.state.requests?.map((r) => r.requestId)).toEqual(["r2"]);
    expect(session.state.answering).toEqual({});
    // Its chat says how it went before the message's own update arrives.
    expect(session.state.decided.r1?.state).toBe("approved");
  });

  it("keeps a request whose answer failed, with why", async () => {
    const { hub, session } = setup();
    hub.answer("requests_list", { requests: [approval("r1")] });
    await flush();
    const answer = session.answer("r1", "deny");
    hub.fail("approval_answer", "conflict", "Already answered on the desktop.");
    // False, so the card buzzes a warning rather than success.
    expect(await answer).toBe(false);
    expect(session.state.decided).toEqual({});
    expect(session.state.requests?.map((r) => r.requestId)).toEqual(["r1"]);
    expect(session.state.answerErrors.r1).toMatchObject({ message: "Already answered on the desktop." });
  });

  it("keeps the approvals through a dropped link, and an answer the drop cut off on its way till the requests are read again", async () => {
    const { hub, session } = setup();
    hub.answer("requests_list", { requests: [approval("r1"), approval("r2")] });
    await flush();
    const answer = session.answer("r1", "approve");
    hub.link.close(1006);
    await answer;
    // The card stays, still on its way: the answer may have reached the hub.
    expect(session.state.requests?.map((r) => r.requestId)).toEqual(["r1", "r2"]);
    expect(session.state.answering).toEqual({ r1: true });
    expect(session.state.answerErrors).toEqual({});
    vi.advanceTimersByTime(1000);
    hub.ready();
    hub.link.frame(snapshot);
    hub.answer("requests_list", { requests: [approval("r2")] });
    await flush();
    expect(session.state.requests?.map((r) => r.requestId)).toEqual(["r2"]);
    expect(session.state.answering).toEqual({});
  });

  it("keeps the link, and what it shows, when the app comes back to the front and the hub answers", async () => {
    const { hub, session } = setup();
    hub.answer("requests_list", { requests: [approval("r1")] });
    await flush();
    session.sleep();
    vi.advanceTimersByTime(1000);
    session.wake();
    hub.answer("hub_info", {});
    vi.advanceTimersByTime(5000);
    expect(hub.links).toHaveLength(1);
    expect(session.state.hub.phase).toBe("live");
    expect(session.state.requests?.map((r) => r.requestId)).toEqual(["r1"]);
  });

  it("back from a drop that missed a few events, the open chat goes on with them rather than read again", async () => {
    const { hub, session } = setup();
    session.openChat(KEY);
    hub.answer("chat_history", page([message(1, "Morning."), message(2, "Two emails need you.")]));
    await flush();
    hub.link.frame({ t: "event", seq: 3, type: "x", at: AT });
    hub.link.close(1006);
    vi.advanceTimersByTime(1000);
    hub.ready();
    const pages = () => hub.sentOf("call").filter((c) => c.tool === "chat_history" && (c.input as { limit: number }).limit === 50);
    hub.link.frame({ ...snapshot, cursor: 5, chats: [{ ...snapshot.chats[0], lastSeq: 3, leadWorking: false }] });
    expect(hub.sentOf("events")).toEqual([{ t: "events", cursor: 3 }]);
    expect(pages()).toHaveLength(0);
    // What it missed: its lead started and finished a turn, and wrote.
    hub.link.frame({ t: "event", seq: 4, type: "chat.waiting", at: AT, data: { ...snapshot.chats[0], lastSeq: 2, leadWorking: true } });
    hub.link.frame({ t: "event", seq: 5, type: "chat.message", at: AT, data: { projectRef: REF, messageId: "msg3", seq: 3, author: "lead", state: "final", message: message(3, "Sent both.") } });
    expect(session.state.chats[KEY]?.messages.map((m) => m.text)).toEqual(["Morning.", "Two emails need you.", "Sent both."]);
    expect(session.state.chats[KEY]?.cached).toBe(false);
    // The snapshot is newer than what the chat waited for back then.
    expect(session.state.chatStates[KEY]?.leadWorking).toBe(false);
    // Too many missed: everything is read again. (The second retry in a row waits up to 1.25 s.)
    hub.link.close(1006);
    vi.advanceTimersByTime(1250);
    hub.ready();
    hub.link.frame({ ...snapshot, cursor: 500 });
    expect(hub.sentOf("events")).toEqual([{ t: "events", cursor: 500 }]);
    expect(pages()).toHaveLength(1);
  });

  it("checks a live link when the network changes, and dials at once one that waits out its backoff", () => {
    const { hub, session } = setup();
    vi.advanceTimersByTime(1000);
    session.networkChanged();
    expect(hub.sentOf("call").filter((c) => c.tool === "hub_info")).toHaveLength(2);
    // Nothing back: the link was on the network left behind.
    vi.advanceTimersByTime(2500);
    expect(hub.links).toHaveLength(2);
    hub.link.close(1006);
    expect(session.state.hub.phase).toBe("retrying");
    session.networkChanged();
    expect(hub.links).toHaveLength(3);
    // Still dialling on the old network: again, on the new one.
    session.networkChanged();
    expect(hub.links).toHaveLength(4);
    expect(hub.links[2]?.closed).toBe(true);
  });

  it("refreshes with a fresh snapshot while live", () => {
    const { hub, session } = setup();
    const before = hub.sentOf("snapshot").length;
    session.refresh();
    expect(hub.sentOf("snapshot").length).toBe(before + 1);
    expect(hub.links.length).toBe(1);
  });

  it("shows a project's new name once the hub says it was renamed, without a restart", () => {
    const { hub, session } = setup();
    const before = hub.sentOf("snapshot").length;
    hub.link.frame({ t: "event", seq: 2, type: "project.settings", at: AT, machineId: "m1", projectId: "shop", data: { title: "Shop" } });
    expect(hub.sentOf("snapshot").length).toBe(before + 1);
    hub.link.frame({ ...snapshot, cursor: 2, projects: [project("inbox", "Ada"), project("shop", "Shop")] });
    expect(lists(session.state)?.chats.find((r) => r.key === "m1/shop")?.project.title).toEqual("Shop");
  });

  it("reads the open requests again when one changes", () => {
    const { hub } = setup();
    const reads = () => hub.sentOf("call").filter((c) => c.tool === "requests_list").length;
    expect(reads()).toBe(1);
    hub.link.frame({ t: "event", seq: 2, type: "request.opened", at: AT });
    expect(reads()).toBe(2);
  });

  it("reads an older page once at a time, showing it's on its way", async () => {
    const { hub, session } = setup();
    session.openChat(KEY);
    hub.answer("chat_history", { ...page([message(51, "Fifty-one"), message(52, "Fifty-two")]), moreBefore: true });
    await flush();
    const older = () => hub.sentOf("call").filter((c) => c.tool === "chat_history" && (c.input as { before?: number }).before !== undefined);
    void session.loadOlder(KEY);
    // The list's end reached again, or a landing looking further back, while the page is out: no second read.
    void session.loadOlder(KEY);
    expect(older()).toHaveLength(1);
    expect(session.state.chats[KEY]?.loadingOlder).toBe(true);
    hub.answer("chat_history", { ...page([message(50, "Fifty")]), moreBefore: true });
    await flush();
    expect(session.state.chats[KEY]).toMatchObject({ loadingOlder: false, hasOlder: true });
    expect(session.state.chats[KEY]?.messages.map((m) => m.seq)).toEqual([50, 51, 52]);
    void session.loadOlder(KEY);
    expect(older()).toHaveLength(2);
    hub.fail("chat_history", "unavailable", "The machine is offline.");
    await flush();
    // An older page's failure is said at the top of the thread, not as the chat's.
    expect(session.state.chats[KEY]).toMatchObject({ loadingOlder: false });
    expect(session.state.chats[KEY]?.error).toBeUndefined();
    expect(session.state.olderErrors[KEY]).toMatchObject({ message: "The machine is offline." });
  });

  it("reads a message too big for its event by seq", async () => {
    const { hub, session } = setup();
    session.openChat(KEY);
    hub.answer("chat_history", page([message(1, "Hi")]));
    await flush();
    hub.link.frame({ t: "event", seq: 2, type: "chat.message", at: AT, data: { projectRef: REF, messageId: "msg2", seq: 2, author: "lead", state: "final" } });
    expect(hub.sentOf("call").at(-1)).toMatchObject({ tool: "chat_history", input: { after: 1, limit: 1 } });
    hub.answer("chat_history", page([message(2, "A long one")]));
    await flush();
    expect(session.state.chats[KEY]?.messages.map((m) => m.text)).toEqual(["Hi", "A long one"]);
  });
});

describe("Stale errors", () => {
  const devbox = { machineId: "m1", name: "devbox", nodeVersion: "0.9.0", status: "offline", tags: [], lastSeenAt: AT };

  it("say a machine is back as soon as the hub does, not at the next snapshot", () => {
    const { hub, session } = setup();
    hub.link.frame({ ...snapshot, cursor: 2, machines: [devbox] });
    expect(session.state.machines[0]?.status).toBe("offline");
    const before = session.state;
    hub.link.frame({ t: "event", seq: 3, type: "machine.online", at: AT, machineId: "m1" });
    expect(session.state.machines[0]?.status).toBe("online");
    hub.link.frame({ t: "event", seq: 4, type: "machine.degraded", at: AT, machineId: "m1" });
    expect(session.state.machines[0]?.status).toBe("degraded");
    hub.link.frame({ t: "event", seq: 5, type: "machine.offline", at: AT, machineId: "m1" });
    expect(session.state.machines[0]?.status).toBe("offline");
    // One the snapshot doesn't list changes nothing.
    const now = session.state;
    hub.link.frame({ t: "event", seq: 6, type: "machine.online", at: AT, machineId: "buildbox" });
    expect(session.state.machines).toBe(now.machines);
    expect(before.machines[0]?.status).toBe("offline");
  });

  it("tell a screen each time the link is live again, so a read that failed while it was down is read again", () => {
    const hub = fakeHub();
    const session = new Session({ hub: "http://devbox:4790", key: "key_abc", transport: hub.transport, now: () => Date.parse(AT) });
    const lives = vi.fn();
    session.onLive(lives);
    session.start();
    expect(lives).not.toHaveBeenCalled();
    hub.ready();
    expect(lives).toHaveBeenCalledTimes(1);
    // A snapshot or event on the same link is no new link.
    hub.link.frame(snapshot);
    expect(lives).toHaveBeenCalledTimes(1);
    hub.link.close(1006);
    vi.advanceTimersByTime(1000);
    hub.ready();
    expect(lives).toHaveBeenCalledTimes(2);
  });

  it("keep an older page that failed apart from the chat, for the top of the thread, until a page comes", async () => {
    const { hub, session } = setup();
    session.openChat(KEY);
    hub.answer("chat_history", { ...page([message(2, "Hi")]), moreBefore: true });
    await flush();
    const older = session.loadOlder(KEY);
    hub.fail("chat_history", "timeout", "The hub didn't answer chat_history within 30 s.");
    await older;
    expect(session.state.chats[KEY]?.error).toBeUndefined();
    expect(session.state.olderErrors[KEY]).toMatchObject({ code: "timeout" });
    // Tried again, and read.
    const again = session.loadOlder(KEY);
    hub.answer("chat_history", page([message(1, "Hello")]));
    await again;
    expect(session.state.olderErrors[KEY]).toBeUndefined();
    expect(session.state.chats[KEY]?.messages.map((m) => m.text)).toEqual(["Hello", "Hi"]);
  });
});

describe("Pinned chats", () => {
  const pinCalls = (hub: ReturnType<typeof fakeHub>, tool: string) => hub.sentOf("call").filter((c) => c.tool === tool);

  it("read on each snapshot: this hub's own chats among an older build's pins go up to a hub that never had them, then follow another device's", async () => {
    const hub = fakeHub();
    // Pinned before the hubs kept them: one of this hub's chats, and one of another hub's.
    const store = memoryPins(["m1/shop", "lab/elsewhere"]);
    const session = new Session({ hub: "http://devbox:4790", key: "key_abc", transport: hub.transport, pins: store });
    session.start();
    hub.ready();
    // Not before its chats are known.
    expect(pinCalls(hub, "chat_pins_get")).toHaveLength(0);
    hub.link.frame(snapshot);
    expect(pinCalls(hub, "chat_pins_get")).toHaveLength(1);
    hub.answer("chat_pins_get", { pins: [], set: false });
    await flush();
    // Only this hub's: another hub's chat never goes to it.
    expect(pinCalls(hub, "chat_pins_set").at(-1)?.input).toEqual({ pins: [{ machineId: "m1", projectId: "shop" }] });
    expect(store.saved()).toEqual(["m1/shop"]);
    hub.answer("chat_pins_set", { pins: [{ machineId: "m1", projectId: "shop" }] });
    await flush();
    expect(store.pending()).toBe(false);

    // Pinned on the person's other phone: this one reads them again.
    hub.link.frame({ t: "event", seq: 2, type: "chat.pins", at: AT, data: { personId: "p_abcd2345" } });
    expect(pinCalls(hub, "chat_pins_get")).toHaveLength(2);
    hub.answer("chat_pins_get", { pins: [REF, { machineId: "m1", projectId: "shop" }], set: true });
    await flush();
    expect(store.saved()).toEqual([KEY, "m1/shop"]);
  });

  it("shows a pin made here at once and sends it", async () => {
    const hub = fakeHub();
    const store = memoryPins();
    const session = new Session({ hub: "http://devbox:4790", key: "key_abc", transport: hub.transport, pins: store });
    session.start();
    hub.ready();
    hub.link.frame(snapshot);
    hub.answer("chat_pins_get", { pins: [], set: true });
    await flush();
    void session.changePins(() => [KEY]);
    expect(store.saved()).toEqual([KEY]);
    expect(pinCalls(hub, "chat_pins_set").at(-1)?.input).toEqual({ pins: [REF] });
  });
});

describe("Sections", () => {
  const sectionCalls = (hub: ReturnType<typeof fakeHub>, tool: string) => hub.sentOf("call").filter((c) => c.tool === tool);
  const work = { id: "s1", name: "Work", chats: [REF] };

  it("read on each snapshot, and again when another of the person's devices changed them", async () => {
    const hub = fakeHub();
    const store = memorySections();
    const session = new Session({ hub: "http://devbox:4790", key: "key_abc", transport: hub.transport, sections: store });
    session.start();
    hub.ready();
    expect(sectionCalls(hub, "chat_sections_get")).toHaveLength(0);
    hub.link.frame(snapshot);
    expect(sectionCalls(hub, "chat_sections_get")).toHaveLength(1);
    hub.answer("chat_sections_get", { sections: [work] });
    await flush();
    expect(store.saved()).toEqual([{ id: "s1", name: "Work", chats: [KEY] }]);

    hub.link.frame({ t: "event", seq: 2, type: "chat.sections", at: AT, data: { personId: "p_abcd2345" } });
    expect(sectionCalls(hub, "chat_sections_get")).toHaveLength(2);
    hub.answer("chat_sections_get", { sections: [] });
    await flush();
    expect(store.saved()).toEqual([]);
  });

  it("shows a change made here at once, sends it, and takes it back with the hub's words when the hub refuses", async () => {
    const hub = fakeHub();
    const store = memorySections();
    const session = new Session({ hub: "http://devbox:4790", key: "key_abc", transport: hub.transport, sections: store });
    const said: string[] = [];
    session.onSectionsRefused((words) => said.push(words));
    session.start();
    hub.ready();
    hub.link.frame(snapshot);
    hub.answer("chat_sections_get", { sections: [] });
    await flush();
    void session.changeSections(() => [{ id: "s1", name: "Work", chats: [KEY] }]);
    expect(store.saved()).toEqual([{ id: "s1", name: "Work", chats: [KEY] }]);
    expect(sectionCalls(hub, "chat_sections_set").at(-1)?.input).toEqual({ sections: [work] });
    hub.fail("chat_sections_set", "invalid", "A section needs a name.");
    await flush();
    expect(said).toEqual(["A section needs a name."]);
    hub.answer("chat_sections_get", { sections: [] });
    await flush();
    expect(store.saved()).toEqual([]);
    expect(store.pending()).toBe(false);
  });
});

describe("A chat's picture", () => {
  it("is read once per picture while the app runs, and again after a failed read", async () => {
    const { hub, session } = setup();
    const reads = () => hub.sentOf("call").filter((c) => c.tool === "project_avatar_get");
    const first = session.picture(REF, "a1b2c3d4e5f60718");
    const again = session.picture(REF, "a1b2c3d4e5f60718");
    expect(reads().map((c) => c.input)).toEqual([REF]);
    hub.answer("project_avatar_get", { avatar: "a1b2c3d4e5f60718", mime: "image/jpeg", dataB64: "/9j/AA==" });
    await expect(first).resolves.toBe("/9j/AA==");
    await expect(again).resolves.toBe("/9j/AA==");

    // A newer picture than the one asked for answers nothing; it is read again under its own id.
    const stale = session.picture(REF, "0000000000000000");
    hub.answer("project_avatar_get", { avatar: "a1b2c3d4e5f60718", mime: "image/jpeg", dataB64: "/9j/AA==" });
    await expect(stale).resolves.toBeNull();
    void session.picture(REF, "0000000000000000");
    expect(reads()).toHaveLength(3);
  });
});

describe("A message's file", () => {
  it("that couldn't be read says the hub's why, and is read again on the next ask, not kept", async () => {
    const { hub, session } = setup();
    const reads = () => hub.sentOf("call").filter((c) => c.tool === "attachment_get");
    const first = session.attachment(KEY, "att1");
    hub.fail("attachment_get", "not_found", "The hub no longer has that file.");
    await expect(first).resolves.toMatchObject({ ok: false, error: { message: "The hub no longer has that file." } });
    const again = session.attachment(KEY, "att1");
    expect(reads()).toHaveLength(2);
    hub.answer("attachment_get", { attachmentId: "att1", name: "lease.png", mime: "image/png", dataB64: "iVBORw==" });
    await expect(again).resolves.toMatchObject({ ok: true, output: { name: "lease.png" } });
    // Read once it's had.
    await expect(session.attachment(KEY, "att1")).resolves.toMatchObject({ ok: true });
    expect(reads()).toHaveLength(2);
  });
});

describe("a chat's screens", () => {
  const live = (control: string, takeoverReason?: string) => ({
    sessionId: "B0123456789abcdef0123456789abcdef",
    projectRef: REF,
    threadId: "th-1",
    purpose: "Book the hotel",
    state: "live",
    control,
    startedAt: AT,
    ...(takeoverReason === undefined ? {} : { takeoverReason }),
  });
  const sessions = (list: unknown[]) => ({ sessions: list, retention: { days: 30, maxGb: 20 } });

  it("are read as the chat opens and again when one of them changes", async () => {
    const { hub, session } = setup();
    session.openChat(KEY);
    hub.answer("browser_sessions", sessions([live("agent")]));
    await flush();
    expect(session.state.screens[KEY]?.map((s) => s.control)).toEqual(["agent"]);
    hub.link.frame({ t: "event", seq: 2, type: "browser.session", at: AT, data: { projectRef: REF, sessionId: live("agent").sessionId, state: "live", control: "agent" } });
    expect(hub.sentOf("call").filter((c) => c.tool === "browser_sessions")).toHaveLength(2);
    hub.answer("browser_sessions", sessions([live("agent", "Solve the captcha")]));
    await flush();
    expect(session.state.screens[KEY]?.[0]?.takeoverReason).toBe("Solve the captcha");
    // Another chat's screen, never looked at, isn't read.
    hub.link.frame({ t: "event", seq: 3, type: "browser.session", at: AT, data: { projectRef: { machineId: "m1", projectId: "shop" }, sessionId: "Bx", state: "live", control: "agent" } });
    expect(hub.sentOf("call").filter((c) => c.tool === "browser_sessions")).toHaveLength(2);
  });

  it("send frames to the live view alone, never through the state", () => {
    const { hub, session } = setup();
    hub.ready(["browser_sessions"]);
    hub.link.frame(snapshot);
    const seen: number[] = [];
    let draws = 0;
    session.subscribe(() => draws++);
    const off = session.onFrame((f) => seen.push(f.seq));
    session.watch("Bsee");
    expect(hub.sentOf("browser_watch")).toEqual([{ t: "browser_watch", session: "Bsee" }]);
    for (const seq of [1, 2]) hub.link.frame({ t: "browser_frame", sessionId: "Bsee", seq, jpegB64: "AA==", width: 4, height: 3, control: "agent" });
    expect(seen).toEqual([1, 2]);
    expect(draws).toBe(0);
    off();
  });

  it("change hands once the hub says so, and stay as they were when it refuses", async () => {
    const { hub, session } = setup();
    session.openChat(KEY);
    hub.answer("browser_sessions", sessions([live("agent", "Solve the captcha")]));
    await flush();
    const taking = session.control(live("agent").sessionId, "human");
    expect(hub.sentOf("call").at(-1)).toMatchObject({ tool: "browser_control", input: { sessionId: live("agent").sessionId, control: "human" } });
    hub.answer("browser_control", { session: live("human") });
    await expect(taking).resolves.toMatchObject({ ok: true });
    expect(session.state.screens[KEY]?.[0]?.control).toBe("human");
    // Another person's project's screen: refused, and nothing changes here.
    const refused = session.control(live("human").sessionId, "agent");
    hub.fail("browser_control", "forbidden", "inbox on m1 is another person's project: only its owner uses and manages it.");
    await expect(refused).resolves.toMatchObject({ ok: false, error: { code: "forbidden" } });
    expect(session.state.screens[KEY]?.[0]?.control).toBe("human");
  });
});

describe("a tap on a screen just taken over", () => {
  it("goes to the page as soon as the hub says it's yours, before the screens are read again", async () => {
    const { hub, session } = setup();
    hub.ready(["browser_sessions"]);
    hub.link.frame(snapshot);
    session.openChat(KEY);
    const id = "B0123456789abcdef0123456789abcdef";
    const screen = (control: string) => ({ sessionId: id, projectRef: REF, threadId: "th-1", purpose: "Book", state: "live", control, startedAt: AT, kind: "browser" });
    hub.answer("browser_sessions", { sessions: [screen("agent")], retention: { days: 30, maxGb: 20 } });
    await flush();
    // The view drew while the agent had it: what it reads must be now's, not that draw's.
    const touches = new PageTouches({
      yours: () => controlOf(session.state.screens[KEY]?.[0], undefined) === "human",
      where: (x, y) => ({ at: { x, y }, frame: { x: x * 4, y: y * 4 }, t: Date.now() }),
      scale: () => 4,
      send: (input) => session.input(id, input),
    });
    touches.down(10, 20);
    touches.up(10, 20);
    expect(hub.sentOf("browser_input")).toEqual([]);
    const reads = hub.sentOf("call").filter((c) => c.tool === "browser_sessions").length;
    const taking = session.control(id, "human");
    hub.answer("browser_control", { session: screen("human") });
    await taking;
    // No read of the list since: the hub's answer to Take Over is enough.
    expect(hub.sentOf("call").filter((c) => c.tool === "browser_sessions")).toHaveLength(reads);
    touches.down(10, 20);
    touches.up(10, 20);
    expect(hub.sentOf("browser_input")).toEqual([
      { t: "browser_input", session: id, input: { kind: "mouse", action: "moved", x: 40, y: 80, button: "none" } },
      { t: "browser_input", session: id, input: { kind: "mouse", action: "pressed", x: 40, y: 80, button: "left", clickCount: 1 } },
      { t: "browser_input", session: id, input: { kind: "mouse", action: "released", x: 40, y: 80, button: "left", clickCount: 1 } },
    ]);
  });

  describe("a chat's pictures and files", () => {
    const file = { attachmentId: "F3", name: "shot.png", bytes: 900_000 };
    const gets = (hub: ReturnType<typeof setup>["hub"]) => hub.sentOf("call").filter((c) => c.tool === "attachment_get").map((c) => c.input);

    it("shows a picture's preview, kept on disk, so the next launch reads nothing", async () => {
      const kept = new Map<string, unknown>();
      const previews = { load: (h: string, id: string) => (kept.get(`${h} ${id}`) ?? null) as never, save: (h: string, id: string, p: unknown) => void kept.set(`${h} ${id}`, p) };
      const { hub, session } = setup({ previews });
      const shown = session.preview(KEY, "F3");
      expect(gets(hub)).toEqual([{ projectRef: REF, attachmentId: "F3", maxSide: 1024 }]);
      hub.answer("attachment_get", { ...file, mime: "image/jpeg", dataB64: "c21hbGw=", preview: true });
      await expect(shown).resolves.toMatchObject({ ok: true, output: { preview: true, dataB64: "c21hbGw=" } });
      const again = setup({ previews });
      await expect(again.session.preview(KEY, "F3")).resolves.toMatchObject({ ok: true, output: { preview: true } });
      expect(gets(again.hub)).toEqual([]);
    });

    it("reads the picture itself, in pieces from the start, only when it is opened", async () => {
      const { hub, session } = setup();
      void session.preview(KEY, "F3");
      hub.answer("attachment_get", { ...file, mime: "image/jpeg", dataB64: "c21hbGw=", preview: true });
      await flush();
      const whole = session.attachment(KEY, "F3");
      await flush();
      expect(gets(hub).at(-1)).toEqual({ projectRef: REF, attachmentId: "F3", offset: 0, length: 524_286 });
      hub.answer("attachment_get", { ...file, bytes: 3, mime: "image/png", dataB64: "AAEC", offset: 0 });
      await expect(whole).resolves.toMatchObject({ ok: true, output: { dataB64: "AAEC", mime: "image/png" } });
    });

    it("takes the file an older hub sent for a preview as the file, which opening then uses", async () => {
      const { hub, session } = setup();
      const shown = session.preview(KEY, "F3");
      hub.answer("attachment_get", { ...file, mime: "image/png", dataB64: "AAEC" });
      await shown;
      await expect(session.attachment(KEY, "F3")).resolves.toMatchObject({ ok: true, output: { dataB64: "AAEC" } });
      expect(gets(hub)).toHaveLength(1);
    });
  });
});
