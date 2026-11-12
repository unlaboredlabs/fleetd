// The node as the hub's modules reach it (approvals, 1Password, Claude accounts, MCP servers, the vault):
// `nodePort(hub)`, over `link(hub)` (D346) and the executor's session calls (crates/fleetd/src/hub/executor/mod.rs
// `mcp_secrets`, `claude_account_secret`, `onepassword_token`, `answer`, `pending_permission`, …), with their
// operations, waits and errors' words. Tests set `hub.area("node_port")` to a fake.
import type { Hub } from "../api/hub.ts";
import { ExecutorError, executors, type NodeOperation } from "../executor/index.ts";
import { link } from "./index.ts";
import type { PendingPermission } from "../approvals/ports.ts";
import { fromExecutor } from "./node_errors.ts";

export { fromExecutor, offline } from "./node_errors.ts";

export type NodePort = {
  /** The machine's node is linked and its session stream live (executor `is_connected`). */
  linked(m: string): boolean;
  /** Its node is on a link at all, live or not yet (link `link_id`). */
  onLink(m: string): boolean;
  /** The linked node lists `cap` (link `node_can`). */
  can(m: string, cap: string): boolean;
  /** One request/reply frame (`secret_deliver`, `gated_run`, `node_action`, …): its reply. */
  request(m: string, frame: Record<string, unknown>): Promise<Record<string, unknown>>;
  /** One session call: its output; an ExecutorError when it fails. */
  call(m: string, operation: NodeOperation, call: { op: string } & Record<string, unknown>, waitMs: number): Promise<Record<string, unknown>>;
  /** The prompt the thread's run waits on now, from the machine stream. */
  pending(m: string, threadId: string): PendingPermission | undefined;
};

export const nodePort = (hub: Hub): NodePort =>
  hub.area<NodePort>("node_port", (h) => ({
    linked: (m) => executors(h).isConnected(m),
    onLink: (m) => link(h).linkId(m) !== undefined,
    can: (m, cap) => link(h).can(m, cap),
    request: (m, frame) => link(h).request(m, frame as never) as unknown as Promise<Record<string, unknown>>,
    call: async (m, operation, call, waitMs) => (await executors(h).call(m, operation, call as never, waitMs)) as unknown as Record<string, unknown>,
    pending: (m, t) => executors(h).tracked({ machineId: m, threadId: t })?.pending as PendingPermission | undefined,
  }));

export const linked = (hub: Hub, m: string) => nodePort(hub).linked(m);
export const nodeCan = (hub: Hub, m: string, cap: string) => nodePort(hub).can(m, cap);

/** Each session call this area sends: the executor's operation it reports under, and how long it waits. */
const CALLS: Record<string, [NodeOperation, number]> = {
  mcp_secrets: ["project", 15_000],
  claude_account_secret: ["project", 15_000],
  onepassword_token: ["project", 15_000],
  claude_account_test: ["read", 100_000],
  onepassword_test: ["read", 230_000],
  onepassword_cards: ["read", 230_000],
  claude_models: ["read", 15_000],
  mcp_test: ["read", 45_000],
  answer: ["answer", 15_000],
  repo_scan: ["read", 10_000],
  repo_inspect: ["read", 10_000],
  repo_clone: ["project", 60 * 60_000],
};

/** One session call to `m`'s node: its output, or a ToolError in the executor's words. */
export async function sessionCall(hub: Hub, m: string, call: { op: string } & Record<string, unknown>): Promise<Record<string, unknown>> {
  const [operation, waitMs] = CALLS[call.op] ?? ["read", 15_000];
  try {
    return await nodePort(hub).call(m, operation, call, waitMs);
  } catch (e) {
    throw fromExecutor(e);
  }
}

/**
 * A NodePort over a test's fake link: `request` answers every frame, a `session_call`'s with `{ result: { ok } }` or
 * `{ result: { err } }`; `linkId` says which machines are linked.
 */
export function fakeNodePort(fake: {
  request(m: string, frame: Record<string, unknown>): Promise<Record<string, unknown>>;
  can(m: string, cap: string): boolean;
  linkId(m: string): unknown;
  pending?(m: string, t: string): PendingPermission | undefined;
}): NodePort {
  return {
    linked: (m) => fake.linkId(m) !== undefined,
    onLink: (m) => fake.linkId(m) !== undefined,
    can: (m, cap) => fake.can(m, cap),
    request: (m, frame) => fake.request(m, frame),
    async call(m, operation, call) {
      if (fake.linkId(m) === undefined) throw ExecutorError.notConnected(m);
      const reply = await fake.request(m, { t: "session_call", id: "pending", call });
      const result = (reply.result ?? reply) as { ok?: Record<string, unknown>; err?: { message?: string; fix?: string } };
      if (result.err) throw ExecutorError.failed(m, operation, result.err.message ?? "no reason given", result.err.fix);
      return result.ok ?? {};
    },
    pending: (m, t) => fake.pending?.(m, t),
  };
}

/** The fake link a test hands `fakeNodePort`. */
export type Link = Parameters<typeof fakeNodePort>[0];
