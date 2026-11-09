// The hub-links area as the navi bridge reads it: a project's linked hubs for its `factory_status`.
import type { ProjectRef } from "../../shared/contracts.ts";
import type { Hub } from "../api/hub.ts";
import * as links from "./store.ts";

export { ask, status } from "./client.ts";

/** A project's links as `factory_status` lists them: each one's label, state and last error. */
export const linked = (hub: Hub, navi: ProjectRef) => links.linked(hub.db, navi);
