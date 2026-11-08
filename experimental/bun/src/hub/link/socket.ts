// Ports crates/fleetd/src/hub/link/mod.rs `handle` (GET /node/link: the nodes' websocket).
import { type Route, upgrade } from "../http/route.ts";
import { link } from "./server.ts";

export const nodeLink: Route = (req, ctx) => upgrade(req, ctx, link(ctx.hub).socket);
