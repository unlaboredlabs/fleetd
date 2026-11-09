// One call to this session's node over its socket, waiting `waitMs` (agent-mcp's envDeps and sendCall, with the
// wait a `mac` or `agent-device` step takes). The answer frame, or (thrown, a string) why the node could not be asked.
import { envDeps, sendCall } from "./agent_mcp/index.ts";
import { sendToNode } from "./agent_mcp/socket.ts";

export function nodeCall(call: Record<string, unknown>, waitMs: number): Promise<Record<string, unknown>> {
  return sendCall(call, { ...envDeps(), send: (socket, frame) => sendToNode(socket, frame, waitMs) });
}

/** A thrown reason as words. */
export const why = (error: unknown) => (error instanceof Error ? error.message : String(error));
