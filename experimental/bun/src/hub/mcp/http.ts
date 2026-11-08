// Ports crates/fleetd/src/hub/mcp (/mcp: MCP over streamable HTTP, JSON-RPC, every tool in the registry).
import { NotImplemented } from "../../shared/errors.ts";
import { authenticate } from "../auth/http.ts";
import type { Route } from "../http/route.ts";

export const mcp: Route = (req, ctx) => {
  const caller = authenticate(ctx.hub, req);
  if (caller instanceof Response) return caller;
  throw new NotImplemented("src/hub/mcp/http: mcp");
};
