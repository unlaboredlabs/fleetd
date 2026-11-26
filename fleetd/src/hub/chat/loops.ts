// The chat's start: the flow's loop (chat::flow::run), its lead calls, each project's chat state in fleetd_status
// (chat/tools.rs `extend_status`), the project bridge's `sendAsAgent`, the /app `chat` subscription and its `chat_delta`
// frames, and the `chat_state` area the push area reads.
import type { ProjectRef } from "../../shared/contracts.ts";
import { allows } from "../auth/index.ts";
import { forbidden } from "../api/grants.ts";
import type { Hub } from "../api/hub.ts";
import { type AppConn, appWs, errorFrame } from "../app_ws/index.ts";
import { executorHooks } from "../executor/hooks.ts";
import { found } from "../project_lead/bridge.ts";
import { registerLeadCalls } from "./calls.ts";
import { fill } from "./find.ts";
import { leadThread, run, state, states } from "./flow.ts";
import { chat, chatState, sendAsAgent } from "./index.ts";
import { events } from "../store/events.ts";

/** Each connection's running chat subscription, which a new `chat` replaces. */
const running = new WeakMap<AppConn, () => void>();

export function start(hub: Hub): void {
  chatState(hub);
  // `fleetd people remove` hands a removed person's cards on from its own process: what the hub kept of the chats' states
  // goes, read again from the messages as they are now.
  events(hub).onOthers((got) => {
    if (got.some((e) => e.type === "chat.message" || e.type === "people.changed")) chat(hub).forgetStates();
  });
  registerLeadCalls(hub);
  // fleetd_status (and so the app's snapshot) carries each readable project's chat state.
  executorHooks(hub).extendStatus((h, caller) => {
    return { chats: states(h).filter((s) => allows(caller, "read", s.projectRef.machineId)) };
  });
  // A lead's computer that went to sleep or woke: its chat state says so (the sidebar's and the chat's bot).
  executorHooks(hub).onAsleep((t) => {
    const r = { machineId: t.machineId, projectId: t.projectId };
    if (leadThread(hub, r)?.threadId === t.threadId) state(hub, r);
  });
  // The search index of the messages from before it, filled in small steps while the hub runs.
  void fill(hub);
  void run(hub).catch((error) => {
    if (!hub.shutdown.signal.aborted) console.error("chat: the flow stopped:", error);
  });
  // The project bridge's project_message writes to another project's lead as an agent.
  found.sendAsAgent = (h, to, by, body, requestId, lead) => sendAsAgent(h, to, by, body, requestId, lead);
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
    let stop: () => void = () => {};
    const off = chat(hub).subscribe((delta) => {
      if (delta.projectRef.machineId !== project.machineId || delta.projectRef.projectId !== project.projectId) return;
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
