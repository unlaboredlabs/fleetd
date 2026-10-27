// Which sessions are open in a window of their own (the pop-out, for taking over), as every window of the app sees it:
// a session's window says so as it opens and as it goes, on a channel the app's windows share, and answers when a
// window that opened later asks. The main window then shows that session there instead of in its own panel.
import { useSyncExternalStore } from "react";
import type { ProjectKey } from "../shell/routes";
import { FIRST_HUB } from "../../../shared/hubs";

type Message = { readonly t: "open" | "closed"; readonly id: string } | { readonly t: "ask" };

const channel = typeof BroadcastChannel === "undefined" ? undefined : new BroadcastChannel("fleetd-session-windows");
/** The session this window shows on its own, when it is a session's window. */
let mine: string | undefined;
let open: ReadonlySet<string> = new Set();
const listeners = new Set<() => void>();

const set = (id: string, on: boolean) => {
  if (open.has(id) === on) return;
  const next = new Set(open);
  if (on) next.add(id);
  else next.delete(id);
  open = next;
  for (const l of listeners) l();
};

channel?.addEventListener("message", (e: MessageEvent<Message>) => {
  const m = e.data;
  if (m.t === "ask") {
    if (mine !== undefined) channel.postMessage({ t: "open", id: mine } satisfies Message);
  } else set(m.id, m.t === "open");
});
channel?.postMessage({ t: "ask" } satisfies Message);

/** This window shows session `id` on its own: the others hear it now, and again when it closes. */
export const announceWindow = (id: string): (() => void) => {
  mine = id;
  channel?.postMessage({ t: "open", id } satisfies Message);
  const closed = () => channel?.postMessage({ t: "closed", id } satisfies Message);
  window.addEventListener("pagehide", closed);
  return () => {
    window.removeEventListener("pagehide", closed);
    closed();
    mine = undefined;
  };
};

const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => listeners.delete(l);
};

/** Whether session `id` is open in a window of its own (not this one). */
export const useInItsWindow = (id: string): boolean => useSyncExternalStore(subscribe, () => open.has(id));

/** Opens session `id` (on `hub`, the first when absent) in a window of its own, or brings that window forward. */
export const showWindow = (project: ProjectKey, id: string, hub?: string): void =>
  void window.fleetd.app.sessionWindow({ machineId: project.machineId, projectId: project.projectId, session: id, ...(hub === undefined || hub === FIRST_HUB ? {} : { hub }) });
