// What a hub's error means, where the app's answer differs by it.
import type { HubError } from "../../../shared/hub";

/**
 * The hub's answer to a tool it doesn't have (hub/app_ws: "No tool <name>."): a hub older than the app, which an update
 * fixes. A fixture without an answer says not_found too.
 */
export const lacksTool = (e: HubError): boolean => e.code === "not_found";
