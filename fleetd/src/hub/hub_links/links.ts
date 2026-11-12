// A hub link as its two hubs see it, without the database (store.ts keeps them): a link minted here and what it may
// do, and one kept here for a project, as the apps show it.
import type { AgentKeyInfo, ErrorCode, Grant, HubLink, HubLinkState, LinkProject, PersonRef, ProjectRef, Role } from "../../shared/contracts.ts";
import { ToolError } from "../../shared/errors.ts";
import { isHuman } from "../api/grants.ts";
import { capped } from "../people/roles.ts";
import { isoMs } from "../store/time.ts";

export const LINK_KEY_PREFIX = "flk_";
/** The longest a feed read waits for news. */
export const FEED_WAIT_MAX_SEC = 25;
/** A link unused this long expires, revoked at its next use. */
export const IDLE_EXPIRY_MS = 90 * 24 * 60 * 60 * 1000;

/** A link minted here as a request through it sees it, read again at each request (T2246's ask bridge `Issued`). */
export type Issued = {
  linkId: string;
  label: string;
  projects?: ProjectRef[];
  person?: PersonRef;
  /** What it may do (`linkGrants`). */
  grants: Grant[];
  /** Its person's name, or its device's for a link from before people. */
  who: string;
};

export const RANK: Record<Role, number> = { read: 0, operate: 1, admin: 2 };

/** The link holds `role` on the machine. */
export const linkAllows = (link: Issued, role: Role, machineId: string) =>
  link.grants.some((g) => RANK[g.role] >= RANK[role] && (g.machines === "*" || g.machines.includes(machineId)));

/** The project is within the link's limits. */
export const linkLimits = (link: Issued, p: ProjectRef) =>
  link.projects === undefined || link.projects.some((q) => q.machineId === p.machineId && q.projectId === p.projectId);

/** Who its asks are from, in the chats here. */
export const linkAuthor = (link: Issued) => `${link.who} via ${link.label}`;

/** What a link may do: the minting device's grants, none above its person's role cap, and none above operate. */
export const linkGrants = (device: Grant[], cap: Role): Grant[] => capped(device, RANK[cap] < RANK.operate ? cap : "operate");

/** Why a link key can't be used: the request goes no further. */
export const dead = (message: string) =>
  new ToolError("forbidden", message, "Ask the person to make a new link on this hub and add it to their project's Linked hubs.");

/** A link this hub keeps for one of its projects, its key still sealed. */
export type Kept = {
  linkId: string;
  project: ProjectRef;
  label: string;
  url: string;
  sealed: Uint8Array;
  cursor: number;
  state: HubLinkState;
  error?: string;
  checkedMs?: number;
  createdMs: number;
  /** What the other hub's last hello said: the person it acts as, and the projects it is limited to (JSON). */
  who?: string;
  projects?: string;
};

export function keptInfo(k: Kept): HubLink {
  let projects: LinkProject[] | undefined;
  try {
    // Written by `setHello` only; a row that doesn't read reads as not limited.
    projects = k.projects === undefined ? undefined : (JSON.parse(k.projects) as LinkProject[]);
  } catch {
    projects = undefined;
  }
  return {
    ...(k.checkedMs === undefined ? {} : { checkedAt: isoMs(k.checkedMs) }),
    createdAt: isoMs(k.createdMs),
    ...(k.error === undefined ? {} : { error: k.error }),
    label: k.label,
    linkId: k.linkId,
    project: k.project,
    ...(projects === undefined ? {} : { projects }),
    state: k.state,
    url: k.url,
    ...(k.who === undefined ? {} : { who: k.who }),
  };
}

/** What `GET /link/v1/hello` answers (fleetd-contracts hub_links.rs `LinkHello`). */
export type LinkHello = { label: string; projects: LinkProject[]; cursor: number; who?: string; limited?: boolean };

/** Keeps what the other hub's hello said of a kept link: its person, and its projects when it is limited to them. */

/** A refusal's HTTP status on `/link/v1`, by its code. */
export const STATUS: Record<string, number> = { forbidden: 403, not_found: 404, invalid: 400, machine_offline: 503, failed: 500 };
export const statusOf = (code: ErrorCode) => STATUS[code] ?? 500;

/** Only a person links hubs: a link acts as them on the other hub. */
export function personOnly(caller: AgentKeyInfo): void {
  if (isHuman(caller)) return;
  throw new ToolError("forbidden", "Only a person links hubs: a link acts as them on the other hub.", "Do it in the desktop app.");
}
