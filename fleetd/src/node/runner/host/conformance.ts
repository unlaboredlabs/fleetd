// What the stream mapper checks of claude's `system/init`: the
// capabilities fleetd's sends and interrupts rely on, and claude's own agent tools, which fleetd keeps from every session.

/** A `system/init` without these makes interrupts and queued sends misbehave. */
export const REQUIRED_INIT_CAPABILITIES = ["interrupt_receipt_v1", "interrupt_cancel_queued_v1", "msg_lifecycle_v1"];

/** Optional: a steer sent with ⌘Enter stops the running step with `interrupt {send_now}`. Without it the runner falls
 * back to an interrupt scoped to the running message (`interrupt_receipt_v1`), then to a plain interrupt. */
export const SEND_NOW_CAPABILITY = "interrupt_send_now_v1";

/** The agent tools of claude 2.1.302, all in claude.ts's ALWAYS_DISALLOWED. */
export const AGENT_TOOLS = ["Task", "Agent", "Workflow", "ListAgents", "SendMessage", "TaskStop", "TaskOutput", "TeamCreate", "TeamDelete"];

/** One of claude's own agent tools, or one that looks like a newer one. Never an MCP tool. */
export function agentLike(tool: string): boolean {
  if (tool.startsWith("mcp__")) return false;
  return AGENT_TOOLS.includes(tool) || tool.startsWith("Task") || ["Agent", "Team", "Workflow", "Subagent", "Swarm"].some((word) => tool.includes(word));
}

/** The REQUIRED_INIT_CAPABILITIES a `system/init` lacks. */
export const missingInitCapabilities = (capabilities: string[]) => REQUIRED_INIT_CAPABILITIES.filter((need) => !capabilities.includes(need));
