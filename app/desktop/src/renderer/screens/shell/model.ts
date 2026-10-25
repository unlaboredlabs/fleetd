// What the frame shows, as plain view data: the sidebar's projects with their two marks, the home project, the
// connection line. Pure, so it is unit-tested. The rows are the data layer's (selectShownProjects), in its order.
import type { HubState } from "../../../shared/hub";
import type { ProjectRow } from "../../src/data/selectors";
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

/** A project row with the sidebar's two marks. */
export interface SidebarProject extends ProjectRow {
  /** Why it wants you now; undefined when it doesn't. */
  readonly want: Want | undefined;
  /** The lead's chat has a message newer than the one you last saw there. */
  readonly unread: boolean;
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
  /** Status's blocked projects (status_get rows), by "machineId/projectId", with why. */
  readonly blocked?: ReadonlyMap<string, string | undefined> | undefined;
  /** The chat seq last seen per "machineId/projectId" (data/seen.ts). */
  readonly seen?: Readonly<Record<string, number>> | undefined;
  /** The project on screen: never unread. */
  readonly open?: ProjectKey | null | undefined;
}

const plural = (n: number, one: string, many: string): string => `${String(n)} ${n === 1 ? one : many}`;

/** The most pressing reason first: a secret or an approval blocks a run now; a reply, then a block outside the work. */
const wantOf = ({ key, needsYou }: ProjectRow, marks: MarksIn): Want | undefined => {
  const open = marks.requests?.filter((r) => r.state === "open" && projectId(r.projectRef) === key);
  const secrets = open?.filter((r) => r.kind === "secret").length ?? 0;
  const approvals = open?.filter((r) => r.kind === "approval").length ?? 0;
  if (secrets > 0) return { word: "secret", count: secrets, label: `The lead needs ${plural(secrets, "secret", "secrets")} from you` };
  if (approvals > 0) return { word: "approve", count: approvals, label: `${plural(approvals, "command", "commands")} to approve` };
  if (needsYou) {
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

/** Undefined until the projects loaded (startup, and after every link drop): not "no projects". */
export const toSidebar = (rows: ReadonlyArray<ProjectRow> | undefined, marks: MarksIn = {}): ReadonlyArray<SidebarProject> | undefined => {
  const open = marks.open == null ? null : projectId(marks.open);
  return rows?.map((r): SidebarProject => {
    const seen = marks.seen?.[r.key];
    const unread = r.key !== open && r.lastSeq !== undefined && seen !== undefined && r.lastSeq > seen;
    return { ...r, want: wantOf(r, marks), unread };
  });
};

/** The route of a sidebar project. */
export const routeOf = (p: SidebarProject): ProjectKey => ({ machineId: p.project.machineId, projectId: p.project.projectId });

/** The next project after `current` that wants you, in sidebar order and wrapping; null when no other one does. */
export const nextWanting = (projects: ReadonlyArray<SidebarProject>, current: ProjectKey | null): ProjectKey | null => {
  const at = current === null ? -1 : projects.findIndex((p) => p.key === projectId(current));
  for (let i = 1; i <= projects.length; i++) {
    const p = projects[(at + i) % projects.length];
    if (p !== undefined && p.want !== undefined && (at === -1 || p !== projects[at])) return routeOf(p);
  }
  return null;
};

export const projectId = (key: ProjectKey): string => `${key.machineId}/${key.projectId}`;

/** The project before or after `current` in the sidebar, wrapping; the first (or last) when none is open. */
export const stepProject = (projects: ReadonlyArray<SidebarProject>, current: ProjectKey | null, by: 1 | -1): ProjectKey | null => {
  if (projects.length === 0) return null;
  const at = current === null ? -1 : projects.findIndex((p) => p.key === projectId(current));
  const p = at === -1 ? (by === 1 ? projects[0] : projects.at(-1)) : projects[(at + by + projects.length) % projects.length];
  return p === undefined ? null : routeOf(p);
};

/**
 * Where `#/` goes: the project you last had open when it still exists, else the first in the sidebar; null when
 * there are no projects (the frame offers to add one).
 */
export const homeProject = (projects: ReadonlyArray<SidebarProject>, last: string | null): ProjectKey | null => {
  const p = projects.find((x) => x.key === last) ?? projects[0];
  return p === undefined ? null : routeOf(p);
};

export type ConnTone = "success" | "warning" | "danger" | "quiet";

/** `http://100.64.0.1:4790/` → `100.64.0.1:4790`. */
const host = (hub: string): string => hub.replace(/^[a-z]+:\/\//iu, "").replace(/\/.*$/u, "");

/**
 * What the sidebar calls a hub: the first label of its host (`https://forge.example.ts.net:4790` → `forge`). An
 * address has no such label, so it stays whole, without its port (`100.64.0.1`, `[fd7a::1]`).
 */
export const hubName = (hub: string): string => {
  const h = host(hub);
  if (h.startsWith("[")) return h.slice(0, h.indexOf("]") + 1);
  const bare = h.replace(/:\d*$/u, "");
  if (/^\d+(?:\.\d+){3}$/u.test(bare)) return bare;
  return bare.split(".")[0] ?? bare;
};

export interface ConnLine {
  /** The chip's words: the hub's short name while connected, else its state in a word or two. */
  readonly label: string;
  readonly tone: ConnTone;
  /** The state in a word or two ("Connected", "Offline"), the popover's heading. */
  readonly status: string;
  /** What is going on, in a sentence without a final period; null when the status says it all. */
  readonly detail: string | null;
  /** The hub's address in full, when there is one. */
  readonly hub: string | null;
  /** Waiting out a retry: Retry dials now. */
  readonly retry: boolean;
}

/**
 * The sidebar's hub chip, and its popover. A fixture never says it is connected. Offline the projects above it are
 * marked with the time they were last current (`asOf`, "as of 09:02"); the popover says it too, and the banner
 * counts down.
 */
export const connLine = (state: HubState, fixture = false, asOf?: string): ConnLine => {
  const none = { detail: null, hub: null, retry: false };
  if (fixture) return { ...none, label: "Sample data", tone: "quiet", status: "Sample data", detail: "Sample data, no hub" };
  switch (state.phase) {
    case "connecting": {
      const status = state.attempt > 1 ? "Reconnecting…" : "Connecting…";
      return { ...none, label: status, tone: "warning", status, hub: state.hub === "" ? null : state.hub };
    }
    case "unpaired":
      return { ...none, label: "No hub", tone: "quiet", status: "Not connected", detail: state.note ?? "This app isn't paired with a hub" };
    case "live":
      return { ...none, label: hubName(state.hub), tone: "success", status: "Connected", hub: state.hub };
    case "retrying":
      return {
        label: "Offline",
        tone: "warning",
        status: asOf === undefined ? "Offline" : `Offline, ${asOf}`,
        detail: state.reason,
        hub: state.hub,
        retry: true,
      };
    case "refused":
      return { label: "Key refused", tone: "danger", status: "Key refused", detail: `The hub refused this app's key: ${state.message}`, hub: state.hub, retry: false };
  }
};
