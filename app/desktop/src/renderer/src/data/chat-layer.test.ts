import { afterEach, describe, expect, it, vi } from "vitest";
import type { HubError, HubFrame } from "../../../shared/hub";
import type { ChatMessage } from "./chat-contract";
import { live, snapshot } from "./fixtures.test-util";
import { createDataLayer, type HubApi } from "./queries";
import { selectChat, selectNeedsYou } from "./selectors";

type Answer = { ok: true; output: unknown } | { ok: false; error: HubError };

const fakeHub = () => {
  let listener: (frame: HubFrame) => void = () => undefined;
  const calls: { tool: string; input: Record<string, unknown>; answer: (a: Answer) => void }[] = [];
  const hub: HubApi = {
    call: (tool, input) =>
      new Promise((resolve) => calls.push({ tool, input: input as Record<string, unknown>, answer: resolve })),
    subscribe: (l) => ((listener = l), () => undefined),
    resync: () => Promise.resolve(),
    live: () => Promise.resolve(),
  };
  const of = (tool: string) => calls.filter((c) => c.tool === tool);
  return { hub, send: (f: HubFrame) => listener(f), calls, of };
};

const KEY = "devbox/storefront";
const ref = { machineId: "devbox", projectId: "storefront" };
const msg = (seq: number, patch: Partial<ChatMessage> = {}): ChatMessage => ({
  messageId: `m${seq}`,
  projectRef: ref,
  seq,
  author: "lead",
  kind: "message",
  text: `message ${seq}`,
  createdAt: "2026-10-19T10:00:00.000Z",
  ...patch,
});
const chatEvent = (seq: number, type: string, data: unknown): HubFrame => ({
  t: "event",
  event: { seq, at: "2026-10-19T10:00:00.000Z", type, summary: type, data },
});
const page = (messages: ChatMessage[], patch: Record<string, unknown> = {}): Answer => ({
  ok: true,
  output: { messages, hasOlder: false, needsYou: false, ...patch },
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
  fake.of("chat_history")[0]?.answer(page([msg(1), msg(2)], { hasOlder: true, needsYou: true }));
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
    expect(fake.of("chat_history").map((c) => c.input["beforeSeq"])).toEqual([undefined, 1]);
    fake.of("chat_history")[1]?.answer(page([msg(0)]));
    await vi.waitFor(() => expect(selectChat(KEY)(layer.store.getState())?.hasOlder).toBe(false));
    expect(items(layer)).toEqual([
      ["m0", "sent"],
      ["m1", "sent"],
      ["m2", "sent"],
    ]);
  });

  it("a reconnect shows the skeleton, reads the chat again and drops the old connection's late answer", async () => {
    const { fake, layer } = await connected();
    layer.chat.loadOlder(KEY);
    fake.send({ t: "state", state: { phase: "retrying", hub: "devbox:4790", reason: "closed", retryAt: 1 } });
    expect(selectChat(KEY)(layer.store.getState())).toBeUndefined();
    fake.send(live());
    fake.send(snapshot(5));
    fake.of("chat_history")[1]?.answer(page([msg(0)]));
    await Promise.resolve();
    expect(fake.of("chat_history")).toHaveLength(3);
    fake.of("chat_history")[2]?.answer(page([msg(1), msg(2), msg(3)]));
    await vi.waitFor(() => expect(items(layer)).toEqual([["m1", "sent"], ["m2", "sent"], ["m3", "sent"]]));
  });

  it("live messages and deltas merge without duplicates; a gap reads the latest page again", async () => {
    const { fake, layer } = await connected();
    fake.send(chatEvent(2, "chat.message", { message: msg(3, { streaming: true, text: "" }) }));
    fake.send(chatEvent(3, "chat.delta", { projectRef: ref, messageId: "m3", offset: 0, append: "Looking" }));
    fake.send(chatEvent(3, "chat.delta", { projectRef: ref, messageId: "m3", offset: 0, append: "Looking" }));
    expect(selectChat(KEY)(layer.store.getState())?.items.at(-1)).toMatchObject({ id: "m3", text: "Looking", state: "streaming" });
    fake.send(chatEvent(4, "chat.delta", { projectRef: ref, messageId: "m3", offset: 50, append: "!" }));
    await Promise.resolve();
    expect(fake.of("chat_history")).toHaveLength(2);
    fake.of("chat_history")[1]?.answer(page([msg(2), msg(3, { text: "Looking at it now", updatedAt: "2026-10-19T10:01:00.000Z" })]));
    await vi.waitFor(() => expect(items(layer)).toEqual([["m1", "sent"], ["m2", "sent"], ["m3", "sent"]]));
  });
});

describe("sending", () => {
  it("shows at once, settles on the echo event first, and the late answer adds nothing", async () => {
    const { fake, layer } = await connected();
    const out = layer.chat.send(KEY, { text: "1 go, 2 rec" }, "c1");
    expect(items(layer)?.at(-1)).toEqual(["c1", "pending"]);
    expect(fake.of("chat_send")[0]?.input).toMatchObject({ clientRequestId: "c1", text: "1 go, 2 rec", projectRef: ref });
    const mine = msg(3, { author: "human", text: "1 go, 2 rec", clientRequestId: "c1" });
    fake.send(chatEvent(2, "chat.message", { message: mine }));
    expect(items(layer)?.at(-1)).toEqual(["m3", "sent"]);
    expect(selectNeedsYou(KEY)(layer.store.getState())).toBe(false);
    fake.of("chat_send")[0]?.answer({ ok: true, output: { message: mine } });
    expect(await out).toBe("sent");
    expect(items(layer)?.filter(([id]) => id === "m3" || id === "c1")).toEqual([["m3", "sent"]]);
  });

  it("a timeout retries once in the call, then waits as unanswered and goes again on reconnect, same id", async () => {
    const { fake, layer } = await connected();
    const out = layer.chat.send(KEY, { text: "do it" }, "c1");
    fake.of("chat_send")[0]?.answer(err("timeout"));
    await vi.waitFor(() => expect(fake.of("chat_send")).toHaveLength(2));
    fake.of("chat_send")[1]?.answer(err("timeout"));
    expect(await out).toBe("pending");
    expect(items(layer)?.at(-1)).toEqual(["c1", "unanswered"]);
    fake.send({ t: "state", state: { phase: "connecting", hub: "devbox:4790", attempt: 1 } });
    fake.send(live());
    fake.send(snapshot(9));
    await vi.waitFor(() => expect(fake.of("chat_send")).toHaveLength(3));
    expect(fake.of("chat_send").map((c) => c.input["clientRequestId"])).toEqual(["c1", "c1", "c1"]);
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

  it("no hub on a first try leaves no row; a refusal fails and keeps its row until discarded", async () => {
    const { fake, layer } = await connected();
    const offline = layer.chat.send(KEY, { text: "hello" }, "c1");
    fake.of("chat_send")[0]?.answer(err("offline"));
    expect(await offline).toBe("offline");
    expect(items(layer)?.some(([id]) => id === "c1")).toBe(false);
    const refused = layer.chat.send(KEY, { text: "x".repeat(10) }, "c2");
    fake.of("chat_send")[1]?.answer(err("invalid"));
    expect(await refused).toBe("failed");
    expect(items(layer)?.at(-1)).toEqual(["c2", "failed"]);
    layer.chat.discard(KEY, "c2");
    expect(items(layer)?.some(([id]) => id === "c2")).toBe(false);
    fake.send({ t: "state", state: { phase: "connecting", hub: "devbox:4790", attempt: 1 } });
    expect(await layer.chat.send(KEY, { text: "later" }, "c3")).toBe("offline");
  });
});
