// The quiet update indicator: one word under your name in the sidebar ("Update", "Updating…", "Updated", "Not
// updated") while there is something to say, and what the menu there says with it (shell/youMenu.ts): the status's
// title (model.ts) and its one button. A hub that closed to restart is "Updating…" and nothing else for its first
// 30 s; past that the main area's one line says it isn't back yet, and past 2 minutes it is an outage, shown as one.
// Pure, so every state is unit-tested.
import type { HubUpdateData } from "../../../shared/contracts";
import type { HubState } from "../../../shared/hub";
import { restartOf } from "../shell/model";
import { FAILED_SHOWN_MS, RESULT_SHOWN_MS, type Act, type Status } from "./model";

export type QuietKind = "restarting" | "updating" | "failed" | "updated" | "available";

export interface Word {
  readonly text: "Update" | "Updating…" | "Updated" | "Not updated";
  readonly tone: "accent" | "quiet" | "danger";
}

export interface Note {
  readonly title: string;
  readonly action?: { readonly label: string; readonly act: Act };
  /** Settings › Hub › Updates has more to read (a machine that didn't update or is behind), for an admin. */
  readonly details: boolean;
  /** With "Updated": when, epoch ms. */
  readonly at?: number;
}

export interface Quiet {
  readonly kind: QuietKind;
  readonly word: Word;
  /** Null while the hub restarts: the hub's own line in the menu says it. */
  readonly note: Note | null;
}

export interface QuietInput {
  readonly status: Status;
  readonly hub: HubState;
  /** The last time a link came back on a newer fleetd, in this window (store.ts `updated`). */
  readonly updated?: { readonly from: string; readonly to: string; readonly at: number } | undefined;
  /** The hub's update as it tells everyone (the snapshot's and `hub.update`'s): what someone who can't update reads. */
  readonly update?: HubUpdateData | undefined;
  readonly administers: boolean;
  readonly now: number;
}

const WORDS: Readonly<Record<QuietKind, Word>> = {
  restarting: { text: "Updating…", tone: "quiet" },
  updating: { text: "Updating…", tone: "quiet" },
  failed: { text: "Not updated", tone: "danger" },
  updated: { text: "Updated", tone: "quiet" },
  available: { text: "Update", tone: "accent" },
};

const quiet = (kind: QuietKind, note: Note | null): Quiet => ({ kind, word: WORDS[kind], note });

/** Whether the hub's last update didn't go in, lately, by its own word. */
const hubFailed = (u: HubUpdateData | undefined, now: number): boolean =>
  u?.finishedAt !== undefined && (u.state === "put_back" || u.state === "failed") && now - Date.parse(u.finishedAt) < FAILED_SHOWN_MS;

/** The word and its note; null when there is nothing to say. */
export const quietOf = ({ status, hub, updated, update, administers, now }: QuietInput): Quiet | null => {
  // An update restarting says so; any other restart or stop says nothing of updates.
  const restart = restartOf(hub, now);
  if (restart !== null) return restart.to !== null && restart.phase !== "outage" ? quiet("restarting", null) : null;
  const details = administers && status.rows.length > 0;
  const note: Note = {
    title: status.title,
    ...(status.action === undefined ? {} : { action: status.action }),
    details,
  };
  if (status.kind === "updating" || status.kind === "failed") return quiet(status.kind, note);
  // An admin reads the run, with its button. Anyone else reads only that it didn't go in, and who to ask (youMenu.ts).
  if (!administers && hubFailed(update, now)) return quiet("failed", { title: "Not updated", details: false });
  if (status.kind === "available") return status.quiet === true ? null : quiet("available", note);
  if (status.kind !== "current") return null;
  // An update this window followed, or one it only saw land: the link came back on a newer fleetd.
  const at = status.updatedAt ?? (updated !== undefined && now - updated.at < RESULT_SHOWN_MS ? updated.at : undefined);
  return at === undefined ? null : quiet("updated", { title: "Updated", details, at });
};
