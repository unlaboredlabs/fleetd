// C1: the app's own update, one fixture per state (main's fixture updater reads each one's `update` section in place
// of the release feed), around typical's data so the sidebar line and the sheet are shot in a full window.
import type { UpdatesState } from "../../src/shared/updates.ts";
import { defineGroup } from "../kit/group.ts";
import { Fixture } from "../kit/fixture.ts";
import type { JsonObject } from "../kit/json.ts";

const MINE = "0.6.0-nightly.202610221030+4f1c2ab";
const NEXT = "0.6.0-nightly.202610231030+9e07d31";
const NOTES = [
  "Updates show in the app, with what's new and one click to restart",
  "Drafts in the chat composer survive a restart",
  "The live strip names the agent waiting on you",
  "`fleetd status` says how long each project has been idle",
  "Status loads faster with many projects, and long project names wrap instead of pushing the counts off the row",
];

const state = (app: UpdatesState["app"]): JsonObject => ({ current: MINE, app }) as unknown as JsonObject;

/** C2's contract (FleetStatus.hub, hub.update, hub_update) is still on its branch; these skip its schema until it merges. */
const PENDING = "C2: the hub's version and hub_update, on feat/safe-update";
const AT = "2026-10-19T10:00:00.000Z";
const RUNNING = ["The lead is working on storefront", "2 agents are running in storefront"];

const hubVersion = (over: JsonObject = {}): JsonObject => ({
  version: MINE,
  channel: "nightly",
  latest: NEXT,
  updateAvailable: true,
  notes: NOTES.slice(0, 3),
  checkedAt: AT,
  ...over,
});
const progress = (state: string, text: string): JsonObject => ({ state, to: NEXT, text, at: AT });

export default defineGroup({
  fixtures: (base) => {
    const make = (what: string, note: string, app: UpdatesState["app"]): Fixture => {
      const f = Fixture.from(base("typical"), `updates-${what}`, note);
      f.appUpdate = state(app);
      return f;
    };
    const withHub = (what: string, note: string, hub: JsonObject): Fixture => {
      const f = make(what, note, { kind: "current" });
      f.snapshot = { ...f.snapshot, hub };
      f.pendingContracts.set("fleetd_status", PENDING);
      f.pendingContracts.set("hub_update", PENDING);
      return f;
    };
    const behind = withHub("hub-behind", "The hub's machine is on an older nightly than its channel's newest: Update devbox.", hubVersion());
    // Update devbox: work runs there, so the update waits for it (the event), and Update now asks first with what it stops.
    const waiting = hubVersion({ update: progress("waiting", "Updates once the lead and 2 agents in storefront finish") });
    const cursor = typeof behind.snapshot?.["cursor"] === "number" ? behind.snapshot["cursor"] : 0;
    behind.answer("hub_update", { when: "idle" }, { hub: waiting, running: RUNNING });
    behind.then("hub_update", { when: "idle" }, {
      frames: [{ ms: 200, kind: "event", payload: { seq: cursor + 1, at: AT, type: "hub.update", summary: "Updates once the lead and 2 agents in storefront finish", data: waiting } }],
    });
    return [
      behind,
      withHub("hub-waiting", "An update to the hub's machine waits for its work to finish.", waiting),
      withHub("hub-installing", "The hub's machine installs the update.", hubVersion({ update: progress("installing", "Installing the update") })),
      withHub("hub-failed", "The hub's machine couldn't update.", hubVersion({ update: progress("failed", "The download was damaged, so nothing changed. Try again.") })),
      withHub(
        "hub-older",
        "The hub runs an older stable release, and its channel has nothing newer: the command for this app's channel.",
        hubVersion({ version: "0.5.0", channel: "stable", latest: "0.5.0", updateAvailable: false, notes: [] }),
      ),
      make("current", "This app is up to date (the sheet after Check for Updates).", { kind: "current" }),
      make("available", "A newer nightly found and downloading in the background: Update and restart, with what's new.", {
        kind: "available",
        version: NEXT,
        notes: NOTES,
        percent: 18,
        restart: false,
      }),
      make("downloading", "Update and restart chosen while the download runs: restarts once it's in.", {
        kind: "available",
        version: NEXT,
        notes: NOTES,
        percent: 42,
        restart: true,
      }),
      make("ready", "Downloaded: Restart to update.", { kind: "ready", version: NEXT, notes: NOTES }),
      make("deb", "The deb, which can't update itself: the download and the apt command.", { kind: "manual", version: NEXT, notes: NOTES.slice(0, 2) }),
      make("failed", "An asked-for check that found no release server.", {
        kind: "failed",
        during: "check",
        reason: "The release server didn't answer. Check your connection and try again.",
      }),
    ];
  },
});
