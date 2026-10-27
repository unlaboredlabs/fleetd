// A person's Delete and Clear done on the Checklist tab. The items leave the list at once and a toast offers Undo; the
// hub hears of it (checklist_remove) only once that Undo is gone, so an undone removal never reaches the hub or the
// lead. Undo's time stops while the toast does (the pointer or focus on it, the window in the background). One removal
// waits at a time: a second sends the first at once, and so does the window closing. Each is kept in localStorage
// until the hub answers it, so one the app quit before sending goes at the next launch (`sendKept`) instead of the
// items coming back. Only the app's own window sends those: a session's window shares the storage, and starts while
// the app's removal may still be waiting out its Undo.
import { useSyncExternalStore } from "react";
import type { ChecklistGetOutput, ProjectRef, TodoItem } from "../../../shared/contracts";
import { callKey, type DataLayer } from "../../src/data/queries";
import { projectKey } from "../../src/data/store";
import { toast } from "../../ui";
import { parseHash, type ProjectKey } from "../shell/routes";

/** How long Undo stays: the toast's own time with an action. */
export const UNDO_MS = 8_000;

interface Waiting {
  readonly send: () => void;
  readonly dismiss: () => void;
  /** Running toward the send; null while the toast is paused. */
  timer: ReturnType<typeof setTimeout> | null;
  /** Undo's time left as of `since`. */
  left: number;
  since: number;
}

/** A removal the hub hasn't answered yet. */
interface Kept {
  readonly projectRef: ProjectRef;
  readonly ids: readonly number[];
}

const KEY = "fleetd.checklistRemovals";

const NONE: ReadonlySet<number> = new Set();
// By project: the ids off the list on screen, waiting out their Undo or on their way to the hub.
let hidden: ReadonlyMap<string, ReadonlySet<number>> = new Map();
let waiting: Waiting | null = null;
const listeners = new Set<() => void>();

const setHidden = (key: string, ids: ReadonlySet<number>) => {
  const next = new Map(hidden);
  if (ids.size === 0) next.delete(key);
  else next.set(key, ids);
  hidden = next;
  for (const l of listeners) l();
};

const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => listeners.delete(l);
};

const isKept = (k: unknown): k is Kept => {
  if (typeof k !== "object" || k === null) return false;
  const { projectRef, ids } = k as Record<string, unknown>;
  const r = projectRef as Record<string, unknown> | null | undefined;
  return typeof r?.["machineId"] === "string" && typeof r["projectId"] === "string" && Array.isArray(ids) && ids.length > 0 && ids.every((id) => typeof id === "number");
};

const readKept = (): Kept[] => {
  try {
    const raw = JSON.parse(window.localStorage.getItem(KEY) ?? "[]") as unknown;
    return Array.isArray(raw) ? raw.filter(isKept) : [];
  } catch {
    return [];
  }
};

const writeKept = (kept: readonly Kept[]) => {
  try {
    if (kept.length === 0) window.localStorage.removeItem(KEY);
    else window.localStorage.setItem(KEY, JSON.stringify(kept));
  } catch {
    // Without storage, a removal the app quits before sending is lost: its items come back.
  }
};

const keep = (k: Kept) => {
  writeKept([...readKept(), k]);
};

const forget = (k: Kept) => {
  const same = (o: Kept) => projectKey(o.projectRef) === projectKey(k.projectRef) && o.ids.join() === k.ids.join();
  const kept = readKept();
  const at = kept.findIndex(same);
  if (at >= 0) writeKept(kept.toSpliced(at, 1));
};

/** The project's items as the tab shows them: without the ones a person just removed. */
export const useShown = (project: ProjectKey, items: readonly TodoItem[] | undefined): readonly TodoItem[] | undefined => {
  const gone = useSyncExternalStore(subscribe, () => hidden.get(projectKey(project)) ?? NONE);
  return items === undefined || gone.size === 0 ? items : items.filter((i) => !gone.has(i.id));
};

/** Sends the removal waiting out its Undo now. */
export const flush = () => {
  const w = waiting;
  if (w === null) return;
  waiting = null;
  if (w.timer !== null) clearTimeout(w.timer);
  w.dismiss();
  w.send();
};

/** Undo's time stops with the toast's, so it can't run out under the pointer. */
const pause = () => {
  const w = waiting;
  if (w?.timer == null) return;
  clearTimeout(w.timer);
  w.timer = null;
  w.left = Math.max(0, w.left - (Date.now() - w.since));
};

const resume = () => {
  const w = waiting;
  if (w === null || w.timer !== null) return;
  w.since = Date.now();
  w.timer = setTimeout(flush, w.left);
};

let unloadHooked = false;

/** Takes `items` off the project's list, with Undo; `title` is what the toast says ("Deleted …", "Cleared …"). */
export const removeItems = (layer: DataLayer, project: ProjectKey, items: readonly TodoItem[], title: string) => {
  if (items.length === 0) return;
  flush();
  if (!unloadHooked) {
    unloadHooked = true;
    window.addEventListener("pagehide", flush);
  }
  const key = projectKey(project);
  const kept: Kept = { projectRef: { machineId: project.machineId, projectId: project.projectId }, ids: items.map((i) => i.id) };
  const show = (on: boolean) => {
    const now = new Set(hidden.get(key) ?? NONE);
    for (const id of kept.ids) {
      if (on) now.add(id);
      else now.delete(id);
    }
    setHidden(key, now);
  };
  const send = () => {
    void sendOne(layer, kept).then(() => {
      show(false);
    });
  };
  const undo = () => {
    if (waiting?.send !== send) return;
    if (waiting.timer !== null) clearTimeout(waiting.timer);
    waiting = null;
    forget(kept);
    dismiss();
    show(false);
  };
  keep(kept);
  show(true);
  const dismiss = toast({ key: "checklist.removal", title, action: { label: "Undo", onClick: undo }, duration: UNDO_MS, onPause: pause, onResume: resume });
  waiting = { send, dismiss, timer: setTimeout(flush, UNDO_MS), left: UNDO_MS, since: Date.now() };
};

/** One removal to the hub; once it answers, it is no longer kept. */
const sendOne = async (layer: DataLayer, kept: Kept) => {
  const { projectRef } = kept;
  const out = await layer.call("checklist_remove", { projectRef, ids: [...kept.ids] });
  forget(kept);
  if (out.ok) {
    // The list after it, so the items don't flash back before checklist.changed reads it again.
    layer.queryClient.setQueryData<ChecklistGetOutput>(callKey("checklist_get", { projectRef }), (was) => (was === undefined ? was : out.output));
  } else {
    toast({ title: "Couldn’t remove it from the checklist", description: out.error.message, tone: "danger" });
  }
};

/**
 * At launch: the removals an earlier run kept but never sent (the app quit within their Undo), once connected. In the
 * app's window only (`hash`, the one it opened on), never a session's.
 */
export const sendKept = (layer: DataLayer, hash: string = window.location.hash) => {
  if (parseHash(hash).id === "session") return;
  const kept = readKept();
  if (kept.length === 0) return;
  const go = () => {
    for (const k of kept) void sendOne(layer, k);
  };
  if (layer.store.getState().fresh) {
    go();
    return;
  }
  const stop = layer.store.subscribe((s) => {
    if (!s.fresh) return;
    stop();
    go();
  });
};
