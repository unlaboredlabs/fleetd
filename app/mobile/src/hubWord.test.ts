import { describe, expect, it } from "vitest";
import type { FleetStatus, HubState, UpdateRun } from "./desktop";
import type { HubFrame } from "./hub/client";
import { FAILED_FOR_MS, holding, hubWord, LONG_RESTART_MS, nextChange, RESTART_HOLD_MS, SLOW_RESTART_MS, slowLine, UPDATED_FOR_MS, type WordInput } from "./hubWord";
import { initial, reduce, type State } from "./store";

const HUB = "http://devbox:4790";
const T = 1_794_000_000_000;
const live = (version = "0.9.1"): HubState => ({ phase: "live", hub: HUB, protocol: 1, version });
const retrying: HubState = { phase: "retrying", hub: HUB, reason: `${HUB} is restarting`, retryAt: T + 250 };

const snapshot = {
  cursor: 1,
  attention: [],
  machines: [],
  projects: [{ machineId: "m1", projectId: "shop", title: "storefront", workspaceRoot: "/home/devbox/shop", lastActivityAt: "2026-11-08T10:00:00Z", threads: { running: 0, waiting: 0, failed: 0, idle: 0 } }],
} as unknown as FleetStatus;

const step = (s: State, frame: HubFrame, nowMs: number): State => reduce(s, { t: "frame", frame, nowMs });
const at = (s: State, now: number, run: UpdateRun | null = null): WordInput => ({ hub: s.hub, restart: s.restart, run, now });

/** Live on 0.9.1 with a project, then the hub closes the link to restart (client.ts `restart`) at T. */
const restartedAt = (reason = "service restart"): State => {
  let s = step(initial({ phase: "connecting", hub: HUB, attempt: 0 }), { t: "state", state: live() }, T - 60_000);
  s = step(s, { t: "snapshot", snapshot }, T - 60_000);
  s = step(s, { t: "restart", code: 1012, reason }, T);
  return step(s, { t: "state", state: retrying }, T);
};

const run = (over: Partial<UpdateRun>): UpdateRun => ({ id: "u1", channel: "stable", startedAt: "2026-11-08T10:00:00Z", parts: [], to: "0.9.2", ...over }) as UpdateRun;

describe("a planned restart", () => {
  it("keeps what the screens show, says Updating…, and holds off can't-reach for 10 s", () => {
    const s = restartedAt("updating to 0.9.2");
    expect(s.projects?.["m1/shop"]?.title).toBe("storefront");
    expect(s.restart).toEqual({ t: "down", since: T, planned: true, update: true, from: "0.9.1" });
    expect(hubWord(at(s, T + 1000))).toEqual({ text: "Updating…", tone: "quiet", busy: true, restart: true });
    expect(holding(at(s, T + RESTART_HOLD_MS - 1))).toBe(true);
    // Past the hold: what the screens say when they have nothing yet falls back to today's.
    expect(holding(at(s, T + RESTART_HOLD_MS))).toBe(false);
    expect(s.projects?.["m1/shop"]).toBeDefined();
  });

  it("is said as a restart when the hub didn't say it was to update, and as an update when an admin's run goes on", () => {
    const s = restartedAt("hub shutting down");
    expect(hubWord(at(s, T + 1000))?.text).toBe("Restarting…");
    expect(hubWord(at(s, T + 1000, run({})))?.text).toBe("Updating…");
  });

  it("gets one quiet line past 30 s, a warning past 2 minutes, and is an outage after that", () => {
    const s = restartedAt("updating to 0.9.2");
    const line = (now: number) => slowLine({ ...at(s, now), hubName: "devbox" });
    expect(line(T + SLOW_RESTART_MS - 1)).toBeUndefined();
    expect(line(T + SLOW_RESTART_MS)).toEqual({ text: "Still updating. What you send goes once it's back.", tone: "quiet" });
    expect(line(T + LONG_RESTART_MS)).toEqual({ text: "devbox hasn't come back after 2 minutes", tone: "warning" });
    expect(hubWord(at(s, T + LONG_RESTART_MS))?.text).toBe("Connecting…");
    expect(nextChange(at(s, T))).toBe(T + RESTART_HOLD_MS);
    expect(nextChange(at(s, T + RESTART_HOLD_MS))).toBe(T + SLOW_RESTART_MS);
    expect(nextChange(at(s, T + LONG_RESTART_MS))).toBeUndefined();
  });

  it("back on a new build says Updated, for a while", () => {
    const s = step(restartedAt(), { t: "state", state: live("0.9.2") }, T + 3000);
    expect(s.restart).toEqual({ t: "updated", at: T + 3000, from: "0.9.1", to: "0.9.2", took: 3000 });
    expect(hubWord(at(s, T + 4000))).toEqual({ text: "Updated", tone: "quiet", busy: false });
    expect(nextChange(at(s, T + 4000))).toBe(T + 3000 + UPDATED_FOR_MS);
    expect(hubWord(at(s, T + 3000 + UPDATED_FOR_MS))).toBeUndefined();
  });

  it("back on the same build says nothing", () => {
    const s = step(restartedAt(), { t: "state", state: live("0.9.1") }, T + 3000);
    expect(s.restart?.t).toBe("back");
    expect(hubWord(at(s, T + 4000))).toBeUndefined();
  });

  it("goes on through a hub that took the fast redial while it was still shutting down, then closed it", () => {
    let s = step(restartedAt("updating to 0.9.2"), { t: "state", state: live("0.9.1") }, T + 300);
    s = step(s, { t: "restart", code: 1001, reason: "hub shutting down" }, T + 400);
    s = step(s, { t: "state", state: retrying }, T + 400);
    expect(s.restart).toEqual({ t: "down", since: T, planned: true, update: true, from: "0.9.1" });
    expect(hubWord(at(s, T + 1000))?.text).toBe("Updating…");
    s = step(s, { t: "state", state: live("0.9.2") }, T + 5000);
    expect(s.restart).toEqual({ t: "updated", at: T + 5000, from: "0.9.1", to: "0.9.2", took: 5000 });
  });
});

describe("any other drop", () => {
  it("is today's Connecting…, with no hold and no line, and Updated when the hub came back on a new build", () => {
    let s = step(initial({ phase: "connecting", hub: HUB, attempt: 0 }), { t: "state", state: live() }, T - 1000);
    s = step(s, { t: "state", state: { ...retrying, reason: "The connection to the hub dropped" } }, T);
    expect(s.restart).toMatchObject({ t: "down", planned: false });
    expect(hubWord(at(s, T + 1000))).toEqual({ text: "Connecting…", tone: "quiet", busy: true });
    expect(holding(at(s, T + 1000))).toBe(false);
    expect(slowLine({ ...at(s, T + SLOW_RESTART_MS), hubName: "devbox" })).toBeUndefined();
    s = step(s, { t: "state", state: live("0.9.2") }, T + 5000);
    expect(hubWord(at(s, T + 6000))?.text).toBe("Updated");
  });

  it("a refused key is Not Connected, and ends the restart", () => {
    const s = step(restartedAt(), { t: "state", state: { phase: "refused", hub: HUB, message: "no" } }, T + 1000);
    expect(s.restart).toBeNull();
    expect(hubWord(at(s, T + 1000))?.text).toBe("Not Connected");
  });
});

describe("an admin's run, while the hub is live", () => {
  const s = step(initial({ phase: "connecting", hub: HUB, attempt: 0 }), { t: "state", state: live() }, T);
  const ended = "2026-11-08T10:05:00Z";
  const endMs = Date.parse(ended);
  const part = (state: string) => ({ part: "node", name: "buildbox", from: "0.9.1", to: "0.9.2", state });

  it("says Updating… while it goes on and Updated for a while once it went through", () => {
    expect(hubWord(at(s, T, run({ parts: [part("waiting")] as UpdateRun["parts"] })))).toEqual({ text: "Updating…", tone: "quiet", busy: false });
    const done = run({ finishedAt: ended, parts: [part("done")] as UpdateRun["parts"] });
    expect(hubWord(at(s, endMs + 1000, done))?.text).toBe("Updated");
    expect(hubWord(at(s, endMs + UPDATED_FOR_MS, done))).toBeUndefined();
  });

  it("says Put back when a machine went back to its old build, Not Updated when one failed, for an hour", () => {
    const back = run({ finishedAt: ended, parts: [part("done"), part("rolled_back")] as UpdateRun["parts"] });
    expect(hubWord(at(s, endMs + 1000, back))).toEqual({ text: "Put back", tone: "danger", busy: false });
    expect(hubWord(at(s, endMs + 1000, run({ finishedAt: ended, parts: [part("failed")] as UpdateRun["parts"] })))?.text).toBe("Not Updated");
    expect(hubWord(at(s, endMs + FAILED_FOR_MS, back))).toBeUndefined();
    expect(nextChange(at(s, endMs + 1000, back))).toBe(endMs + UPDATED_FOR_MS);
    expect(nextChange(at(s, endMs + UPDATED_FOR_MS, back))).toBe(endMs + FAILED_FOR_MS);
  });
});
