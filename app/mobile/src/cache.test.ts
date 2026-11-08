import { describe, expect, it } from "vitest";
import { cachedOf, parseCached, withCached } from "./cache";
import type { ChatSend } from "./desktop";
import { initial } from "./store";

const HUB = "http://devbox:4790";
const REF = { machineId: "m1", projectId: "navi" };
const hub = { phase: "connecting", hub: HUB, attempt: 0 } as const;
const row = (clientRequestId: string, state: ChatSend["state"]): ChatSend => ({ clientRequestId, text: "hi", attachments: [], at: "2026-10-28T10:00:00Z", state });

describe("the cache", () => {
  it("keeps a send that was on its way as one that may have reached the hub, and a failed one to try again", () => {
    const s = { ...initial(hub), sends: { "m1/navi": [row("a", { t: "sending" }), row("b", { t: "failed", error: { code: "x", message: "No." } }), row("c", { t: "queued" })] } };
    expect(cachedOf(HUB, s).sends["m1/navi"]?.map((r) => [r.clientRequestId, r.state.t, r.reached === true])).toEqual([
      ["a", "reconnecting", true],
      ["b", "failed", false],
      ["c", "queued", false],
    ]);
  });

  it("shows no lead working until the hub says so again", () => {
    const kept = cachedOf(HUB, { ...initial(hub), projects: {}, chatStates: { "m1/navi": { projectRef: REF, lastSeq: 3, leadWorking: true, needsYou: true } } });
    expect(withCached(initial(hub), kept).chatStates["m1/navi"]).toMatchObject({ leadWorking: false, needsYou: true, lastSeq: 3 });
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
});
