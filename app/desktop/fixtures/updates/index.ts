// C1: the app's own update and the hub's, one fixture per state, around typical's data so the sidebar line and the
// sheet are shot in a full window. Main's fixture updater reads each one's `update` section in place of the release
// feed; the hub's version comes in the ready frame (the fixture's live state), its update as `hub.update` events.
import type { Release, UpdatesState } from "../../src/shared/updates.ts";
import { defineGroup } from "../kit/group.ts";
import { Fixture } from "../kit/fixture.ts";
import type { JsonObject } from "../kit/json.ts";

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
};

const state = (app: UpdatesState["app"], release: Release | null = RELEASE): JsonObject => ({ current: MINE, app, release }) as unknown as JsonObject;

/** C2's hub_update and its hub.update event are still on their branch; hub_info and the ready frame's version are main's. */
const PENDING = "C2: hub_update and its hub.update event, on feat/safe-update";
const BUSY = [
  { kind: "lead", text: "The storefront lead's reply" },
  { kind: "agent", text: "T19 writing the checkout page in storefront (12 m)", machineId: "devbox" },
  { kind: "agent", text: "T21 testing the cart in storefront (4 m)", machineId: "devbox" },
  { kind: "train", text: "Merging PR #251 into acme/storefront" },
];

type Progress = { readonly state: string; readonly to: string; readonly text: string; readonly at: string };
const progress = (s: string, text: string): Progress => ({ state: s, to: NEXT, text, at: AT });

/** The seq after the snapshot's cursor and every event the fixture has. */
const nextSeq = (f: Fixture): number =>
  Math.max(typeof f.snapshot?.["cursor"] === "number" ? f.snapshot["cursor"] : 0, ...f.events.map((e) => (typeof e["seq"] === "number" ? e["seq"] : 0))) + 1;

export default defineGroup({
  fixtures: (base) => {
    const make = (what: string, note: string, app: UpdatesState["app"], release?: Release | null): Fixture => {
      const f = Fixture.from(base("typical"), `updates-${what}`, note);
      f.appUpdate = state(app, release);
      // A hub on this app's build, so the app's own states show beside an up to date hub.
      if (f.state.phase === "live") f.state = { ...f.state, version: MINE };
      return f;
    };
    /** The hub running `version` (its ready frame), and, when given, an update of it under way. */
    const withHub = (what: string, note: string, version: string, update?: Progress, release: Release = RELEASE): Fixture => {
      const f = make(what, note, { kind: "current" }, release);
      if (f.state.phase === "live") f.state = { ...f.state, version };
      f.pendingContracts.set("hub_update", PENDING);
      f.pendingContracts.set("hub.update", PENDING);
      if (update !== undefined) f.events.push({ seq: nextSeq(f), at: AT, type: "hub.update", summary: update.text, data: { version, update: { ...update } } });
      f.answer("hub_info", {}, { version, protocol: 1, channel: "nightly", startedAt: AT, busy: BUSY });
      return f;
    };

    // Update the hub, on a newer CLI than the hub's: it waits for the work there (the event), with Restart the hub now.
    const available = withHub("hub-available", "The channel has a newer hub than the one running, which can update itself.", MINE, undefined, { ...RELEASE, cli: NEXT });
    const waiting = progress("waiting", "Updates once the storefront lead and 2 agents finish");
    available.answer("hub_update", { when: "idle" }, { hub: { version: MINE, update: { ...waiting } } });
    available.then("hub_update", { when: "idle" }, {
      frames: [{ ms: 200, kind: "event", payload: { seq: nextSeq(available), at: AT, type: "hub.update", summary: waiting.text, data: { version: MINE, update: { ...waiting } } } }],
    });

    // The hub is older than this app; Update the hub is refused (an app key, not a person's), so the command shows.
    const behind = withHub("hub-behind", "The hub runs an older nightly than this app: a warning, and Update the hub.", OLDER);
    behind.fail("hub_update", { when: "idle" }, { code: "forbidden", message: "Only a person's key can update the hub." });

    return [
      available,
      behind,
      withHub("hub-waiting", "An update of the hub waits for its work; Restart the hub now asks first, naming what it stops.", MINE, waiting),
      withHub("hub-installing", "The hub installs the update.", MINE, progress("installing", "Downloading and checking the new build")),
      withHub("hub-restarting", "The hub restarts into the update; the connection drops for a moment.", MINE, progress("restarting", "Restarting into the new build")),
      withHub("hub-failed", "The hub couldn't update.", MINE, progress("failed", "The download was damaged, so nothing changed. Try again.")),
      withHub("hub-current", "The hub runs this app's build, the newest on the channel.", MINE),
      withHub("hub-unknown", "The hub reports 0.0.0 (a local build): its version is unknown, and nothing is flagged.", "0.0.0"),
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
