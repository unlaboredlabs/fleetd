import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { chatItems, type ChatMessage, type HumanRequest } from "./desktop";
import { fakeHub } from "./hub/fake";
import { lists } from "./lists";
import { Session } from "./session";

const REF = { machineId: "m1", projectId: "navi" };
const KEY = "m1/navi";
const AT = "2026-10-28T10:00:00Z";

const project = (projectId: string, title: string, kind?: "assistant") => ({
  machineId: "m1",
  projectId,
  title,
  workspaceRoot: `/home/devbox/${projectId}`,
  lastActivityAt: AT,
  threads: { running: 0, waiting: 0, failed: 0, idle: 0 },
  ...(kind === undefined ? {} : { kind }),
});

const snapshot = {
  t: "snapshot",
  cursor: 1,
  attention: [],
  machines: [],
  projects: [project("navi", "Ada", "assistant"), project("shop", "storefront")],
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

const setup = () => {
  const hub = fakeHub();
  let id = 0;
  const session = new Session({ hub: "http://devbox:4790", key: "key_abc", transport: hub.transport, now: () => Date.parse(AT), newId: () => `c${String(++id)}` });
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
  it("lists what needs you on top, then the Navis, then the projects", async () => {
    const { hub, session } = setup();
    expect(lists(session.state)).toMatchObject({ needsYou: [], navis: [{ key: KEY }], projects: [{ key: "m1/shop" }] });
    hub.answer("requests_list", { requests: [approval("r1")] });
    await flush();
    expect(lists(session.state)).toMatchObject({ needsYou: [{ key: KEY, want: "1 approval waiting" }], navis: [], projects: [{ key: "m1/shop" }] });
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

  it("previews each chat from its newest messages, read after the snapshot and kept by events", async () => {
    const { hub, session } = setup();
    const reads = () => hub.sentOf("call").filter((c) => c.tool === "chat_history");
    expect(reads().map((c) => c.input)).toEqual([{ projectRef: REF, limit: 3 }]);
    hub.answer("chat_history", page([message(1, "Morning."), message(2, "Two **emails** need you.")]));
    await flush();
    expect(reads().map((c) => (c.input as { projectRef: unknown }).projectRef)).toEqual([REF, { machineId: "m1", projectId: "shop" }]);
    expect(lists(session.state)?.navis.map((r) => r.preview)).toEqual(["Two emails need you."]);
    hub.link.frame({ t: "event", seq: 2, type: "chat.message", at: AT, data: { projectRef: REF, messageId: "msg3", seq: 3, author: "lead", state: "final", message: message(3, "Sent both.") } });
    expect(lists(session.state)?.navis.map((r) => r.preview)).toEqual(["Sent both."]);
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

  it("approves an open request and drops it from the list", async () => {
    const { hub, session } = setup();
    hub.answer("requests_list", { requests: [approval("r1"), approval("r2")] });
    await flush();
    const answer = session.answer("r1", "approve");
    expect(session.state.answering).toEqual({ r1: true });
    expect(hub.sentOf("call").at(-1)).toMatchObject({ tool: "approval_answer", input: { requestId: "r1", decision: "approve" } });
    hub.answer("approval_answer", { request: { ...approval("r1"), state: "approved" } });
    await answer;
    expect(session.state.requests?.map((r) => r.requestId)).toEqual(["r2"]);
    expect(session.state.answering).toEqual({});
  });

  it("keeps a request whose answer failed, with why", async () => {
    const { hub, session } = setup();
    hub.answer("requests_list", { requests: [approval("r1")] });
    await flush();
    const answer = session.answer("r1", "deny");
    hub.fail("approval_answer", "conflict", "Already answered on the desktop.");
    await answer;
    expect(session.state.requests?.map((r) => r.requestId)).toEqual(["r1"]);
    expect(session.state.answerErrors.r1).toMatchObject({ message: "Already answered on the desktop." });
  });

  it("refreshes with a fresh snapshot while live", () => {
    const { hub, session } = setup();
    const before = hub.sentOf("snapshot").length;
    session.refresh();
    expect(hub.sentOf("snapshot").length).toBe(before + 1);
    expect(hub.links.length).toBe(1);
  });

  it("reads the open requests again when one changes", () => {
    const { hub } = setup();
    const reads = () => hub.sentOf("call").filter((c) => c.tool === "requests_list").length;
    expect(reads()).toBe(1);
    hub.link.frame({ t: "event", seq: 2, type: "request.opened", at: AT });
    expect(reads()).toBe(2);
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
