// Ports crates/fleetd/src/hub/machine_roles/relay.rs (GET /relay/{token}: session relays).
import { NotImplemented } from "../../shared/errors.ts";
import { expectUpgrade, type Route } from "../http/route.ts";

export const relay: Route = (req) => {
  if (req.headers.get("upgrade")?.toLowerCase() !== "websocket") return expectUpgrade();
  // Upgrade with `upgrade(req, ctx, handler)` (../http/route.ts) once the handler is ported.
  throw new NotImplemented("src/hub/machine_roles/relay: relay");
};
