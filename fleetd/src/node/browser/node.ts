// The node core's seams (src/node/api.ts, D350) as the screens' areas use them: a lead call that throws its refusal,
// and a local handler that answers `{ result }` or `{ error }`.
import type { ErrorCode } from "../../shared/contracts.ts";
import { ToolError } from "../../shared/errors.ts";
import type { Node } from "../api.ts";
import type { HubToNodeTag } from "../wire.ts";

export type { Node };

/** A lead call to the hub in a session's name: its result, or its refusal thrown. */
export async function hubCall(
  node: Node,
  op: string,
  args: Record<string, unknown>,
  opts: { threadId?: string; cwd?: string; waitMs?: number } = {},
): Promise<Record<string, unknown>> {
  const answer = await node.area("link").leadCall(op, args, opts);
  if (answer.error) {
    const { code, message, fix, reason } = answer.error as { code: string; message: string; fix?: string; reason?: string };
    throw new ToolError(code as ErrorCode, message, fix, reason);
  }
  return (answer.result ?? {}) as Record<string, unknown>;
}

/** Takes agent-mcp's `op` calls on the node's socket: `fn(session, call)`'s result, or its ToolError. */
export function onLocal(node: Node, op: string, fn: (session: string, call: Record<string, unknown>) => Promise<Record<string, unknown>>): void {
  node.area("local").on(op, async (session, frame) => {
    try {
      return { result: await fn(session, (frame.call ?? {}) as Record<string, unknown>) };
    } catch (e) {
      if (e instanceof ToolError) return { error: e.toJSON() };
      return { error: { code: "failed", message: (e as Error).message } };
    }
  });
}

/** Takes the hub's frames tagged `tag`. */
export function onHub(node: Node, tag: HubToNodeTag, fn: (frame: Record<string, unknown>) => void): void {
  node.area("link").on(tag, (frame) => fn(frame as Record<string, unknown>));
}

/** Sends a frame to the hub on the link that is up. */
export const toHub = (node: Node, frame: { t: string } & Record<string, unknown>) => node.area("link").send(frame as never);
