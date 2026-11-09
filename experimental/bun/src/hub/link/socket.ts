// Ports crates/fleetd/src/hub/link/mod.rs `handle` (GET /node/link: the nodes' websocket).
import { type Route, upgrade } from "../http/route.ts";
import { link } from "./server.ts";

/** The link's socket gets who dialed, so its silence can count the bytes their connection reads (server.ts `progress`). */
export const nodeLink: Route = (req, ctx) => {
  const ip = ctx.server.requestIP(req);
  const peer = ip && ctx.server.port !== undefined ? { address: ip.address, port: ip.port, local: ctx.server.port } : undefined;
  return upgrade(req, ctx, link(ctx.hub).socket, { peer });
};
