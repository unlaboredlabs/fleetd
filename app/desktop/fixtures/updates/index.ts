// C1 and W38: the app's own update, the hub's and its machines', and the one Update button's run, one fixture per
// state, around typical's data so the sidebar line and the sheet are shot in a full window. Main's fixture updater
// reads each one's `update` section in place of the release feed; the hub's version comes in the ready frame (the
// fixture's live state), its machines' from the snapshot, and the run from hub_update and hub_update_status.
import type { Release, UpdatesState } from "../../src/shared/updates.ts";
import { defineGroup } from "../kit/group.ts";
import { Fixture } from "../kit/fixture.ts";
import { asText, isObject, type JsonObject } from "../kit/json.ts";
import { arr } from "../kit/stress.ts";

const MINE = "0.6.0-nightly.202610221030+4f1c2ab";
const NEXT = "0.6.0-nightly.202610231030+9e07d31";
const OLDER = "0.6.0-nightly.202610201030+1c0ffee";
const AT = "2026-10-19T10:00:00.000Z";

const change = (commit: string, subject: string, areas: string[]) => ({ commit, date: AT, subject, areas });
/** changes.json since MINE (4f1c2ab) and a little before it, newest first. */
const RELEASE: Release = {
  changes: [
    change("9e07d31a", "feat(desktop): updates show in the app, with what's new and one click to restart (#268)", ["app"]),
    change("8d1e2f3a", "batch: fix(desktop): drafts in the chat composer survive a restart (#250); feat(desktop): the live strip names the agent waiting on you (#258)", ["app"]),
    change("7c2d3e4a", "fix(hub): the hub reports its version, and asks before a restart stops work (#277)", ["hub"]),
    change("6b3c4d5a", "feat(cli): fleetd status says how long each project has been idle (#249)", ["hub"]),
    change("5a4b5c6a", "ci(release): nightly and release publish changes.json (#276)", ["other"]),
    change("4f1c2abf", "feat(desktop): status loads faster with many projects (#240)", ["app"]),
    change("3e5f6a7a", "fix(hub): a lead turn resumes after the hub restarts (#230)", ["hub"]),
  ],
  cli: MINE,
  app: MINE,
};

const state = (app: UpdatesState["app"], release: Release | null = RELEASE): JsonObject => ({ current: MINE, app, release }) as unknown as JsonObject;

/** Every machine's node on `version`, and `offline` ones offline. */
const nodesOn = (f: Fixture, version: string, offline: readonly string[] = []): void => {
  const on = (m: JsonObject) => ({ ...m, nodeVersion: version, ...(offline.includes(asText(m["machineId"])) ? { status: "offline" } : {}) });
  if (f.snapshot !== undefined) f.snapshot["machines"] = arr(f.snapshot["machines"]).map((m) => (isObject(m) ? on(m) : m));
};

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
  channel: "nightly",
  to: NEXT,
  startedAt: AT,
  ...(finished ? { finishedAt: "2026-10-19T10:03:00.000Z" } : {}),
  parts: [
    { part: "hub", name: "the hub", from: OLDER, ...hub },
    ...machinesOf(f).flatMap((m, i) => {
      const node = { part: "node", machineId: m.machineId, name: m.name, from: OLDER, ...(nodes[i] ?? rest) };
      const says = claude[i];
      return says === undefined ? [node] : [node, { part: "claude", machineId: m.machineId, name: m.name, from: "2.1.310", to: "2.1.302", ...says }];
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
      return f;
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
     * sheet finds it going on when it opens with `going`, else no run before.
     */
    const everything = (what: string, note: string, run: (f: Fixture) => JsonObject | null, going = false, ready?: string): Fixture => {
      const release = { ...RELEASE, cli: NEXT };
      const f = withHub(what, note, OLDER, { release });
      f.appUpdate = state({ kind: "available", version: NEXT, percent: 64, restart: false }, release);
      const started = run(f);
      if (started === null) f.fail("hub_update", {}, { code: "forbidden", message: "This key lacks the admin role.", fix: "Run `fleetd pair` on the hub machine, then pair this app again with the new code: it grants admin." });
      else f.answer("hub_update", {}, { run: started });
      // Pressed, a finished run needs no read; one going on is read again and again, and stays as it is.
      f.answer("hub_update_status", {}, { ...(going && started !== null ? { run: started } : {}), ...(ready === undefined ? {} : { ready }) });
      return f;
    };
    const waiting: PartSay = { state: "waiting" };
    const done: PartSay = { state: "done", message: "runs it" };
    const skipped: PartSay = { state: "skipped", message: "not asked: the hub didn't update, and nodes follow the hub" };

    return [
      withHub("hub-current", "The hub and its machines run this app's build, the newest on the channel.", MINE),
      withHub("hub-unknown", "The hub reports 0.0.0 (a local build): its version is unknown, and nothing is flagged.", "0.0.0"),
      withHub("hub-available", "The channel has a newer build than the hub and its machines run: Update.", MINE, { release: { ...RELEASE, cli: NEXT } }),
      withHub("hub-behind", "The hub and its machines run an older nightly than this app: Update.", OLDER),
      withHub("node-behind", "One machine's node is behind the hub: Update.", MINE, { nodes: OLDER }),
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
        // end, and nothing in the hub drives the run any more: Start over, quiet beside it.
        const stuck = (g: Fixture) =>
          runOf(g, done, [done, { state: "waiting", message: "waits until it's idle: 1 live session can't carry on through a restart" }], waiting, false, [{ state: "done" }, waiting]);
        const f = everything("run-left-over", "A run nothing in the hub drives any more, one machine waiting on a session: Start over.", stuck, true);
        f.drop("hub_update_status").answer("hub_update_status", {}, { run: stuck(f), leftOver: true });
        return f;
      })(),
      everything(
        "hub-ready",
        "The hub downloaded and checked the channel's newest build ahead: \"fleetd … is ready\", once, and Update swaps it in.",
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
        "The hub's new build didn't come up healthy: the previous one was put back, and its machines weren't asked.",
        (f) => runOf(f, { state: "rolled_back", stage: "health", message: `Nightly · Oct 23, 10:30 UTC · 9e07d31 didn't come up healthy within 90 s, so Nightly · Oct 20, 10:30 UTC · 1c0ffee was put back and runs again` }, [], { state: "skipped", message: "not asked: the hub kept its build, and nodes follow the hub" }, true),
      ),
      everything(
        "run-nodes-mixed",
        "The hub updated; one machine was put back, one failed its download, one was offline.",
        (f) =>
          runOf(
            f,
            done,
            [
              { state: "rolled_back", stage: "health", message: "Nightly · Oct 23, 10:30 UTC · 9e07d31 didn't come up healthy, so Nightly · Oct 20, 10:30 UTC · 1c0ffee was put back and runs again" },
              { state: "failed", stage: "download", message: "couldn't download `fleetd-darwin-arm64`: GET `https://github.com/…/fleetd-darwin-arm64`: 503 Service Unavailable" },
              { state: "skipped", message: "offline: press Update again once it's online, or run `fleetd update` on it" },
            ],
            done,
            true,
          ),
      ),
      (() => {
        const f = everything(
          "run-updated",
          "Update pressed, this app already current: every part came through, the sheet closes itself and the sidebar says \"Updated to …\".",
          (g) => runOf(g, done, [done, done], done, true, [{ state: "done" }, { state: "done" }]),
        );
        f.appUpdate = state({ kind: "current" }, { ...RELEASE, cli: NEXT });
        return f;
      })(),
      everything("refused", "Update pressed with a key that isn't Admin everywhere: the hub's words and fix.", () => null),
      make("idle", "Not checked yet (just started).", { kind: "idle" }, null),
      make("checking", "A check someone asked for, under way.", { kind: "checking" }, null),
      make("unsupported", "A development or test build, which doesn't update itself.", { kind: "unsupported" }, null),
      make("current", "This app is up to date (the sheet after Check for Updates).", { kind: "current" }),
      make("available", "A newer nightly found and downloading in the background: Update and restart, with what's new.", {
        kind: "available",
        version: NEXT,
        percent: 18,
        restart: false,
      }),
      make("downloading", "Update and restart chosen while the download runs: restarts once it's in.", { kind: "available", version: NEXT, percent: 42, restart: true }),
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
