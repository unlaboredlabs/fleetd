// The node's areas beyond its core, each registering its handlers on the `Node` (./api.ts) at start: one import and
// one line per area (node/browser, node/device, node/desktop, node/mac_tool).
import { isAgentsMac, start as startAgentsMac, stop as stopAgentsMac } from "./agents_mac/index.ts";
import type { Node } from "./api.ts";
import { broker, start as startBrowser } from "./browser/index.ts";
import { start as startDevices, stop as stopDevices } from "./device/index.ts";
import { start as startMac, stop as stopMac } from "./mac_tool/index.ts";
import { start as startMcpRelay } from "./actions/mcp_relay.ts";
import { start as startDesktop, stop as stopDesktop } from "./desktop/index.ts";
import { start as startHosts } from "./hosts/index.ts";
import { start as startScreens } from "./screens/index.ts";
import { start as startRtc } from "./rtc/index.ts";
import { start as startSandboxes } from "./sandbox/hosted.ts";
import { start as startSessionRoute } from "./session_route/index.ts";
import { start as startShare } from "./share/index.ts";

export function registerAreas(node: Node): void {
  // Every session's signed-in MCP servers reach it through `fleetd mcp-relay`, wherever it runs.
  startMcpRelay(node);
  // The hub's own runner runs every agent in a hosted box, and has no screens or tools of its machine's to offer: its
  // agents' browser, Linux desktop and Android run in their own boxes (place/box_screens.ts, place/box_android.ts),
  // driven, recorded and watched from here as a machine's are (shared/sandbox.ts CAP_RUNNER).
  if (node.config.runner) {
    startSandboxes(node);
    startBrowser(node);
    startSessionRoute(node);
    startScreens(node);
    startDevices(node);
    startDesktop(node);
    startRtc(node);
    return;
  }
  startBrowser(node);
  startSessionRoute(node);
  // Share links' streams to this machine's own ports (a runner's agents' ports are in their boxes, which the cloud reaches).
  startShare(node);
  startScreens(node);
  startDevices(node);
  // Hosted sandboxes' keys are tested, and their limits kept, only where agents run in sandboxes (Linux).
  if (!isAgentsMac(node.config)) startSandboxes(node);
  startMac(node);
  // After the browser's: the desktops take the hub's live-view frames for their own ids and hand on the rest.
  startDesktop(node);
  startAgentsMac(node);
  // After every screen area: its peers see the hub's watch frames before the screens do, and the screens' frames.
  startRtc(node);
  // Last: the heartbeat's `load.hosts` goes around the lines the areas above added (the desktop's).
  startHosts(node);
}

/**
 * Stops what the areas hold as the node stops (SIGTERM, an update, a screens restart): each live browser session is
 * ended and reported, its Chrome closed and its fresh profile removed, as the Rust node's broker shuts down.
 */
export async function stopAreas(node: Node): Promise<void> {
  await broker(node).shutdown();
  await stopDevices(node);
  await stopMac(node);
  await stopDesktop(node);
  stopAgentsMac(node);
}
