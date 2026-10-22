import { afterEach, describe, expect, it, vi } from "vitest";
import type { HubError, HubFrame } from "../../../shared/hub";
import { CACHE_CHATS, decodeCache, encodeCache, restoreCache, toCache, type HubCache } from "./cache";
import { emptyChat, type ChatSend } from "./chat";
import type { ChatMessage } from "./chat-contract";
import { AT, live, snapshot } from "./fixtures.test-util";
import { createDataLayer, type HubApi } from "./queries";
import { selectChat, selectOfflineAsOf, selectShownProjects } from "./selectors";
import { initialState, type DataState } from "./store";
import { toSidebar } from "../../screens/shell/model";

const HUB = "devbox:4710";
const KEY = "devbox/storefront";
const ref = { machineId: "devbox", projectId: "storefront" };
const msg = (seq: number, patch: Partial<ChatMessage> = {}): ChatMessage => ({
  messageId: `m${seq}`,
  projectRef: ref,
  seq,
  author: "lead",
  state: "final",
  text: `message ${seq}`,
  createdAt: AT,
  ...patch,
});
const send = (id: string, state: ChatSend["state"]): ChatSend => ({ clientRequestId: id, text: `words ${id}`, attachments: [], at: AT, state });
const project = (projectId: string) => ({
  machineId: "devbox",
  projectId,
  title: projectId,
  workspaceRoot: `/srv/${projectId}`,
  lastActivityAt: AT,
  threads: { running: 0, waiting: 0, idle: 0, failed: 0 },
});
const AS_OF = "2026-10-19T09:02:00.000Z";
const cache = (patch: Partial<HubCache> = {}): HubCache => ({
  version: 1,
  hub: HUB,
  asOf: AS_OF,
  projects: [project("storefront")],
  chatStates: [{ projectRef: ref, lastSeq: 2, leadWorking: true, needsYou: true }],
  chats: [{ key: KEY, messages: [msg(1), msg(2)], hasOlder: true }],
  sends: { [KEY]: [send("c1", { t: "reconnecting" }), send("c2", { t: "failed", error: { code: "invalid", message: "x" } })] },
  ...patch,
});

describe("the disk cache", () => {
  it("keeps the chat on screen first, then the most active, each to its newest page", () => {
    const keys = Array.from({ length: CACHE_CHATS + 2 }, (_, i) => `p${String(i)}`);
    const base = initialState();
    const s: DataState = {
      ...base,
      fresh: true,
      hub: { phase: "live", hub: HUB, protocol: 1 },
      projects: Object.fromEntries(keys.map((k) => [`devbox/${k}`, project(k)])),
      chats: Object.fromEntries(
        keys.map((k, i) => [
          `devbox/${k}`,
          {
            ...emptyChat,
            loaded: true,
            // p0 is the oldest; p7 the newest.
            messages: Array.from({ length: 80 }, (_, n) => msg(n, { createdAt: new Date(Date.parse(AT) + i * 60_000 + n).toISOString() })),
          },
        ]),
      ),
    };
    const out = toCache(s, HUB, Date.parse(AT), "devbox/p0");
    expect(out?.chats.map((c) => c.key)).toEqual(["devbox/p0", "devbox/p7", "devbox/p6", "devbox/p5", "devbox/p4", "devbox/p3"]);
    expect(out?.chats[0]?.messages).toHaveLength(50);
    expect(out?.chats[0]?.messages.at(-1)?.seq).toBe(79);
    expect(out?.chats[0]?.hasOlder).toBe(true);
    // Current while fresh: as of now.
    expect(out?.asOf).toBe(AT);
  });

  it("is written only with projects to show, and is cut to fit", () => {
    expect(toCache(initialState(), HUB, 0, null)).toBeUndefined();
    const huge = cache({ chats: Array.from({ length: 6 }, (_, i) => ({ key: `devbox/p${String(i)}`, messages: [msg(1, { text: "x".repeat(600_000) })], hasOlder: false })) });
    const text = encodeCache(huge);
    expect(text).toBeDefined();
    expect(decodeCache(text ?? "")?.chats.length).toBeLessThan(6);
    expect(decodeCache("{")).toBeUndefined();
    expect(decodeCache(JSON.stringify({ ...cache(), version: 2 }))).toBeUndefined();
  });

  it("restores the projects, chats and waiting messages, marked as of when they were current", () => {
    const s = restoreCache(initialState(), cache());
    expect(selectOfflineAsOf(s)).toBe(Date.parse(AS_OF));
    expect(selectShownProjects(s)).toMatchObject([{ key: KEY, needsYou: true, running: 0, working: false }]);
    const view = selectChat(KEY)(s);
    expect(view).toMatchObject({ held: true, asOf: Date.parse(AS_OF), hasOlder: true });
    // A cut-off message comes back queued, to go when the link is back; a refused one stays refused.
    expect(view?.items.map((i) => [i.id, i.state])).toEqual([
      ["m1", "sent"],
      ["m2", "sent"],
      ["c1", "queued"],
      ["c2", "failed"],
    ]);
  });

  it("keeps the sidebar's marks as last known: what waits on you, and the newest message for unread", () => {
    const s = restoreCache(initialState(), cache({ openRequests: [{ projectRef: ref, kind: "approval", state: "open" }] }));
    const rows = toSidebar(selectShownProjects(s), { requests: s.openRequests, seen: { [KEY]: 1 } });
    expect(rows).toMatchObject([{ want: { word: "approve", count: 1 }, unread: true }]);
    // And they go back on disk with the rest.
    expect(toCache(s, HUB, 0, null)?.openRequests).toEqual([{ projectRef: ref, kind: "approval", state: "open" }]);
  });

  it("never replaces data this window already holds", () => {
    const held = { ...initialState(), projects: { "devbox/api": project("api") } };
    expect(restoreCache(held, cache())).toBe(held);
    const fresh = { ...initialState(), fresh: true };
    expect(restoreCache(fresh, cache())).toBe(fresh);
  });
});

type Answer = { ok: true; output: unknown } | { ok: false; error: HubError };

describe("the layer and the cache", () => {
  afterEach(() => vi.useRealTimers());

  it("a launch with no hub shows the cache; the first connection sends the queued message and writes the cache back", async () => {
    vi.useFakeTimers();
    let listener: (frame: HubFrame) => void = () => undefined;
    const calls: { tool: string; input: Record<string, unknown>; answer: (a: Answer) => void }[] = [];
    const written: string[] = [];
    const hub: HubApi = {
      call: (tool, input) => new Promise((resolve) => calls.push({ tool, input: input as Record<string, unknown>, answer: resolve })),
      subscribe: (l) => ((listener = l), () => undefined),
      resync: () => Promise.resolve(),
      live: () => Promise.resolve(),
      chat: () => Promise.resolve(),
      cache: {
        read: () => Promise.resolve(JSON.stringify(cache({ sends: { [KEY]: [send("c1", { t: "queued" })] } }))),
        write: (text) => {
          written.push(text);
          return Promise.resolve();
        },
      },
    };
    const layer = createDataLayer(hub, () => Date.parse(AT));
    layer.start();
    listener({ t: "state", state: { phase: "retrying", hub: HUB, reason: "closed", retryAt: 1 } });
    await vi.waitFor(() => expect(selectChat(KEY)(layer.store.getState())?.held).toBe(true));
    expect(calls).toHaveLength(0);
    listener(live());
    listener(snapshot(1));
    await vi.waitFor(() => expect(calls.filter((c) => c.tool === "chat_send")).toHaveLength(1));
    expect(calls.find((c) => c.tool === "chat_send")?.input).toMatchObject({ clientRequestId: "c1", text: "words c1" });
    vi.advanceTimersByTime(3_000);
    const last = decodeCache(written.at(-1) ?? "");
    expect(last?.hub).toBe(HUB);
    expect(last?.asOf).toBe(AT);
  });

  it("Forget drops what the window holds, queued messages included: none shows, goes or is written for the next hub", async () => {
    vi.useFakeTimers();
    let listener: (frame: HubFrame) => void = () => undefined;
    const calls: { tool: string; input: Record<string, unknown>; answer: (a: Answer) => void }[] = [];
    const written: string[] = [];
    const hub: HubApi = {
      call: (tool, input) => new Promise((resolve) => calls.push({ tool, input: input as Record<string, unknown>, answer: resolve })),
      subscribe: (l) => ((listener = l), () => undefined),
      resync: () => Promise.resolve(),
      live: () => Promise.resolve(),
      chat: () => Promise.resolve(),
      cache: {
        read: () => Promise.resolve(JSON.stringify(cache({ sends: { [KEY]: [send("c1", { t: "queued" })] }, openRequests: [{ projectRef: ref, kind: "approval", state: "open" }] }))),
        write: (text) => {
          written.push(text);
          return Promise.resolve();
        },
      },
    };
    const layer = createDataLayer(hub, () => Date.parse(AT));
    layer.start();
    listener({ t: "state", state: { phase: "retrying", hub: HUB, reason: "closed", retryAt: 1 } });
    await vi.waitFor(() => expect(selectShownProjects(layer.store.getState())).toHaveLength(1));
    expect(layer.store.getState().openRequests).toHaveLength(1);
    layer.chat.open(KEY);
    void layer.chat.send(KEY, { text: "typed offline" }, "c2");
    expect(layer.store.getState().chatSends[KEY]).toHaveLength(2);

    listener({ t: "state", state: { phase: "unpaired" } });
    const forgot = layer.store.getState();
    expect(selectShownProjects(forgot)).toBeUndefined();
    expect(selectChat(KEY)(forgot)).toBeUndefined();
    expect(forgot).toMatchObject({ projects: {}, chats: {}, chatStates: {}, chatSends: {} });
    expect(forgot.asOf).toBeUndefined();
    expect(forgot.openRequests).toBeUndefined();

    // Another hub paired: its first snapshot sends nothing of the old hub's, and its cache holds none of it.
    const other = "other:4790";
    listener({ t: "state", state: { phase: "connecting", hub: other, attempt: 0 } });
    listener({ t: "state", state: { phase: "live", hub: other, protocol: 1 } });
    listener(snapshot(1));
    await Promise.resolve();
    expect(calls.filter((c) => c.tool === "chat_send")).toHaveLength(0);
    vi.advanceTimersByTime(3_000);
    const last = decodeCache(written.at(-1) ?? "");
    expect(last?.hub).toBe(other);
    expect(last?.sends).toEqual({});
    expect(written.every((t) => decodeCache(t)?.hub !== other || Object.keys(decodeCache(t)?.sends ?? {}).length === 0)).toBe(true);
  });

  it("pairing another hub without Forget drops the old hub's held data too", () => {
    let listener: (frame: HubFrame) => void = () => undefined;
    const fake: HubApi = { call: () => new Promise(() => undefined), subscribe: (l) => ((listener = l), () => undefined), resync: () => Promise.resolve(), live: () => Promise.resolve(), chat: () => Promise.resolve() };
    const second = createDataLayer(fake);
    second.start();
    listener({ t: "state", state: { phase: "retrying", hub: HUB, reason: "closed", retryAt: 1 } });
    second.store.setState((s) => restoreCache(s, cache()), true);
    expect(selectShownProjects(second.store.getState())).toHaveLength(1);
    listener({ t: "state", state: { phase: "connecting", hub: "other:4790", attempt: 0 } });
    expect(second.store.getState()).toMatchObject({ projects: {}, chats: {}, chatSends: {} });
    // The same hub retrying keeps it.
    listener({ t: "state", state: { phase: "retrying", hub: "other:4790", reason: "closed", retryAt: 2 } });
    second.store.setState((s) => restoreCache(s, cache()), true);
    listener({ t: "state", state: { phase: "connecting", hub: "other:4790", attempt: 1 } });
    expect(selectShownProjects(second.store.getState())).toHaveLength(1);
  });
});
