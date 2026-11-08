import type { Hub } from "../api/hub.ts";
import { chatState } from "./index.ts";

/**
 * Makes the chat's `chat_state` area before the areas that read it start (push sorts after chat). The flow's loop
 * (Rust: chat::flow::run) is not ported yet.
 */
export function start(hub: Hub): void {
  chatState(hub);
}
