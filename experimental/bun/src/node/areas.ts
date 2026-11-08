// The node's areas beyond its core, each registering its handlers on the `Node` (./api.ts) at start: one import and
// one line per area (node/browser, node/device, node/desktop, node/mac_tool).
import type { Node } from "./api.ts";

export function registerAreas(_node: Node): void {}
