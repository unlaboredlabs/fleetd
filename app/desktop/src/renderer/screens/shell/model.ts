// What the frame shows, as plain view data: the sidebar's projects with their two marks, the home project, the
// connection line. Pure, so it is unit-tested. The rows come from the data layer's selectProjectList.
import type { HubState } from "../../../shared/hub";
import type { ProjectKey } from "./routes";

/** Why a project wants you: a secret to enter, a command to approve, a reply, or something outside the work. */
export type WantWord = "secret" | "approve" | "reply" | "blocked";

export interface Want {
  /** Undefined while the lead waits on you but the open requests haven't loaded yet: the dot alone, no guess. */
  readonly word: WantWord | undefined;
  /** How many of that kind wait: secrets or approvals; 1 otherwise. */
  readonly count: number;
  /** The row's tooltip and accessible name for the mark. */
  readonly label: string;
}

export interface SidebarProject {
  readonly key: ProjectKey;
  readonly title: string;
  /** Why it wants you now; undefined when it doesn't. */
  readonly want: Want | undefined;
  /** The lead's chat has a message newer than the one you last saw there. */
  readonly unread: boolean;
  /** The lead or any agent is running. */
  readonly working: boolean;
  /** Agents running, the lead not counted. */
  readonly running: number;
}

/** The parts of a data-layer ProjectRow the frame reads. */
export interface ProjectRowIn {
  readonly project: { readonly machineId: string; readonly projectId: string; readonly title: string };
  readonly needsYou: boolean;
  readonly working: boolean;
  readonly running: number;
  readonly lastSeq?: number | undefined;
}

/** The parts of an open request (requests_list) the marks count. */
export interface RequestIn {
  readonly projectRef: ProjectKey;
  readonly kind: "secret" | "approval";
  readonly state: string;
}

/** What the rows' marks read besides the project rows. */
export interface MarksIn {
  /** The hub's requests; undefined until read. Only open ones count. */
  readonly requests?: ReadonlyArray<RequestIn> | undefined;
  /** Status's blocked projects (status_projects), by "machineId/projectId", with why. */
  readonly blocked?: ReadonlyMap<string, string | undefined> | undefined;
  /** The chat seq last seen per "machineId/projectId" (data/seen.ts). */
  readonly seen?: Readonly<Record<string, number>> | undefined;
  /** The project on screen: never unread. */
  readonly open?: ProjectKey | null | undefined;
}

const plural = (n: number, one: string, many: string): string => `${String(n)} ${n === 1 ? one : many}`;

/** The most pressing reason first: a secret or an approval blocks a run now; a reply, then a block outside the work. */
export const wantOf = (row: ProjectRowIn, key: string, marks: MarksIn): Want | undefined => {
  const open = marks.requests?.filter((r) => r.state === "open" && projectId(r.projectRef) === key);
  const secrets = open?.filter((r) => r.kind === "secret").length ?? 0;
  const approvals = open?.filter((r) => r.kind === "approval").length ?? 0;
  if (secrets > 0) return { word: "secret", count: secrets, label: `The lead needs ${plural(secrets, "secret", "secrets")} from you` };
  if (approvals > 0) return { word: "approve", count: approvals, label: `${plural(approvals, "command", "commands")} to approve` };
  if (row.needsYou) {
    return marks.requests === undefined
      ? { word: undefined, count: 1, label: "The lead is waiting on you" }
      : { word: "reply", count: 1, label: "The lead is waiting for your reply" };
  }
  if (marks.blocked?.has(key) === true) {
    const why = marks.blocked.get(key);
    return { word: "blocked", count: 1, label: why === undefined || why === "" ? "Blocked" : `Blocked: ${why}` };
  }
  return undefined;
};

/**
 * Undefined until this connection's projects loaded (startup, and after every link drop): not "no projects".
 * Alphabetical, whatever the layer's order: a project never moves as its agents start and stop, so ⌘1–9 and the
 * mouse keep their target; its state shows only as its marks.
 */
export const toSidebar = (rows: ReadonlyArray<ProjectRowIn> | undefined, marks: MarksIn = {}): ReadonlyArray<SidebarProject> | undefined =>
  rows
    ?.map((r): SidebarProject => {
      const key = { machineId: r.project.machineId, projectId: r.project.projectId };
      const id = projectId(key);
      const seen = marks.seen?.[id];
      const isOpen = marks.open != null && projectId(marks.open) === id;
      return {
        key,
        title: r.project.title,
        want: wantOf(r, id, marks),
        unread: !isOpen && r.lastSeq !== undefined && seen !== undefined && r.lastSeq > seen,
        working: r.working,
        running: r.running,
      };
    })
    .sort((a, b) => a.title.localeCompare(b.title) || projectId(a.key).localeCompare(projectId(b.key)));

/** The next project after `current` that wants you, in sidebar order and wrapping; null when no other one does. */
export const nextWanting = (projects: ReadonlyArray<SidebarProject>, current: ProjectKey | null): ProjectKey | null => {
  const at = current === null ? -1 : projects.findIndex((p) => projectId(p.key) === projectId(current));
  for (let i = 1; i <= projects.length; i++) {
    const p = projects[(at + i) % projects.length];
    if (p !== undefined && p.want !== undefined && (at === -1 || p !== projects[at])) return p.key;
  }
  return null;
};

export const projectId = (key: ProjectKey): string => `${key.machineId}/${key.projectId}`;

/** The project before or after `current` in the sidebar, wrapping; the first (or last) when none is open. */
export const stepProject = (projects: ReadonlyArray<SidebarProject>, current: ProjectKey | null, by: 1 | -1): ProjectKey | null => {
  if (projects.length === 0) return null;
  const at = current === null ? -1 : projects.findIndex((p) => projectId(p.key) === projectId(current));
  if (at === -1) return (by === 1 ? projects[0] : projects.at(-1))?.key ?? null;
  return projects[(at + by + projects.length) % projects.length]?.key ?? null;
};

/**
 * Where `#/` goes: the project you last had open when it still exists, else the first in the sidebar; null when
 * there are no projects (the frame offers to add one).
 */
export const homeProject = (projects: ReadonlyArray<SidebarProject>, last: string | null): ProjectKey | null =>
  (projects.find((p) => projectId(p.key) === last) ?? projects[0])?.key ?? null;

export type ConnTone = "success" | "warning" | "danger" | "quiet";

/** `http://100.64.0.1:4790/` → `100.64.0.1:4790`. */
const host = (hub: string): string => hub.replace(/^[a-z]+:\/\//iu, "").replace(/\/+$/u, "");

/**
 * The sidebar's last line. A fixture never says it is connected. Offline it marks the projects above it with the
 * time they were last current (`asOf`, "as of 09:02"); the banner says why and counts down.
 */
export const connLine = (state: HubState | null, fixture = false, asOf?: string): { readonly label: string; readonly tone: ConnTone } => {
  if (fixture) return { label: "Sample data, no hub", tone: "quiet" };
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
      return { label: asOf === undefined ? "Offline" : `Offline, ${asOf}`, tone: "warning" };
    case "refused":
      return { label: "The hub refused this key", tone: "danger" };
  }
};
