import { describe, expect, it } from "vitest";
import type { HubState } from "./desktop";
import { afterAnswer, afterLink, RESTART_WAIT_MS, restartRow, type RestartStep } from "./hubRestart";
import type { Restart } from "./store";

const HUB = "http://devbox:4790";
const T = 1_794_000_000_000;
const live: HubState = { phase: "live", hub: HUB, protocol: 1, version: "0.9.1" };
const retrying: HubState = { phase: "retrying", hub: HUB, reason: `${HUB} is restarting`, retryAt: T + 250 };
const idle: RestartStep = { at: "idle" };
const restarting: RestartStep = { at: "restarting", asked: T, leads: 2 };
const down: Restart = { t: "down", since: T + 40, planned: true, update: false, from: "0.9.1" };
const back: Restart = { ...down, t: "back", at: T + 900 };

describe("the Restart Hub row", () => {
  it("is an admin's only, on a connected hub", () => {
    expect(restartRow(true, live, idle)).toEqual({ detail: undefined, value: undefined, canAsk: true });
    expect(restartRow(false, live, idle)).toBeNull();
    // Not read yet: a member never sees it flash in.
    expect(restartRow(undefined, live, idle)).toBeNull();
    expect(restartRow(true, retrying, idle)).toBeNull();
  });

  it("says Restarting… while one goes, without a second tap, through the hub's time away", () => {
    for (const step of [{ at: "asking", asked: T }, restarting] as const) {
      expect(restartRow(true, live, step)).toEqual({ detail: undefined, value: "Restarting…", canAsk: false });
      expect(restartRow(true, retrying, step)).toEqual({ detail: undefined, value: "Restarting…", canAsk: false });
    }
  });

  it("says Restarted, and how many leads start again", () => {
    expect(restartRow(true, live, { at: "done", leads: 0 })).toEqual({ detail: undefined, value: "Restarted", canAsk: true });
    expect(restartRow(true, live, { at: "done", leads: 1 })?.detail).toBe("1 lead starts again on the current lead profile, each once it is idle.");
    expect(restartRow(true, live, { at: "done", leads: 3 })?.detail).toBe("3 leads start again on the current lead profile, each once it is idle.");
  });

  it("says why a restart failed, and can be asked again", () => {
    expect(restartRow(true, live, { at: "failed", message: "The hub couldn't restart itself." })).toEqual({ detail: "The hub couldn't restart itself.", value: undefined, canAsk: true });
  });
});

describe("hub_restart's answer", () => {
  it("takes the hub's count of leads", () => {
    expect(afterAnswer(T, { ok: true, output: { leads: 2 } })).toEqual(restarting);
  });

  it("counts a call the restart itself cut off as taken", () => {
    expect(afterAnswer(T, { ok: false, error: { code: "disconnected", message: "The hub connection closed before it answered." } })).toEqual({ at: "restarting", asked: T, leads: 0 });
  });

  it("keeps a refusal's words and fix, and says what a hub from before the tool needs", () => {
    expect(afterAnswer(T, { ok: false, error: { code: "failed", message: "The hub doesn't run as a service, so it can't restart itself", fix: "Restart it on its machine." } })).toEqual({
      at: "failed",
      message: "The hub doesn't run as a service, so it can't restart itself. Restart it on its machine.",
    });
    expect(afterAnswer(T, { ok: false, error: { code: "not_found", message: "No tool hub_restart." } })).toEqual({ at: "failed", message: "This hub runs a fleetd from before Restart Hub. Update fleetd on it first." });
  });
});

describe("the link, as a restart goes", () => {
  it("is restarting until the hub has been away and is live again", () => {
    expect(afterLink(restarting, live, null, T + 20)).toBe(restarting);
    expect(afterLink(restarting, retrying, down, T + 100)).toBe(restarting);
    expect(afterLink(restarting, live, back, T + 900)).toEqual({ at: "done", leads: 2 });
    // Updated on the way: back all the same.
    expect(afterLink(restarting, live, { t: "updated", at: T + 900, from: "0.9.1", to: "0.9.2", took: 860 }, T + 900)).toEqual({ at: "done", leads: 2 });
  });

  it("doesn't take an earlier restart for this one", () => {
    const earlier: Restart = { ...down, t: "back", since: T - 60_000, at: T - 59_000 };
    expect(afterLink(restarting, live, earlier, T + 20)).toBe(restarting);
  });

  it("says a hub still up long after it took the restart didn't restart", () => {
    expect(afterLink(restarting, live, null, T + RESTART_WAIT_MS)).toEqual({ at: "failed", message: "The hub took the restart but is still up. Try again, or restart its service on the hub's machine." });
    // Away that long is another matter: the chats list says so.
    expect(afterLink(restarting, retrying, down, T + RESTART_WAIT_MS)).toBe(restarting);
  });

  it("leaves every other step as it is", () => {
    for (const step of [idle, { at: "asking", asked: T }, { at: "done", leads: 0 }, { at: "failed", message: "No." }] as const) expect(afterLink(step, live, back, T + RESTART_WAIT_MS)).toBe(step);
  });
});
