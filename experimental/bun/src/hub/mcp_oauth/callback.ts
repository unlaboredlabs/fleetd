// Ports crates/fleetd/src/hub/mcp_oauth/callback.rs (GET /oauth/callback).
import { NotImplemented } from "../../shared/errors.ts";
import type { Route } from "../http/route.ts";

export const oauthCallback: Route = () => {
  throw new NotImplemented("src/hub/mcp_oauth/callback: oauthCallback");
};
