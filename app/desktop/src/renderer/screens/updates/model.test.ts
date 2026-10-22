import { describe, expect, it } from "vitest";
import type { AppUpdate } from "../../../shared/updates";
import type { HubVersion } from "../../src/data/hub-version-contract";
import { hubMachine, updatesView, type UpdatesInput } from "./model";

const NIGHTLY = "0.6.0-nightly.202610221030+abc1234";
const NEXT = "0.6.0-nightly.202610231030+def5678";

const view = (app: AppUpdate, more: Partial<UpdatesInput> = {}) =>
  updatesView({ app: { current: NIGHTLY, app }, hub: undefined, hubUrl: "http://devbox:4790", probeVersion: null, platform: "darwin", ...more });

const hub = (over: Partial<HubVersion> = {}): HubVersion => ({ version: NIGHTLY, channel: "nightly", updateAvailable: false, notes: [], ...over });

describe("this app's update", () => {
  it("says nothing in the sidebar while up to date, checking or after a quiet failure", () => {
    for (const app of [{ kind: "current" }, { kind: "checking" }, { kind: "idle" }, { kind: "unsupported" }, { kind: "failed", during: "check", reason: "x" }] as const) {
      expect(view(app).line).toBeNull();
    }
  });

  it("offers Update and restart, with what's new, once found", () => {
    const v = view({ kind: "available", version: NEXT, notes: ["Updates show in the app"], percent: 30, restart: false });
    expect(v.line).toEqual({ tone: "accent", text: "Update available" });
    expect(v.app?.action).toEqual({ label: "Update and restart", run: "install", primary: true });
    expect(v.app?.notes).toEqual(["Updates show in the app"]);
    expect(v.app?.title).not.toMatch(/def5678/u);
  });

  it("shows the download once asked to restart, with a way back", () => {
    const v = view({ kind: "available", version: NEXT, notes: [], percent: 42, restart: true });
    expect(v.line?.text).toBe("Downloading the update: 42%");
    expect(v.app?.action?.run).toBe("keep");
  });

  it("offers the restart once downloaded", () => {
    const v = view({ kind: "ready", version: NEXT, notes: [] });
    expect(v.line).toEqual({ tone: "accent", text: "Restart to update" });
    expect(v.app?.action?.label).toBe("Restart to update");
  });

  it("gives the deb its command to copy", () => {
    expect(view({ kind: "manual", version: NEXT, notes: [] }).app?.command).toBe("sudo apt install ./fleetd-desktop-linux-amd64.deb");
  });

  it("says why a check or a download failed", () => {
    expect(view({ kind: "failed", during: "check", reason: "Offline." }).app).toMatchObject({ title: "Couldn't check for updates", detail: "Offline." });
    expect(view({ kind: "failed", during: "download", reason: "Damaged." }).app?.title).toBe("Couldn't download the update");
  });
});

describe("the hub's machine", () => {
  const current: AppUpdate = { kind: "current" };

  it("offers the update when its channel has a newer build", () => {
    const v = view(current, { hub: hub({ updateAvailable: true, latest: NEXT, notes: ["Status loads faster"] }) });
    expect(v.hub?.actions).toEqual([{ label: "Update devbox", run: "update", primary: true }]);
    expect(v.hub?.notes).toEqual(["Status loads faster"]);
    expect(v.line).toEqual({ tone: "warning", text: "Update devbox" });
  });

  it("leaves the notes to this app's part when both have them", () => {
    const app: AppUpdate = { kind: "available", version: NEXT, notes: ["Status loads faster"], percent: null, restart: false };
    expect(view(app, { hub: hub({ updateAvailable: true, latest: NEXT, notes: ["Status loads faster"] }) }).hub?.notes).toEqual([]);
  });

  it("waits for work to finish, and can update now or cancel", () => {
    const update = { state: "waiting", to: NEXT, text: "The lead is working, 2 agents running", at: "2026-10-22T10:30:00Z" } as const;
    const v = view({ kind: "ready", version: NEXT, notes: [] }, { hub: hub({ updateAvailable: true, latest: NEXT, update }) });
    expect(v.hub?.actions.map((a) => a.run)).toEqual(["now", "cancel"]);
    expect(v.hub?.detail).toBe(update.text);
    // An update under way outranks this app's restart.
    expect(v.line).toEqual({ tone: "quiet", text: "devbox updates when idle" });
  });

  it("has nothing to click while it installs and restarts", () => {
    for (const state of ["installing", "restarting"] as const) {
      const v = view(current, { hub: hub({ updateAvailable: true, latest: NEXT, update: { state, to: NEXT, text: "Installing", at: "2026-10-22T10:30:00Z" } }) });
      expect(v.hub?.working).toBe(true);
      expect(v.hub?.actions).toEqual([]);
      expect(v.line?.text).toBe("Updating devbox…");
    }
  });

  it("gives the exact command, on this app's channel, when the hub's channel has nothing newer", () => {
    const v = updatesView({ app: { current: NEXT, app: current }, hub: hub({ channel: "stable", version: "0.5.0" }), hubUrl: "http://devbox:4790", probeVersion: null, platform: "linux" });
    expect(v.hub?.command).toBe("fleetd update --channel nightly");
    const same = updatesView({ app: { current: NEXT, app: current }, hub: hub(), hubUrl: "http://devbox:4790", probeVersion: null, platform: "linux" });
    expect(same.hub?.command).toBe("fleetd update");
  });

  it("tells a hub from before it reported its version by /healthz, with the command", () => {
    const v = view(current, { probeVersion: "0.5.0" });
    expect(v.hub).toMatchObject({ title: "fleetd on devbox is older than this app", command: "fleetd update" });
    expect(view(current, { probeVersion: NEXT }).hub).toBeNull();
  });

  it("never flags anything from a development build", () => {
    const v = updatesView({ app: { current: "0.0.0", app: { kind: "unsupported" } }, hub: hub({ version: "0.5.0" }), hubUrl: "http://devbox:4790", probeVersion: null, platform: "linux" });
    expect(v.hub?.command).toBeUndefined();
    expect(v.line).toBeNull();
  });

  it("has no part while not connected", () => {
    expect(view(current, { hubUrl: null, hub: hub({ updateAvailable: true, latest: NEXT }) }).hub).toBeNull();
  });
});

describe("hubMachine", () => {
  it("names the hub's machine as people do", () => {
    expect(hubMachine("http://127.0.0.1:4790", "darwin")).toBe("this Mac");
    expect(hubMachine("http://localhost:4790", "linux")).toBe("this computer");
    expect(hubMachine("https://devbox.example.ts.net", "linux")).toBe("devbox");
  });
});
