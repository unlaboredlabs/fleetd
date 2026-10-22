import { describe, expect, it } from "vitest";
import type { AppUpdate, Release } from "../../../shared/updates";
import type { HubUpdateProgress } from "../../src/data/hub-update-contract";
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
};

const hubOf = (over: Partial<HubInput> = {}): HubInput => ({ url: "http://devbox:4790", version: MINE, updatesItself: false, progress: undefined, ...over });
const view = (app: AppUpdate, hub: Partial<HubInput> = {}, current = MINE) => updatesView({ app: { current, app, release }, hub: hubOf(hub) });
const progress = (state: HubUpdateProgress["state"], text = "x"): HubUpdateProgress => ({ state, to: NEXT, text, at: "2026-10-22T10:30:00Z" });

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
    expect(v.app?.title).not.toMatch(/def5678/u);
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
    expect(v.hub).toMatchObject({ title: "The hub is up to date", actions: [] });
    expect(v.line).toBeNull();
  });

  it("is unknown, with no warning, when it reports 0.0.0 or nothing", () => {
    for (const version of ["0.0.0", undefined, "devel"]) {
      const v = view(current, { version });
      expect(v.hub).toMatchObject({ title: "The hub's version is unknown", actions: [] });
      expect(v.hub?.command).toBeUndefined();
      expect(v.line).toBeNull();
    }
  });

  it("warns when it is older than this app, and the command says it restarts the hub", () => {
    const v = view(current, { version: OLDER });
    expect(v.line).toEqual({ tone: "warning", text: "Update the hub" });
    expect(v.hub).toMatchObject({ title: "The hub runs an older fleetd than this app", command: { text: "fleetd update" }, actions: [] });
    expect(v.hub?.command?.note).toMatch(/on devbox\. It restarts the hub, which stops its running agents/u);
    const local = view(current, { version: OLDER, url: "http://127.0.0.1:4790" });
    expect(local.hub?.command?.note).toMatch(/in a terminal on this computer\. It restarts the hub/u);
  });

  it("offers Update the hub, which waits for its work, when the hub can update itself", () => {
    const v = view(current, { version: OLDER, updatesItself: true });
    expect(v.hub?.actions).toEqual([{ label: "Update the hub", run: "update", primary: true }]);
    expect(v.hub?.detail).toMatch(/restarts the hub once nothing runs there/u);
    expect(v.hub?.notes.lines).toEqual(["Status loads faster", "The hub says its version"]);
  });

  it("names a newer hub on the channel in the sheet only, not the sidebar", () => {
    const v = updatesView({ app: { current: MINE, app: current, release: { ...release, cli: NEXT } }, hub: hubOf({ updatesItself: true }) });
    expect(v.hub?.title).toMatch(/is available for the hub$/u);
    expect(v.hub?.actions.map((a) => a.run)).toEqual(["update"]);
    expect(v.line).toBeNull();
  });

  it("gives the command on this app's channel when the hub follows another", () => {
    expect(view(current, { version: "0.5.0" }, "0.6.0-nightly.202610221030+abc1234").hub?.command?.text).toBe("fleetd update --channel nightly");
  });

  it("waits for work to finish, and can restart now or cancel", () => {
    const v = view({ kind: "ready", version: NEXT }, { updatesItself: true, progress: progress("waiting", "The lead is working, 2 agents running") });
    expect(v.hub?.actions.map((a) => [a.label, a.run])).toEqual([
      ["Restart the hub now", "now"],
      ["Cancel update", "cancel"],
    ]);
    expect(v.hub?.detail).toBe("The lead is working, 2 agents running");
    // An update under way outranks this app's restart.
    expect(v.line).toEqual({ tone: "quiet", text: "The hub updates when idle" });
  });

  it("has nothing to click while it installs and restarts", () => {
    for (const state of ["installing", "restarting"] as const) {
      const v = view(current, { updatesItself: true, progress: progress(state) });
      expect(v.hub?.working).toBe(true);
      expect(v.hub?.actions).toEqual([]);
      expect(v.line?.text).toBe("Updating the hub…");
    }
    expect(view(current, { progress: progress("restarting") }).hub?.title).toBe("Restarting the hub…");
  });

  it("is up to date once it came back on the version it restarted into", () => {
    expect(view(current, { version: NEXT, progress: progress("restarting") }, NEXT).hub?.title).toBe("The hub is up to date");
    expect(view(current, { progress: progress("done") }).hub?.title).toBe("The hub is up to date");
  });

  it("says a failed update, with Try again", () => {
    const v = view(current, { updatesItself: true, progress: progress("failed", "The download was damaged, so nothing changed.") });
    expect(v.hub).toMatchObject({ title: "Couldn't update the hub", actions: [{ run: "retry" }] });
    expect(v.line).toEqual({ tone: "danger", text: "Couldn't update the hub" });
  });

  it("never flags anything from a development build", () => {
    const v = updatesView({ app: { current: "0.0.0", app: { kind: "unsupported" }, release: null }, hub: hubOf({ version: OLDER }) });
    expect(v.hub?.command).toBeUndefined();
    expect(v.line).toBeNull();
  });

  it("has no part while not connected", () => {
    expect(view(current, { url: null, version: OLDER }).hub).toBeNull();
  });
});

describe("hubHost", () => {
  it("names the hub's machine as people do, and none for this computer", () => {
    expect(hubHost("http://127.0.0.1:4790")).toBeNull();
    expect(hubHost("http://localhost:4790")).toBeNull();
    expect(hubHost("https://devbox.example.ts.net")).toBe("devbox");
  });
});
