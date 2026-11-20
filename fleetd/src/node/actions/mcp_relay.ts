// The node's half of `fleetd mcp-relay` (cli/mcp_relay.ts), on its own socket, for the session the relay runs in
// (a process here, or a hosted box's through its node.sock forward): `mcp_header`, a signed-in server's
// headers as the node holds them now, and `mcp_renew`, the hub's renewal (`mcp_oauth_renew`) of a token the server
// turned away. The token goes to that relay alone: never to the hub, a log or the session's files.
import { join } from "node:path";
import { ToolError } from "../../shared/errors.ts";
import type { Node } from "../api.ts";
import { hubCall, onLocal } from "../browser/node.ts";
import { type RelayHeaders, RelayRefused, relayHeaders } from "./mcp.ts";

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
    out = await ask({ server: name, ...(refused ? { refused: true } : {}) });
  } catch (e) {
    const why = e instanceof ToolError ? e.message : (e as Error).message;
    return { refused: `fleetd couldn't ask its hub to renew ${name}'s sign-in (${why})`, signedOut: false };
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

/** One of the relay's calls for `session`: `mcp_header` or `mcp_renew`, `ask` being the hub's `mcp_oauth_renew`. */
export async function relayCall(
  home: string,
  session: string,
  call: Record<string, unknown>,
  ask: (args: Record<string, unknown>) => Promise<Record<string, unknown>>,
): Promise<{ op: string } & RelayAnswer> {
  const name = String(call.server);
  if (call.op === "mcp_header") return { op: "mcp_header", ...headersOf(home, session, name) };
  return { op: "mcp_renew", ...(await renew(home, session, name, String(call.fingerprint ?? ""), call.refused === true, ask)) };
}

export function start(node: Node): void {
  for (const op of ["mcp_header", "mcp_renew"]) {
    onLocal(node, op, (session, call) =>
      relayCall(node.home, session, { ...call, op }, (args) =>
        // "/" is in no bot's workspace: the hub knows the call's bot by its session.
        hubCall(node, "mcp_oauth_renew", args, { threadId: session, cwd: "/", waitMs: RENEW_WAIT_MS }),
      ),
    );
  }
}
