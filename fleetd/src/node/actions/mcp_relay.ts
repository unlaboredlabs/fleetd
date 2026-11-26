// The node's half of `fleetd mcp-relay` (cli/mcp_relay.ts), on its own socket, for the session the relay runs in
// (a process here, or a hosted box's through its node.sock forward): `mcp_header`, a signed-in server's
// headers as the node holds them now, and `mcp_renew`, the hub's renewal (`mcp_oauth_renew`) of a token the server
// turned away. The token goes to that relay alone: never to the hub, a log or the session's files.
import { join } from "node:path";
import { ToolError } from "../../shared/errors.ts";
import type { Node } from "../api.ts";
import { hubCall, onLocal } from "../browser/node.ts";
import { type RelayHeaders, RelayRefused, relayHeaders } from "./mcp.ts";
import { routeFetch } from "./mcp_tailnet.ts";

/** How long a renewal waits for the hub: it trades the refresh token with the service and hands the new token here. */
const RENEW_WAIT_MS = 45_000;

/** The relay's answer when it can't have headers: the words for the agent, and whether the sign-in is gone. */
export type RelayAnswer = RelayHeaders | { refused: string; signedOut: boolean };

const refusal = (e: RelayRefused): RelayAnswer => ({ refused: e.message, signedOut: e.signedOut });

function headersOf(home: string, session: string, name: string): RelayAnswer {
  try {
    return relayHeaders(home, join(home, "sessions", session), name);
  } catch (e) {
    if (e instanceof RelayRefused) return refusal(e);
    throw e;
  }
}

/**
 * The server turned away the token whose fingerprint is `stale`. One the node has replaced since is answered at once;
 * else the hub renews it (or, with `refused`, the one just renewed was turned away too, and the hub signs it out).
 */
export async function renew(
  home: string,
  session: string,
  name: string,
  stale: string,
  refused: boolean,
  ask: (args: Record<string, unknown>) => Promise<Record<string, unknown>>,
): Promise<RelayAnswer> {
  const now = headersOf(home, session, name);
  if ("refused" in now || now.fingerprint !== stale) return now;
  let out: Record<string, unknown>;
  try {
    // The token's fingerprint goes too: the hub acts only on its current token, never on one another agent's
    // renewal has replaced since.
    out = await ask({ server: name, fingerprint: stale, ...(refused ? { refused: true } : {}) });
  } catch (e) {
    const why = e instanceof ToolError ? e.message : (e as Error).message;
    return { refused: `fleetd couldn't ask its workspace to renew ${name}'s sign-in (${why})`, signedOut: false };
  }
  const problem = typeof out.problem === "string" ? out.problem : undefined;
  if (out.renewed === "signed_out") return { refused: problem ?? `${name} is signed out`, signedOut: true };
  if (out.renewed !== "yes") return { refused: `fleetd couldn't renew ${name}'s sign-in just now${problem ? ` (${problem})` : ""}`, signedOut: false };
  const after = headersOf(home, session, name);
  if (!("refused" in after) && after.fingerprint === stale) {
    return { refused: `${name}'s renewed sign-in hasn't reached this machine yet`, signedOut: false };
  }
  return after;
}

/** One of the relay's calls for `session`: `mcp_header`, `mcp_fetch` or `mcp_renew`, `ask` being the hub's `mcp_oauth_renew`. */
export async function relayCall(
  home: string,
  session: string,
  call: Record<string, unknown>,
  ask: (args: Record<string, unknown>) => Promise<Record<string, unknown>>,
): Promise<{ op: string } & (RelayAnswer | Fetched)> {
  const name = String(call.server);
  if (call.op === "mcp_header") return { op: "mcp_header", ...headersOf(home, session, name) };
  if (call.op === "mcp_fetch") return { op: "mcp_fetch", ...(await viaRoute(home, session, name, call)) };
  return { op: "mcp_renew", ...(await renew(home, session, name, String(call.fingerprint ?? ""), call.refused === true, ask)) };
}

/** What the relay gets for one request through the hub's route: the answer read to its end. */
export type Fetched = { status: number; headers: [string, string][]; body: string } | { refused: string; signedOut: boolean };

/**
 * One request of the relay's to a tailnet server through the hub's Tailscale route: only to the server's own origin,
 * only for a server of the session's that goes that way now. The answer is read to its end (an event stream that
 * answers one POST ends with it), so the older SSE transport, whose stream stays open, isn't carried.
 */
export async function viaRoute(
  home: string,
  session: string,
  name: string,
  call: Record<string, unknown>,
  fetcher: () => ReturnType<typeof routeFetch> = routeFetch,
): Promise<Fetched> {
  const h = headersOf(home, session, name);
  if ("refused" in h) return h;
  if (!h.viaHub) return { refused: `${name} isn't reached through the workspace's Tailscale route from this machine`, signedOut: false };
  if (h.transport.type !== "http" || !h.transport.url) {
    return { refused: `${name} uses the older SSE transport, which reaches the tailnet only from a machine on it: put this machine on the tailnet`, signedOut: false };
  }
  const url = String(call.url ?? "");
  let same = false;
  try {
    same = new URL(url).origin === new URL(h.transport.url).origin;
  } catch {}
  if (!same) return { refused: `${name}'s requests go to its own address only`, signedOut: false };
  const method = typeof call.method === "string" ? call.method : "POST";
  const headers = call.headers && typeof call.headers === "object" ? (call.headers as Record<string, string>) : {};
  try {
    const res = await fetcher()(url, {
      method,
      headers,
      ...(typeof call.body === "string" ? { body: call.body } : {}),
      signal: AbortSignal.timeout(RENEW_WAIT_MS * 4),
      redirect: "manual",
    });
    return { status: res.status, headers: [...res.headers.entries()], body: await res.text() };
  } catch (e) {
    return { refused: `the workspace's Tailscale route didn't reach ${name} (${(e as Error).message})`, signedOut: false };
  }
}

export function start(node: Node): void {
  onLocal(node, "mcp_fetch", (session, call) => relayCall(node.home, session, { ...call, op: "mcp_fetch" }, async () => ({})));
  for (const op of ["mcp_header", "mcp_renew"]) {
    onLocal(node, op, (session, call) =>
      relayCall(node.home, session, { ...call, op }, (args) =>
        // "/" is in no bot's workspace: the hub knows the call's bot by its session.
        hubCall(node, "mcp_oauth_renew", args, { threadId: session, cwd: "/", waitMs: RENEW_WAIT_MS }),
      ),
    );
  }
}
