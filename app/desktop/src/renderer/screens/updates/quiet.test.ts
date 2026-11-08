import { describe, expect, it } from "vitest";
import type { HubUpdateData, UpdatePart, UpdateRun } from "../../../shared/contracts";
import type { HubState } from "../../../shared/hub";
import type { AppUpdate, Release } from "../../../shared/updates";
import { restartOf } from "../shell/model";
import { updatesView, type MachineInput } from "./model";
import { quietOf } from "./quiet";

const MINE = "0.0.0-edge.202610221030+abc1234";
const NEXT = "0.0.0-edge.202610231030+def5678";
const NOW = Date.parse("2026-10-26T10:00:00.000Z");

const release: Release = {
  changes: [
    { commit: "def5678ffff", date: "2026-10-23T10:30:00Z", subject: "feat(hub): agents keep working while fleetd updates (#300)", areas: ["hub"] },
    { commit: "ccc3333cccc", date: "2026-10-22T18:00:00Z", subject: "fix(hub): status loads faster (#277)", areas: ["hub"] },
    { commit: "abc1234aaaa", date: "2026-10-22T10:30:00Z", subject: "fix(hub): the hub says its version (#275)", areas: ["hub"] },
  ],
  cli: NEXT,
  app: MINE,
};

const LIVE: HubState = { phase: "live", hub: "http://devbox:4790", protocol: 1, version: MINE };
const machines: MachineInput[] = [{ machineId: "builder", name: "builder", nodeVersion: MINE, online: true }];
const part = (over: Partial<UpdatePart>): UpdatePart => ({ part: "node", name: "builder", machineId: "builder", from: MINE, state: "done", ...over });
const HUB_DONE: UpdatePart = { part: "hub", name: "the hub", from: MINE, state: "done" };
const runOf = (parts: UpdatePart[], finished: boolean): UpdateRun =>
  ({ id: "U1", channel: "edge", to: NEXT, startedAt: "2026-10-26T09:58:00.000Z", parts, ...(finished ? { finishedAt: "2026-10-26T09:59:00.000Z" } : {}) });

const quiet = (over: {
  app?: AppUpdate;
  hub?: HubState;
  run?: UpdateRun | null;
  ready?: string | null;
  administers?: boolean;
  updated?: { from: string; to: string; at: number };
  update?: HubUpdateData;
  version?: string;
}) => {
  const administers = over.administers ?? true;
  const version = over.version ?? MINE;
  const view = updatesView({
    app: { current: MINE, app: over.app ?? { kind: "current" }, release },
    hub: { url: "http://devbox:4790", version },
    machines: machines.map((m) => ({ ...m, nodeVersion: version })),
    run: over.run ?? null,
    ready: over.ready ?? null,
    administers,
    now: NOW,
  });
  return quietOf({ view, hub: over.hub ?? LIVE, updated: over.updated, update: over.update, release, administers, now: NOW, timeZone: "UTC" });
};

describe("the hub row's word", () => {
  it("says nothing while all is current", () => {
    expect(quiet({ version: NEXT })).toBeNull();
  });

  it("says Updating… while the hub restarts into a new build, then nothing past 2 minutes: an outage says itself", () => {
    const away = (ms: number): HubState => ({ phase: "retrying", hub: "http://devbox:4790", reason: "x", retryAt: NOW, restarting: NOW - ms, updatingTo: NEXT });
    expect(quiet({ hub: away(2_000), version: NEXT })).toEqual({ kind: "restarting", word: { text: "Updating…", tone: "quiet" }, note: null });
    expect(quiet({ hub: away(60_000), version: NEXT })?.kind).toBe("restarting");
    expect(quiet({ hub: away(121_000), version: NEXT })).toBeNull();
    // A restart or stop that isn't an update says nothing of updates.
    expect(quiet({ hub: { phase: "retrying", hub: "http://devbox:4790", reason: "x", retryAt: NOW, restarting: NOW - 2_000 }, version: NEXT })).toBeNull();
    // Any other drop isn't a restart.
    expect(quiet({ hub: { phase: "retrying", hub: "http://devbox:4790", reason: "x", retryAt: NOW }, version: NEXT })).toBeNull();
  });

  it("offers an admin the build the hub has ready, with what's new and Update now; a member hears nothing of it", () => {
    const admin = quiet({ ready: NEXT });
    expect(admin?.word).toEqual({ text: "Update", tone: "accent" });
    expect(admin?.note).toMatchObject({ title: "fleetd Edge · Oct 23, 10:30 UTC is ready", action: { label: "Update now", run: "update" }, details: true });
    expect(admin?.note?.notes).toEqual(["Agents keep working while fleetd updates", "Status loads faster"]);
    expect(quiet({ ready: NEXT, administers: false })).toBeNull();
  });

  it("offers anyone this app's own update, ready to restart into", () => {
    const q = quiet({ app: { kind: "ready", version: NEXT }, administers: false });
    expect(q?.word.text).toBe("Update");
    expect(q?.note).toMatchObject({ action: { label: "Restart to update", run: "restartApp" }, details: false });
  });

  it("says Updating… while a run goes, with its progress for an admin only", () => {
    const run = runOf([HUB_DONE, part({ state: "restarting" })], false);
    const admin = quiet({ run, version: NEXT });
    expect(admin?.word.text).toBe("Updating…");
    expect(admin?.note).toMatchObject({ title: "Updating to Edge · Oct 23, 10:30 UTC", body: "Updating the machines: 0 of 1 done" });
    const member = quiet({ run, version: NEXT, administers: false });
    expect(member?.word.text).toBe("Updating…");
    expect(member?.note?.body).toBeUndefined();
    expect(member?.note?.details).toBe(false);
  });

  it("says Updated once a link came back on a newer build, with what changed since the old one, for 15 minutes", () => {
    const updated = { from: MINE, to: NEXT, at: NOW - 60_000 };
    const q = quiet({ updated, version: NEXT });
    expect(q?.word).toEqual({ text: "Updated", tone: "quiet" });
    expect(q?.note).toMatchObject({ title: "Updated to Edge · Oct 23, 10:30 UTC", aside: "09:59", notes: ["Agents keep working while fleetd updates", "Status loads faster"] });
    expect(quiet({ updated, version: NEXT, administers: false })?.note?.notes).toEqual([]);
    expect(quiet({ updated: { ...updated, at: NOW - 16 * 60_000 }, version: NEXT })).toBeNull();
  });

  it("says Put back when a machine didn't take the build: why and Try again for an admin, only the fact for a member", () => {
    const run = runOf(
      [HUB_DONE, part({ state: "rolled_back", stage: "health", message: "didn't answer" })],
      true,
    );
    const admin = quiet({ run, version: NEXT });
    expect(admin?.word).toEqual({ text: "Put back", tone: "danger" });
    expect(admin?.note).toMatchObject({
      title: "Edge · Oct 23, 10:30 UTC didn't go in on builder",
      danger: true,
      body: "builder: Didn't start, so it was put back. It runs its old build, and nothing was lost.",
      action: { label: "Try again", run: "retry" },
    });
    const member = quiet({ run, version: NEXT, administers: false });
    expect(member?.word.text).toBe("Put back");
    expect(member?.note?.action).toBeUndefined();
    expect(member?.note?.body).toBe("It runs its old build, and nothing was lost. An admin can try it again.");
  });
});

describe("the hub's own word on its update (hub.update)", () => {
  const said = (over: Partial<HubUpdateData>): HubUpdateData => ({
    runId: "U1",
    state: "updating",
    hub: "done",
    from: MINE,
    to: NEXT,
    startedAt: "2026-10-26T09:58:00.000Z",
    machines: [
      { machineId: "builder", name: "builder", state: "done" },
      { machineId: "mac", name: "mac", state: "restarting" },
    ],
    ...over,
  });

  it("says Updating… with how many machines are on it, for an admin", () => {
    const q = quiet({ update: said({}), version: NEXT });
    expect(q?.word.text).toBe("Updating…");
    expect(q?.note).toMatchObject({ title: "Updating to Edge · Oct 23, 10:30 UTC", body: "1 of 2 machines on it." });
    expect(quiet({ update: said({}), version: NEXT, administers: false })?.note?.body).toBeUndefined();
  });

  it("says Updated with what changed since its old build, for 15 minutes after it finished", () => {
    const update = said({ state: "updated", finishedAt: "2026-10-26T09:59:00.000Z", machines: [] });
    const q = quiet({ update, version: NEXT });
    expect(q?.word.text).toBe("Updated");
    expect(q?.note).toMatchObject({ title: "Updated to Edge · Oct 23, 10:30 UTC", aside: "09:59", notes: ["Agents keep working while fleetd updates", "Status loads faster"] });
    expect(quiet({ update: { ...update, finishedAt: "2026-10-26T09:44:00.000Z" }, version: NEXT })).toBeNull();
  });

  it("says Put back, naming the machine that missed the build and the hub's words, for a day", () => {
    const update = said({ state: "put_back", finishedAt: "2026-10-26T09:59:00.000Z", message: "mac didn't come up healthy, so it was put back", machines: [{ machineId: "mac", name: "mac", state: "rolled_back" }] });
    const q = quiet({ update, version: NEXT });
    expect(q?.word).toEqual({ text: "Put back", tone: "danger" });
    expect(q?.note).toMatchObject({
      title: "Edge · Oct 23, 10:30 UTC didn't go in on mac",
      body: "mac didn't come up healthy, so it was put back. It runs its old build, and nothing was lost.",
      action: { label: "Try again", run: "retry" },
    });
    expect(quiet({ update: { ...update, finishedAt: "2026-10-25T09:00:00.000Z" }, version: NEXT })).toBeNull();
  });

  it("leaves a current update to what else there is to say: the build ready, for an admin", () => {
    expect(quiet({ update: said({ state: "current", finishedAt: "2026-10-26T09:59:00.000Z" }), ready: NEXT })?.word.text).toBe("Update");
  });
});

describe("a restart's phases", () => {
  it("is quiet for 30 s, long until 2 minutes, then an outage, for an update; any other restart only while held", () => {
    const at = (ms: number) => restartOf({ phase: "connecting", hub: "h", attempt: 0, restarting: NOW - ms, updatingTo: NEXT }, NOW)?.phase;
    expect([at(0), at(29_999), at(30_000), at(119_999), at(120_000)]).toEqual(["quiet", "quiet", "long", "long", "outage"]);
    const plain = (ms: number) => restartOf({ phase: "connecting", hub: "h", attempt: 0, restarting: NOW - ms }, NOW)?.phase;
    expect([plain(0), plain(9_999), plain(10_000), plain(40_000)]).toEqual(["quiet", "quiet", "outage", "outage"]);
    expect(restartOf(LIVE, NOW)).toBeNull();
  });
});
