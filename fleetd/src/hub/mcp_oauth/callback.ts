// `GET /oauth/callback`: where a service sends the person's browser back
// after they sign in to an MCP server. The hub finishes the sign-in and answers with a small page saying how it went;
// the app, watching the server's sign-in, carries on by itself. The page loads nothing and is never cached.
import type { Route } from "../http/route.ts";
import { finish } from "./index.ts";

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

const escape = (text: string) =>
  text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#39;");

function page(status: number, rawTitle: string, rawText: string): Response {
  // Hosts and codes are marked as code for the app; the page shows them plain.
  const [title, text] = [escape(rawTitle), escape(rawText.replaceAll("`", ""))];
  const html =
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" ` +
    `content="width=device-width,initial-scale=1"><title>${title} · fleetd</title><style>` +
    ":root{color-scheme:light dark}body{margin:0;min-height:100vh;display:grid;place-items:center;" +
    "font:15px/1.5 system-ui,-apple-system,sans-serif}main{max-width:28rem;padding:2rem}" +
    "h1{font-size:1.15rem;margin:0 0 .5rem}p{margin:0;opacity:.75}</style></head>" +
    `<body><main><h1>${title}</h1><p>${text}</p></main></body></html>`;
  return new Response(html, {
    status,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      "referrer-policy": "no-referrer",
      "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'",
      "x-frame-options": "DENY",
    },
  });
}
