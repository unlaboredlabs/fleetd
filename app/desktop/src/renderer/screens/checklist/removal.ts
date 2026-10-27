// A person's Delete and Clear done on the Checklist tab. The items leave the list at once and a toast offers Undo; the
// hub hears of it (checklist_remove) only once that Undo is gone, so an undone removal never reaches the hub or the
// lead. One removal waits at a time: a second sends the first at once, and so does the window closing.
import { useSyncExternalStore } from "react";
import type { ChecklistGetOutput, TodoItem } from "../../../shared/contracts";
import { callKey, type DataLayer } from "../../src/data/queries";
import { projectKey } from "../../src/data/store";
import { toast } from "../../ui";
import type { ProjectKey } from "../shell/routes";

/** How long Undo stays: the toast's own time with an action. */
export const UNDO_MS = 8_000;

interface Waiting {
  readonly send: () => void;
  readonly timer: ReturnType<typeof setTimeout>;
  readonly dismiss: () => void;
}

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
  clearTimeout(w.timer);
  w.dismiss();
  w.send();
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
  const ids = items.map((i) => i.id);
  const show = (on: boolean) => {
    const now = new Set(hidden.get(key) ?? NONE);
    for (const id of ids) {
      if (on) now.add(id);
      else now.delete(id);
    }
    setHidden(key, now);
  };
  const send = () => {
    const projectRef = { machineId: project.machineId, projectId: project.projectId };
    void layer.call("checklist_remove", { projectRef, ids: [...ids] }).then((out) => {
      if (out.ok) {
        // The list after it, so the items don't flash back before checklist.changed reads it again.
        layer.queryClient.setQueryData<ChecklistGetOutput>(callKey("checklist_get", { projectRef }), (was) => (was === undefined ? was : out.output));
      } else {
        toast({ title: "Couldn’t remove it from the checklist", description: out.error.message, tone: "danger" });
      }
      show(false);
    });
  };
  const undo = () => {
    if (waiting?.send !== send) return;
    clearTimeout(waiting.timer);
    waiting = null;
    dismiss();
    show(false);
  };
  show(true);
  const dismiss = toast({ key: "checklist.removal", title, action: { label: "Undo", onClick: undo }, duration: UNDO_MS });
  waiting = { send, dismiss, timer: setTimeout(flush, UNDO_MS) };
};
