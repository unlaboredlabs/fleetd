import { afterEach, describe, expect, it, vi } from "vitest";
import type { HubError, HubFrame } from "../../../shared/hub";
import type { ChatMessage } from "./chat-contract";
import { live, snapshot } from "./fixtures.test-util";
import { createDataLayer, type HubApi } from "./queries";
import { selectCanStop, selectChat, selectLeadWorking, selectNeedsYou } from "./selectors";

type Answer = { ok: true; output: unknown } | { ok: false; error: HubError };

const fakeHub = () => {
  let listener: (frame: HubFrame) => void = () => undefined;
  const calls: { tool: string; input: Record<string, unknown>; answer: (a: Answer) => void }[] = [];
  const chats: unknown[] = [];
  const hub: HubApi = {
    call: (tool, input) =>
      new Promise((resolve) => calls.push({ tool, input: input as Record<string, unknown>, answer: resolve })),
    subscribe: (l) => ((listener = l), () => undefined),
    resync: () => Promise.resolve(),
    chat: (project) => {
      chats.push(project);
      return Promise.resolve();
    },
    focus: () => Promise.resolve(),
  };
  const of = (tool: string) => calls.filter((c) => c.tool === tool);
  return { hub, send: (f: HubFrame) => listener(f), calls, of, chats };
};

const KEY = "devbox/storefront";
const ref = { machineId: "devbox", projectId: "storefront" };
const msg = (seq: number, patch: Partial<ChatMessage> = {}): ChatMessage => ({
  messageId: `m${seq}`,
  projectRef: ref,
  seq,
  author: "lead",
  state: "final",
  text: `message ${seq}`,
  createdAt: "2026-10-19T10:00:00.000Z",
  ...patch,
});
const chatEvent = (seq: number, type: string, data: unknown): HubFrame => ({
  t: "event",
  event: { seq, at: "2026-10-19T10:00:00.000Z", type, summary: type, data },
});
const page = (messages: ChatMessage[], { moreBefore = false, needsYou = false } = {}): Answer => ({
  ok: true,
  output: { messages, moreBefore, moreAfter: false, state: { projectRef: ref, needsYou, leadWorking: false, lastSeq: messages.at(-1)?.seq ?? 0 } },
});
const delta = (messageId: string, offset: number, append: string): HubFrame => ({
  t: "chat_delta",
  delta: { projectRef: ref, messageId, seq: 3, offset, append },
});
const messageEvent = (seq: number, m: ChatMessage, carry = true): HubFrame =>
  chatEvent(seq, "chat.message", {
    projectRef: ref,
    messageId: m.messageId,
    seq: m.seq,
    author: m.author,
    state: m.state,
    ...(carry ? { message: m } : {}),
  });
const err = (code: string): Answer => ({ ok: false, error: { code, message: code } });

const connected = async () => {
  const fake = fakeHub();
  const layer = createDataLayer(fake.hub);
  layer.start();
  fake.send(live());
  fake.send(snapshot(1));
  layer.chat.open(KEY);
  await Promise.resolve();
  fake.of("chat_history")[0]?.answer(page([msg(1), msg(2)], { moreBefore: true, needsYou: true }));
  await vi.waitFor(() => expect(selectChat(KEY)(layer.store.getState())).toBeDefined());
  return { fake, layer };
};

const items = (layer: Awaited<ReturnType<typeof connected>>["layer"]) =>
  selectChat(KEY)(layer.store.getState())?.items.map((i) => [i.id, i.state]);

afterEach(() => vi.useRealTimers());

describe("chat history", () => {
  it("opens once per connection, pages older, and takes needs-you from the hub", async () => {
    const { fake, layer } = await connected();
    expect(selectNeedsYou(KEY)(layer.store.getState())).toBe(true);
    layer.chat.open(KEY);
    expect(fake.of("chat_history")).toHaveLength(1);
    layer.chat.loadOlder(KEY);
    layer.chat.loadOlder(KEY);
    expect(fake.of("chat_history").map((c) => c.input["before"])).toEqual([undefined, 1]);
    fake.of("chat_history")[1]?.answer(page([msg(0)]));
    await vi.waitFor(() => expect(selectChat(KEY)(layer.store.getState())?.hasOlder).toBe(false));
    expect(items(layer)).toEqual([
      ["m0", "sent"],
      ["m1", "sent"],
      ["m2", "sent"],
    ]);
  });

  it("a drop keeps the chat on screen, marked offline; the reconnect reads it again and drops the old connection's late answer", async () => {
    const { fake, layer } = await connected();
    layer.chat.loadOlder(KEY);
    fake.send({ t: "state", state: { phase: "retrying", hub: "devbox:4710", reason: "closed", retryAt: 1 } });
    const offline = selectChat(KEY)(layer.store.getState());
    expect(offline).toMatchObject({ held: true, asOf: expect.any(Number) as unknown });
    expect(items(layer)).toEqual([["m1", "sent"], ["m2", "sent"]]);
    fake.send(live());
    fake.send(snapshot(5));
    // Connected again, not yet read back: the same messages, no longer offline but still marked as of the drop,
    // never a blank chat.
    expect(selectChat(KEY)(layer.store.getState())).toMatchObject({ held: true, offline: false, asOf: expect.any(Number) as unknown });
    expect(items(layer)).toEqual([["m1", "sent"], ["m2", "sent"]]);
    fake.of("chat_history")[1]?.answer(page([msg(0)]));
    await Promise.resolve();
    expect(fake.of("chat_history")).toHaveLength(3);
    fake.of("chat_history")[2]?.answer(page([msg(2), msg(3)]));
    // The page replaces what was held; it doesn't join up with it.
    await vi.waitFor(() => expect(items(layer)).toEqual([["m2", "sent"], ["m3", "sent"]]));
    expect(selectChat(KEY)(layer.store.getState())?.held).toBe(false);
  });

  it("after a reconnect, a failed read keeps the chat marked as last known, with the error; Retry catches it up", async () => {
    const { fake, layer } = await connected();
    fake.send({ t: "state", state: { phase: "retrying", hub: "devbox:4710", reason: "closed", retryAt: 1 } });
    fake.send(live());
    fake.send(snapshot(5));
    await Promise.resolve();
    fake.of("chat_history")[1]?.answer(err("timeout"));
    await vi.waitFor(() => expect(selectChat(KEY)(layer.store.getState())?.error?.code).toBe("timeout"));
    // Never shown as current: held, marked as of the drop, with the error to retry from.
    expect(selectChat(KEY)(layer.store.getState())).toMatchObject({ held: true, offline: false, asOf: expect.any(Number) as unknown });
    // The lead goes on meanwhile; the held chat can't place it, so the next read brings it.
    fake.send(messageEvent(6, msg(3)));
    expect(items(layer)).toEqual([["m1", "sent"], ["m2", "sent"]]);
    layer.chat.open(KEY);
    expect(fake.of("chat_history")).toHaveLength(3);
    // Retrying: the last failure doesn't stand while the read is out.
    expect(selectChat(KEY)(layer.store.getState())?.error).toBeUndefined();
    fake.of("chat_history")[2]?.answer(page([msg(1), msg(2), msg(3)]));
    await vi.waitFor(() => expect(selectChat(KEY)(layer.store.getState())?.held).toBe(false));
    expect(items(layer)).toEqual([["m1", "sent"], ["m2", "sent"], ["m3", "sent"]]);
    expect(selectChat(KEY)(layer.store.getState())?.asOf).toBeUndefined();
    // Read: new lines join it as they come.
    fake.send(messageEvent(7, msg(4)));
    expect(items(layer)?.at(-1)).toEqual(["m4", "sent"]);
  });

  it("a message the hub takes while the chat is held shows in it, not nowhere", async () => {
    const { fake, layer } = await connected();
    fake.send({ t: "state", state: { phase: "retrying", hub: "devbox:4710", reason: "closed", retryAt: 1 } });
    fake.send(live());
    fake.send(snapshot(5));
    const out = layer.chat.send(KEY, { text: "ship it" }, "c1");
    const mine = msg(3, { author: "human", text: "ship it", clientRequestId: "c1" });
    fake.of("chat_send")[0]?.answer({ ok: true, output: { message: mine } });
    expect(await out).toBe("sent");
    expect(selectChat(KEY)(layer.store.getState())?.held).toBe(true);
    expect(items(layer)).toEqual([["m1", "sent"], ["m2", "sent"], ["m3", "sent"]]);
  });

  it("a resync while the latest page is loading reads it again, and the chat doesn't stay on its skeleton", async () => {
    const fake = fakeHub();
    const layer = createDataLayer(fake.hub);
    layer.start();
    fake.send(live());
    fake.send(snapshot(1));
    layer.chat.open(KEY);
    await Promise.resolve();
    // A resync snapshot arrives with the first read still out.
    fake.send(snapshot(2));
    await Promise.resolve();
    expect(fake.of("chat_history")).toHaveLength(2);
    fake.of("chat_history")[0]?.answer(page([msg(1)]));
    fake.of("chat_history")[1]?.answer(page([msg(1), msg(2)]));
    await vi.waitFor(() => expect(items(layer)).toEqual([["m1", "sent"], ["m2", "sent"]]));
  });

  it("subscribes to the open chat's stream; deltas merge without duplicates; a gap reads the latest page again", async () => {
    const { fake, layer } = await connected();
    expect(fake.chats).toEqual([ref]);
    fake.send(messageEvent(2, msg(3, { state: "streaming", text: "" })));
    fake.send(delta("m3", 0, "Looking"));
    fake.send(delta("m3", 0, "Looking"));
    expect(selectChat(KEY)(layer.store.getState())?.items.at(-1)).toMatchObject({ id: "m3", text: "Looking", state: "streaming" });
    fake.send(delta("m3", 50, "!"));
    await Promise.resolve();
    expect(fake.of("chat_history")).toHaveLength(2);
    fake.of("chat_history")[1]?.answer(page([msg(2), msg(3, { text: "Looking at it now", updatedAt: "2026-10-19T10:01:00.000Z" })]));
    await vi.waitFor(() => expect(items(layer)).toEqual([["m1", "sent"], ["m2", "sent"], ["m3", "sent"]]));
    layer.chat.close();
    expect(fake.chats).toEqual([ref, null]);
  });

  it("a message too big for its event is read by seq", async () => {
    const { fake, layer } = await connected();
    fake.send(messageEvent(2, msg(3, { text: "x".repeat(3000) }), false));
    await Promise.resolve();
    expect(fake.of("chat_history")[1]?.input).toMatchObject({ after: 2, limit: 1 });
    fake.of("chat_history")[1]?.answer(page([msg(3, { text: "x".repeat(3000) })]));
    await vi.waitFor(() => expect(items(layer)?.at(-1)).toEqual(["m3", "sent"]));
  });

  it("the lead's waiting and working state comes from chat.waiting", async () => {
    const { fake, layer } = await connected();
    fake.send(chatEvent(2, "chat.waiting", { projectRef: ref, needsYou: false, leadWorking: true, lastSeq: 2 }));
    expect(selectNeedsYou(KEY)(layer.store.getState())).toBe(false);
    expect(selectLeadWorking(KEY)(layer.store.getState())).toBe(true);
  });
});

describe("sending", () => {
  it("shows at once, settles on the echo event first, and the late answer adds nothing", async () => {
    const { fake, layer } = await connected();
    const out = layer.chat.send(KEY, { text: "1 go, 2 rec" }, "c1");
    expect(items(layer)?.at(-1)).toEqual(["c1", "pending"]);
    expect(fake.of("chat_send")[0]?.input).toMatchObject({ clientRequestId: "c1", text: "1 go, 2 rec", projectRef: ref });
    const mine = msg(3, { author: "human", text: "1 go, 2 rec", clientRequestId: "c1" });
    fake.send(messageEvent(2, mine));
    expect(items(layer)?.at(-1)).toEqual(["m3", "sent"]);
    fake.of("chat_send")[0]?.answer({ ok: true, output: { message: mine, leadWaiting: "The lead is starting; it reads this first." } });
    expect(await out).toBe("sent");
    expect(items(layer)?.filter(([id]) => id === "m3" || id === "c1")).toEqual([["m3", "sent"]]);
    expect(selectChat(KEY)(layer.store.getState())?.items.at(-1)?.leadWaiting).toBe("The lead is starting; it reads this first.");
  });

  it("a timeout retries once in the call, then waits as unanswered and goes again on reconnect, same id", async () => {
    const { fake, layer } = await connected();
    const out = layer.chat.send(KEY, { text: "do it" }, "c1");
    fake.of("chat_send")[0]?.answer(err("timeout"));
    await vi.waitFor(() => expect(fake.of("chat_send")).toHaveLength(2));
    fake.of("chat_send")[1]?.answer(err("timeout"));
    expect(await out).toBe("pending");
    expect(items(layer)?.at(-1)).toEqual(["c1", "unanswered"]);
    fake.send({ t: "state", state: { phase: "connecting", hub: "devbox:4710", attempt: 1 } });
    fake.send(live());
    fake.send(snapshot(9));
    await vi.waitFor(() => expect(fake.of("chat_send")).toHaveLength(3));
    expect(fake.of("chat_send").map((c) => c.input["clientRequestId"])).toEqual(["c1", "c1", "c1"]);
  });

  it("sending from a window paged above the latest keeps the person's message, even when the jump's page lacks it", async () => {
    const { fake, layer } = await connected();
    layer.store.setState((s) => {
      const chat = s.chats[KEY];
      return chat === undefined ? s : { ...s, chats: { ...s.chats, [KEY]: { ...chat, hasNewer: true } } };
    });
    const out = layer.chat.send(KEY, { text: "do it" }, "c1");
    // The jump's read went out before chat_send, so its page doesn't have the message.
    const jump = fake.of("chat_history").at(-1);
    expect(jump?.input).toMatchObject({ limit: 50 });
    const mine = msg(3, { author: "human", text: "do it", clientRequestId: "c1" });
    fake.send(messageEvent(2, mine));
    fake.of("chat_send")[0]?.answer({ ok: true, output: { message: mine } });
    expect(await out).toBe("sent");
    jump?.answer(page([msg(1), msg(2)]));
    await vi.waitFor(() => expect(items(layer)).toEqual([["m1", "sent"], ["m2", "sent"], ["m3", "sent"]]));
  });

  it("a cut-off waits as reconnecting; a snapshot while the link stayed up resends nothing", async () => {
    const { fake, layer } = await connected();
    const out = layer.chat.send(KEY, { text: "nvm" }, "c1");
    fake.of("chat_send")[0]?.answer(err("disconnected"));
    expect(await out).toBe("pending");
    expect(items(layer)?.at(-1)).toEqual(["c1", "reconnecting"]);
    fake.send(snapshot(9));
    await Promise.resolve();
    expect(fake.of("chat_send")).toHaveLength(1);
  });

  it("offline, a message is queued under its own id and goes, once, when the link is back", async () => {
    const { fake, layer } = await connected();
    fake.send({ t: "state", state: { phase: "retrying", hub: "devbox:4710", reason: "closed", retryAt: 1 } });
    expect(await layer.chat.send(KEY, { text: "hold the release" }, "c1")).toBe("pending");
    expect(fake.of("chat_send")).toHaveLength(0);
    expect(items(layer)?.at(-1)).toEqual(["c1", "queued"]);
    // A resend by hand while still offline only keeps it queued.
    await layer.chat.retry(KEY, "c1");
    expect(fake.of("chat_send")).toHaveLength(0);
    fake.send({ t: "state", state: { phase: "connecting", hub: "devbox:4710", attempt: 1 } });
    fake.send(live());
    fake.send(snapshot(9));
    await vi.waitFor(() => expect(fake.of("chat_send")).toHaveLength(1));
    expect(fake.of("chat_send")[0]?.input).toMatchObject({ clientRequestId: "c1", text: "hold the release" });
    const mine = msg(3, { author: "human", text: "hold the release", clientRequestId: "c1" });
    fake.of("chat_send")[0]?.answer({ ok: true, output: { message: mine } });
    await vi.waitFor(() => expect(items(layer)?.some(([id]) => id === "c1")).toBe(false));
    // A later snapshot has nothing left to send.
    fake.send(snapshot(10));
    await Promise.resolve();
    expect(fake.of("chat_send")).toHaveLength(1);
  });

  it("a call that finds no hub queues the message, and the next snapshot sends it even with no drop seen", async () => {
    const { fake, layer } = await connected();
    const out = layer.chat.send(KEY, { text: "hello" }, "c1");
    fake.of("chat_send")[0]?.answer(err("offline"));
    expect(await out).toBe("pending");
    expect(items(layer)?.at(-1)).toEqual(["c1", "queued"]);
    fake.send(snapshot(9));
    await vi.waitFor(() => expect(fake.of("chat_send")).toHaveLength(2));
    expect(fake.of("chat_send")[1]?.input["clientRequestId"]).toBe("c1");
  });

  it("a refusal fails and keeps its row until discarded", async () => {
    const { fake, layer } = await connected();
    const refused = layer.chat.send(KEY, { text: "x".repeat(10) }, "c2");
    fake.of("chat_send")[0]?.answer(err("invalid"));
    expect(await refused).toBe("failed");
    expect(items(layer)?.at(-1)).toEqual(["c2", "failed"]);
    layer.chat.discard(KEY, "c2");
    expect(items(layer)?.some(([id]) => id === "c2")).toBe(false);
  });
});

describe("stopping the lead", () => {
  it("asks once per connection whether the hub can, with an input that runs nothing", async () => {
    const { fake, layer } = await connected();
    layer.chat.probeStop();
    layer.chat.probeStop();
    expect(fake.of("chat_stop").map((c) => c.input)).toEqual([{}]);
    fake.of("chat_stop")[0]?.answer(err("invalid"));
    await vi.waitFor(() => expect(selectCanStop(layer.store.getState())).toBe(true));
    layer.chat.probeStop();
    expect(fake.of("chat_stop")).toHaveLength(1);
    // A new connection may be a different hub: it asks again.
    fake.send(snapshot(9));
    expect(selectCanStop(layer.store.getState())).toBe(false);
    layer.chat.probeStop();
    expect(fake.of("chat_stop")).toHaveLength(2);
  });

  it("has no Stop on a hub without the tool, or for a key that may not stop leads", async () => {
    for (const code of ["not_found", "forbidden"]) {
      const { fake, layer } = await connected();
      layer.chat.probeStop();
      fake.of("chat_stop")[0]?.answer(err(code));
      await vi.waitFor(() => expect(layer.store.getState().chatStop).toBe(false));
    }
  });

  it("a dropped link leaves it unknown until the next connection", async () => {
    const { fake, layer } = await connected();
    layer.chat.probeStop();
    fake.of("chat_stop")[0]?.answer(err("disconnected"));
    await Promise.resolve();
    await Promise.resolve();
    expect(layer.store.getState().chatStop).toBeUndefined();
    layer.chat.probeStop();
    expect(fake.of("chat_stop")).toHaveLength(1);
  });

  it("stops the lead's turn, and its line shows once though the event carries it too", async () => {
    const { fake, layer } = await connected();
    const out = layer.chat.stop(KEY);
    const call = fake.of("chat_stop")[0];
    expect(call?.input).toMatchObject({ projectRef: ref, clientRequestId: expect.any(String) as unknown });
    const line = msg(3, { author: "system", text: "Stopped the lead." });
    call?.answer({ ok: true, output: { stopped: true, message: line } });
    expect(await out).toEqual({ t: "stopped" });
    fake.send(messageEvent(2, line));
    expect(items(layer)).toEqual([["m1", "sent"], ["m2", "sent"], ["m3", "sent"]]);
  });

  it("says when the lead wasn't working, when the hub can't, and why it failed", async () => {
    const { fake, layer } = await connected();
    const idle = layer.chat.stop(KEY);
    fake.of("chat_stop")[0]?.answer({ ok: true, output: { stopped: false, message: msg(3, { author: "system", text: "The lead wasn't working; nothing to stop." }) } });
    expect(await idle).toEqual({ t: "idle" });
    const none = layer.chat.stop(KEY);
    fake.of("chat_stop")[1]?.answer(err("not_found"));
    expect(await none).toEqual({ t: "unsupported" });
    expect(layer.store.getState().chatStop).toBe(false);
    const failed = layer.chat.stop(KEY);
    fake.of("chat_stop")[2]?.answer(err("timeout"));
    expect(await failed).toEqual({ t: "failed", error: { code: "timeout", message: "timeout" } });
  });

  it("takes Stop away from a key the hub won't let stop the lead", async () => {
    const { fake, layer } = await connected();
    layer.chat.probeStop();
    fake.of("chat_stop")[0]?.answer(err("invalid"));
    await vi.waitFor(() => expect(selectCanStop(layer.store.getState())).toBe(true));
    const refused = layer.chat.stop(KEY);
    fake.of("chat_stop")[1]?.answer(err("forbidden"));
    expect(await refused).toMatchObject({ t: "failed" });
    expect(selectCanStop(layer.store.getState())).toBe(false);
  });
});
