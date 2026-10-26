import { describe, expect, it } from "vitest";
import type { AppUpdate, Release } from "../../../shared/updates";
import type { UpdatePart, UpdateRun } from "../../../shared/contracts";
import type { Flow } from "./flow";
import { updatesView, type HubInput, type MachineInput } from "./model";

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

const machine = (name: string, nodeVersion: string, online = true): MachineInput => ({ machineId: name, name, nodeVersion, online });

describe("the hub and its machines", () => {
  const current: AppUpdate = { kind: "current" };

  it("are up to date when they run this app's build and the channel's newest: no button, no line", () => {
    const v = updatesView({ app: { current: MINE, app: current, release }, hub: hubOf(), machines: [machine("builder", MINE)] });
    expect(v.hub).toMatchObject({ name: "The hub", status: "Up to date: Nightly · Oct 22, 10:30 UTC · abc1234", tone: "quiet", raw: MINE });
    expect(v.nodes).toEqual([{ key: "builder", name: "builder", status: "Up to date: Nightly · Oct 22, 10:30 UTC · abc1234", tone: "quiet", raw: MINE }]);
    expect(v.update).toBeNull();
    expect(v.line).toBeNull();
  });

  it("offer the one Update button when the hub, a machine or this app has a newer build", () => {
    const hubBehind = view(current, { version: OLDER });
    expect(hubBehind.hub).toMatchObject({ status: "Nightly · Oct 22, 10:30 UTC · abc1234 is available", tone: "accent" });
    expect(hubBehind.hub?.notes.lines).toEqual(["Status loads faster", "The hub says its version"]);
    expect(hubBehind.update?.label).toBe("Update");
    expect(hubBehind.line).toEqual({ tone: "accent", text: "Update available" });

    const newer = updatesView({ app: { current: MINE, app: current, release: { ...release, cli: NEXT } }, hub: hubOf(), machines: [machine("builder", MINE), machine("mac", MINE, false)] });
    expect(newer.hub?.status).toBe("Nightly · Oct 23, 10:30 UTC · def5678 is available");
    expect(newer.nodes.map((n) => n.status)).toEqual(["Nightly · Oct 23, 10:30 UTC · def5678 is available", "Offline"]);
    expect(newer.update?.note).toBe(
      "Updates the hub, then its 2 machines, then this app, which restarts. Nothing waits for work to finish: what's running carries on by itself.",
    );

    const appOnly = view({ kind: "available", version: NEXT, percent: null, restart: false });
    expect(appOnly.update?.label).toBe("Update");
  });

  it("say their version is unknown, with no warning, when it is 0.0.0 or missing", () => {
    for (const version of ["0.0.0", undefined, "devel"]) {
      const v = view(current, { version });
      expect(v.hub?.status).toBe("Its version is unknown");
      expect(v.update).toBeNull();
      expect(v.line).toBeNull();
    }
  });

  it("never flag anything from a development build", () => {
    const v = updatesView({ app: { current: "0.0.0", app: { kind: "unsupported" }, release: null }, hub: hubOf({ version: OLDER }) });
    expect(v.update).toBeNull();
    expect(v.line).toBeNull();
  });

  it("have no part and no button while not connected", () => {
    const v = view(current, { url: null, version: OLDER });
    expect(v.hub).toBeNull();
    expect(v.nodes).toEqual([]);
    expect(v.update).toBeNull();
  });

  it("leave the sidebar to this app's restart when both want it", () => {
    expect(view({ kind: "ready", version: NEXT }, { version: OLDER }).line).toEqual({ tone: "accent", text: "Restart to update" });
  });
});

describe("an update of everything", () => {
  const p = (over: Partial<UpdatePart>): UpdatePart => ({ part: "node", name: "builder", from: OLDER, state: "waiting", ...over });
  const runOf = (parts: UpdatePart[], finished = false): UpdateRun => ({
    id: "U1",
    channel: "nightly",
    to: NEXT,
    startedAt: "2026-10-26T10:00:00.000Z",
    ...(finished ? { finishedAt: "2026-10-26T10:03:00.000Z" } : {}),
    parts,
  });
  const machines = [machine("builder", OLDER), machine("mac", OLDER)];
  const during = (run: UpdateRun, flow: Flow) =>
    updatesView({ app: { current: MINE, app: { kind: "available", version: NEXT, percent: null, restart: false }, release }, hub: hubOf({ version: OLDER }), machines, run, flow });

  it("shows each part's progress while it goes, and no button", () => {
    const run = runOf([
      p({ part: "hub", name: "the hub", state: "restarting" }),
      p({ machineId: "builder", name: "builder" }),
      p({ machineId: "mac", name: "mac" }),
    ]);
    const v = during(run, { phase: "following", reconnecting: true });
    expect(v.update).toBeNull();
    expect(v.hub?.status).toBe("Restarting on Nightly · Oct 23, 10:30 UTC · def5678; the app reconnects by itself");
    expect(v.nodes.map((n) => n.status)).toEqual(["Waiting for the hub", "Waiting for the hub"]);
    expect(v.progress).toEqual({ tone: "quiet", text: "Updating the hub…" });
    expect(v.line).toEqual({ tone: "quiet", text: "Updating…" });

    const nodes = runOf([
      p({ part: "hub", name: "the hub", state: "done", message: "runs it" }),
      p({ machineId: "builder", name: "builder", state: "done" }),
      p({ machineId: "mac", name: "mac", state: "downloading" }),
    ]);
    const n = during(nodes, { phase: "following", reconnecting: false });
    expect(n.hub?.status).toBe("Updated to Nightly · Oct 23, 10:30 UTC · def5678");
    expect(n.progress?.text).toBe("Updating the machines: 1 of 2 done");
  });

  it("says which part failed and how, and that nothing else changed when the hub did", () => {
    const run = runOf(
      [
        p({ part: "hub", name: "the hub", state: "failed", stage: "checksum", message: "fleetd-linux-x64: checksum mismatch; nothing was changed" }),
        p({ machineId: "builder", name: "builder", state: "skipped", message: "not asked: the hub didn't update, and nodes follow the hub" }),
        p({ machineId: "mac", name: "mac", state: "skipped", message: "not asked: the hub didn't update, and nodes follow the hub" }),
      ],
      true,
    );
    const v = during(run, { phase: "finished" });
    expect(v.hub).toMatchObject({ status: "Failed while checking the download: fleetd-linux-x64: checksum mismatch; nothing was changed", tone: "danger" });
    expect(v.nodes[0]).toMatchObject({ tone: "warning" });
    expect(v.progress).toEqual({ tone: "danger", text: "Update failed: the hub. Nothing else was changed." });
    expect(v.line).toEqual({ tone: "danger", text: "Update failed" });
    // Nothing changed, so the button is there to try again.
    expect(v.update?.label).toBe("Update");
  });

  it("says a part was put back when its new build didn't come up", () => {
    const run = runOf(
      [
        p({ part: "hub", name: "the hub", state: "done" }),
        p({ machineId: "builder", name: "builder", state: "done" }),
        p({ machineId: "mac", name: "mac", state: "rolled_back", stage: "health", message: "it didn't come up healthy, so the old build was put back and runs again" }),
      ],
      true,
    );
    const v = during(run, { phase: "finished" });
    expect(v.nodes[1]).toMatchObject({ status: "Put back: it didn't come up healthy, so the old build was put back and runs again", tone: "danger" });
    expect(v.progress?.text).toBe("Update failed: mac. The rest updated; this app updates with its own button.");
  });

  it("says everything is updated only when nothing was skipped, and names what was", () => {
    const all = runOf(
      [p({ part: "hub", name: "the hub", state: "done" }), p({ machineId: "builder", name: "builder", state: "done" }), p({ machineId: "mac", name: "mac", state: "current" })],
      true,
    );
    expect(during(all, { phase: "finished" }).progress).toEqual({ tone: "quiet", text: "Everything is updated." });
    const left = runOf(
      [
        p({ part: "hub", name: "the hub", state: "done" }),
        p({ machineId: "builder", name: "builder", state: "skipped", message: "offline: press Update again once it's online" }),
        p({ machineId: "mac", name: "mac", state: "skipped", message: "its fleetd (0.4.0) is too old to update from the hub" }),
      ],
      true,
    );
    expect(during(left, { phase: "finished" }).progress).toEqual({ tone: "warning", text: "Updated, except builder, mac: each says why, and how to update it." });
  });

  it("says this app updates last, and when its download failed", () => {
    const done = runOf([p({ part: "hub", name: "the hub", state: "done" })], true);
    expect(during(done, { phase: "app" }).progress?.text).toBe("Updating this app; it restarts once the download is in");
    const failed = updatesView({
      app: { current: MINE, app: { kind: "failed", during: "download", reason: "The download was damaged." }, release },
      hub: hubOf(),
      run: done,
      flow: { phase: "app" },
    });
    expect(failed.progress).toEqual({ tone: "danger", text: "Update failed: this app. The download was damaged. The hub and its machines updated." });
  });

  it("says why the hub wouldn't start it", () => {
    const v = during(runOf([p({ part: "hub", name: "the hub", state: "done" })], true), { phase: "refused", message: "This key lacks the admin role." });
    expect(v.progress).toEqual({ tone: "danger", text: "Couldn't start the update: This key lacks the admin role." });
  });

  it("shows a finished run for a while, across this app's restart, then where things stand", () => {
    const old = runOf([p({ part: "hub", name: "the hub", state: "failed", stage: "download", message: "offline" })], true);
    const finished = Date.parse("2026-10-26T10:03:00.000Z");
    const at = (now: number) =>
      updatesView({ app: { current: MINE, app: { kind: "current" }, release }, hub: hubOf({ version: OLDER }), machines, run: old, flow: { phase: "idle" }, now });
    expect(at(finished + 60_000).progress?.tone).toBe("danger");
    const later = at(finished + 60 * 60_000);
    expect(later.progress).toBeNull();
    expect(later.hub?.tone).toBe("accent");
  });
});
