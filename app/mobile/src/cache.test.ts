import { describe, expect, it } from "vitest";
import { cachedOf, openChatOf, parseCached, withCached, type Cached } from "./cache";
import { emptyChat, type ChatMessage, type ChatSend, type HumanRequest } from "./desktop";
import { initial } from "./store";

const HUB = "http://devbox:4790";
const REF = { machineId: "m1", projectId: "inbox" };
const hub = { phase: "connecting", hub: HUB, attempt: 0 } as const;
const row = (clientRequestId: string, state: ChatSend["state"]): ChatSend => ({ clientRequestId, text: "hi", attachments: [], at: "2026-10-28T10:00:00Z", state });

describe("the cache", () => {
  it("keeps a send that was on its way as one that may have reached the hub, and a failed one to try again", () => {
    const s = { ...initial(hub), sends: { "m1/inbox": [row("a", { t: "sending" }), row("b", { t: "failed", error: { code: "x", message: "No." } }), row("c", { t: "queued" })] } };
    expect(cachedOf(HUB, s).sends["m1/inbox"]?.map((r) => [r.clientRequestId, r.state.t, r.reached === true])).toEqual([
      ["a", "reconnecting", true],
      ["b", "failed", false],
      ["c", "queued", false],
    ]);
  });

  it("shows no lead working until the hub says so again", () => {
    const kept = cachedOf(HUB, { ...initial(hub), projects: {}, chatStates: { "m1/inbox": { projectRef: REF, lastSeq: 3, leadWorking: true, needsYou: true } } });
    expect(withCached(initial(hub), kept).chatStates["m1/inbox"]).toMatchObject({ leadWorking: false, needsYou: true, lastSeq: 3 });
  });

  it("keeps the open approvals, so their chats open with their counts and in their place", () => {
    const open = { requestId: "Q1", projectRef: REF, kind: "approval", text: "Run it", state: "open", createdAt: "2026-10-28T10:00:00Z" } as unknown as HumanRequest;
    const kept = JSON.parse(JSON.stringify(cachedOf(HUB, { ...initial(hub), projects: {}, requests: [open] }))) as unknown;
    expect(withCached(initial(hub), parseCached(kept, HUB) as Cached).requests).toEqual([open]);
    expect(parseCached({ hub: HUB, chatStates: {}, latest: {}, sends: {} }, HUB)?.requests).toBeUndefined();
  });

  it("reads back only this hub's, of the right shape", () => {
    const kept = JSON.parse(JSON.stringify(cachedOf(HUB, { ...initial(hub), projects: {} }))) as unknown;
    expect(parseCached(kept, HUB)).toMatchObject({ hub: HUB, projects: {} });
    expect(parseCached(kept, "http://lab:4790")).toBeNull();
    expect(parseCached("nonsense", HUB)).toBeNull();
    expect(parseCached({ hub: HUB, chatStates: {}, latest: { k: "x" }, sends: {} }, HUB)?.latest).toEqual({});
  });

  it("keeps who the person is, their picture and role too, so the avatar shows at once on the next launch", () => {
    const s = { ...initial(hub), projects: {}, me: "p_1", meName: "Sam", meAvatar: "0123456789abcdef", meRole: "owner" as const };
    const kept = parseCached(JSON.parse(JSON.stringify(cachedOf(HUB, s))) as unknown, HUB);
    expect(kept).toMatchObject({ me: "p_1", meName: "Sam", meAvatar: "0123456789abcdef", meRole: "owner" });
    if (kept === null) throw new Error("not read back");
    expect(withCached(initial(hub), kept)).toMatchObject({ meAvatar: "0123456789abcdef", meRole: "owner" });
  });

  it("keeps the open chat, from a screen before what showed to its newest, and where it was scrolled to", () => {
    const m = (seq: number): ChatMessage => ({ messageId: `m${String(seq)}`, projectRef: REF, seq, author: "lead", text: `line ${String(seq)}`, attachments: [], createdAt: "2026-10-28T10:00:00Z", state: "final" });
    const chat = { ...emptyChat, messages: Array.from({ length: 200 }, (_, i) => m(i + 1)), loaded: true };
    const at = { offset: 1840, rows: 24, oldestSeq: 150 };
    const s = { ...initial(hub), projects: { "m1/inbox": { machineId: "m1", projectId: "inbox", title: "Ada" } as never }, chats: { "m1/inbox": chat } };
    const kept = parseCached(JSON.parse(JSON.stringify(cachedOf(HUB, s, { key: "m1/inbox", at }))) as unknown, HUB) as Cached;
    expect(kept.open).toMatchObject({ key: "m1/inbox", offset: 1840, rows: 24, oldestSeq: 150, hasOlder: true });
    expect(kept.open?.messages.map((x) => x.seq)).toEqual(Array.from({ length: 81 }, (_, i) => i + 120));
    // Opened as it was, until its latest page starts it over.
    expect(withCached(initial(hub), kept).chats["m1/inbox"]).toMatchObject({ cached: true, loaded: false, hasOlder: true });
    // Scrolled further back than it keeps: it opens at its newest end.
    expect(openChatOf("m1/inbox", { ...chat, messages: Array.from({ length: 900 }, (_, i) => m(i + 1)) }, { offset: 90_000, rows: 700, oldestSeq: 10 })).toMatchObject({ offset: 0, rows: 0 });
    // None open, or one with nothing in it: none kept.
    expect(cachedOf(HUB, s).open).toBeUndefined();
    expect(openChatOf("m1/inbox", emptyChat, at)).toBeUndefined();
  });
});
