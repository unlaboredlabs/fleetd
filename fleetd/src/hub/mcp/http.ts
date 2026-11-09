// Ports crates/fleetd/src/hub/mcp (/mcp: MCP over streamable HTTP, JSON-RPC, every tool in the registry).
import { authenticate } from "../auth/http.ts";
import type { Route } from "../http/route.ts";
import { McpEndpoint } from "./endpoint.ts";

/** The bearer must be a live key on every request, so a revoked key stops working on its next call. */
export const mcp: Route = (req, ctx) => {
  const caller = authenticate(ctx.hub, req);
  if (caller instanceof Response) return caller;
  const endpoint = ctx.hub.area("mcp", () => new McpEndpoint(ctx.tools));
  return endpoint.handle(ctx.hub, caller, req);
};
