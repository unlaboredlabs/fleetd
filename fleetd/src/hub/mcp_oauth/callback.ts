// `GET /oauth/callback`: where a service sends the person's browser back
// after they sign in to an MCP server. The hub finishes the sign-in and answers with a small page saying how it went;
// the app, watching the server's sign-in, carries on by itself. The page loads nothing and is never cached.
import type { Route } from "../http/route.ts";
import { finish } from "./index.ts";
import { page } from "./page.ts";

export { escape, page } from "./page.ts";

export const oauthCallback: Route = async (req, ctx) => {
  const query = new URL(req.url).searchParams;
  const state = query.get("state");
  if (!state) {
    return page(400, "Sign-in failed", "The service sent the browser back without its sign-in state. Start the sign-in again from fleetd.");
  }
  // The service's description, else its error code.
  const e = query.get("error");
  const described = query.get("error_description")?.trim();
  const error = e === null ? undefined : described ? described : `\`${e}\``;
  const done = await finish(ctx.hub, state, query.get("code") ?? undefined, error);
  if ("connected" in done) {
    const rest = done.onMachine
      ? "Go back to fleetd: it tests the connection and asks which tools its lead may use without asking."
      : "Its machine is offline: the lead gets it once the machine is back. You can go back to fleetd.";
    return page(200, `Signed in to ${done.connected}`, `${rest} You can close this tab.`);
  }
  return page(400, done.name !== undefined ? `Signing in to ${done.name} failed` : "Sign-in failed", done.failed);
};
