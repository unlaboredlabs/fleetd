import { describe, expect, it } from "vitest";
import type { AppUpdate, Release } from "../../../shared/updates";
import type { UpdatePart, UpdateRun } from "../../../shared/contracts";
import type { Auto, Flow } from "./flow";
import { FAILED_SHOWN_MS, RESULT_SHOWN_MS, STALE_MS, updateStatus, type MachineInput, type StatusInput } from "./model";

const MINE = "0.0.0-edge.202610221030+abc1234";
const NEXT = "0.0.0-edge.202610231030+def5678";
const OLDER = "0.0.0-edge.202610201030+0001111";
const NOW = Date.parse("2026-10-26T10:00:00.000Z");
const HUB = "http://devbox:4790";

const release: Release = { cli: MINE, app: MINE };

const machine = (name: string, nodeVersion: string, online = true): MachineInput => ({ machineId: name, name, nodeVersion, online });

/** The status of a hub on MINE with this app on MINE and nothing newer, unless `over` says otherwise. */
const status = (over: Partial<Omit<StatusInput, "app" | "hub">> & { app?: AppUpdate | null; cli?: string; version?: string | undefined; url?: string | null } = {}) => {
  const { app, cli, version, url, ...rest } = over;
  return updateStatus({
    app: app === null ? null : { current: MINE, app: app ?? { kind: "current" }, release: { ...release, cli: cli ?? MINE } },
    hub: { url: url === undefined ? HUB : url, version: "version" in over ? version : MINE },
    now: NOW,
    timeZone: "UTC",
    ...rest,
  });
};

const hubPart = (over: Partial<UpdatePart> = {}): UpdatePart => ({ part: "hub", name: "the hub", from: OLDER, state: "done", ...over });
const node = (name: string, over: Partial<UpdatePart> = {}): UpdatePart => ({ part: "node", machineId: name, name, from: OLDER, state: "done", ...over });
const runOf = (parts: UpdatePart[], over: Partial<UpdateRun> = {}): UpdateRun => ({ id: "U1", channel: "edge", to: MINE, startedAt: "2026-10-26T09:50:00.000Z", parts, ...over });
const finished = (parts: UpdatePart[], ago = 60_000, over: Partial<UpdateRun> = {}): UpdateRun => runOf(parts, { finishedAt: new Date(NOW - ago).toISOString(), ...over });
const following: Flow = { phase: "following", reconnecting: false, since: NOW };
const auto = (over: Partial<Auto> = {}): Auto => ({ on: true, at: null, held: null, ...over });

describe("up to date", () => {
  it("is one line: what everything runs, no button, no rows", () => {
    expect(status({ machines: [machine("devbox", MINE), machine("buildbox", MINE)] })).toEqual({ kind: "current", title: "Up to date", detail: "fleetd Edge · Oct 22, 10:30", rows: [] });
  });

  it("says when an update came through, for a while", () => {
    const run = finished([hubPart(), node("devbox")]);
    expect(status({ run }).updatedAt).toBe(NOW - 60_000);
    expect(status({ run: finished([hubPart(), node("devbox")], RESULT_SHOWN_MS + 1) })).toEqual({ kind: "current", title: "Up to date", detail: "fleetd Edge · Oct 22, 10:30", rows: [] });
  });

  it("says a version nobody knows as that, never as behind", () => {
    expect(status({ version: undefined })).toMatchObject({ kind: "none", title: "Version unknown", detail: "The hub hasn't said which fleetd it runs." });
    expect(status({ version: "0.0.0" })).toMatchObject({ kind: "none", title: "Version unknown", detail: "The hub runs a local build, which doesn't update itself." });
  });

  it("says Not connected without a hub, unless this app has an update of its own", () => {
    expect(status({ url: null })).toEqual({ kind: "none", title: "Not connected", detail: "Updates show here once the hub answers.", rows: [] });
    expect(status({ url: null, app: { kind: "ready", version: NEXT } }).action).toEqual({ label: "Restart to update", act: "app" });
  });
});

describe("fleetd cloud, which updates itself (updates: false)", () => {
  it("says only this app's own update: never the hub's build, its machines or a run, and no Update for the hub", () => {
    const cloud = { updates: false, version: "4f2a91c", cli: NEXT, ready: NEXT, machines: [machine("devbox", OLDER)], run: runOf([hubPart({ state: "downloading" })]) };
    expect(status(cloud)).toEqual(status({ updates: false, version: "4f2a91c" }));
    expect(status(cloud).action).toBeUndefined();
    expect(status({ ...cloud, app: { kind: "ready", version: NEXT } }).action).toEqual({ label: "Restart to update", act: "app" });
    // With nothing from this app to say (the phone), the one line why.
    expect(status({ updates: false, app: null })).toEqual({ kind: "current", title: "Up to date", detail: "fleetd cloud updates itself.", rows: [] });
    // A self-run hub, which serves hub_update, as before.
    expect(status({ updates: true, cli: NEXT }).action).toEqual({ label: "Update", act: "update" });
  });
});

describe("an update to take", () => {
  it("is one line and one button: the channel's newer build", () => {
    expect(status({ cli: NEXT })).toEqual({ kind: "available", title: "Update available", detail: "fleetd Edge · Oct 23, 10:30", action: { label: "Update", act: "update" }, rows: [] });
  });

  it("is the build the hub has ready, and this app's own when the hub runs an older one", () => {
    expect(status({ ready: NEXT }).detail).toBe("fleetd Edge · Oct 23, 10:30");
    expect(status({ version: OLDER })).toMatchObject({ title: "Update available", detail: "fleetd Edge · Oct 22, 10:30", action: { label: "Update", act: "update" } });
  });

  it("never offers a build of the other channel", () => {
    expect(status({ version: "0.6.0", cli: NEXT }).kind).toBe("current");
  });

  it("says when it installs by itself, and Update now only does it sooner", () => {
    const s = status({ ready: NEXT, auto: auto({ at: "2026-10-26T10:10:00.000Z" }) });
    expect(s).toEqual({ kind: "available", title: "Update available", detail: "Installs by itself at 10:10.", action: { label: "Update now", act: "update" }, quiet: true, rows: [] });
    // Held back, or with no time set: the plain offer.
    expect(status({ ready: NEXT, auto: auto({ held: "An update someone started is still running." }) }).action?.label).toBe("Update");
    expect(status({ ready: NEXT, auto: auto() }).quiet).toBeUndefined();
  });

  it("tells a member who installs it, with no button", () => {
    expect(status({ cli: NEXT, administers: false })).toEqual({ kind: "available", title: "Update available", detail: "fleetd Edge · Oct 23, 10:30. An owner or admin installs it.", quiet: true, rows: [] });
  });

  it("leaves a finished run behind once a newer build is there", () => {
    const run = finished([hubPart({ state: "failed", stage: "download" })], 60_000, { to: MINE });
    expect(status({ version: OLDER, run, ready: NEXT })).toMatchObject({ kind: "available", title: "Update available", detail: "fleetd Edge · Oct 23, 10:30" });
  });
});

describe("this app's own update", () => {
  it("uses the same words: found, downloaded, or the deb's command", () => {
    const found = { kind: "available", title: "Update available", detail: "fleetd Edge · Oct 23, 10:30", action: { label: "Restart to update", act: "app" }, rows: [] };
    expect(status({ app: { kind: "available", version: NEXT, percent: 30, restart: false } })).toEqual(found);
    expect(status({ app: { kind: "ready", version: NEXT } })).toEqual(found);
    expect(status({ app: { kind: "manual", version: NEXT } })).toMatchObject({ action: { label: "Download", act: "app" }, command: "sudo apt install ./fleetd-desktop-linux-amd64.deb" });
  });

  it("shows its download once asked to restart", () => {
    expect(status({ app: { kind: "available", version: NEXT, percent: 42, restart: true } })).toEqual({
      kind: "updating",
      title: "Updating this app…",
      detail: "42% downloaded. It restarts once the download is in.",
      rows: [],
    });
    expect(status({ flow: { phase: "app" } }).detail).toBe("It restarts once the download is in.");
  });

  it("says why a check or a download failed, with Try again", () => {
    expect(status({ app: { kind: "failed", during: "check", reason: "Offline." } })).toMatchObject({ kind: "none", title: "Couldn't check for updates", detail: "Offline.", action: { label: "Try again", act: "check" } });
    expect(status({ app: { kind: "failed", during: "download", reason: "Damaged." } })).toMatchObject({ kind: "failed", title: "This app didn't update", detail: "Damaged." });
  });

  it("comes after the hub's: one Update takes both", () => {
    expect(status({ cli: NEXT, app: { kind: "ready", version: NEXT } }).action).toEqual({ label: "Update", act: "update" });
  });

  it("is a member's to take", () => {
    expect(status({ administers: false, app: { kind: "ready", version: NEXT } }).action).toEqual({ label: "Restart to update", act: "app" });
  });

  it("is nothing on the phone", () => {
    expect(status({ app: null, version: MINE })).toMatchObject({ kind: "current", title: "Up to date" });
  });
});

describe("updating", () => {
  it("is one line: the hub first", () => {
    expect(status({ cli: NEXT, flow: { phase: "starting" } })).toEqual({ kind: "updating", title: "Updating the hub…", detail: "fleetd Edge · Oct 23, 10:30", rows: [] });
    const run = runOf([hubPart({ state: "restarting" }), node("devbox", { state: "waiting" })], { to: NEXT });
    expect(status({ run, flow: following })).toEqual({ kind: "updating", title: "Updating the hub…", detail: "fleetd Edge · Oct 23, 10:30", rows: [] });
  });

  it("then its machines, counted as each settles, its Claude Code with it", () => {
    const claude = (name: string, state: UpdatePart["state"]): UpdatePart => ({ part: "claude", machineId: name, name, from: "2.1.310", state });
    const run = runOf([hubPart(), node("devbox"), claude("devbox", "done"), node("buildbox"), claude("buildbox", "waiting"), node("mac1", { state: "downloading" })], { to: NEXT });
    expect(status({ run, flow: following }).title).toBe("Updating the machines · 1 of 3");
    expect(status({ run: runOf([hubPart(), node("devbox", { state: "restarting" })]), flow: following }).title).toBe("Updating devbox…");
    expect(status({ run: runOf([hubPart()]), flow: following }).title).toBe("Updating…");
  });

  it("says what a machine waits for, and until when at the latest", () => {
    const waiting = (name: string, agents: number, installsBy: string) => node(name, { state: "waiting", agents, installsBy });
    const run = runOf([hubPart(), waiting("devbox", 2, "2026-10-26T10:01:00.000Z"), waiting("buildbox", 1, "2026-10-26T10:02:00.000Z")]);
    expect(status({ run, flow: following }).detail).toBe("Waiting for 3 agents to finish their step, 10:02 at the latest.");
    expect(status({ run: runOf([hubPart(), waiting("devbox", 1, "2026-10-26T10:01:00.000Z")]), flow: following }).detail).toBe("Waiting for 1 agent to finish its step, 10:01 at the latest.");
    expect(status({ run: runOf([hubPart(), waiting("devbox", 0, "2026-10-26T10:01:00.000Z")]), flow: following }).detail).toBe("Waiting for what runs there to end, 10:01 at the latest.");
  });

  it("says a run that stopped, with Start over: one nothing drives, or one unchanged for 10 minutes", () => {
    const run = runOf([hubPart(), node("devbox", { state: "downloading" })]);
    expect(status({ run, flow: { ...following, leftOver: true } })).toEqual({
      kind: "failed",
      title: "The update stopped",
      detail: "Nothing in the hub drives it any more.",
      action: { label: "Start over", act: "startOver" },
      rows: [],
    });
    expect(status({ run, flow: { ...following, since: NOW - STALE_MS } }).detail).toBe("Nothing has changed for 10 minutes.");
    expect(status({ run, flow: { ...following, since: NOW - STALE_MS + 1 } }).kind).toBe("updating");
    // Never while the hub restarts, nor for a member, who can't start it over.
    expect(status({ run: runOf([hubPart({ state: "restarting" })]), flow: { ...following, leftOver: true } }).kind).toBe("updating");
    expect(status({ run, flow: { ...following, leftOver: true }, administers: false }).kind).toBe("updating");
  });

  it("says the hub's words and fix when it wouldn't start", () => {
    expect(status({ flow: { phase: "refused", message: "This key lacks the admin role. Run `fleetd pair` on the hub machine" } })).toEqual({
      kind: "failed",
      title: "The update didn't start",
      detail: "This key lacks the admin role. Run `fleetd pair` on the hub machine.",
      action: { label: "Try again", act: "update" },
      rows: [],
    });
  });
});

describe("a problem", () => {
  it("is the hub's, in plain words by the step it stopped at, with Try again", () => {
    const failed = (over: Partial<UpdatePart>) => status({ version: OLDER, run: finished([hubPart(over)]) });
    expect(failed({ state: "failed", stage: "checksum" })).toEqual({
      kind: "failed",
      title: "The hub didn't update",
      detail: "The download didn't match its checksum, so nothing changed.",
      action: { label: "Try again", act: "update" },
      rows: [],
    });
    expect(failed({ state: "rolled_back", stage: "health" }).detail).toBe("Didn't start on the new build, so its old one runs again.");
    expect(failed({ state: "failed", stage: "download" }).detail).toBe("Couldn't download the new build.");
    expect(failed({ state: "failed", stage: "download", message: "GitHub's downloads are failing right now, try again later: 503" }).detail).toBe("GitHub's downloads are failing right now. Try again later.");
    // Installing fails for reasons only the hub can name: its own words, as a sentence.
    expect(failed({ state: "failed", stage: "install", message: "the hub runs a local build: run `fleetd update` on it" }).detail).toBe("The hub runs a local build: run `fleetd update` on it.");
  });

  it("stays a day, then is history; and is over once the hub runs that build", () => {
    const part = hubPart({ state: "failed", stage: "download" });
    expect(status({ version: OLDER, cli: OLDER, app: null, run: finished([part], FAILED_SHOWN_MS - 1, { to: MINE }) }).kind).toBe("failed");
    expect(status({ version: OLDER, cli: OLDER, app: null, run: finished([part], FAILED_SHOWN_MS, { to: MINE }) }).kind).toBe("current");
    expect(status({ run: finished([part]) }).kind).toBe("current");
  });

  it("is a row per machine that didn't update, and only those", () => {
    const run = finished([hubPart(), node("devbox", { state: "rolled_back", stage: "health" }), node("buildbox", { state: "failed", stage: "download" }), node("mac1", { state: "skipped" }), node("fine")]);
    const machines = [machine("mac1", OLDER, false), machine("devbox", OLDER), machine("fine", MINE), machine("buildbox", OLDER)];
    expect(status({ run, machines })).toEqual({
      kind: "failed",
      title: "2 machines didn't update",
      action: { label: "Try again", act: "update" },
      rows: [
        { key: "buildbox", name: "buildbox", why: "Couldn't download the new build.", tone: "danger" },
        { key: "devbox", name: "devbox", why: "Didn't start on the new build, so its old one runs again.", tone: "danger" },
        { key: "mac1", name: "mac1", why: "Offline. Update it when it's back.", tone: "quiet" },
      ],
    });
  });

  it("says the hub's fix for a machine too old to update from the hub, and offers no button that would only skip it again", () => {
    const old = node("buildbox", { state: "skipped", message: "its fleetd (0.8.0) is too old to update from the hub: run `fleetd update` on buildbox once" });
    const rows = [{ key: "buildbox", name: "buildbox", why: "Its fleetd (0.8.0) is too old to update from the hub: run `fleetd update` on buildbox once.", tone: "quiet" }];
    const run = finished([hubPart(), old, node("devbox")]);
    expect(status({ run, machines: [machine("buildbox", OLDER), machine("devbox", MINE)] })).toEqual({ kind: "available", title: "1 machine is behind", rows });
    // It stays as long as a failure does, and beside a machine Update can bring up it only adds its line.
    expect(status({ run: finished([hubPart(), old, node("devbox")], FAILED_SHOWN_MS - 1), machines: [machine("buildbox", OLDER), machine("devbox", MINE)] }).rows).toEqual(rows);
    expect(status({ run, machines: [machine("buildbox", OLDER), machine("devbox", OLDER)] })).toMatchObject({ title: "2 machines are behind", action: { label: "Update", act: "update" } });
  });

  it("drops a machine's failure once it runs the hub's build", () => {
    const run = finished([hubPart(), node("devbox", { state: "failed", stage: "download" })]);
    expect(status({ run, machines: [machine("devbox", MINE)] })).toMatchObject({ kind: "current", rows: [] });
  });

  it("says a Claude Code that didn't install, in the hub's words", () => {
    const run = finished([hubPart(), node("devbox"), { part: "claude", machineId: "devbox", name: "devbox", from: "2.1.310", state: "failed", message: "npm isn't on its PATH" }]);
    expect(status({ run, machines: [machine("devbox", MINE)] })).toMatchObject({ title: "1 machine didn't update", rows: [{ name: "devbox", why: "Claude Code: Npm isn't on its PATH.", tone: "danger" }] });
  });

  it("is a machine behind the hub: what it runs, and Update", () => {
    expect(status({ machines: [machine("devbox", OLDER), machine("buildbox", MINE)] })).toEqual({
      kind: "available",
      title: "1 machine is behind",
      action: { label: "Update", act: "update" },
      rows: [{ key: "devbox", name: "devbox", why: "fleetd Edge · Oct 20, 10:30", tone: "quiet" }],
    });
    expect(status({ machines: [machine("devbox", OLDER), machine("buildbox", OLDER)] }).title).toBe("2 machines are behind");
  });

  it("says an offline machine behind catches up by itself only with Update automatically on", () => {
    const machines = [machine("mac1", OLDER, false)];
    expect(status({ machines })).toEqual({ kind: "current", title: "Up to date", detail: "fleetd Edge · Oct 22, 10:30", rows: [{ key: "mac1", name: "mac1", why: "Offline. Update it when it's back.", tone: "quiet" }] });
    expect(status({ machines, auto: auto() }).rows[0]?.why).toBe("Offline. It updates when it's back.");
  });

  it("shows a member no machines", () => {
    expect(status({ machines: [machine("devbox", OLDER)], administers: false })).toEqual({ kind: "current", title: "Up to date", detail: "fleetd Edge · Oct 22, 10:30", rows: [] });
  });
});
