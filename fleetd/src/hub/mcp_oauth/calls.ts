// `mcp_oauth_renew`: the node's call for an agent's `fleetd mcp-relay` that a signed-in server turned away (HTTP 401).
// The server is the one of that name the session's bot gets, found as its sessions' config finds it (`serversFor`),
// so the relay never names where the sign-in is kept. Without `refused` the token is renewed now and handed to the
// machine before the answer; with it (the token just renewed was turned away too) the server is signed out.
import { ToolError } from "../../shared/errors.ts";
import type { Hub } from "../api/hub.ts";
import { leadCalls } from "../lead_calls/index.ts";
import { mcpServers } from "../mcp_servers/index.ts";
import { type Renewed, renewNow, turnedAway } from "./index.ts";

export const OPS = ["mcp_oauth_renew"] as const;

export function registerLeadCalls(hub: Hub): void {
  leadCalls(hub).register("mcp_oauth_renew", async (caller, call) => {
    if (caller.threadId === undefined) {
      throw new ToolError("forbidden", "mcp_oauth_renew is an agent's relay's call, and this call comes from no session.", "Sign in again from Settings instead.");
    }
    const name = String(call.server);
    const server = mcpServers(hub)
      .serversFor(caller.projectRef)
      .find((s) => s.name === name);
    if (!server?.oauth) return { renewed: "signed_out" satisfies Renewed, problem: `${name} doesn't sign in for this bot.` };
    let renewed: Renewed;
    try {
      // The token the agent was turned away with: one older than the hub's is never renewed again or signed out.
      const stale = typeof call.fingerprint === "string" ? call.fingerprint : undefined;
      renewed = call.refused === true ? await turnedAway(hub, server.scope, name, stale) : await renewNow(hub, server.scope, name, stale);
    } catch (e) {
      throw new ToolError("failed", (e as Error).message, "try again shortly");
    }
    const problem = mcpServers(hub).get(server.scope, name)?.oauth?.problem;
    return { renewed, ...(problem !== undefined ? { problem } : {}) };
  });
}
