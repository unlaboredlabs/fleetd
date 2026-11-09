// Ports crates/fleetd/src/hub/app_ws (GET /app: the desktop and phone apps' websocket).
import { type Route, upgrade } from "../http/route.ts";
import { APP_FEATURES_HEADER, appWs, type EarlyAuth } from "./server.ts";

/** The `auth` an upgrade request carried: its key as `Authorization: Bearer`, and its features. */
export function earlyAuth(headers: Headers): EarlyAuth | undefined {
  const auth = headers.get("authorization");
  if (!auth?.startsWith("Bearer ")) return undefined;
  const key = auth.slice(7).trim();
  if (!key) return undefined;
  const features = (headers.get(APP_FEATURES_HEADER) ?? "")
    .split(",")
    .map((f) => f.trim())
    .filter((f) => f !== "");
  return { key, features };
}

export const app: Route = (req, ctx) => {
  const server = appWs(ctx.hub);
  server.tools = ctx.tools;
  return upgrade(req, ctx, server.socket(earlyAuth(req.headers)));
};
