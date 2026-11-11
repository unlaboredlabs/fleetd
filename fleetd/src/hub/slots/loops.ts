import type { Hub } from "../api/hub.ts";
import { CAP_AGENTS_MAC, link, type NodeLoad } from "../link/index.ts";
import { events } from "../store/events.ts";
import { store } from "../store/hub_store.ts";
import { slots } from "./index.ts";

/**
 * Starts this module's loops (Rust: slots.run): the board follows thread events from the log's head as of now. It
 * also takes what the Rust link server hands the board itself: each heartbeat's facts about its machine
 * (`observe_load`), and the agents' Mac's hello, which keeps its agents role off (`keep_tool_only`).
 */
export function start(hub: Hub): void {
  const board = slots(hub);
  void board.run(events(hub), hub.shutdown.signal);
  const nodeLink = link(hub);
  nodeLink.on("hb", (machineId, frame) => {
    const load = frame.load as NodeLoad | undefined;
    if (!load) return;
    let name = machineId;
    try {
      name = store(hub).machineGet(machineId)?.name ?? machineId;
    } catch {}
    try {
      board.observeMachine(machineId, name, load);
    } catch (error) {
      console.warn("node link: machine facts not applied to the slot board:", error);
    }
  });
  nodeLink.onLinked(({ machineId, hello }) => {
    // The agents' Mac is a tool, never a runner.
    if (!hello.capabilities?.includes(CAP_AGENTS_MAC)) return;
    try {
      board.keepToolOnly(machineId);
    } catch (error) {
      console.error("node link: the agents' Mac's agents role didn't go off:", error);
    }
  });
}
