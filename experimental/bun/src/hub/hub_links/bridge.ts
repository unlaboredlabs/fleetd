// The seam with the navi area's bridge (crates/fleetd/src/hub/navi/bridge.rs, T2246's): what /link/v1 and the Navi
// side's client call. The navi area assigns the real methods onto this object when it starts
// (`Object.assign(naviBridge(hub), …)`); until then each throws NotImplemented.
import type { ProjectRef } from "../../shared/contracts.ts";
import { NotImplemented } from "../../shared/errors.ts";
import type { Hub } from "../api/hub.ts";
import type { Issued } from "./store.ts";

/** Who asks: a Navi on this hub, or a link minted here, for a Navi on another hub. */
export type Asker = { kind: "navi"; navi: ProjectRef } | { kind: "link"; link: Issued };

/** `FactoryStatusCall` / `ProjectMessageCall`, as navi.rs has them. */
export type FactoryStatusCall = { project?: string; hub?: string };
export type ProjectMessageCall = { project: string; text: string; hub?: string };

/** What `project_message` answers (`ProjectMessageResult`). */
export type ProjectMessageResult = {
  handle: string;
  projectRef: ProjectRef;
  title: string;
  leadWaiting?: string;
  hub?: string;
  next?: string;
};

/** What `factory_status` answers (`FactoryStatusResult`), the parts the link reads by name. */
export type FactoryStatusResult = {
  projects: {
    projectRef: ProjectRef;
    title: string;
    openOrders: { asked?: string; [k: string]: unknown }[];
    asks: { handle: string; [k: string]: unknown }[];
    [k: string]: unknown;
  }[];
  hubs?: unknown;
  next?: string;
  [k: string]: unknown;
};

/** One item of a link's feed (`LinkFeedItem`). */
export type LinkFeedItem = { handle: string; title: string; what: string };

/** An ask a Navi here sent through a kept link: its handle here and who sent it. */
export type SentAsk = { handle: string; from: ProjectRef };

export type NaviBridge = {
  factoryStatus(asker: Asker, call: FactoryStatusCall): FactoryStatusResult | Promise<FactoryStatusResult>;
  projectMessage(asker: Asker, call: ProjectMessageCall): Promise<ProjectMessageResult>;
  /** What happened to the link's asks after `after`: `[cursor, more, items]`. */
  feed(linkId: string, after: number): { cursor: number; more: boolean; items: LinkFeedItem[] };
  /** Refuses (throws) when links can't be added to `navi`. */
  mayUse(navi: ProjectRef): void;
  askSent(linkId: string, remote: string): SentAsk | undefined;
  recordSent(from: ProjectRef, linkId: string, sent: { handle: string; projectRef: ProjectRef; title: string; leadWaiting?: string }, text: string, nowMs: number): string;
};

const missing = (what: string) => () => {
  throw new NotImplemented(`src/hub/navi (bridge ${what})`);
};

/** The hub's navi bridge: `naviBridge(hub).factoryStatus(…)`. */
export const naviBridge = (hub: Hub): NaviBridge =>
  hub.area<NaviBridge>("navi_bridge", () => ({
    factoryStatus: missing("factory_status"),
    projectMessage: missing("project_message"),
    feed: missing("feed"),
    mayUse: missing("may_use"),
    askSent: missing("ask_sent"),
    recordSent: missing("record_sent"),
  }));

/** Whether `r` is a project here, an archived one only when `archived` (bridge.rs `is_project`). */
export const isProject = (hub: Hub, r: ProjectRef, archived: boolean) =>
  hub.db.conn
    .query(
      `SELECT 1 FROM projects p WHERE p.machine_id = ?1 AND p.project_id = ?2 AND (?3 OR NOT EXISTS (
         SELECT 1 FROM project_settings s WHERE s.machine_id = ?1 AND s.project_id = ?2
           AND s.archived_ms IS NOT NULL))`,
    )
    .get(r.machineId, r.projectId, archived ? 1 : 0) !== null;
