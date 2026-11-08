import { describe, expect, it } from "vitest";
import type { Machine } from "../../../shared/contracts";
import type { HubState } from "../../../shared/hub";
import { awayFor, lineView, MACHINES_WAIT_MS } from "./RestartLine";

const NOW = Date.parse("2026-10-26T10:00:00.000Z");
const HUB = "http://devbox.example.ts.net:4790";
const machine = (machineId: string, status: Machine["status"]): Machine => ({ machineId, name: machineId, nodeVersion: "1", status, lastSeenAt: "2026-10-26T09:00:00.000Z" });
const away = (ms: number, update = true): HubState => ({ phase: "retrying", hub: HUB, reason: "x", retryAt: NOW, restarting: NOW - ms, ...(update ? { updatingTo: "0.9.2" } : {}) });
const LIVE: HubState = { phase: "live", hub: HUB, protocol: 1 };

describe("the long-restart line", () => {
  it("stays away for the first 30 s, says how long from then, and leaves an outage to the offline banner", () => {
    expect(lineView(away(29_000), null, [], NOW)).toBeNull();
    expect(lineView(away(41_400), null, [], NOW)).toEqual({ t: "down", hub: "devbox", seconds: 41 });
    expect(lineView(away(121_000), null, [], NOW)).toBeNull();
    // A restart that isn't an update never gets it: past its hold it is offline as any lost link.
    expect(lineView(away(41_400, false), null, [], NOW)).toBeNull();
    // Any other drop isn't a restart.
    expect(lineView({ phase: "retrying", hub: HUB, reason: "x", retryAt: NOW }, null, [], NOW)).toBeNull();
  });

  it("counts the machines coming back once the hub is, and folds away when they all are, or after a minute", () => {
    const long = { since: NOW - 50_000, machines: ["devbox", "builder"], backAt: NOW - 1_000 };
    expect(lineView(LIVE, long, [machine("devbox", "online"), machine("builder", "offline")], NOW)).toEqual({ t: "back", hub: "devbox", back: 1, of: 2 });
    expect(lineView(LIVE, long, [machine("devbox", "online"), machine("builder", "online")], NOW)).toBeNull();
    expect(lineView(LIVE, long, [machine("devbox", "offline")], long.backAt + MACHINES_WAIT_MS)).toBeNull();
    // A restart that never went long says nothing once back.
    expect(lineView(LIVE, null, [machine("devbox", "offline")], NOW)).toBeNull();
  });

  it("says how long in seconds, then minutes and seconds", () => {
    expect([awayFor(41), awayFor(65)]).toEqual(["41 s", "1 min 5 s"]);
  });
});
