import { describe, expect, it } from "vitest";
import type { HubState } from "../../../shared/hub";
import { awayFor, lineView } from "./RestartLine";

const NOW = Date.parse("2026-10-26T10:00:00.000Z");
const HUB = "http://devbox.example.ts.net:4790";
const away = (ms: number, update = true): HubState => ({ phase: "retrying", hub: HUB, reason: "x", retryAt: NOW, restarting: NOW - ms, ...(update ? { updatingTo: "0.9.2" } : {}) });

describe("the long-restart line", () => {
  it("stays away for the first 30 s, says how long from then, and leaves an outage to the offline banner", () => {
    expect(lineView(away(29_000), NOW)).toBeNull();
    expect(lineView(away(41_400), NOW)).toEqual({ hub: "devbox", seconds: 41 });
    expect(lineView(away(121_000), NOW)).toBeNull();
    // A restart that isn't an update never gets it: past its hold it is offline as any lost link.
    expect(lineView(away(41_400, false), NOW)).toBeNull();
    // Any other drop isn't a restart, and a hub that is back says nothing.
    expect(lineView({ phase: "retrying", hub: HUB, reason: "x", retryAt: NOW }, NOW)).toBeNull();
    expect(lineView({ phase: "live", hub: HUB, protocol: 1 }, NOW)).toBeNull();
  });

  it("says how long in seconds, then minutes and seconds", () => {
    expect([awayFor(41), awayFor(65)]).toEqual(["41 s", "1 min 5 s"]);
  });
});
