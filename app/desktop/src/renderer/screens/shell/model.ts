// What the frame shows, as plain view data: the sidebar's projects with their two marks, the home project, the
// connection line. Pure, so it is unit-tested. The rows come from the data layer's selectProjectList.
import type { HubState } from "../../../shared/hub";
import type { ProjectKey } from "./routes";

export interface SidebarProject {
  readonly key: ProjectKey;
  readonly title: string;
  /** The lead is waiting for your reply. */
  readonly needsYou: boolean;
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
}

/** Undefined until this connection's projects loaded (startup, and after every link drop): not "no projects". */
export const toSidebar = (rows: ReadonlyArray<ProjectRowIn> | undefined): ReadonlyArray<SidebarProject> | undefined =>
  rows?.map((r) => ({
    key: { machineId: r.project.machineId, projectId: r.project.projectId },
    title: r.project.title,
    needsYou: r.needsYou,
    working: r.working,
    running: r.running,
  }));

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

/** The sidebar's last line. A fixture never says it is connected; a retry says why rather than counting down. */
export const connLine = (state: HubState | null, fixture = false): { readonly label: string; readonly tone: ConnTone } => {
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
      // Main words the reason (hub/explain.ts), so it is shown as it comes.
      return { label: `Reconnecting: ${state.reason}`, tone: "warning" };
    case "refused":
      return { label: "The hub refused this key", tone: "danger" };
  }
};
