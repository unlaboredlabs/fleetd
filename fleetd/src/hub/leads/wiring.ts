// The leads area's ports over the hub: a lead launches through the
// executor on the account its project runs on, its wakes go through the offline write queue, and the node's hello says
// whether it runs one lead per machine.
import { ToolError } from "../../shared/errors.ts";
import { CAP_ASSISTANT, CAP_ONE_LEAD_MODE } from "../../shared/node_link.ts";
import type { Hub } from "../api/hub.ts";
import { forLead as accountForLead, isRefusal, type NodeAccounts } from "../claude_accounts/index.ts";
import { CAP_CLAUDE_ACCOUNTS } from "../claude_accounts/tools.ts";
import { ExecutorError } from "../executor/index.ts";
import { launch } from "../executor/sessions.ts";
import { fromExecutor } from "../executor/tools.ts";
import { link } from "../link/server.ts";
import { WriteError, writeQueue } from "../queue/index.ts";
import { leadWiring } from "./ports.ts";

/** claude_accounts `node_accounts`: whether the machine's node runs Claude accounts. */
function nodeAccounts(hub: Hub, m: string): NodeAccounts {
  const l = link(hub);
  return l.can(m, CAP_CLAUDE_ACCOUNTS) ? "runs" : l.lacks(m, CAP_CLAUDE_ACCOUNTS) ? "too_old" : "offline";
}

/** Sets the leads area's launch, send and one-lead mode on `leadWiring(hub).ports`. */
export function wire(hub: Hub): void {
  Object.assign(leadWiring(hub).ports, {
    launch: async (machineId: string, input: Parameters<typeof launch>[2], role: "lead" | "assistant") => {
      // An older node can't decode the assistant role and would drop its link on the launch.
      if (role === "assistant" && !link(hub).can(machineId, CAP_ASSISTANT)) {
        throw new ToolError(
          "invalid",
          `${machineId}'s node is too old to run a project.`,
          `Run fleetd update on ${machineId}; the project's message waits until then.`,
        );
      }
      // A project's lead runs on the hub's account whoever writes to it, a project's on its owner's.
      const r = { machineId, projectId: input.projectId };
      const account = accountForLead(hub.db, (m) => nodeAccounts(hub, m), r);
      if (isRefusal(account)) throw new ToolError("invalid", account.message, account.fix);
      try {
        const out = await launch(hub, machineId, input, {
          role,
          mcpRole: "lead",
          ...(account === undefined ? {} : { claudeAccount: account }),
        });
        return out.threadId;
      } catch (error) {
        throw error instanceof ExecutorError ? fromExecutor(error) : error;
      }
    },
    send: async (thread: { machineId: string; threadId: string }, message: string, clientRequestId: string) => {
      try {
        return (await writeQueue(hub).send(thread, message, clientRequestId)).queued;
      } catch (error) {
        if (!(error instanceof WriteError)) throw error;
        if (error.kind === "MachineNotConnected") {
          throw new ToolError(
            "machine_offline",
            `Machine ${thread.machineId} has no live node link.`,
            "Wait for the machine to come back online (fleetd_status shows it), then retry.",
          );
        }
        // The node's own words and fix, e.g. claude not logged in and how to log it in.
        throw new ToolError("failed", error.message, error.kind === "NodeRequestFailed" ? error.fix : undefined);
      }
    },
    oneLeadMode: (machineId: string) => link(hub).can(machineId, CAP_ONE_LEAD_MODE),
  });
}
