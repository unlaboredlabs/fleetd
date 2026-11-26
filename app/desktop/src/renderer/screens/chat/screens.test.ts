import { describe, expect, it } from "vitest";
import type { ChatItem } from "../../src/data/chat";
import type { BrowserSession, SessionState } from "../sessions/model";
import { chatRows, type Row } from "./model";
import { askStrip, cardView } from "./screens";
import { withScreens } from "./screenRows";

const at = (d: number, h: number, m = 0) => new Date(Date.UTC(2026, 9, d, h, m)).toISOString();
const NOW = Date.parse(at(19, 18));
const item = (id: string, author: ChatItem["author"], time: string): ChatItem => ({ id, author, kind: "message", text: `text ${id}`, at: time, attachments: [], state: "sent" });
const rows = (items: ChatItem[], hasOlder = false) => chatRows({ items, hasOlder, loadingOlder: false, nowMs: NOW, timeZone: "UTC" });
const keys = (r: readonly Row[]) => r.map((x) => x.key);

const session = (id: string, state: SessionState, more: Partial<BrowserSession> = {}): BrowserSession => ({
  id,
  projectRef: { machineId: "devbox", projectId: "grokdemo" },
  agent: { laneId: "lead:devbox/grokdemo", title: "Lead", role: "lead" },
  purpose: "Read Wikipedia's Web browser intro",
  state,
  startedAt: at(19, 9),
  actions: [],
  ...more,
});

describe("a screen's card in the chat", () => {
  const items = [item("a", "human", at(18, 9)), item("b", "lead", at(19, 9)), item("c", "lead", at(19, 10))];

  it("stands where the screen opened: after the last message before it, above the day line over the next", () => {
    const out = withScreens(rows(items), [{ id: "s1", at: at(18, 12), live: false }], { hasOlder: false, newer: false });
    expect(keys(out)).toEqual(["top", expect.stringMatching(/^day:/u), "a", "screen:s1", expect.stringMatching(/^day:/u), "b", "c"]);
  });

  it("stands at the end while the lead browses, after the newest message, live or ended", () => {
    const out = withScreens(rows(items), [{ id: "s2", at: at(19, 11), live: true }, { id: "s1", at: at(19, 9, 30), live: false }], { hasOlder: false, newer: false });
    expect(keys(out).slice(-4)).toEqual(["b", "screen:s1", "c", "screen:s2"]);
  });

  it("waits for its page when it opened before the oldest message loaded, and older pages exist", () => {
    const early = [{ id: "s0", at: at(17, 9), live: false }];
    expect(keys(withScreens(rows(items, true), early, { hasOlder: true, newer: false }))).not.toContain("screen:s0");
    expect(keys(withScreens(rows(items), early, { hasOlder: false, newer: false }))).toContain("screen:s0");
  });

  it("in a window far back, leaves what opened after its last row to the next page", () => {
    const out = withScreens(rows(items), [{ id: "s3", at: at(19, 11), live: true }], { hasOlder: false, newer: true });
    expect(keys(out)).not.toContain("screen:s3");
  });

  it("keeps the same rows when the bot has no screens", () => {
    const r = rows(items);
    expect(withScreens(r, [], { hasOlder: false, newer: false })).toBe(r);
  });
});

describe("what a screen's card says", () => {
  it("names the lead's screen by the bot, and says what it does now, with Watch", () => {
    const card = cardView(session("s", "running", { now: "Reading Web browser – Wikipedia" }), "grokdemo", NOW);
    expect(card).toMatchObject({ title: "grokdemo’s browser", state: "live", line: "Reading Web browser – Wikipedia", action: "watch", asking: false });
  });

  it("while it asks: that it needs you, why, and Take over", () => {
    const card = cardView(session("s", "asking", { handoff: { reason: "Scroll it to the bottom, then hand it back.", at: 0 } }), "grokdemo", NOW);
    expect(card).toMatchObject({ title: "grokdemo’s browser", state: "needs you", tone: "warning", line: "Scroll it to the bottom, then hand it back.", action: "takeOver" });
  });

  it("names an agent's screen by its agent, and yours as yours", () => {
    expect(cardView(session("s", "running", { agent: { laneId: "T9", title: "Checkout QA", role: "qa" } }), "grokdemo", NOW).title).toBe("Browser · Checkout QA");
    expect(cardView(session("s", "yours", { openedBy: "Ada", kind: "android" }), "grokdemo", NOW)).toMatchObject({ title: "Your Android emulator", state: "you’re in control" });
  });

  it("once ended: how long it ran, what it was for, and Replay; none while it saves or once its recording is gone", () => {
    const ended = session("s", "ended", { endedAt: at(19, 9, 2) });
    expect(cardView(ended, "grokdemo", NOW)).toMatchObject({ state: "Ended · 2:00", line: "Read Wikipedia's Web browser intro", action: "replay", live: false });
    expect(cardView({ ...ended, state: "saving" }, "grokdemo", NOW)).toMatchObject({ line: "Saving the recording", action: "none" });
    expect(cardView({ ...ended, state: "lost", note: "The machine went away." }, "grokdemo", NOW)).toMatchObject({ state: "Recording lost", tone: "danger", action: "none" });
  });
});

describe("the strip over the composer", () => {
  it("shows the oldest screen asking for you, and how many more ask", () => {
    const strip = askStrip(
      [session("late", "asking", { startedAt: at(19, 10) }), session("live", "running"), session("early", "asking", { startedAt: at(19, 9), kind: "android", agent: { laneId: "T9", title: "Checkout QA", role: "qa" } })],
      "grokdemo",
    );
    expect(strip).toMatchObject({ title: "Checkout QA needs you", more: 1 });
    expect(strip?.session.id).toBe("early");
  });

  it("is gone while nothing asks", () => {
    expect(askStrip([session("a", "running"), session("b", "ended")], "grokdemo")).toBeUndefined();
  });
});
