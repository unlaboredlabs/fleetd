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

  it("shows each machine's Claude Code under it, from its version to the tested one, and names one that failed", () => {
    const run = runOf(
      [
        p({ part: "hub", name: "the hub", state: "done" }),
        p({ machineId: "builder", name: "builder", state: "done" }),
        p({ part: "claude", machineId: "builder", name: "builder", from: "2.1.310", to: "2.1.302", state: "done" }),
        p({ machineId: "mac", name: "mac", state: "done" }),
        p({
          part: "claude",
          machineId: "mac",
          name: "mac",
          from: "2.1.310",
          to: "2.1.302",
          state: "failed",
          stage: "install",
          message: "`claude install 2.1.302` failed (404), so 2.1.310 stays",
        }),
      ],
      true,
    );
    const v = during(run, { phase: "finished", updated: false });
    expect(v.nodes.map((n) => [n.name, n.status])).toEqual([
      ["builder", "Updated to Nightly · Oct 23, 10:30 UTC · def5678"],
      ["builder: Claude Code", "Claude Code 2.1.310 → 2.1.302: new sessions start on 2.1.302"],
      ["mac", "Updated to Nightly · Oct 23, 10:30 UTC · def5678"],
      ["mac: Claude Code", "Claude Code 2.1.310 → 2.1.302 failed: `claude install 2.1.302` failed (404), so 2.1.310 stays"],
    ]);
    expect(v.progress?.text).toBe("Update failed: mac's Claude Code. The rest updated; Retry tries it again.");
  });

  it("names a skipped machine once, leaves a Claude Code installed another way calm, and counts Claude Code in done", () => {
    const run = runOf(
      [
        p({ part: "hub", name: "the hub", state: "done" }),
        p({ machineId: "builder", name: "builder", state: "done" }),
        p({
          part: "claude",
          machineId: "builder",
          name: "builder",
          from: "2.1.310",
          to: "2.1.302",
          state: "skipped",
          message: "Claude Code is managed by Homebrew: run `brew upgrade claude-code` to update it (it runs 2.1.310)",
        }),
        p({ machineId: "mac", name: "mac", state: "skipped", message: "offline: press Update again once it's online" }),
        p({ part: "claude", machineId: "mac", name: "mac", state: "skipped", message: "offline: press Update again once it's online" }),
      ],
      true,
    );
    const v = during(run, { phase: "finished", updated: false });
    expect(v.nodes.find((n) => n.key === "claude:builder")).toMatchObject({
      status: "Claude Code is managed by Homebrew: run `brew upgrade claude-code` to update it (it runs 2.1.310)",
      tone: "quiet",
    });
    expect(v.progress).toEqual({ tone: "warning", text: "Updated, except mac: each says why; Retry tries it again." });

    const going = runOf([
      p({ part: "hub", name: "the hub", state: "done" }),
      p({ machineId: "builder", name: "builder", state: "done" }),
      p({ part: "claude", machineId: "builder", name: "builder", state: "downloading" }),
    ]);
    expect(during(going, { phase: "following", reconnecting: false }).progress?.text).toBe("Updating the machines: 0 of 1 done");
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
    const v = during(run, { phase: "finished", updated: false });
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
    const v = during(run, { phase: "finished", updated: false });
    expect(v.nodes[1]).toMatchObject({ status: "Put back: it didn't come up healthy, so the old build was put back and runs again", tone: "danger" });
    expect(v.progress?.text).toBe("Update failed: mac. The rest updated; Retry tries it again.");
  });

  it("says plainly that a machine's restart was refused, not that it didn't come back", () => {
    const refused =
      "restarting fleetd-node.service exited with exit status: 1, so it never restarted onto the new build and still runs the old one; its previous binary was put back";
    const run = runOf(
      [
        p({ part: "hub", name: "the hub", state: "done" }),
        p({ machineId: "builder", name: "builder", state: "done" }),
        p({ machineId: "mac", name: "mac", state: "failed", stage: "restart", message: refused }),
      ],
      true,
    );
    const v = during(run, { phase: "finished", updated: false });
    expect(v.nodes[1]).toMatchObject({ status: `Didn't restart: ${refused}`, tone: "danger" });
    expect(v.progress?.text).toBe("Update failed: mac. The rest updated; Retry tries it again.");
  });

  it("says everything is updated only when nothing was skipped, and names what was", () => {
    const all = runOf(
      [p({ part: "hub", name: "the hub", state: "done" }), p({ machineId: "builder", name: "builder", state: "done" }), p({ machineId: "mac", name: "mac", state: "current" })],
      true,
    );
    expect(during(all, { phase: "finished", updated: false }).progress).toEqual({ tone: "quiet", text: "Updated to Nightly · Oct 23, 10:30 UTC · def5678" });
    const left = runOf(
      [
        p({ part: "hub", name: "the hub", state: "done" }),
        p({ machineId: "builder", name: "builder", state: "skipped", message: "offline: press Update again once it's online" }),
        p({ machineId: "mac", name: "mac", state: "skipped", message: "its fleetd (0.4.0) is too old to update from the hub" }),
      ],
      true,
    );
    expect(during(left, { phase: "finished", updated: false }).progress).toEqual({ tone: "warning", text: "Updated, except builder, mac: each says why; Retry tries it again." });
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

describe("the sheet's lines, the notice and the note", () => {
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
  const at = Date.parse("2026-10-26T10:04:00.000Z");
  const of = (input: { run?: UpdateRun; flow?: Flow; ready?: string | null; app?: AppUpdate }) =>
    updatesView({
      app: { current: MINE, app: input.app ?? { kind: "current" }, release: { ...release, cli: NEXT } },
      hub: hubOf({ version: OLDER }),
      machines,
      run: input.run ?? null,
      flow: input.flow ?? { phase: "idle" },
      ready: input.ready ?? null,
      now: at,
    });
  const says = (v: ReturnType<typeof of>) => v.lines.map((l) => [l.name, l.state, l.reason ?? "", l.retry === undefined ? "" : (l.label ?? "Retry")]);

  it("names the build the hub has ready, with what's new in a few lines, and one notice for it", () => {
    const v = of({ ready: NEXT });
    expect(v.update).toMatchObject({ title: "fleetd Nightly · Oct 23, 10:30 UTC · def5678 is ready", label: "Update" });
    expect(v.update?.note).toMatch(/^Downloaded and checked already/u);
    // The hub's build is older than changes.json reaches, so there is more.
    expect(v.update?.notes).toEqual({ lines: ["Status loads faster", "The hub says its version"], more: true });
    // Without the build commit: the notice is also read aloud.
    expect(v.notice).toEqual({ version: NEXT, title: "fleetd Nightly · Oct 23, 10:30 UTC is ready", notes: v.update?.notes });
    expect(says(v)).toEqual([
      ["The hub", "Update ready", "", ""],
      ["builder", "Update ready", "", ""],
      ["mac", "Update ready", "", ""],
      ["This app", "Up to date", "", ""],
    ]);
  });

  it("shows no notice for a build still to download, nor while an update runs", () => {
    expect(of({}).notice).toBeNull();
    expect(of({}).update?.title).toBe("fleetd Nightly · Oct 23, 10:30 UTC · def5678 is available");
    const going = runOf([p({ part: "hub", name: "the hub", state: "downloading" })]);
    expect(of({ ready: NEXT, run: going, flow: { phase: "following", reconnecting: false } }).notice).toBeNull();
    // This app's own download, once in, is ready too.
    expect(of({ app: { kind: "ready", version: NEXT } }).notice?.version).toBe(NEXT);
  });

  it("gives each part one line while a run goes: waiting, updating, done, and why a busy machine waits", () => {
    const run = runOf([
      p({ part: "hub", name: "the hub", state: "done" }),
      p({ machineId: "builder", name: "builder", state: "restarting" }),
      p({ part: "claude", machineId: "builder", name: "builder", state: "waiting" }),
      p({ machineId: "mac", name: "mac", state: "waiting", message: "waits until it's idle: 1 live session can't carry on through a restart" }),
    ]);
    const v = of({ run, flow: { phase: "following", reconnecting: false }, app: { kind: "available", version: NEXT, percent: null, restart: false } });
    expect(says(v)).toEqual([
      ["The hub", "Done", "", ""],
      ["builder", "Updating…", "", ""],
      ["mac", "Waiting", "Waits until it's idle", ""],
      ["Claude Code", "Waiting", "", ""],
      ["This app", "Waiting", "", ""],
    ]);
  });

  it("says why a machine failed in one line, with Retry for it, while the others finish", () => {
    const run = runOf(
      [
        p({ part: "hub", name: "the hub", state: "done" }),
        p({ machineId: "builder", name: "builder", state: "rolled_back", stage: "health", message: "it didn't come up healthy within 90 s, so the old build was put back" }),
        p({ machineId: "mac", name: "mac", state: "done" }),
        p({ part: "claude", machineId: "mac", name: "mac", from: "2.1.310", to: "2.1.302", state: "done" }),
      ],
      true,
    );
    const v = of({ run, flow: { phase: "finished", updated: false }, app: { kind: "ready", version: NEXT } });
    expect(says(v)).toEqual([
      ["The hub", "Done", "", ""],
      ["builder", "Failed", "Didn't start, so it was put back", "Retry"],
      ["mac", "Done", "", ""],
      ["Claude Code", "Done", "New sessions start on 2.1.302", ""],
      // Not restarted at the end of a run that didn't all come through: it updates here.
      ["This app", "Update ready", "Downloaded; it restarts when you update", "Update"],
    ]);
    expect(v.lines.find((l) => l.key === "builder")?.retry).toEqual({ kind: "machine", machineId: "builder" });
    expect(v.lines.find((l) => l.key === "app")?.retry).toEqual({ kind: "app", run: "install" });
    // Retry on the lines, not the whole update again.
    expect(v.update).toBeNull();
    // The hub's words stay behind Details.
    expect(v.nodes.find((n) => n.key === "builder")?.status).toBe("Put back: it didn't come up healthy within 90 s, so the old build was put back");
  });

  it("offers Retry for a skipped machine and a failed Claude Code, but not while a run goes or when the hub didn't update", () => {
    const run = runOf(
      [
        p({ part: "hub", name: "the hub", state: "done" }),
        p({ machineId: "builder", name: "builder", state: "done" }),
        p({ part: "claude", machineId: "builder", name: "builder", from: "2.1.310", to: "2.1.302", state: "failed", stage: "install", message: "`claude install 2.1.302` failed (404), so 2.1.310 stays" }),
        p({ machineId: "mac", name: "mac", state: "skipped", message: "offline: press Update again once it's online" }),
      ],
      true,
    );
    const v = of({ run, flow: { phase: "finished", updated: false } });
    expect(says(v).slice(1, 4)).toEqual([
      ["builder", "Done", "", ""],
      ["mac", "Skipped", "Offline", "Retry"],
      ["Claude Code", "Failed", "builder: `claude install 2.1.302` failed (404), so 2.1.310 stays", "Retry"],
    ]);
    expect(of({ run, flow: { phase: "starting" } }).lines.some((l) => l.retry !== undefined)).toBe(false);

    const hubFailed = runOf(
      [
        p({ part: "hub", name: "the hub", state: "failed", stage: "checksum", message: "checksum mismatch" }),
        p({ machineId: "builder", name: "builder", state: "skipped", message: "not asked: the hub didn't update" }),
      ],
      true,
    );
    const h = of({ run: hubFailed, flow: { phase: "finished", updated: false } });
    expect(says(h).slice(0, 2)).toEqual([
      ["The hub", "Failed", "The download didn't match its checksum; nothing changed", ""],
      ["builder", "Skipped", "Not asked", ""],
    ]);
    // The whole update is tried again with the one button.
    expect(h.update?.label).toBe("Update");
  });

  it("leaves a small Updated to note in the sidebar once everything came through", () => {
    const run = runOf([p({ part: "hub", name: "the hub", state: "done" }), p({ machineId: "builder", name: "builder", state: "done" }), p({ machineId: "mac", name: "mac", state: "current" })], true);
    const v = updatesView({ app: { current: NEXT, app: { kind: "current" }, release }, hub: hubOf({ version: NEXT }), machines: [machine("builder", NEXT), machine("mac", NEXT)], run, now: at });
    expect(v.progress).toEqual({ tone: "quiet", text: "Updated to Nightly · Oct 23, 10:30 UTC · def5678" });
    expect(v.line).toEqual({ tone: "quiet", text: "Updated to Nightly · Oct 23, 10:30 UTC · def5678", done: true });
    expect(v.notice).toBeNull();
  });

  it("says why this app's update failed, with Retry, and shows its download while it updates last", () => {
    const failed = of({ app: { kind: "failed", during: "download", reason: "The download stopped." } });
    expect(says(failed).at(-1)).toEqual(["This app", "Failed", "The download stopped.", "Retry"]);
    const done = runOf([p({ part: "hub", name: "the hub", state: "done" })], true);
    const updating = of({ run: done, flow: { phase: "app" }, app: { kind: "available", version: NEXT, percent: 40, restart: true } });
    expect(says(updating).at(-1)).toEqual(["This app", "Updating…", "Downloading 40%", ""]);
  });

  it("offers Update and the notice for a newer build once ready, after a run that left a machine out", () => {
    const NEWER = "0.0.0-nightly.202610241030+fff9999";
    const run = runOf(
      [
        p({ part: "hub", name: "the hub", state: "done" }),
        p({ machineId: "builder", name: "builder", state: "done" }),
        p({ machineId: "mac", name: "mac", state: "skipped", message: "offline: press Update again once it's online" }),
      ],
      true,
    );
    // Followed in this window: the flow stays finished.
    const flow: Flow = { phase: "finished", updated: false };
    const before = of({ run, flow });
    expect(before.update).toBeNull();
    expect(before.lines.find((l) => l.key === "mac")?.retry).toEqual({ kind: "machine", machineId: "mac" });

    const v = of({ run, flow, ready: NEWER });
    expect(v.update?.title).toBe("fleetd Nightly · Oct 24, 10:30 UTC · fff9999 is ready");
    expect(v.notice?.version).toBe(NEWER);
    expect(v.progress).toBeNull();
    expect(v.lines.some((l) => l.retry !== undefined)).toBe(false);
    // A newer build on the channel, not downloaded yet, also ends the old run's Retry.
    const channel = updatesView({
      app: { current: MINE, app: { kind: "current" }, release: { ...release, cli: NEWER } },
      hub: hubOf({ version: NEXT }),
      machines,
      run,
      flow,
      now: at,
    });
    expect(channel.update?.title).toBe("fleetd Nightly · Oct 24, 10:30 UTC · fff9999 is available");
  });
});
