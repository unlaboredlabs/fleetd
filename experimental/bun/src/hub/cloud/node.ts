// The node link as this area's modules use it (approvals, 1Password, Claude accounts, MCP servers, cloud machines):
// T2253's `hub.area("link")` (D346), and the session calls the Rust hub's executor sends for them
// (crates/fleetd/src/hub/executor/mod.rs), with its errors' words.
import { NotImplemented, ToolError } from "../../shared/errors.ts";
import type { Hub } from "../api/hub.ts";

/** The node link's side these modules use. */
export type Link = {
  request(machineId: string, frame: Record<string, unknown>): Promise<Record<string, unknown>>;
  can(machineId: string, cap: string): boolean;
  linkId(machineId: string): string | undefined;
};

/** The link, once its area made it; a hub without one has every node offline. */
export function linkOf(hub: Hub): Link | undefined {
  try {
    return hub.area<Link>("link", () => {
      throw new NotImplemented("src/hub/link");
    });
  } catch {
    return undefined;
  }
}

/** The machine's node is linked (executor `is_connected`). */
export const linked = (hub: Hub, m: string) => linkOf(hub)?.linkId(m) !== undefined;

/** The linked node lists `cap` (link `node_can`). */
export const nodeCan = (hub: Hub, m: string, cap: string) => linkOf(hub)?.can(m, cap) === true;

/** api/grants.rs `offline`. */
export const offline = (m: string) =>
  new ToolError("machine_offline", `Machine ${m} is offline.`, `Start the node on ${m} or check its network, then retry.`);

/**
 * One `session_call` to `m`'s node: its output (the `ok` of its `session_reply`), or a ToolError in the executor's
 * words (executor/tools.rs `from_executor`).
 */
export async function sessionCall(hub: Hub, m: string, call: { op: string } & Record<string, unknown>): Promise<Record<string, unknown>> {
  const link = linkOf(hub);
  if (!link || link.linkId(m) === undefined) throw offline(m);
  const failed = (message: string, fix?: string) =>
    new ToolError(
      "failed",
      `the node on ${m} refused or failed the ${call.op} request: ${message}`,
      fix ?? "Retry; if it keeps failing, check the machine with fleetd_status.",
    );
  let reply: Record<string, unknown>;
  try {
    reply = await link.request(m, { t: "session_call", id: "pending", call });
  } catch (e) {
    if ((e as { reason?: string }).reason === "offline") throw offline(m);
    throw failed(e instanceof Error ? e.message : String(e));
  }
  const result = (reply.result ?? reply) as { ok?: Record<string, unknown>; err?: { message?: string; fix?: string } };
  if (result.err) throw failed(result.err.message ?? "no reason given", result.err.fix);
  if (!result.ok) throw failed("the node's answer had no result");
  return result.ok;
}
