// Ports crates/fleetd/src/hub/app_ws (GET /app: the desktop and phone apps' websocket).
import { NotImplemented } from "../../shared/errors.ts";
import { expectUpgrade, type Route } from "../http/route.ts";

export const app: Route = (req) => {
  if (req.headers.get("upgrade")?.toLowerCase() !== "websocket") return expectUpgrade();
  // Upgrade with `upgrade(req, ctx, handler)` (../http/route.ts) once the handler is ported.
  throw new NotImplemented("src/hub/app_ws/socket: app");
};
