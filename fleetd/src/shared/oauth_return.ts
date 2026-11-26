// The sign-in return page: an https address fleetd runs (on the cloud's accounts host) that a service signing a
// self-hosted workspace in to an MCP server sends the browser back to, when the workspace has only a plain-http address
// (on a tailnet or a LAN) and the service takes only https or loopback callbacks. The page forwards the browser to the
// workspace's own `/oauth/callback` with the service's query as it came: the browser reaches the workspace, fleetd
// never does. The workspace's address travels in the OAuth `state` (`<random>.<base64url(origin)>`), which the
// workspace made and checks again when the browser arrives; PKCE ties the code to that workspace's verifier, so a code
// sent anywhere else is worthless. The page forwards only to a private plain-http origin (loopback, LAN, tailnet,
// `.ts.net`, `.local`, a one-label name), always to its `/oauth/callback`, keeps nothing and must log nothing: the
// cloud mounts `returnResponse` as it is.

/** fleetd's return page: the redirect a self-hosted workspace registers with a service when it has no https address. */
export const RETURN_PAGE = "https://accounts.fleetd.dev/oauth/return";

/** Where the workspace takes the browser back: the page forwards here, under the workspace's origin. */
export const CALLBACK_PATH = "/oauth/callback";

/** The longest state the page reads: a nonce, a dot and an origin of a few hundred characters. */
const STATE_MAX = 1024;

function ipv4(host: string): number[] | undefined {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (!m) return undefined;
  const parts = m.slice(1).map(Number);
  return parts.every((p) => p <= 255) ? parts : undefined;
}

/**
 * Whether `hostname` (as URL gives it: lower case, IPv6 in brackets) is one only a private network reaches: loopback,
 * a LAN or link-local range, the tailnet's CGNAT and ULA ranges, a `.ts.net`, `.local`, `.lan`, `.internal`,
 * `.home.arpa` or `.localhost` name, or a one-label name a LAN or MagicDNS resolves.
 */
export function privateHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (host === "") return false;
  const v4 = ipv4(host);
  if (v4) {
    const [a, b] = [v4[0] ?? 0, v4[1] ?? 0];
    return a === 127 || a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && (b & 0xc0) === 64) || (a === 169 && b === 254);
  }
  if (host.includes(":")) return host === "::1" || /^f[cd][0-9a-f]{2}:/.test(host) || /^fe[89ab][0-9a-f]:/.test(host);
  if (/^\d+$/.test(host) || !/^[a-z0-9.-]+$/.test(host) || host.startsWith(".") || host.endsWith(".")) return false;
  if (!host.includes(".")) return true;
  return [".ts.net", ".local", ".lan", ".internal", ".home.arpa", ".localhost"].some((s) => host.endsWith(s)) || host === "localhost";
}

/** `origin` as the page forwards to it: a plain-http private origin with no user, path, query or fragment; else undefined. */
export function returnable(origin: string): string | undefined {
  let u: URL;
  try {
    u = new URL(origin);
  } catch {
    return undefined;
  }
  if (u.protocol !== "http:" || u.username !== "" || u.password !== "" || (u.pathname !== "/" && u.pathname !== "") || u.search !== "" || u.hash !== "") {
    return undefined;
  }
  return privateHost(u.hostname) ? u.origin : undefined;
}

/** The OAuth state for a sign-in that comes back through the page: the workspace's own random `nonce`, then its origin. */
export function returnState(nonce: string, origin: string): string {
  if (!/^[A-Za-z0-9_-]+$/.test(nonce)) throw new Error("a return state's nonce is base64url");
  const to = returnable(origin);
  if (to === undefined) throw new Error(`${origin} isn't an address the return page forwards to`);
  return `${nonce}.${Buffer.from(to, "utf8").toString("base64url")}`;
}

/** The origin a return state names, when it is well formed and one the page forwards to. */
export function returnOrigin(state: string): string | undefined {
  if (state.length > STATE_MAX) return undefined;
  const m = /^[A-Za-z0-9_-]{16,}\.([A-Za-z0-9_-]+)$/.exec(state);
  if (!m?.[1]) return undefined;
  const decoded = Buffer.from(m[1], "base64url").toString("utf8");
  const to = returnable(decoded);
  // Only the origin as returnState writes it: no second spelling of one address.
  return to !== undefined && to === decoded ? to : undefined;
}

const HEADERS = {
  "cache-control": "no-store",
  "referrer-policy": "no-referrer",
  "x-content-type-options": "nosniff",
  "x-frame-options": "DENY",
};

const escape = (text: string) =>
  text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#39;");

function refused(title: string, text: string): Response {
  const html =
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" ` +
    `content="width=device-width,initial-scale=1"><title>${escape(title)} · fleetd</title><style>` +
    ":root{color-scheme:light dark}body{margin:0;min-height:100vh;display:grid;place-items:center;" +
    "font:15px/1.5 system-ui,-apple-system,sans-serif}main{max-width:28rem;padding:2rem}" +
    "h1{font-size:1.15rem;margin:0 0 .5rem}p{margin:0;opacity:.75}</style></head>" +
    `<body><main><h1>${escape(title)}</h1><p>${escape(text)}</p></main></body></html>`;
  return new Response(html, {
    status: 400,
    headers: { ...HEADERS, "content-type": "text/html; charset=utf-8", "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'" },
  });
}

/**
 * The return page's whole answer to `GET <RETURN_PAGE>?…`: a redirect to the workspace's `/oauth/callback` with the
 * query as the service sent it, or a short page saying why not. It reads only the state; the code passes through.
 */
export function returnResponse(url: string | URL): Response {
  const u = typeof url === "string" ? new URL(url) : url;
  const state = u.searchParams.get("state");
  if (state === null || state === "") {
    return refused("Sign-in failed", "The service sent the browser back without its sign-in state. Start the sign-in again from fleetd.");
  }
  const origin = returnOrigin(state);
  if (origin === undefined) {
    return refused("Sign-in failed", "This sign-in didn't start from a fleetd workspace this page can return to. Start it again from fleetd.");
  }
  return new Response(null, { status: 302, headers: { ...HEADERS, location: `${origin}${CALLBACK_PATH}${u.search}` } });
}
