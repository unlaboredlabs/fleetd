import { describe, expect, it } from "vitest";
import type { AppUpdate, Release } from "../../../shared/updates";
import { hubHost, updatesView, type HubInput } from "./model";

const MINE = "0.0.0-nightly.202610221030+abc1234";
const NEXT = "0.0.0-nightly.202610231030+def5678";
const OLDER = "0.0.0-nightly.202610201030+0001111";

const release: Release = {
  changes: [
    { commit: "def5678ffff", date: "2026-10-23T10:30:00Z", subject: "feat(desktop): updates show in the app (#268)", areas: ["app"] },
    { commit: "ccc3333cccc", date: "2026-10-22T18:00:00Z", subject: "fix(hub): status loads faster (#277)", areas: ["hub"] },
    { commit: "abc1234aaaa", date: "2026-10-22T10:30:00Z", subject: "fix(hub): the hub says its version (#275)", areas: ["hub"] },
  ],
  cli: MINE,
  app: MINE,
};

const hubOf = (over: Partial<HubInput> = {}): HubInput => ({ url: "http://devbox:4790", version: MINE, ...over });
const view = (app: AppUpdate, hub: Partial<HubInput> = {}, current = MINE) => updatesView({ app: { current, app, release }, hub: hubOf(hub) });

describe("this app's update", () => {
  it("says nothing in the sidebar while up to date, checking or after a quiet failure", () => {
    for (const app of [{ kind: "current" }, { kind: "checking" }, { kind: "idle" }, { kind: "unsupported" }, { kind: "failed", during: "check", reason: "x" }] as const) {
      expect(view(app).line).toBeNull();
    }
  });

  it("offers Update and restart once found, with what's new to this app from changes.json", () => {
    const v = view({ kind: "available", version: NEXT, percent: 30, restart: false });
    expect(v.line).toEqual({ tone: "accent", text: "Update available" });
    expect(v.app?.action).toEqual({ label: "Update and restart", run: "install", primary: true });
    expect(v.app?.notes).toEqual({ lines: ["Updates show in the app"], more: false });
    expect(v.app?.title).toBe("fleetd Nightly · Oct 23, 10:30 UTC · def5678 is available");
    // The label is for reading; the raw version is there to copy.
    expect(v.app?.raw).toBe(MINE);
  });

  it("shows the download once asked to restart, with a way back", () => {
    const v = view({ kind: "available", version: NEXT, percent: 42, restart: true });
    expect(v.line?.text).toBe("Downloading the update: 42%");
    expect(v.app?.action?.run).toBe("keep");
  });

  it("offers the restart once downloaded, and says the hub keeps running", () => {
    const v = view({ kind: "ready", version: NEXT });
    expect(v.line).toEqual({ tone: "accent", text: "Restart to update" });
    expect(v.app?.action?.label).toBe("Restart to update");
    expect(v.app?.detail).toMatch(/hub keeps running/u);
  });

  it("gives the deb its command to copy", () => {
    expect(view({ kind: "manual", version: NEXT }).app?.command).toBe("sudo apt install ./fleetd-desktop-linux-amd64.deb");
  });

  it("says why a check or a download failed", () => {
    expect(view({ kind: "failed", during: "check", reason: "Offline." }).app).toMatchObject({ title: "Couldn't check for updates", detail: "Offline." });
    expect(view({ kind: "failed", during: "download", reason: "Damaged." }).app?.title).toBe("Couldn't download the update");
  });
});

describe("the hub", () => {
  const current: AppUpdate = { kind: "current" };

  it("is up to date when it runs this app's build and the channel's newest", () => {
    const v = view(current);
    expect(v.hub).toMatchObject({ title: "The hub is up to date" });
    expect(v.hub?.update).toBeUndefined();
    expect(v.line).toBeNull();
  });

  it("is unknown, with no warning, when it reports 0.0.0 or nothing", () => {
    for (const version of ["0.0.0", undefined, "devel"]) {
      const v = view(current, { version });
      expect(v.hub).toMatchObject({ title: "The hub's version is unknown" });
      expect(v.hub?.update).toBeUndefined();
      expect(v.line).toBeNull();
    }
  });

  it("warns when it is older than this app, with the command and when it restarts the hub", () => {
    const v = view(current, { version: OLDER });
    expect(v.line).toEqual({ tone: "warning", text: "Update the hub" });
    expect(v.hub).toMatchObject({ title: "The hub runs an older fleetd than this app", update: { command: "fleetd update", terminal: false } });
    expect(v.hub?.update?.note).toMatch(/^Run this on devbox\. .*restarts the hub only if nothing is running there/u);
    expect(v.hub?.notes.lines).toEqual(["Status loads faster", "The hub says its version"]);
  });

  it("can open the command in a terminal only for a hub on this computer, and only the bare fleetd update", () => {
    const local = view(current, { version: OLDER, url: "http://127.0.0.1:4790" });
    expect(local.hub?.update).toMatchObject({ terminal: true });
    expect(local.hub?.update?.note).toMatch(/^Run this in a terminal on this computer\./u);
    // Another channel needs --channel, which the terminal can't run: Copy only.
    const otherChannel = view(current, { version: "0.5.0", url: "http://127.0.0.1:4790" }, "0.6.0-nightly.202610221030+abc1234");
    expect(otherChannel.hub?.update).toMatchObject({ command: "fleetd update --channel nightly", terminal: false });
  });

  it("names a newer hub on the channel in the sheet only, not the sidebar", () => {
    const v = updatesView({ app: { current: MINE, app: current, release: { ...release, cli: NEXT } }, hub: hubOf() });
    expect(v.hub?.title).toMatch(/is available for the hub$/u);
    expect(v.hub?.update?.command).toBe("fleetd update");
    expect(v.line).toBeNull();
  });

  it("gives the command on this app's channel when the hub follows another", () => {
    expect(view(current, { version: "0.5.0" }, "0.6.0-nightly.202610221030+abc1234").hub?.update?.command).toBe("fleetd update --channel nightly");
  });

  it("leaves the sidebar to this app's restart when both want it", () => {
    expect(view({ kind: "ready", version: NEXT }, { version: OLDER }).line).toEqual({ tone: "accent", text: "Restart to update" });
  });

  it("never flags anything from a development build", () => {
    const v = updatesView({ app: { current: "0.0.0", app: { kind: "unsupported" }, release: null }, hub: hubOf({ version: OLDER }) });
    expect(v.hub?.update).toBeUndefined();
    expect(v.line).toBeNull();
  });

  it("has no part while not connected", () => {
    expect(view(current, { url: null, version: OLDER }).hub).toBeNull();
    expect(view(current, { url: null, version: OLDER }).line).toBeNull();
  });
});

describe("hubHost", () => {
  it("names the hub's machine as people do, and none for this computer", () => {
    expect(hubHost("http://127.0.0.1:4790")).toBeNull();
    expect(hubHost("http://localhost:4790")).toBeNull();
    expect(hubHost("https://devbox.example.ts.net")).toBe("devbox");
  });
});
