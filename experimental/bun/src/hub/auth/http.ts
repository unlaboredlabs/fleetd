// The bearer check of the HTTP routes that take a key (/mcp, /link/v1): every request, so a revoked key stops at once.
import { internalError, ToolError } from "../../shared/errors.ts";
import type { Hub } from "../api/hub.ts";
import type { Caller } from "../api/registry.ts";
import { json } from "../http/route.ts";

const missingBearer = () =>
  new ToolError(
    "forbidden",
    "The MCP endpoint needs an agent key.",
    "Send Authorization: Bearer fld_… (create one with fleetd hub key create).",
  );

const unauthorized = (error: ToolError) =>
  json(error.toJSON(), 401, { "cache-control": "no-store", "www-authenticate": 'Bearer error="invalid_token"' });

/** The verified caller, or the 401 (or 500) to answer with. */
export function authenticate(hub: Hub, req: Request): Caller | Response {
  const header = req.headers.get("authorization") ?? "";
  const bearer = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
  if (!bearer) return unauthorized(missingBearer());
  try {
    return hub.auth.verify(bearer);
  } catch (error) {
    if (error instanceof ToolError) return unauthorized(error);
    console.error("key check failed:", error);
    return json(internalError().toJSON(), 500);
  }
}
