// Ports crates/fleetd/src/hub/link/server.rs (GET /node/link: the nodes' websocket).
import { NotImplemented } from "../../shared/errors.ts";
import { expectUpgrade, type Route } from "../http/route.ts";

export const nodeLink: Route = (req) => {
  if (req.headers.get("upgrade")?.toLowerCase() !== "websocket") return expectUpgrade();
  // Upgrade with `upgrade(req, ctx, handler)` (../http/route.ts) once the handler is ported.
  throw new NotImplemented("src/hub/link/socket: nodeLink");
};
