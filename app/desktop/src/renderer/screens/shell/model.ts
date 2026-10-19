// What the frame shows, as plain view data: the sidebar's projects and orders, the inbox count, the connection
// line. Pure, so it is unit-tested. `toShellData` reads the data layer's selector outputs (selectProjects,
// selectBoard, selectInbox, selectMachines); its inputs name only the fields it uses, in their generated shapes.
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
  /** Undefined until this connection's projects loaded (startup, and after every link drop): not "no projects". */
  readonly projects: ReadonlyArray<SidebarProject> | undefined;
  readonly machinesDown: number;
}


export const projectId = (key: ProjectKey): string => `${key.machineId}\u0000${key.projectId}`;

/** A finished or stopped order stays listed this long, as on the board (board.rs DONE_HOLD_SECS). */
export const DONE_HOLD_MS = 600_000;

/** Each input is undefined until it loaded for this connection, as the data layer's selectors give them. */
export interface ShellInputs {
  readonly projects: undefined | ReadonlyArray<{ readonly machineId: string; readonly projectId: string; readonly title: string; readonly lastActivityAt: string }>;
  /** Board order: by phase, then most recently updated. */
  readonly board: undefined | ReadonlyArray<{
    readonly card: {
      readonly workstreamId: string;
      readonly title: string;
      readonly projectRef: ProjectKey;
      readonly updatedAt: string;
    };
    readonly phase: { readonly phase: string };
    readonly asks: ReadonlyArray<unknown>;
    readonly lanes: ReadonlyArray<{ readonly status: string }>;
  }>;
  readonly inbox: undefined | ReadonlyArray<{ readonly ask: { readonly projectRef?: ProjectKey | undefined } }>;
  readonly machines: undefined | ReadonlyArray<{ readonly machine: { readonly status: string } }>;
  /** The lead lanes' live statuses, by project. */
  readonly leadStatus: (key: ProjectKey) => string | undefined;
}

const finished = (phase: string): boolean => phase === "done" || phase === "stopped";

export const toShellData = (inputs: ShellInputs, nowMs: number): ShellData => {
  // Orders and needs-you marks appear once the board and the asks have loaded; until then a project shows neither,
  // rather than claiming it has none.
  const needs = new Map<string, number>();
  for (const { ask } of inputs.inbox ?? []) {
    if (ask.projectRef === undefined) continue;
    const id = projectId(ask.projectRef);
    needs.set(id, (needs.get(id) ?? 0) + 1);
  }
  const orders = new Map<string, Array<NonNullable<ShellInputs["board"]>[number]>>();
  for (const view of inputs.board ?? []) {
    const done = finished(view.phase.phase);
    if (done && !(nowMs - Date.parse(view.card.updatedAt) < DONE_HOLD_MS)) continue;
    const id = projectId(view.card.projectRef);
    orders.set(id, [...(orders.get(id) ?? []), view]);
  }
  const projects = inputs.projects?.map((p): SidebarProject => {
    const key = { machineId: p.machineId, projectId: p.projectId };
    const mine = orders.get(projectId(key)) ?? [];
    return {
      key,
      title: p.title,
      lastActivityAt: p.lastActivityAt,
      needsYou: needs.get(projectId(key)) ?? 0,
      stalled: inputs.leadStatus(key) === "stalled",
      running: mine.reduce((n, v) => n + v.lanes.filter((l) => l.status === "working" || l.status === "starting").length, 0),
      orders: mine.map((v) => ({ id: v.card.workstreamId, title: v.card.title, needsYou: v.asks.length > 0 })),
    };
  });
  return {
    projects,
    machinesDown: (inputs.machines ?? []).filter((m) => m.machine.status !== "online").length,
  };
};

/** The orders the sidebar lists, in its order; ⌘1..9 open the first nine, ⌘[ and ⌘] step through them. */
export const sidebarOrders = (projects: ReadonlyArray<SidebarProject> | undefined): Array<string> => (projects ?? []).flatMap((p) => p.orders.map((o) => o.id));

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
    case "connecting":
      return { label: state.hub === "" ? "Connecting…" : `Connecting to ${host(state.hub)}…`, tone: "quiet" };
    case "unpaired":
      return { label: "Not connected to a hub", tone: "quiet" };
    case "live":
      return { label: `Connected to ${host(state.hub)}`, tone: "success" };
    case "retrying":
      return { label: `Reconnecting to ${host(state.hub)}: ${state.reason}`, tone: "warning" };
    case "refused":
      return { label: "The hub refused this key", tone: "danger" };
  }
};
