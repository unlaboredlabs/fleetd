// What the hub keeps of an MCP server's sign-in besides its sealed tokens, and when it renews (index.ts runs the
// sign-ins): the client, a pending sign-in, the record as serde writes it, the server's oauth as shown, and the margins.
import type { McpOauth, McpScope, ProjectRef } from "../../shared/contracts.ts";
import type { Discovered } from "./flow.ts";

/** How long a sign-in waits for the person to finish it in their browser. */
export const PENDING_MS = 15 * 60_000;
/** How often the renewal loop looks. */
export const RENEW_TICK_MS = 30_000;
export const MARGIN_MAX_MS = 30 * 60_000;
export const MARGIN_UNKNOWN_MS = 5 * 60_000;
export const RETRY_MS = 2 * 60_000;

/** A client of one service: where it signs in, and as which app. */
export type Client = {
  resource: string;
  issuer: string;
  authorizationEndpoint: string;
  tokenEndpoint: string;
  revocationEndpoint?: string;
  scope?: string;
  clientId: string;
  registered: boolean;
  redirectUri: string;
  /** Its secret, sealed to the hub's own box key (standard base64); none for a public client. */
  sealedSecret?: string;
  tokenAuth?: string;
};

export type Pending = { client: Client; verifier: string; startedMs: number };

/** What the hub keeps of a server's sign-in besides its sealed tokens (`mcp_oauth.data`). */
export type Record_ = {
  client?: Client;
  expiresMs?: number;
  lifetimeMs?: number;
  pushed?: boolean;
  failingSinceMs?: number;
  retryMs?: number;
  told?: boolean;
  pending?: Pending;
};

export type Row = {
  scope: McpScope;
  name: string;
  record: Record_;
  state?: string;
  access?: Uint8Array;
  refresh?: Uint8Array;
};

export const projectOfRow = (row: Row): ProjectRef | undefined =>
  row.scope.kind === "project" ? { machineId: row.scope.machineId, projectId: row.scope.projectId } : undefined;

export const clientText = (c: Client) => ({
  resource: c.resource,
  issuer: c.issuer,
  authorizationEndpoint: c.authorizationEndpoint,
  tokenEndpoint: c.tokenEndpoint,
  revocationEndpoint: c.revocationEndpoint ?? null,
  scope: c.scope ?? null,
  clientId: c.clientId,
  registered: c.registered,
  redirectUri: c.redirectUri,
  sealedSecret: c.sealedSecret ?? null,
  tokenAuth: c.tokenAuth ?? null,
});

/** The record as serde writes it: every field in the struct's order, an absent one as null. */
export function recordText(r: Record_): string {
  return JSON.stringify({
    client: r.client ? clientText(r.client) : null,
    expiresMs: r.expiresMs ?? null,
    lifetimeMs: r.lifetimeMs ?? null,
    pushed: r.pushed ?? false,
    failingSinceMs: r.failingSinceMs ?? null,
    retryMs: r.retryMs ?? null,
    told: r.told ?? false,
    pending: r.pending ? { client: clientText(r.pending.client), verifier: r.pending.verifier, startedMs: r.pending.startedMs } : null,
  });
}

/** McpOauth in serde's order with absent fields left out; `signingIn` always. */
export function tidy(o: McpOauth): McpOauth {
  return {
    status: o.status,
    issuer: o.issuer,
    ...(o.clientId != null ? { clientId: o.clientId } : {}),
    signingIn: o.signingIn ?? false,
    ...(o.signedInAt != null ? { signedInAt: o.signedInAt } : {}),
    ...(o.expiresAt != null ? { expiresAt: o.expiresAt } : {}),
    ...(o.problem != null ? { problem: o.problem } : {}),
  };
}

export const clientOf = (found: Discovered): Client => ({
  resource: found.resource,
  issuer: found.issuer,
  authorizationEndpoint: found.authorizationEndpoint,
  tokenEndpoint: found.tokenEndpoint,
  ...(found.revocationEndpoint !== undefined ? { revocationEndpoint: found.revocationEndpoint } : {}),
  ...(found.scope !== undefined ? { scope: found.scope } : {}),
  clientId: "",
  registered: false,
  redirectUri: "",
});

/** Whether the token should be renewed now: half its life left, at most MARGIN_MAX_MS. */
export function due(record: Record_, at: number): boolean {
  if (record.expiresMs === undefined) return false;
  const margin = Math.min(record.lifetimeMs !== undefined ? Math.trunc(record.lifetimeMs / 2) : MARGIN_UNKNOWN_MS, MARGIN_MAX_MS);
  return record.expiresMs - at <= margin;
}
