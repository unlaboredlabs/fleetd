// The lead chat's tools (crates/fleetd/src/hub/chat/tools.rs, nudges.rs): chat_send, chat_history, chat_stop,
// project_stop and chat_nudge_clear.
import type { ChatNudgeCleared, ChatStopInput } from "../../shared/contracts.ts";
import { ToolError } from "../../shared/errors.ts";
import { requireRole } from "../api/grants.ts";
import { DecodeError, decodeInput } from "../api/decode.ts";
import type { Registry } from "../api/registry.ts";
import { requireHuman } from "../leads/seams.ts";
import { store } from "../store/hub_store.ts";
import { chatStop, ensure, projectStop, send, state } from "./flow.ts";
import { chat } from "./index.ts";

export function register(tools: Registry): void {
  tools.add("chat_send", (hub, caller, input) => send(hub, caller, input));

  tools.add("chat_history", async (hub, caller, input) => {
    const r = input.projectRef;
    requireRole(caller, "read", r.machineId);
    if (store(hub).projectGet(r)) await ensure(hub, r);
    const page = chat(hub).page(r, input.before, input.after, input.limit ?? 50);
    return { messages: page.messages, moreBefore: page.moreBefore, moreAfter: page.moreAfter, state: state(hub, r) };
  });

  tools.add("project_stop", (hub, caller, input) => projectStop(hub, caller, input));

  // The key is checked before the input, so the app's probe with `{}` tells "you may stop" (invalid input) from "you
  // may not" (forbidden).
  tools.addRaw("chat_stop", (hub, caller, raw) => {
    requireHuman(caller, "chat_stop");
    let input: ChatStopInput;
    try {
      input = decodeInput("chat_stop", raw) as ChatStopInput;
    } catch (error) {
      if (error instanceof DecodeError) throw new ToolError("invalid", error.message);
      throw error;
    }
    return chatStop(hub, caller, input);
  });

  // The person has seen a nudge's message, or dismissed it.
  tools.add("chat_nudge_clear", (hub, caller, input) => {
    requireHuman(caller, "chat_nudge_clear");
    const r = input.projectRef;
    requireRole(caller, "operate", r.machineId);
    const message = chat(hub).byId(input.messageId);
    if (!message || message.projectRef.machineId !== r.machineId || message.projectRef.projectId !== r.projectId) {
      throw new ToolError("not_found", `No message ${input.messageId} in this chat.`);
    }
    const how: ChatNudgeCleared = input.dismissed === true ? "dismissed" : "seen";
    if (chat(hub).clearNudge(message, how)) state(hub, r);
    return { ok: true };
  });
}
