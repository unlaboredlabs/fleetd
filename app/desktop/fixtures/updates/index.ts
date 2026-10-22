// C1: the app's own update and the hub's, one fixture per state, around typical's data so the sidebar line and the
// sheet are shot in a full window. Main's fixture updater reads each one's `update` section in place of the release
// feed; the hub's version comes in the ready frame (the fixture's live state), what runs on it from hub_info.
import type { Release, UpdatesState } from "../../src/shared/updates.ts";
import { defineGroup } from "../kit/group.ts";
import { Fixture } from "../kit/fixture.ts";
import type { JsonObject } from "../kit/json.ts";

const MINE = "0.6.0-nightly.202610221030+4f1c2ab";
const NEXT = "0.6.0-nightly.202610231030+9e07d31";
const OLDER = "0.6.0-nightly.202610201030+1c0ffee";
const AT = "2026-10-19T10:00:00.000Z";
const LOCAL = "http://127.0.0.1:4790";

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
};

const state = (app: UpdatesState["app"], release: Release | null = RELEASE): JsonObject => ({ current: MINE, app, release }) as unknown as JsonObject;

const BUSY = [
  { kind: "lead", text: "The storefront lead's reply" },
  { kind: "agent", text: "T19 writing the checkout page in storefront (12 m)", machineId: "devbox" },
  { kind: "agent", text: "T21 testing the cart in storefront (4 m)", machineId: "devbox" },
  { kind: "train", text: "Merging PR #251 into acme/storefront" },
];

export default defineGroup({
  fixtures: (base) => {
    const make = (what: string, note: string, app: UpdatesState["app"], release?: Release | null): Fixture => {
      const f = Fixture.from(base("typical"), `updates-${what}`, note);
      f.appUpdate = state(app, release);
      // A hub on this app's build, so the app's own states show beside an up to date hub.
      if (f.state.phase === "live") f.state = { ...f.state, version: MINE };
      return f;
    };
    /** The hub at `url` running `version` (its ready frame), with `busy` running on it (hub_info). */
    const withHub = (what: string, note: string, version: string, opts: { release?: Release; busy?: JsonObject[]; url?: string } = {}): Fixture => {
      const f = make(what, note, { kind: "current" }, opts.release ?? RELEASE);
      if (f.state.phase === "live") f.state = { ...f.state, version, ...(opts.url === undefined ? {} : { hub: opts.url }) };
      f.answer("hub_info", {}, { version, protocol: 1, channel: "nightly", startedAt: AT, busy: opts.busy ?? BUSY });
      return f;
    };

    // Update the hub, and the hub can't say what runs on it.
    const hubInfoFailed = withHub("hub-info-failed", "Update the hub, and hub_info fails: the hub couldn't say what's running.", OLDER);
    hubInfoFailed.fail("hub_info", {}, { code: "timeout", message: "The hub didn't answer in time." });
    /** The hub on this computer, behind, where Run in Terminal answers `outcome`. */
    const terminal = (what: string, outcome: JsonObject): Fixture => {
      const f = withHub(`terminal-${what}`, `Run in Terminal fails: ${what}.`, OLDER, { busy: [], url: LOCAL });
      f.appUpdate = { ...f.appUpdate, hubTerminal: outcome };
      return f;
    };

    return [
      withHub("hub-current", "The hub runs this app's build, the newest on the channel.", MINE),
      withHub("hub-unknown", "The hub reports 0.0.0 (a local build): its version is unknown, and nothing is flagged.", "0.0.0"),
      withHub("hub-available", "The channel has a newer hub than the one running: in the sheet only.", MINE, { release: { ...RELEASE, cli: NEXT } }),
      withHub("hub-behind", "The hub on devbox runs an older nightly than this app: a warning; Update the hub lists what runs and the command.", OLDER),
      withHub("hub-behind-local", "The hub on this computer is behind and idle: Update the hub offers Run in Terminal.", OLDER, { busy: [], url: LOCAL }),
      hubInfoFailed,
      // Run in Terminal's three failures (main's answers), each with the command to run instead.
      terminal("not-local", { ok: false, message: "The hub isn't on this computer. Run this on the hub's machine:", command: "fleetd update" }),
      terminal("not-found", {
        ok: false,
        message: "Couldn't find the fleetd command on this computer. Once fleetd is installed, run this in a terminal:",
        command: "fleetd update",
      }),
      terminal("no-terminal", { ok: false, message: "Couldn't open a terminal. Run this in one:", command: "~/.local/bin/fleetd update" }),
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
