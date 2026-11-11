import { describe, expect, it } from "vitest";
import type { HubUpdateData, UpdatePart, UpdateRun } from "../../../shared/contracts";
import type { HubState } from "../../../shared/hub";
import type { AppUpdate, Release } from "../../../shared/updates";
import { restartOf } from "../shell/model";
import { updateStatus, type MachineInput } from "./model";
import { quietOf } from "./quiet";

const MINE = "0.0.0-edge.202610221030+abc1234";
const NEXT = "0.0.0-edge.202610231030+def5678";
const NOW = Date.parse("2026-10-26T10:00:00.000Z");

const release: Release = { cli: NEXT, app: MINE };

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
  auto?: { on: boolean; at: string | null; held: string | null };
  administers?: boolean;
  updated?: { from: string; to: string; at: number };
  update?: HubUpdateData;
  version?: string;
  nodes?: string;
}) => {
  const administers = over.administers ?? true;
  const version = over.version ?? MINE;
  const status = updateStatus({
    app: { current: MINE, app: over.app ?? { kind: "current" }, release },
    hub: { url: "http://devbox:4790", version },
    machines: machines.map((m) => ({ ...m, nodeVersion: over.nodes ?? version })),
    run: over.run ?? null,
    ready: over.ready ?? null,
    auto: over.auto ?? null,
    administers,
    now: NOW,
    timeZone: "UTC",
  });
  return quietOf({ status, hub: over.hub ?? LIVE, updated: over.updated, update: over.update, administers, now: NOW });
};

describe("the word under your name", () => {
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

  it("offers an admin the newer build with its one button; a member hears nothing of it, nor does anyone when it installs by itself", () => {
    const admin = quiet({ ready: NEXT });
    expect(admin).toEqual({
      kind: "available",
      word: { text: "Update", tone: "accent" },
      note: { title: "Update available", action: { label: "Update", act: "update" }, details: false },
    });
    expect(quiet({ ready: NEXT, administers: false })).toBeNull();
    expect(quiet({ ready: NEXT, auto: { on: true, at: "2026-10-26T10:10:00.000Z", held: null } })).toBeNull();
    // Held back, it is the admin's to take again.
    expect(quiet({ ready: NEXT, auto: { on: true, at: null, held: "An update someone started is still running." } })?.word.text).toBe("Update");
  });

  it("offers anyone this app's own update, ready to restart into", () => {
    const q = quiet({ app: { kind: "ready", version: NEXT }, administers: false, version: NEXT });
    expect(q?.word.text).toBe("Update");
    expect(q?.note).toEqual({ title: "Update available", action: { label: "Restart to update", act: "app" }, details: false });
  });

  it("says Updating… while a run goes, in the status's title, to anyone", () => {
    const run = runOf([HUB_DONE, part({ state: "restarting" })], false);
    for (const administers of [true, false]) {
      const q = quiet({ run, version: NEXT, administers });
      expect(q?.word).toEqual({ text: "Updating…", tone: "quiet" });
      expect(q?.note).toEqual({ title: "Updating builder…", details: false });
    }
  });

  it("says Updated for 15 minutes once an update came through, with when: one this window followed, or a link back on a newer build", () => {
    const followed = quiet({ run: runOf([HUB_DONE, part({})], true), version: NEXT, nodes: NEXT });
    expect(followed).toEqual({
      kind: "updated",
      word: { text: "Updated", tone: "quiet" },
      note: { title: "Updated", details: false, at: Date.parse("2026-10-26T09:59:00.000Z") },
    });
    const updated = { from: MINE, to: NEXT, at: NOW - 60_000 };
    expect(quiet({ updated, version: NEXT })?.note).toMatchObject({ title: "Updated", at: NOW - 60_000 });
    expect(quiet({ updated: { ...updated, at: NOW - 16 * 60_000 }, version: NEXT })).toBeNull();
  });

  it("says Not updated when a machine didn't take the build: the status's title and Try again for an admin", () => {
    const run = runOf([HUB_DONE, part({ state: "rolled_back", stage: "health", message: "didn't answer" })], true);
    const admin = quiet({ run, version: NEXT, nodes: MINE });
    expect(admin).toEqual({
      kind: "failed",
      word: { text: "Not updated", tone: "danger" },
      note: { title: "1 machine didn't update", action: { label: "Try again", act: "update" }, details: true },
    });
    expect(quiet({ run, version: NEXT, nodes: MINE, administers: false })).toBeNull();
  });

  it("tells a member only that the hub's update didn't go in, by the hub's own word, for a day", () => {
    const told = (state: string, finishedAt = "2026-10-26T09:59:00.000Z"): HubUpdateData => ({ runId: "U1", from: MINE, to: NEXT, startedAt: "2026-10-26T09:58:00.000Z", finishedAt, state, hub: "done", machines: [] });
    for (const state of ["put_back", "failed"]) {
      expect(quiet({ update: told(state), administers: false })).toEqual({ kind: "failed", word: { text: "Not updated", tone: "danger" }, note: { title: "Not updated", details: false } });
    }
    expect(quiet({ update: told("updated"), administers: false })).toBeNull();
    expect(quiet({ update: told("failed", "2026-10-25T09:59:00.000Z"), administers: false })).toBeNull();
    // An admin reads the run instead, which says what didn't update.
    expect(quiet({ update: told("failed"), version: NEXT })).toBeNull();
  });

  it("says Not updated when the hub didn't", () => {
    const run = runOf([{ part: "hub", name: "the hub", from: MINE, state: "failed", stage: "checksum", message: "checksum mismatch" }], true);
    expect(quiet({ run })?.note).toEqual({
      title: "The hub didn't update",
      action: { label: "Try again", act: "update" },
      details: false,
    });
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
