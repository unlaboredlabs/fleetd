// What the frame shows, as plain view data: the sidebar's projects and orders, the inbox count, the connection
// line. Pure, so it is unit-tested. The selector from E1's store fills `ShellData` (see useShellData).
import type { HubState } from "../../../shared/hub";
import type { ProjectKey } from "./routes";

export interface SidebarOrder {
  /** The order's number as people say it ("W14"). */
  readonly id: string;
  readonly title: string;
  /** It has an open ask. */
  readonly needsYou: boolean;
}

export interface SidebarProject {
  readonly key: ProjectKey;
  readonly title: string;
  /** The hub's fixed-width RFC 3339 UTC timestamp, so string order is time order. */
  readonly lastActivityAt: string;
  /** Open asks. */
  readonly needsYou: number;
  /** Its lead stalled. */
  readonly stalled: boolean;
  /** Agents working or starting now. */
  readonly running: number;
  /** Open orders, in the board's order. */
  readonly orders: ReadonlyArray<SidebarOrder>;
}

export interface ShellData {
  readonly projects: ReadonlyArray<SidebarProject>;
  readonly machinesDown: number;
  /** Open asks across the fleet. */
  readonly needsYou: number;
}

export const EMPTY_SHELL_DATA: ShellData = { projects: [], machinesDown: 0, needsYou: 0 };

export const projectId = (key: ProjectKey): string => `${key.machineId}\u0000${key.projectId}`;

/** The orders the sidebar lists, in its order; ⌘1..9 open the first nine, ⌘[ and ⌘] step through them. */
export const sidebarOrders = (projects: ReadonlyArray<SidebarProject>): Array<string> => projects.flatMap((p) => p.orders.map((o) => o.id));

/** The order before or after `current` in the sidebar, wrapping; the first (or last) when none is open. */
export const stepOrder = (orders: ReadonlyArray<string>, current: string | null, by: 1 | -1): string | null => {
  if (orders.length === 0) return null;
  const at = current === null ? -1 : orders.indexOf(current);
  if (at === -1) return (by === 1 ? orders[0] : orders.at(-1)) ?? null;
  return orders[(at + by + orders.length) % orders.length] ?? null;
};

/**
 * What you have seen of each project: its last activity time when you last looked. Kept for the session; what was
 * there when the app connected counts as seen, so a launch doesn't light up every project.
 */
export class Seen {
  readonly #at = new Map<string, string>();

  /** Records each project's activity time the first time it appears, as already seen. */
  prime(projects: ReadonlyArray<SidebarProject>): void {
    for (const p of projects) {
      const id = projectId(p.key);
      if (!this.#at.has(id)) this.#at.set(id, p.lastActivityAt);
    }
  }

  mark(key: ProjectKey, lastActivityAt: string): void {
    this.#at.set(projectId(key), lastActivityAt);
  }

  unread(key: ProjectKey, lastActivityAt: string): boolean {
    const seen = this.#at.get(projectId(key));
    return seen !== undefined && lastActivityAt > seen;
  }
}

export type ConnTone = "success" | "warning" | "danger" | "quiet";

/** `http://100.64.0.1:4790/` → `100.64.0.1:4790`. */
const host = (hub: string): string => hub.replace(/^[a-z]+:\/\//iu, "").replace(/\/+$/u, "");

/** The sidebar's last line. A retry says why rather than counting down, so nothing repaints every second. */
export const connLine = (state: HubState | null): { readonly label: string; readonly tone: ConnTone } => {
  switch (state?.phase) {
    case undefined:
      return { label: "Starting…", tone: "quiet" };
    case "unpaired":
      return { label: "Not connected to a hub", tone: "quiet" };
    case "connecting":
      return { label: `Connecting to ${host(state.hub)}…`, tone: "quiet" };
    case "live":
      return { label: `Connected to ${host(state.hub)}`, tone: "success" };
    case "retrying":
      return { label: `Reconnecting to ${host(state.hub)}: ${state.reason}`, tone: "warning" };
    case "refused":
      return { label: "The hub refused this key", tone: "danger" };
  }
};
