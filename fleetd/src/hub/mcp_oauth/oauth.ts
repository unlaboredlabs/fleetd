// The OAuth side of MCP's authorization spec, as a client: where a
// server signs in (its 401's resource metadata, the protected resource's and the authorization server's well-known
// metadata, with the 2025-03-26 defaults for a server that has neither), dynamic client registration, PKCE (S256),
// and the token endpoint's two grants. Every call has TIMEOUT_MS, follows redirects only within its origin, and goes
// over https unless its host is this machine or on a tailnet, so a token never crosses the internet in the clear.
import { VERSION } from "../../shared/version.ts";
import * as flow from "./flow.ts";
import { type Client, type Discovered, TIMEOUT_MS } from "./flow.ts";

export {
  authorizeUrl,
  challengeParam,
  type Client,
  type Discovered,
  type Http,
  hostOf,
  type Net,
  pkce,
  PROTOCOL_VERSION,
  type Registered,
  secure,
  state,
  TIMEOUT_MS,
  tokenAuthFor,
  TokenError,
  type Tokens,
} from "./flow.ts";

/** A fetch that follows redirects only within its first origin (cli/mcp_client.rs `same_origin_redirects`). */
export async function http(url: string, init: RequestInit = {}): Promise<Response> {
  const origin = new URL(url).origin;
  let at = url;
  let req: RequestInit = { ...init };
  const headers = new Headers(init.headers);
  headers.set("user-agent", `fleetd/${VERSION}`);
  req.headers = headers;
  const signal = AbortSignal.timeout(TIMEOUT_MS);
  for (let hops = 0; ; hops++) {
    const answer = await fetch(at, { ...req, redirect: "manual", signal });
    const location = answer.headers.get("location");
    if (answer.status < 300 || answer.status >= 400 || !location) return answer;
    const next = new URL(location, at);
    if (next.origin !== origin || hops >= 9) return answer;
    if ([301, 302, 303].includes(answer.status) && (req.method ?? "GET").toUpperCase() !== "GET") {
      req = { ...req, method: "GET", body: undefined };
    }
    at = next.toString();
  }
}

/** The hub's way out for the flow: its own `http`, as fleetd's version. */
const net: flow.Net = { http, version: VERSION };

export const offersSignIn = (url: string, sse: boolean) => flow.offersSignIn(url, sse, net);
export const discover = (url: string, sse: boolean) => flow.discover(url, sse, net);
export const register = (d: Discovered, redirect: string) => flow.register(d, redirect, net);
export const token = (endpoint: string, client: Client, resource: string, form: [string, string][]) => flow.token(endpoint, client, resource, form, net);
export const revoke = (endpoint: string, client: Client, tok: string, hint: string) => flow.revoke(endpoint, client, tok, hint, net);
