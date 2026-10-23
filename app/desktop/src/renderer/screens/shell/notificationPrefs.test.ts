import { describe, expect, it } from "vitest";
import { DEFAULT_PREFS, parsePrefs } from "./notificationPrefs";

describe("notification preferences", () => {
  it("start with everything on", () => {
    expect(parsePrefs(null)).toEqual(DEFAULT_PREFS);
    expect(parsePrefs("not json")).toEqual(DEFAULT_PREFS);
  });

  it("keep what was stored and default the rest", () => {
    const stored = JSON.stringify({ kinds: { machine: false, reply: "yes" }, sound: false });
    expect(parsePrefs(stored)).toEqual({ kinds: { ...DEFAULT_PREFS.kinds, machine: false }, sound: false, badge: true });
  });
});
