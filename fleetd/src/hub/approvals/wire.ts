// Approvals' ports over the real hub (crates/fleetd/src/hub/usage/wire_approvals.rs): the node link's secret and
// gated-run commands, the hub's store, the lead's wake with a request's outcome, and the hooks other areas fill.
import type { HumanRequest, McpServer, ProjectRef } from "../../shared/contracts.ts";
import type { Hub } from "../api/hub.ts";
import { leadWakes } from "../api/leads.ts";
import { nodePort } from "../cloud/node.ts";
import { mcpServers } from "../mcp_servers/index.ts";
import { events } from "../store/events.ts";
import { store } from "../store/hub_store.ts";
import type { ApprovalsDeps } from "./index.ts";
import { wakeLine } from "./outcome.ts";
import {
  type ApprovalHub,
  type ApprovalNodes,
  type ApprovalHooks,
  defaultHooks,
  type GatedOutcome,
  NodeCommandError,
  type PendingPermission,
} from "./ports.ts";
import { Requests } from "./store.ts";

/** A node that keeps an approved command's result for a `gated_resume` (node_link.rs `CAP_GATED_RESUME`). */
const CAP_GATED_RESUME = "gated_resume";

/** A node command's failure in approvals' terms: the link's own error carries its reason. */
function nodeError(e: unknown): NodeCommandError {
  if (e instanceof NodeCommandError) return e;
  const reason = (e as { reason?: unknown } | undefined)?.reason;
  const message = e instanceof Error ? e.message : String(e);
  return new NodeCommandError(typeof reason === "string" ? reason : "failed", message);
}

const offline = (m: string) => new NodeCommandError("offline", `${m}'s node is not linked to the hub`);

function gatedOutcome(result: Record<string, unknown>): GatedOutcome {
  const str = (v: unknown) => (typeof v === "string" ? v : undefined);
  return {
    ...(typeof result.exitCode === "number" ? { exitCode: result.exitCode } : {}),
    outputTail: str(result.outputTail) ?? "",
    timedOut: result.timedOut === true,
    ...(str(result.error) !== undefined ? { error: str(result.error) } : {}),
    ...(str(result.unknown) !== undefined ? { unknown: str(result.unknown) } : {}),
  };
}

export function linkNodes(hub: Hub): ApprovalNodes {
  const ask = async (m: string, frame: Record<string, unknown>) => {
    try {
      return await nodePort(hub).request(m, { ...frame, id: "pending" });
    } catch (e) {
      throw nodeError(e);
    }
  };
  return {
    async deliverSecret(m, input) {
      const result = await ask(m, { t: "secret_deliver", ...input });
      return {
        ...(typeof result.fingerprint === "string" ? { fingerprint: result.fingerprint } : {}),
        ...(typeof result.error === "string" ? { error: result.error } : {}),
      };
    },
    async runGated(m, input) {
      return gatedOutcome(await ask(m, { t: "gated_run", ...input }));
    },
    async resumeGated(m, requestId, timeoutSec) {
      const port = nodePort(hub);
      // Between links, the hub may see the node's sessions before its new hello: it is not back yet.
      if (!port.onLink(m)) throw offline(m);
      if (!port.can(m, CAP_GATED_RESUME)) throw new NodeCommandError("old", `${m}'s node is too old to keep a command's result`);
      return gatedOutcome(await ask(m, { t: "gated_resume", requestId, timeoutSec }));
    },
    async isLinked(m) {
      return nodePort(hub).linked(m);
    },
    async answerPermission(m, threadId, requestId, decision, by) {
      try {
        await nodePort(hub).call(m, "answer", { op: "answer", sessionId: threadId, requestId, decision, ...(by ? { by } : {}) }, 15_000);
      } catch (e) {
        // executor_error: offline, not found, or the node's own failure.
        const kind = (e as { kind?: string }).kind;
        throw new NodeCommandError(kind === "not_connected" ? "offline" : kind === "thread_not_found" ? "not_found" : "failed", (e as Error).message);
      }
    },
    async pendingPermission(m, threadId) {
      return nodePort(hub).pending(m, threadId);
    },
  };
}

export function storeHub(hub: Hub, mcpServers: (project: ProjectRef) => Promise<McpServer[]>): ApprovalHub {
  return {
    async boxKey(machineId) {
      const machine = store(hub).machineGet(machineId);
      if (!machine) return undefined;
      return machine.boxPubKey ?? null;
    },
    async workspaceRoot(project) {
      return store(hub).projectGet(project)?.workspaceRoot;
    },
    async wakeRequest(request: HumanRequest) {
      leadWakes(hub).trigger(request.projectRef, { kind: "line", line: "request", text: wakeLine(request) });
    },
    mcpServers,
  };
}

/**
 * The hooks as T2285's navi port fills them: each call peeks at `hub.area("navi_hooks")` (its `naviHooks(hub)`, D355) at
 * runtime, so this builds before that lands and whichever starts first; a hook it doesn't fill keeps the default. An
 * area that sets `approvals(hub).deps.hooks.<name>` itself replaces the lookup for that hook.
 */
export function naviFilled(hub: Hub, base: ApprovalHooks): ApprovalHooks {
  const navi = () => hub.peek<Partial<ApprovalHooks>>("navi_hooks");
  const out = {} as Record<keyof ApprovalHooks, unknown>;
  for (const name of Object.keys(base) as (keyof ApprovalHooks)[]) {
    out[name] = (...args: unknown[]) => {
      const fill = navi()?.[name] as ((...a: unknown[]) => unknown) | undefined;
      return (fill ?? (base[name] as (...a: unknown[]) => unknown))(...args);
    };
  }
  return out as ApprovalHooks;
}

/** The real hub's approvals deps; other areas set `approvals(hub).deps.hooks` fields to theirs (D348). */
export function hubDeps(hub: Hub): ApprovalsDeps {
  const deps: ApprovalsDeps = {
    requests: new Requests(hub.db),
    nodes: linkNodes(hub),
    hub: storeHub(hub, async (r) => {
      try {
        return mcpServers(hub).serversFor(r);
      } catch (e) {
        console.warn("approvals: the project's MCP servers were not read:", e);
        return [];
      }
    }),
    hooks: naviFilled(hub, defaultHooks()),
    events: events(hub),
    clock: hub.clock,
    signal: hub.shutdown.signal,
  };
  return deps;
}
