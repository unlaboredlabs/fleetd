// What /link/v1 and the Navi side's client reach in the navi area's bridge (src/hub/navi/bridge.ts, T2246's): its
// `bridgeOf(hub)`, imported, never an area made here (D354). A test hands its own bridge to `setNaviBridge`.
import type { ProjectRef } from "../../shared/contracts.ts";
import type { Hub } from "../api/hub.ts";
import { bridgeOf, type NaviBridge } from "../navi/bridge.ts";

export type {
  Asker,
  FactoryStatusCall,
  FactoryStatusResult,
  LinkFeedItem,
  NaviBridge,
  ProjectMessageCall,
  ProjectMessageResult,
} from "../navi/bridge.ts";

const overrides = new WeakMap<Hub, Partial<NaviBridge>>();

/** For tests: `bridge`'s methods in place of the navi area's, on this hub only. */
export const setNaviBridge = (hub: Hub, bridge: Partial<NaviBridge>) => overrides.set(hub, bridge);

/** The hub's navi bridge: `naviBridge(hub).factoryStatus(…)`. */
export const naviBridge = (hub: Hub): NaviBridge => ({ ...bridgeOf(hub), ...overrides.get(hub) });

/** Whether `r` is a project here, an archived one only when `archived` (bridge.rs `is_project`). */
export const isProject = (hub: Hub, r: ProjectRef, archived: boolean) =>
  hub.db.conn
    .query(
      `SELECT 1 FROM projects p WHERE p.machine_id = ?1 AND p.project_id = ?2 AND (?3 OR NOT EXISTS (
         SELECT 1 FROM project_settings s WHERE s.machine_id = ?1 AND s.project_id = ?2
           AND s.archived_ms IS NOT NULL))`,
    )
    .get(r.machineId, r.projectId, archived ? 1 : 0) !== null;
