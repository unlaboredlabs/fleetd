// C1, W38 and W603: the app's own update, the hub's and its machines', and the one Update button's run, one fixture
// per state, around typical's data so the sidebar's word and Hub › Machines › Updates are shot in a full window. Main's fixture updater
// reads each one's `update` section in place of the release feed; the hub's version comes in the ready frame (the
// fixture's live state), its machines' from the snapshot, and the run from hub_update and hub_update_status.
import type { Release, UpdatesState } from "../../src/shared/updates.ts";
import { defineGroup } from "../kit/group.ts";
import { Fixture } from "../kit/fixture.ts";
import { asText, isObject, type JsonObject } from "../kit/json.ts";
import { arr } from "../kit/stress.ts";

const MINE = "0.6.0-edge.202610221030+4f1c2ab";
const NEXT = "0.6.0-edge.202610231030+9e07d31";
const OLDER = "0.6.0-edge.202610201030+1c0ffee";
const AT = "2026-10-19T10:00:00.000Z";

const RELEASE: Release = { cli: MINE, app: MINE };

const state = (app: UpdatesState["app"], release: Release | null = RELEASE): JsonObject => ({ current: MINE, app, release }) as unknown as JsonObject;

/** Every machine's node on `version`, and `offline` ones offline. */
const nodesOn = (f: Fixture, version: string, offline: readonly string[] = []): void => {
  const on = (m: JsonObject) => ({ ...m, nodeVersion: version, ...(offline.includes(asText(m["machineId"])) ? { status: "offline" } : {}) });
  if (f.snapshot !== undefined) f.snapshot["machines"] = arr(f.snapshot["machines"]).map((m) => (isObject(m) ? on(m) : m));
};

/** What hub_update_status answers: Update automatically off unless `out` says otherwise. */
const says = (f: Fixture, out: JsonObject = {}): Fixture => f.drop("hub_update_status").answer("hub_update_status", {}, { settings: { auto: false, drainMinutes: 2 }, ...out });

const machinesOf = (f: Fixture): { machineId: string; name: string }[] =>
  arr(f.snapshot?.["machines"])
    .filter(isObject)
    .map((m) => ({ machineId: asText(m["machineId"]), name: asText(m["name"]) }));

type PartState = "waiting" | "downloading" | "restarting" | "done" | "current" | "failed" | "rolled_back" | "skipped";
interface PartSay {
  readonly state: PartState;
  readonly stage?: string;
  readonly message?: string;
}

/**
 * The hub's run: the hub, then each of the fixture's machines, the first ones as `nodes` says, the rest `rest`, each
 * followed by its Claude Code as `claude` says, when it says.
 */
const runOf = (f: Fixture, hub: PartSay, nodes: readonly PartSay[], rest: PartSay, finished: boolean, claude: readonly PartSay[] = []): JsonObject => ({
  id: "U1792000000000",
  channel: "edge",
  to: NEXT,
  startedAt: AT,
  ...(finished ? { finishedAt: "2026-10-19T10:03:00.000Z" } : {}),
  parts: [
    { part: "hub", name: "the hub", from: OLDER, ...hub },
    ...machinesOf(f).flatMap((m, i) => {
      const node = { part: "node", machineId: m.machineId, name: m.name, from: OLDER, ...(nodes[i] ?? rest) };
      const says = claude[i];
      return says === undefined ? [node] : [node, { part: "claude", machineId: m.machineId, name: m.name, from: "2.1.310", to: "2.1.314", ...says }];
    }),
  ],
});

export default defineGroup({
  fixtures: (base) => {
    const make = (what: string, note: string, app: UpdatesState["app"], release?: Release | null): Fixture => {
      const f = Fixture.from(base("typical"), `updates-${what}`, note);
      f.appUpdate = state(app, release);
      // A hub and nodes on this app's build, so the app's own states show beside an up to date fleet.
      if (f.state.phase === "live") f.state = { ...f.state, version: MINE };
      nodesOn(f, MINE);
      return says(f);
    };
    /** The hub running `version` (its ready frame), and its machines' nodes on `nodes` (the hub's own by default). */
    const withHub = (what: string, note: string, version: string, opts: { release?: Release; nodes?: string } = {}): Fixture => {
      const f = make(what, note, { kind: "current" }, opts.release ?? RELEASE);
      if (f.state.phase === "live") f.state = { ...f.state, version };
      nodesOn(f, opts.nodes ?? version);
      return f;
    };
    /**
     * Everything behind: the hub and its nodes on OLDER, this app with NEXT found. Update answers with `run`; the
     * app finds it going on as it opens with `going`, else no run before.
     */
    const everything = (what: string, note: string, run: (f: Fixture) => JsonObject | null, going = false, ready?: string): Fixture => {
      const release = { ...RELEASE, cli: NEXT };
      const f = withHub(what, note, OLDER, { release });
      f.appUpdate = state({ kind: "available", version: NEXT, percent: 64, restart: false }, release);
      const started = run(f);
      if (started === null) f.fail("hub_update", {}, { code: "forbidden", message: "This key lacks the admin role.", fix: "Run `fleetd pair` on the hub machine, then pair this app again with the new code: it grants admin." });
      else f.answer("hub_update", {}, { run: started });
      // Pressed, a finished run needs no read; one going on is read again and again, and stays as it is.
      return says(f, { ...(going && started !== null ? { run: started } : {}), ...(ready === undefined ? {} : { ready }) });
    };
    const waiting: PartSay = { state: "waiting" };
    const done: PartSay = { state: "done", message: "runs it" };
    const skipped: PartSay = { state: "skipped", message: "not asked: the hub didn't update, and nodes follow the hub" };

    return [
      withHub("hub-current", "The hub and its machines run this app's build, the newest on the channel.", MINE),
      withHub("hub-unknown", "The hub reports 0.0.0 (a local build): its version is unknown, and nothing is flagged.", "0.0.0"),
      withHub("hub-available", "The channel has a newer build than the hub and its machines run: Update available.", MINE, { release: { ...RELEASE, cli: NEXT } }),
      withHub("hub-behind", "The hub and its machines run an older Edge build than this app: Update.", OLDER),
      withHub("node-behind", "The machines' nodes are behind the hub: a row each, and Update.", MINE, { nodes: OLDER }),
      // The one Update button's run, part by part (W38).
      everything("everything", "The hub, its machines and this app all have a newer build: the one Update button.", (f) => runOf(f, { state: "downloading" }, [], waiting, false)),
      everything("run-hub", "Update pressed: the hub restarts on the new build, its machines wait.", (f) => runOf(f, { state: "restarting", message: "restarting" }, [], waiting, false), true),
      everything(
        "run-nodes",
        "The hub is updated; one machine is done, one restarts, the rest download.",
        (f) => runOf(f, done, [done, { state: "restarting" }], { state: "downloading" }, false, [{ state: "done" }, waiting]),
        true,
      ),
      (() => {
        // W112: the devbox's story. The hub updated and one machine is done; the next waits on a session nothing will
        // end, and nothing in the hub drives the run any more: The update stopped, and Start over.
        const stuck = (g: Fixture) =>
          runOf(g, done, [done, { state: "waiting", message: "waits until it's idle: 1 live session can't carry on through a restart" }], waiting, false, [{ state: "done" }, waiting]);
        const f = everything("run-left-over", "A run nothing in the hub drives any more, one machine waiting on a session: Start over.", stuck, true);
        return says(f, { run: stuck(f), leftOver: true });
      })(),
      everything(
        "hub-ready",
        "The hub downloaded and checked the channel's newest build ahead: Update available, and Update swaps it in.",
        (f) => runOf(f, done, [done, done], done, true, [{ state: "done" }, { state: "done" }]),
        false,
        NEXT,
      ),
      everything(
        "run-done",
        "Everything updated but this app, which downloads and restarts last.",
        (f) => runOf(f, done, [done, { state: "current" }], done, true, [{ state: "done" }, { state: "current" }]),
      ),
      everything(
        "run-hub-failed",
        "The hub's download didn't match SHA256SUMS: nothing changed, and its machines weren't asked.",
        (f) => runOf(f, { state: "failed", stage: "checksum", message: "`fleetd-linux-x64`: checksum mismatch (expected `9f2c…`, got `41ab…`); nothing was changed" }, [], skipped, true),
      ),
      everything(
        "run-hub-rolled-back",
        "The hub's new build didn't start: its old one runs again, and its machines weren't asked.",
        (f) => runOf(f, { state: "rolled_back", stage: "health", message: `Edge · Oct 23, 10:30 UTC · 9e07d31 didn't come up healthy within 90 s, so Edge · Oct 20, 10:30 UTC · 1c0ffee was put back and runs again` }, [], { state: "skipped", message: "not asked: the hub kept its build, and nodes follow the hub" }, true),
      ),
      (() => {
        // The hub already runs the new build; its machines are behind it, one of them (a third, a Mac) offline.
        const f = everything(
          "run-nodes-mixed",
          "Machines behind the hub: Update pressed, one didn't start the new build, one failed its download, one is offline.",
          (g) => {
            const machines = arr(g.snapshot?.["machines"]).filter(isObject);
            const last = machines.at(-1);
            if (g.snapshot !== undefined && last !== undefined) g.snapshot["machines"] = [...machines, { ...last, machineId: "mac1", name: "mac1", status: "offline" }];
            return runOf(
              g,
              { state: "current" },
              [
                { state: "rolled_back", stage: "health", message: "Edge · Oct 23, 10:30 UTC · 9e07d31 didn't come up healthy, so Edge · Oct 20, 10:30 UTC · 1c0ffee was put back and runs again" },
                { state: "failed", stage: "download", message: "couldn't download `fleetd-darwin-arm64`: GET `https://github.com/…/fleetd-darwin-arm64`: 503 Service Unavailable" },
                { state: "skipped", message: "offline: press Update again once it's online, or run `fleetd update` on it" },
              ],
              { state: "current" },
              true,
            );
          },
        );
        if (f.state.phase === "live") f.state = { ...f.state, version: NEXT };
        return f;
      })(),
      (() => {
        const f = everything(
          "run-updated",
          "Update pressed, this app already current: everything came through, and it is up to date.",
          (g) => runOf(g, done, [done, done], done, true, [{ state: "done" }, { state: "done" }]),
        );
        f.appUpdate = state({ kind: "current" }, { ...RELEASE, cli: NEXT });
        return f;
      })(),
      // W521: the word under your name and Hub › Machines › Updates, found as the app opens (the hub's own automatic update, or one pressed
      // in another window): a machine that didn't update, then everything updated a few minutes ago.
      (() => {
        const f = withHub("put-back", "The hub updated by itself, and one machine didn't start the new build, so its old one runs again: Not updated.", NEXT, { release: { ...RELEASE, cli: NEXT } });
        const run = runOf(f, done, [{ state: "rolled_back", stage: "health", message: "Edge · Oct 23, 10:30 UTC · 9e07d31 didn't come up healthy, so Edge · Oct 20, 10:30 UTC · 1c0ffee was put back and runs again" }], done, true);
        // That machine still runs its old build.
        const first = machinesOf(f)[0]?.machineId;
        if (f.snapshot !== undefined) f.snapshot["machines"] = arr(f.snapshot["machines"]).map((m) => (isObject(m) && m["machineId"] === first ? { ...m, nodeVersion: OLDER } : m));
        return says(f, { run });
      })(),
      (() => {
        const f = withHub("updated", "The hub and its machines updated themselves a few minutes ago: Updated.", NEXT, { release: { ...RELEASE, cli: NEXT } });
        const run = { ...runOf(f, done, [done, done], done, true), finishedAt: "2026-10-19T10:24:00.000Z" };
        return says(f, { run });
      })(),
      everything("refused", "Update pressed with a key that isn't Admin everywhere: the hub's words and fix.", () => null),
      // W469: Update automatically on: the ready build it installs by itself and when; one holding back, with why; and
      // the everyday page, on and up to date.
      (() => {
        const f = withHub("auto-on", "Update automatically on: the ready build it installs by itself, and when.", OLDER, { release: { ...RELEASE, cli: NEXT } });
        return says(f, { ready: NEXT, settings: { auto: true, drainMinutes: 2 }, autoAt: "2026-10-19T10:30:00.000Z" });
      })(),
      (() => {
        const f = withHub("auto-held", "Update automatically holding back, with why: Update available.", OLDER, { release: { ...RELEASE, cli: NEXT } });
        return says(f, { ready: NEXT, settings: { auto: true, drainMinutes: 2 }, skipReason: "An update someone started is still running." });
      })(),
      says(withHub("auto-current", "The everyday page: up to date, Update automatically on.", MINE), { settings: { auto: true, drainMinutes: 2 } }),
      make("idle", "Not checked yet (just started).", { kind: "idle" }, null),
      make("checking", "A check someone asked for, under way.", { kind: "checking" }, null),
      make("unsupported", "A development or test build, which doesn't update itself.", { kind: "unsupported" }, null),
      make("current", "This app is up to date (after Check for updates).", { kind: "current" }),
      make("available", "A newer Edge build of this app found and downloading in the background: Restart to update.", {
        kind: "available",
        version: NEXT,
        percent: 18,
        restart: false,
      }),
      make("downloading", "Restart to update chosen while the download runs: restarts once it's in.", { kind: "available", version: NEXT, percent: 42, restart: true }),
      make("ready", "Downloaded: Restart to update.", { kind: "ready", version: NEXT }),
      make("deb", "The deb, which can't update itself: the download and the apt command.", { kind: "manual", version: NEXT }),
      make("failed", "An asked-for check that found no release server.", {
        kind: "failed",
        during: "check",
        reason: "The release server didn't answer. Check your connection and try again.",
      }),
      make("download-failed", "The update's download broke off.", {
        kind: "failed",
        during: "download",
        reason: "The download stopped before it finished. Try again.",
      }),
    ];
  },
});
