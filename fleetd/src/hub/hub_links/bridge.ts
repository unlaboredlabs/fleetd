// What /link/v1 and the asking side's client reach in the project-lead area's bridge (src/hub/project_lead/bridge.ts, T2246's): its
// `bridgeOf(hub)`, imported, never an area made here (D354). A test hands its own bridge to `setAskBridge`.
import type { ProjectRef } from "../../shared/contracts.ts";
import type { Hub } from "../api/hub.ts";
import { bridgeOf, type AskBridge } from "../project_lead/bridge.ts";

export type {
  Asker,
  FactoryStatusCall,
  FactoryStatusResult,
  LinkFeedItem,
  AskBridge,
  ProjectMessageCall,
  ProjectMessageResult,
} from "../project_lead/bridge.ts";

const overrides = new WeakMap<Hub, Partial<AskBridge>>();

/** For tests: `bridge`'s methods in place of the project-lead area's, on this hub only. */
export const setAskBridge = (hub: Hub, bridge: Partial<AskBridge>) => overrides.set(hub, bridge);

/** The hub's ask bridge: `askBridge(hub).factoryStatus(…)`. */
export const askBridge = (hub: Hub): AskBridge => ({ ...bridgeOf(hub), ...overrides.get(hub) });

/** Whether `r` is a project here, an archived one only when `archived` (bridge.rs `is_project`). */
export const isProject = (hub: Hub, r: ProjectRef, archived: boolean) =>
  hub.db.conn
    .query(
      `SELECT 1 FROM projects p WHERE p.machine_id = ?1 AND p.project_id = ?2 AND (?3 OR NOT EXISTS (
         SELECT 1 FROM project_settings s WHERE s.machine_id = ?1 AND s.project_id = ?2
           AND s.archived_ms IS NOT NULL))`,
    )
    .get(r.machineId, r.projectId, archived ? 1 : 0) !== null;
