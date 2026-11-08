// The chat's start: the Navi bridge's `sendAsAgent`, the /app `chat` subscription and its `chat_delta` frames (crates/fleetd/src/hub/app_ws/mod.rs
// `AppClientMessage::Chat`), and the `chat_state` area the push area reads. The flow's loop (Rust: chat::flow::run)
// is not ported yet.
import type { ProjectRef } from "../../shared/contracts.ts";
import { allows } from "../auth/index.ts";
import { forbidden } from "../api/grants.ts";
import type { Hub } from "../api/hub.ts";
import { type AppConn, appWs, errorFrame } from "../app_ws/index.ts";
import { found } from "../navi/bridge.ts";
import { mayUse, refused } from "../navi/owner.ts";
import { chat, chatState, sendAsAgent } from "./index.ts";

/** Each connection's running chat subscription, which a new `chat` replaces. */
const running = new WeakMap<AppConn, () => void>();

export function start(hub: Hub): void {
  chatState(hub);
  // The Navi bridge's project_message writes to another project's lead as an agent.
  found.sendAsAgent = (h, to, by, body, requestId) => sendAsAgent(h, to, by, body, requestId);
  const ws = appWs(hub);
  ws.on("chat", (conn, message) => {
    // A new `chat` request replaces the running one; none stops it.
    running.get(conn)?.();
    running.delete(conn);
    const project = (message as { project?: ProjectRef }).project;
    const caller = conn.caller;
    if (!project || !caller) return;
    if (!allows(caller, "read", project.machineId)) {
      ws.sendTo(conn, errorFrame(forbidden("read", project.machineId)));
      return;
    }
    // Another person's Navi's chat is theirs alone (D215).
    if (!mayUse(hub.db, caller, project)) {
      ws.sendTo(conn, errorFrame(refused(project)));
      return;
    }
    let stop: () => void = () => {};
    const off = chat(hub).subscribe((delta) => {
      if (delta.projectRef.machineId !== project.machineId || delta.projectRef.projectId !== project.projectId) return;
      // Turned Only me since by another person: its chat streams to them alone.
      if (!mayUse(hub.db, caller, project)) {
        ws.sendTo(conn, errorFrame(refused(project)));
        stop();
        return;
      }
      if (!ws.sendTo(conn, { ...delta, t: "chat_delta" })) stop();
    });
    const offClose = ws.onClose(conn, () => stop());
    stop = () => {
      off();
      offClose();
      if (running.get(conn) === stop) running.delete(conn);
    };
    running.set(conn, stop);
  });
}
