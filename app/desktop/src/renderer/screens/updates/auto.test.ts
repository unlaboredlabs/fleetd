import { describe, expect, it } from "vitest";
import { autoOf, autoStatus, autoWords, whenAt, type AutoState } from "./auto";

const NOW = Date.parse("2026-11-07T15:00:00.000Z");
const READY = "0.0.0-edge.202611071430+f893086";
const OLD = "0.0.0-edge.202611071030+6d5a250";

const on = (over: Partial<AutoState> = {}): AutoState => ({
  settings: { auto: true, drainMinutes: 10 },
  at: null,
  skips: null,
  last: null,
  nextCheck: null,
  skipReason: null,
  ...over,
});
/** Each row as `label (its tone) | [state tone] state | text`. */
const texts = (auto: AutoState, ready: string | null = null) =>
  autoStatus(auto, ready, NOW, "UTC").map(
    (l) => `${l.label ?? ""}${l.labelTone === "quiet" ? "" : ` (${l.labelTone})`} | ${l.state === null ? "" : `[${l.state.tone}] ${l.state.text}`} | ${l.text}`,
  );

describe("automatic updates' words", () => {
  it("say how often and how long machines wait", () => {
    expect(autoWords(10)).toBe("New builds install by themselves as soon as they are ready, at most one update in 10 minutes, each machine once agents finish their step (10 minutes at most).");
    expect(autoWords(0)).toBe("New builds install by themselves as soon as they are ready, at most one update in 10 minutes, each machine without waiting for agents.");
  });

  it("say when, by the day", () => {
    expect(whenAt("2026-11-07T09:05:00.000Z", NOW, "UTC")).toBe("today at 09:05");
    expect(whenAt("2026-11-06T22:10:00.000Z", NOW, "UTC")).toBe("yesterday at 22:10");
    expect(whenAt("2026-11-03T08:00:00.000Z", NOW, "UTC")).toBe("Nov 3 at 08:00");
  });
});

describe("automatic updates' status", () => {
  it("off: says only someone's Update moves the hub", () => {
    expect(texts(on({ settings: { auto: false, drainMinutes: 10 } }))).toEqual([" |  | Off: the hub and its machines update only when someone presses Update."]);
  });

  it("before any: none yet, and the next look", () => {
    expect(texts(on({ nextCheck: "2026-11-07T15:10:00.000Z" }))).toEqual(["Last update |  | None yet.", "Next check |  | Today at 15:10."]);
  });

  it("the last one, then the ready build and when it goes in", () => {
    const last = { at: "2026-11-07T10:30:00.000Z", to: OLD, result: "done" };
    expect(texts(on({ last, at: "2026-11-07T15:30:00.000Z", nextCheck: "2026-11-07T15:10:00.000Z" }), READY)).toEqual([
      "Last update | [success] Updated | today at 10:30, to Edge · Nov 7, 10:30 UTC · 6d5a250.",
      "Next |  | Edge · Nov 7, 14:30 UTC · f893086, today at 15:30.",
    ]);
  });

  it("a partial or failed one, with what didn't", () => {
    const partial = { at: "2026-11-06T10:30:00.000Z", to: OLD, result: "partial", message: "mac1: offline: press Update again once it's online" };
    expect(texts(on({ last: partial }))[0]).toBe(
      "Last update | [warning] Partly updated | yesterday at 10:30, to Edge · Nov 7, 10:30 UTC · 6d5a250. mac1: offline: press Update again once it's online.",
    );
    expect(texts(on({ last: { at: "2026-11-03T10:30:00.000Z", result: "failed", message: "The download didn't match its checksum." } }))[0]).toBe(
      "Last update | [danger] Failed | Nov 3 at 10:30. The download didn't match its checksum.",
    );
  });

  it("holding back: why, and the next look rather than the build", () => {
    const held = on({ at: "2026-11-07T15:30:00.000Z", nextCheck: "2026-11-07T15:10:00.000Z", skipReason: "a person's update is still running" });
    expect(texts(held, READY).slice(1)).toEqual(["Next check |  | Today at 15:10.", "Holding back (warning) |  | A person's update is still running."]);
  });

  it("a build put back: skipped, a newer one installs", () => {
    expect(texts(on({ skips: READY, nextCheck: "2026-11-07T15:10:00.000Z" }), READY).slice(1)).toEqual([
      "Next check |  | Today at 15:10.",
      "Skips (warning) |  | Edge · Nov 7, 14:30 UTC · f893086: the hub didn't come up healthy on it and put it back. A newer build installs as usual; Update installs this one.",
    ]);
  });

  it("reads the hub's answer, and keeps the last one when it has no settings", () => {
    expect(autoOf({})).toBeUndefined();
    expect(autoOf({ settings: { auto: true, drainMinutes: 10 }, nextCheck: "2026-11-07T15:10:00.000Z", skipReason: "Why." })).toEqual(
      on({ nextCheck: "2026-11-07T15:10:00.000Z", skipReason: "Why." }),
    );
  });
});
