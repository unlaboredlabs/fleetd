import { describe, expect, it } from "vitest";
import type { HubEvent, HubState } from "../../desktop";
import { countValue, dmsShown, glyphOf, joinPages, opening, outcomeWord, route, rowLabel, rowOutcome, touchesDms, withNewest, withOlder, type AgentMessage, type DmReceipt } from "./model";

const AT = "2026-11-08T23:04:00.000Z";
const P = { machineId: "devbox", projectId: "fleetd" };

const to = (taskId: string, outcome: DmReceipt["outcome"], extra: Partial<DmReceipt> = {}): DmReceipt => ({ taskId, outcome, ...extra });
const dm = (id: string, recipients: DmReceipt[], text = "The iOS close code is 1012 now: a stopping hub closes node links as a restart."): AgentMessage => ({
  id,
  from: { taskId: "T2573", title: "Phone redials fast on restart" },
  text,
  sentAt: AT,
  to: recipients,
});

const event = (type: string, extra: Partial<HubEvent> = {}): HubEvent => ({ at: AT, seq: 1, summary: "", type, ...extra }) as HubEvent;

describe("a project's DMs between agents", () => {
  it("shows only on a hub that keeps them", () => {
    expect(dmsShown({ phase: "live", features: ["agent_messages"] } as unknown as HubState)).toBe(true);
    expect(dmsShown({ phase: "live", features: ["artifacts"] } as unknown as HubState)).toBe(false);
    expect(dmsShown({ phase: "connecting" } as unknown as HubState)).toBe(false);
  });

  it("names who wrote to whom, and its opening words on one line", () => {
    expect(route(dm("M1", [to("T2577", "delivered"), to("T2580", "held")]))).toBe("T2573 → T2577, T2580");
    expect(opening("  Sidebar.tsx\n\nis mine until\t#1353 lands. ")).toBe("Sidebar.tsx is mine until #1353 lands.");
    expect(opening("x".repeat(1000))).toHaveLength(300);
  });

  it("says what became of it in a word or three", () => {
    expect(outcomeWord("delivered")).toBe("Delivered");
    expect(outcomeWord("held")).toBe("Held");
    expect(outcomeWord("woke")).toBe("Woke it");
    expect(outcomeWord("not_woken")).toBe("Didn't wake it");
    expect(outcomeWord("refused")).toBe("Not sent");
    // A word a newer hub adds shows as the hub names it.
    expect(outcomeWord("timed_out")).toBe("Timed out");
  });

  it("gives one outcome when every recipient fared alike, else each with whom", () => {
    expect(rowOutcome(dm("M1", [to("T2577", "delivered")]))).toBe("Delivered");
    expect(rowOutcome(dm("M1", [to("T2577", "woke"), to("T2580", "woke")]))).toBe("Woke them");
    expect(rowOutcome(dm("M1", [to("T2577", "not_woken"), to("T2580", "not_woken")]))).toBe("Didn't wake them");
    expect(rowOutcome(dm("M1", [to("T2577", "refused")]))).toBe("Not sent");
    expect(rowOutcome(dm("M1", [to("T2577", "delivered"), to("T2567", "not_woken"), to("T2580", "delivered")]))).toBe("Delivered to T2577, T2580 · Didn't wake T2567");
    expect(rowOutcome(dm("M1", [to("T2577", "delivered"), to("T2539", "refused")]))).toBe("Delivered to T2577 · Not sent to T2539");
    expect(rowOutcome(dm("M1", [to("T2577", "woke"), to("T2567", "held")]))).toBe("Woke T2577 · Held for T2567");
  });

  it("marks a row by what most needs a look: not sent, didn't wake, then held, then woke", () => {
    expect(glyphOf(dm("M1", [to("T1", "not_woken"), to("T2", "refused")]))).toBe("refused");
    expect(glyphOf(dm("M1", [to("T1", "delivered"), to("T2", "not_woken"), to("T3", "held")]))).toBe("notWoken");
    expect(glyphOf(dm("M1", [to("T1", "woke"), to("T3", "held")]))).toBe("held");
    expect(glyphOf(dm("M1", [to("T1", "delivered"), to("T3", "woke")]))).toBe("woke");
    expect(glyphOf(dm("M1", [to("T1", "delivered")]))).toBe("delivered");
  });

  it("reads a row out as one sentence", () => {
    expect(rowLabel(dm("M1", [to("T2577", "delivered")], "Rebased."), "23:04")).toBe("From T2573 to T2577, 23:04. Rebased. Delivered.");
    expect(rowLabel(dm("M1", [to("T2577", "not_woken")], "Rebased"), "23:04")).toBe("From T2573 to T2577, 23:04. Rebased. Didn't wake it.");
  });

  it("counts them on the Info row once there are any", () => {
    expect(countValue(undefined)).toBeUndefined();
    expect(countValue(0)).toBeUndefined();
    expect(countValue(8)).toBe("8");
  });

  it("reads again on a DM or a receipt in this project, not on a steer or another project's", () => {
    expect(touchesDms(event("agent.messaged", P), P)).toBe(true);
    expect(touchesDms(event("agent.message_updated", P), P)).toBe(true);
    expect(touchesDms(event("agent.messaged", { ...P, projectId: "storefront" }), P)).toBe(false);
    expect(touchesDms(event("agent.messaged", { ...P, machineId: "laptop" }), P)).toBe(false);
    expect(touchesDms(event("steer.queued", { ...P, data: { by: { kind: "agent", taskId: "T2573" } } }), P)).toBe(false);
    expect(touchesDms(event("chat.message", P), P)).toBe(false);
  });

  it("joins an older page without a DM twice, when a new one pushed the rest down", () => {
    const a = dm("M3", []);
    const b = dm("M2", []);
    const c = dm("M1", []);
    expect(joinPages([a, b], [b, c]).map((m) => m.id)).toEqual(["M3", "M2", "M1"]);
  });

  it("lays a fresh newest page over the whole log as shown, losing no row, as the screen reads them", () => {
    // The screen's own calls: the first read, an older page as the person scrolls, then a new DM and a receipt.
    let shown = withNewest(null, { messages: [dm("M5", [to("T1", "held")]), dm("M4", [])], more: true });
    shown = withOlder(shown, { messages: [dm("M3", []), dm("M2", [])], more: true });
    expect(shown.messages.map((m) => m.id)).toEqual(["M5", "M4", "M3", "M2"]);
    // The newest page now holds M6..M5 (M4 fell off it), M5 delivered: M4 stays, under it.
    shown = withNewest(shown, { messages: [dm("M6", []), dm("M5", [to("T1", "delivered")])], more: true });
    expect(shown.messages.map((m) => m.id)).toEqual(["M6", "M5", "M4", "M3", "M2"]);
    expect(shown.messages[1]?.to[0]?.outcome).toBe("delivered");
    expect(shown.more).toBe(true);
    // Two more DMs push M5 off the newest page too; the next older page reads from M2 and ends the log.
    shown = withNewest(shown, { messages: [dm("M8", []), dm("M7", [])], more: true });
    shown = withOlder(shown, { messages: [dm("M1", [])], more: false });
    expect(shown.messages.map((m) => m.id)).toEqual(["M8", "M7", "M6", "M5", "M4", "M3", "M2", "M1"]);
    expect(shown.more).toBe(false);
  });
});
