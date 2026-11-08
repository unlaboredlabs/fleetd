// The node's areas beyond its core, each registering its handlers on the `Node` (./api.ts) at start: one import and
// one line per area (node/browser, node/device, node/desktop, node/mac_tool).
import type { Node } from "./api.ts";
import { broker, start as startBrowser } from "./browser/index.ts";
import { start as startScreens } from "./screens/index.ts";
import { start as startSessionRoute } from "./session_route/index.ts";

export function registerAreas(node: Node): void {
  startBrowser(node);
  startSessionRoute(node);
  startScreens(node);
}

/**
 * Stops what the areas hold as the node stops (SIGTERM, an update, a screens restart): each live browser session is
 * ended and reported, its Chrome closed and its fresh profile removed, as the Rust node's broker shuts down.
 */
export async function stopAreas(node: Node): Promise<void> {
  await broker(node).shutdown();
}
