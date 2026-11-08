// The quiet update indicator: one word at the end of the sidebar's hub row ("Update", "Updating…", "Updated", "Put
// back") while there is something to say, and what goes with it in the row's popover. The hub's own word on its update
// (the snapshot's and each hub.update event's) comes first; a hub from before it is read by its run. A hub that closed to restart is
// "Updating…" and nothing else for its first 30 s; past that the main area's one line says it isn't back yet, and
// past 2 minutes it is an outage, shown as one. An admin reads what changed and acts from the popover; a member
// reads only where it stands. Pure, so every state is unit-tested.
import type { HubUpdateData } from "../../../shared/contracts";
import type { HubState } from "../../../shared/hub";
import { restartOf } from "../shell/model";
import { notesSince, versionLabel, type Release } from "../../../shared/updates";
import { clockAt, FAILED_SHOWN_MS, NOTES_SHOWN, RESULT_SHOWN_MS, type UpdatesView } from "./model";

export type QuietKind = "restarting" | "updating" | "putBack" | "updated" | "available";

export interface Word {
  readonly text: "Update" | "Updating…" | "Updated" | "Put back";
  readonly tone: "accent" | "quiet" | "danger";
}

/** What Note's button does. */
export type NoteAction = "update" | "updateNow" | "retry" | "restartApp";

export interface Note {
  readonly title: string;
  readonly danger?: boolean;
  /** When, beside the title: "21:14". */
  readonly aside?: string;
  /** One or two plain sentences. */
  readonly body?: string;
  /** What's new, a few plain lines. */
  readonly notes: readonly string[];
  readonly action?: { readonly label: string; readonly run: NoteAction };
  /** A link to Settings › Hub › Updates, for an admin. */
  readonly details: boolean;
}

export interface Quiet {
  readonly kind: QuietKind;
  readonly word: Word;
  /** Null while the hub restarts: the popover's own status says it. */
  readonly note: Note | null;
}

export interface QuietInput {
  readonly view: UpdatesView;
  readonly hub: HubState;
  /** The last time a link came back on a newer fleetd, in this window (store.ts `updated`). */
  readonly updated?: { readonly from: string; readonly to: string; readonly at: number } | undefined;
  readonly release?: Release | null | undefined;
  /** The hub's update as it says it (the snapshot's and `hub.update`'s): first; absent from a hub before it. */
  readonly update?: HubUpdateData | undefined;
  readonly administers: boolean;
  readonly now: number;
  readonly timeZone?: string;
}

const WORDS: Readonly<Record<QuietKind, Word>> = {
  restarting: { text: "Updating…", tone: "quiet" },
  updating: { text: "Updating…", tone: "quiet" },
  putBack: { text: "Put back", tone: "danger" },
  updated: { text: "Updated", tone: "quiet" },
  available: { text: "Update", tone: "accent" },
};

const quiet = (kind: QuietKind, note: Note | null): Quiet => ({ kind, word: WORDS[kind], note });

/** A version as a title says it: an Edge build without its commit, which says nothing to a person (Details has it). */
const titled = (label: string): string => label.replace(/ · [0-9a-f]{7,}\b/u, "");

/** `a`, `a and b`, `a, b and c`. */
const listed = (names: readonly string[]): string => (names.length < 2 ? names.join("") : `${names.slice(0, -1).join(", ")} and ${names.at(-1) ?? ""}`);

/** What's new to the hub since `from`, a few lines, for an admin. */
const newSince = (from: string | null, release: Release | null | undefined, administers: boolean): string[] =>
  administers && from !== null && release !== null && release !== undefined ? notesSince(release.changes, from, "hub").lines.slice(0, NOTES_SHOWN) : [];

/** The machines that didn't take the build: failed or put back. A skipped one is left out, as the run's words leave it
 * out: the signal doesn't say whether it was only offline. */
const missedOf = (u: HubUpdateData): string[] => u.machines.filter((m) => m.state === "failed" || m.state === "rolled_back").map((m) => m.name);

/** Put back: which part didn't take the build and why, with Try again for an admin. */
const putBack = (u: HubUpdateData, to: string, { administers }: QuietInput): Quiet => {
  const missed = missedOf(u);
  const names = listed(u.hub === "failed" || u.hub === "rolled_back" ? ["the hub", ...missed] : missed);
  const said = u.message === undefined ? "" : `${u.message.replace(/\.$/u, "")}. `;
  return quiet("putBack", {
    title: names === "" ? `The update to ${to} didn't go in` : `${to} didn't go in on ${names}`,
    danger: true,
    notes: [],
    body: administers ? `${said}It runs its old build, and nothing was lost.` : "It runs its old build, and nothing was lost. An admin can try it again.",
    ...(administers ? { action: { label: "Try again", run: "retry" as const } } : {}),
    details: administers,
  });
};

/** The hub's own word on its update (hub.update): going on, or finished lately; undefined when it has nothing to say. */
const ofHub = (u: HubUpdateData, input: QuietInput): Quiet | undefined => {
  const { view, release, administers, now, timeZone } = input;
  const admin = { details: administers };
  const to = u.to === undefined ? "the new build" : titled(versionLabel(u.to));
  const ago = u.finishedAt === undefined ? 0 : now - Date.parse(u.finishedAt);
  switch (u.state) {
    case "updating": {
      const back = u.machines.filter((m) => m.state === "done" || m.state === "current").length;
      const of = u.machines.length + (u.moreMachines ?? 0);
      const progress = u.hub === "restarting" || u.hub === "downloading" || u.hub === "waiting" ? "The hub first, then its machines." : `${String(back)} of ${String(of)} machines on it.`;
      return quiet("updating", {
        title: `Updating to ${to}`,
        notes: [],
        ...(administers && of > 0 ? { body: progress } : {}),
        ...(administers && view.updateNow ? { action: { label: "Update now", run: "updateNow" as const } } : {}),
        ...admin,
      });
    }
    case "updated":
      // The hub updated, but a machine didn't take the build: it is put back there, as the run says (the hub's signal
      // says it only in `machines`).
      if (missedOf(u).length > 0) return ago >= FAILED_SHOWN_MS ? undefined : putBack(u, to, input);
      if (ago >= RESULT_SHOWN_MS) return undefined;
      return quiet("updated", {
        title: `Updated to ${to}`,
        notes: newSince(u.from, release, administers),
        ...(u.finishedAt === undefined ? {} : { aside: clockAt(u.finishedAt, timeZone) }),
        ...admin,
      });
    case "put_back":
    case "failed":
      return ago >= FAILED_SHOWN_MS ? undefined : putBack(u, to, input);
    default:
      return undefined;
  }
};

/** The row's word and its note, the most pressing first; null when there is nothing to say. */
export const quietOf = (input: QuietInput): Quiet | null => {
  const { view, hub, updated, release, administers, now, timeZone } = input;
  // An update restarting says so; any other restart or stop says nothing of updates.
  const restart = restartOf(hub, now);
  if (restart !== null) return restart.to !== null && restart.phase !== "outage" ? quiet("restarting", null) : null;
  // The hub's own word first; a hub before it, or one with nothing to say, by its run and this window's flow.
  const said = input.update === undefined ? undefined : ofHub(input.update, input);
  if (said !== undefined) return said;
  const admin = { details: administers };
  const line = view.line;
  const to = view.to === null ? "the new build" : titled(view.to);

  // A run going on, or this app downloading the update it restarts into (the model's quiet line that isn't "Updated").
  if (view.going || view.running || (line?.tone === "quiet" && line.done !== true)) {
    // This app's own download, after Update and restart, when no run goes on.
    if (view.progress === null && view.app !== null) return quiet("updating", { title: view.app.title, notes: [], ...(view.app.detail === undefined ? {} : { body: view.app.detail }), details: false });
    return quiet("updating", {
      title: `Updating to ${to}`,
      notes: [],
      ...(administers && view.progress !== null ? { body: view.progress.text } : {}),
      ...(administers && view.updateNow ? { action: { label: "Update now", run: "updateNow" as const } } : {}),
      ...admin,
    });
  }

  if (line?.tone === "danger") {
    const failed = view.lines.filter((l) => l.tone === "danger");
    const names = listed(failed.map((l) => (l.key === "hub" ? "the hub" : l.name)));
    return quiet("putBack", {
      title: names === "" ? "The update didn't go through" : `${to} didn't go in on ${names}`,
      danger: true,
      notes: [],
      body: administers
        ? [...failed.flatMap((l) => (l.reason === undefined ? [] : [`${l.name}: ${l.reason}.`])), "It runs its old build, and nothing was lost."].join(" ")
        : "It runs its old build, and nothing was lost. An admin can try it again.",
      ...(administers ? { action: { label: "Try again", run: "retry" as const } } : {}),
      ...admin,
    });
  }

  const recent = updated !== undefined && now - updated.at < RESULT_SHOWN_MS ? updated : undefined;
  if (line?.done === true || recent !== undefined) {
    const label = recent !== undefined ? titled(versionLabel(recent.to)) : to;
    const at = recent !== undefined ? new Date(recent.at).toISOString() : view.finishedAt;
    const notes = newSince(recent?.from ?? view.from, release, administers);
    return quiet("updated", { title: `Updated to ${label}`, notes, ...(at === null ? {} : { aside: clockAt(at, timeZone) }), ...admin });
  }

  if (line?.tone === "accent") {
    // An admin's update of the hub, its machines and this app; else this app's own.
    if (view.update !== null) return quiet("available", { title: titled(view.update.title), notes: view.update.notes.lines, action: { label: "Update now", run: "update" }, ...admin });
    const app = view.app;
    if (app?.action?.primary === true) {
      return quiet("available", {
        title: app.title,
        notes: app.notes.lines.slice(0, NOTES_SHOWN),
        ...(app.detail === undefined ? {} : { body: app.detail }),
        action: { label: app.action.label, run: "restartApp" },
        details: false,
      });
    }
  }
  return null;
};
