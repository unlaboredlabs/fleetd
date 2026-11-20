import { describe, expect, it } from "vitest";
import { loadWords, machineMark } from "./placesModel";

describe("a place's state", () => {
  it("marks a machine ready only while online with nothing failing", () => {
    expect(machineMark("online", undefined)).toBe("ready");
    expect(machineMark("online", "Claude is not logged in")).toBe("needs");
    expect(machineMark("offline", "Offline since Fri 09:03")).toBe("needs");
    expect(machineMark("degraded", "Needs a look")).toBe("needs");
  });

  it("says what runs on a well machine, only the kinds it is for, and Idle with nothing", () => {
    expect(loadWords({ agents: 8, screens: 2 })).toBe("8 agents · 2 screens");
    expect(loadWords({ agents: 1 })).toBe("1 agent");
    expect(loadWords({ screens: 1 })).toBe("1 screen");
    expect(loadWords({ agents: 0, screens: 0 })).toBe("Idle");
    expect(loadWords({})).toBe("Idle");
  });
});
