import { describe, expect, it } from "vitest";
import type { HubState, HubUpdateData, UpdateRun } from "./desktop";
import type { Machine } from "./store";
import { shortVersion, updateSection, type UpdateInput } from "./updates";

const NOW = Date.parse("2026-10-29T12:00:00Z");
const HUB: HubState = { phase: "live", hub: "http://devbox:4790", protocol: 1, version: "0.9.0" };
const machine = (machineId: string, nodeVersion = "0.9.0", status: Machine["status"] = "online"): Machine => ({
  machineId,
  name: machineId,
  nodeVersion,
  status,
  tags: [],
  lastSeenAt: "2026-10-29T11:59:00Z",
});
const MACHINES = [machine("devbox"), machine("buildbox")];

const input = (over: Partial<UpdateInput> = {}): UpdateInput => ({
  admin: true,
  hub: HUB,
  machines: MACHINES,
  run: null,
  flow: { phase: "idle" },
  ready: null,
  auto: null,
  restart: null,
  update: undefined,
  now: NOW,
  ...over,
});

const run = (parts: UpdateRun["parts"], finished = false): UpdateRun => ({
  id: "u1",
  channel: "stable",
  to: "0.9.1",
  startedAt: "2026-10-29T11:58:00Z",
  ...(finished ? { finishedAt: "2026-10-29T11:59:30Z" } : {}),
  parts,
});
const part = (p: "hub" | "node", name: string, state: string, extra: Partial<UpdateRun["parts"][number]> = {}): UpdateRun["parts"][number] => ({
  part: p,
  name,
  from: "0.9.0",
  state,
  ...(p === "node" ? { machineId: name } : {}),
  ...extra,
});
const UPDATED = { hub: { ...HUB, version: "0.9.1" }, machines: [machine("devbox", "0.9.1"), machine("buildbox", "0.9.1")] };
const told = (state: string, message?: string): HubUpdateData =>
  ({ runId: "u1", from: "0.9.0", to: "0.9.1", startedAt: "2026-10-29T11:58:00Z", finishedAt: "2026-10-29T11:59:30Z", hub: "done", machines: [], state, ...(message === undefined ? {} : { message }) }) as HubUpdateData;

describe("updateSection", () => {
  it("says Up to date to an admin, and nothing to a member or before the role is read", () => {
    // Which build is the Version row's, just above.
    expect(updateSection(input())).toEqual({ kind: "current", title: "Up to date", rows: [] });
    expect(updateSection(input({ admin: false }))).toBeNull();
    expect(updateSection(input({ admin: undefined }))).toBeNull();
    expect(updateSection(input({ hub: { phase: "retrying", hub: HUB.hub, reason: "gone", retryAt: NOW } }))).toBeNull();
  });

  it("offers the hub's ready build in one line with one button, as the desktop app says it", () => {
    expect(updateSection(input({ ready: "0.9.1" }))).toEqual({ kind: "available", title: "Update available", detail: "fleetd 0.9.1", action: { label: "Update", act: "update" }, rows: [] });
    expect(updateSection(input({ hub: { ...HUB, version: "0.0.0-edge.202610281816+e6ed04e" }, machines: [], ready: "0.0.0-edge.202610292301+c1d2e3f4" }))?.detail).toBe("fleetd Edge · Oct 29, 23:01");
    expect(updateSection(input({ ready: "0.9.1", admin: false }))).toBeNull();
  });

  it("says when Update automatically installs it by itself, with Update now", () => {
    const auto = { on: true, at: "2026-10-29T12:10:00Z", held: null };
    expect(updateSection(input({ ready: "0.9.1", auto }))).toMatchObject({ title: "Update available", action: { label: "Update now", act: "update" }, quiet: true });
  });

  it("names a machine only when it is behind or didn't update", () => {
    expect(updateSection(input({ machines: [machine("devbox"), machine("buildbox", "0.8.9")] }))).toEqual({
      kind: "available",
      title: "1 machine is behind",
      action: { label: "Update", act: "update" },
      rows: [{ key: "buildbox", name: "buildbox", why: "fleetd 0.8.9", tone: "quiet" }],
    });
    const back = updateSection(
      input({
        hub: { ...HUB, version: "0.9.1" },
        machines: [machine("devbox"), machine("buildbox", "0.9.1")],
        flow: { phase: "finished" },
        run: run([part("hub", "devbox", "done"), part("node", "buildbox", "done"), part("node", "devbox", "rolled_back", { stage: "health", message: "the node didn't come back" })], true),
      }),
    );
    expect(back).toEqual({
      kind: "failed",
      title: "1 machine didn't update",
      action: { label: "Try again", act: "update" },
      rows: [{ key: "devbox", name: "devbox", why: "Didn't start on the new build, so its old one runs again.", tone: "danger" }],
    });
  });

  it("follows a run in one line: the hub, then the machines", () => {
    expect(updateSection(input({ ready: "0.9.1", flow: { phase: "starting" } }))).toEqual({ kind: "updating", title: "Updating the hub…", detail: "fleetd 0.9.1", rows: [] });
    const machines = updateSection(input({ hub: { ...HUB, version: "0.9.1" }, flow: { phase: "following", reconnecting: false, since: NOW }, run: run([part("hub", "devbox", "done"), part("node", "buildbox", "done"), part("node", "devbox", "downloading")]) }));
    expect(machines).toEqual({ kind: "updating", title: "Updating the machines · 1 of 2", detail: "fleetd 0.9.1", rows: [] });
  });

  it("says Updated, with when, for a while after one came through", () => {
    const ended = Date.parse("2026-10-29T11:59:30Z");
    const done = run([part("hub", "devbox", "done"), part("node", "buildbox", "done"), part("node", "devbox", "done")], true);
    expect(updateSection(input({ ...UPDATED, flow: { phase: "finished" }, run: done }))).toEqual({ kind: "current", title: "Updated", detail: "fleetd 0.9.1", rows: [], updatedAt: ended });
    // The hub's own automatic update, which this phone only saw come back.
    const restart = { t: "updated", at: NOW - 60_000, from: "0.9.0", to: "0.9.1", took: 900 } as const;
    expect(updateSection(input({ ...UPDATED, restart }))).toMatchObject({ title: "Updated", updatedAt: NOW - 60_000 });
    expect(updateSection(input({ ...UPDATED, restart, now: NOW + 60 * 60_000 }))).toEqual({ kind: "current", title: "Up to date", rows: [] });
  });

  it("says why the hub wouldn't start it", () => {
    expect(updateSection(input({ ready: "0.9.1", flow: { phase: "refused", message: "Only an admin can update the hub." } }))).toEqual({
      kind: "failed",
      title: "The update didn't start",
      detail: "Only an admin can update the hub.",
      action: { label: "Try again", act: "update" },
      rows: [],
    });
  });

  it("tells a member how the hub's last update ended, without a button", () => {
    const member = { admin: false, ...UPDATED };
    expect(updateSection(input({ ...member, update: told("updated") }))).toEqual({ kind: "current", title: "Updated", detail: "fleetd 0.9.1", rows: [], updatedAt: Date.parse("2026-10-29T11:59:30Z") });
    expect(updateSection(input({ ...member, hub: HUB, update: told("put_back", "buildbox didn't start the new build.") }))).toEqual({ kind: "failed", title: "Not updated", detail: "buildbox didn't start the new build.", rows: [] });
    expect(updateSection(input({ ...member, update: told("failed"), now: NOW + 2 * 60 * 60_000 }))).toBeNull();
    expect(updateSection(input({ ...member, update: told("current") }))).toBeNull();
  });
});

describe("shortVersion", () => {
  it("keeps an Edge build to its day and minute, and a release as it is", () => {
    expect(shortVersion("0.0.0-edge.202610291816+e6ed04e")).toBe("Edge · Oct 29, 18:16");
    expect(shortVersion("0.9.1")).toBe("0.9.1");
    expect(shortVersion("0.9.1+abc1234")).toBe("0.9.1");
  });
});
