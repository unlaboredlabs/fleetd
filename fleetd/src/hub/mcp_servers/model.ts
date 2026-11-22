// An MCP server as a session and a lead get it, without the database (index.ts keeps the rows): its scope and secret
// scope, its values, whether it is signed in, the role switch, the session's config, a row's canonical form, and what a
// lead's set gained.
import type { McpRoles, McpScope, McpServer, McpValue, ProjectRef } from "../../shared/contracts.ts";
import { isTailnetHost } from "../../shared/tailnet.ts";

export type McpField = "env" | "header";
export type McpSecretScope = { kind: "global" } | { kind: "project"; projectId: string };
export type McpSessionValue = { kind: "plain"; name: string; value: string } | { kind: "secret"; name: string };
export type McpSessionServer = {
  name: string;
  secrets: McpSecretScope;
  roles: McpRoles;
  transport: McpServer["transport"];
  env: McpSessionValue[];
  headers: McpSessionValue[];
  /** It signs in with OAuth: the node relays it (`fleetd mcp-relay`) with the token it holds now. */
  oauth?: true;
  /** Its URL is on the team's tailnet: a node not on it relays it through the hub's Tailscale route. */
  tailnet?: true;
};
export type McpSessionConfig = { userServers: boolean; servers: McpSessionServer[] };

export const OAUTH_HEADER = "Authorization";
export const MCP_SERVERS_MAX = 50;

/** `(machine_id, project_id)` of a scope's rows: empty for a global server. */
export const scopeKey = (scope: McpScope): [string, string] =>
  scope.kind === "global" ? ["", ""] : [scope.machineId, scope.projectId];

/** Where the node of a session keeps a server's secrets. */
export const secretScope = (scope: McpScope): McpSecretScope =>
  scope.kind === "global" ? { kind: "global" } : { kind: "project", projectId: scope.projectId };

/** A server's env then its headers, each with its field. */
export const valuesOf = (s: McpServer): [McpField, McpValue][] => [
  ...(s.env ?? []).map((v): [McpField, McpValue] => ["env", v]),
  ...(s.headers ?? []).map((v): [McpField, McpValue] => ["header", v]),
];

/** Secrets (typed, or from the vault) whose value the node of `machineId` doesn't hold: the server can't start there. */
export const secretsMissingOn = (s: McpServer, machineId: string) =>
  valuesOf(s)
    .filter(([, v]) => v.kind !== "plain" && !(v.sealedOn ?? []).some((x) => x.machineId === machineId))
    .map(([, v]) => v.name);

/** A server that signs in with OAuth has a token; one that doesn't sign in always counts. */
export const signedIn = (s: McpServer) => !s.oauth || s.oauth.status === "connected";

/** The value is an OAuth server's access token, which the hub replaces as it renews it. */
export const isOauthToken = (s: McpServer, field: McpField, v: McpValue) =>
  s.oauth !== undefined && field === "header" && v.name.toLowerCase() === OAUTH_HEADER.toLowerCase();

export const anyRole = (s: McpServer) => s.roles.lead || s.roles.writers || s.roles.reviewers;

/** Whether bot `r`'s sessions get `s`: a project's own server always, the team's when its bots list names `r` or
 * there is no list. */
export const forBot = (s: McpServer, r: ProjectRef) =>
  s.scope.kind === "project" || s.projects === undefined || s.projects.some((p) => p.machineId === r.machineId && p.projectId === r.projectId);

/** The host of an HTTP or SSE server's URL; undefined for a command or a URL that doesn't parse. */
export function hostOf(t: McpServer["transport"]): string | undefined {
  if (t.type === "stdio") return undefined;
  try {
    return new URL(t.url).hostname.replace(/^\[(.*)\]$/u, "$1");
  } catch {
    return undefined;
  }
}

/** Whether a server's URL is on the team's tailnet (`suffix` its MagicDNS suffix, when known). */
export const onTailnet = (s: Pick<McpServer, "transport">, suffix?: string) => {
  const host = hostOf(s.transport);
  return host !== undefined && isTailnetHost(host, suffix);
};

/** Where a tailnet route dials for a server: its URL's host, in lower case as written, and its port (the scheme's
 * default when it names none). */
export type DialTarget = { host: string; port: number };

export function targetOf(t: McpServer["transport"]): DialTarget | undefined {
  if (t.type === "stdio") return undefined;
  try {
    const u = new URL(t.url);
    const port = u.port ? Number(u.port) : u.protocol === "https:" ? 443 : u.protocol === "http:" ? 80 : NaN;
    return Number.isInteger(port) ? { host: u.hostname.replace(/^\[(.*)\]$/u, "$1").toLowerCase(), port } : undefined;
  } catch {
    return undefined;
  }
}

/**
 * What machine `machineId` may dial through the team's tailnet route: the addresses of the team's tailnet servers its
 * sessions get, as a session gets them (`forSession`: one connected by a person with no key only once signed in), for
 * the bots it names when it names some. Nothing else on the tailnet, and no bot's own server: anyone with Operate on
 * one machine adds those, and lending the hub's tailnet stays the decision of those who change the team's servers.
 */
export function tailnetTargets(servers: readonly McpServer[], machineId: string, suffix?: string): DialTarget[] {
  return servers.flatMap((s) => {
    if (s.scope.kind !== "global" || !s.enabled || !anyRole(s)) return [];
    if (s.projects !== undefined && !s.projects.some((p) => p.machineId === machineId)) return [];
    if (forSession(s, machineId, suffix)?.tailnet !== true) return [];
    const t = targetOf(s.transport);
    return t ? [t] : [];
  });
}

/** Whether a dial of `host`:`port` is to one of `targets`. */
export const mayDial = (targets: readonly DialTarget[], host: string, port: number) => {
  const h = host.replace(/^\[(.*)\]$/u, "$1").toLowerCase();
  return targets.some((t) => t.host === h && t.port === port);
};

/**
 * A server's one switch, "Agents get it too": its lead alone, or its writers and reviewers as well. Roles from an
 * older app that named some kinds of agent count as on; a server for no one is its lead's, and off.
 */
export function oneSwitch(roles: McpRoles, enabled: boolean): { roles: McpRoles; enabled: boolean } {
  const agents = roles.writers || roles.reviewers;
  return { roles: { lead: true, writers: agents, reviewers: agents }, enabled: enabled && (agents || roles.lead) };
}

/**
 * A server as a session on `machineId` gets it: plain values as they are, a secret by name. Undefined when that
 * machine's node doesn't hold all of its secrets, or when it signs in with OAuth and is signed out or tokenless. An
 * integration reaches the lead alone.
 */
export function forSession(s: McpServer, machineId: string, suffix?: string): McpSessionServer | undefined {
  const tokenless = s.oauth !== undefined && !valuesOf(s).some(([f, v]) => isOauthToken(s, f, v));
  // One a person connected for the team reaches agents only once signed in: no one adds a keyless server for every bot.
  const unsigned = s.connectedBy !== undefined && s.oauth?.status !== "connected";
  if (secretsMissingOn(s, machineId).length > 0 || !signedIn(s) || tokenless || unsigned) return undefined;
  const values = (list: McpValue[] | undefined): McpSessionValue[] =>
    (list ?? []).map((v) =>
      v.kind === "plain" && v.value !== undefined ? { kind: "plain", name: v.name, value: v.value } : { kind: "secret", name: v.name },
    );
  return {
    name: s.name,
    secrets: secretScope(s.scope),
    roles: s.integration ? { ...s.roles, writers: false, reviewers: false } : s.roles,
    transport: transportOf(s.transport),
    env: values(s.env),
    headers: values(s.headers),
    ...(s.oauth !== undefined ? { oauth: true as const } : {}),
    ...(onTailnet(s, suffix) ? { tailnet: true as const } : {}),
  };
}

export const parse = (data: string): McpServer | undefined => {
  try {
    return JSON.parse(data) as McpServer;
  } catch {
    return undefined;
  }
};

/** The Rust struct's key order, so a row reads the same whichever hub wrote it. */
export function canonical(s: McpServer): McpServer {
  const out: Record<string, unknown> = {};
  for (const k of ["scope", "name", "enabled", "roles", "transport", "env", "headers", "integration", "oauth", "connectedBy", "projects", "updatedAt"] as const) {
    if (s[k] !== undefined && s[k] !== null) out[k] = s[k];
  }
  out.transport = transportOf(s.transport);
  out.env = (s.env ?? []).map(value);
  out.headers = (s.headers ?? []).map(value);
  return out as McpServer;
}

/** A transport as serde writes it: a stdio one always with its `args`. */
export const transportOf = (t: McpServer["transport"]): McpServer["transport"] =>
  t.type === "stdio" ? { type: "stdio", command: t.command, args: t.args ?? [] } : { type: t.type, url: t.url };

export const value = (v: McpValue): McpValue => ({
  name: v.name,
  kind: v.kind,
  ...(v.value !== undefined && v.value !== null ? { value: v.value } : {}),
  ...(v.itemId !== undefined ? { itemId: v.itemId } : {}),
  ...(v.field !== undefined ? { field: v.field } : {}),
  ...(v.prefix !== undefined ? { prefix: v.prefix } : {}),
  ...(v.label !== undefined ? { label: v.label } : {}),
  ...(v.problem !== undefined ? { problem: v.problem } : {}),
  ...(v.sealedOn && v.sealedOn.length > 0 ? { sealedOn: v.sealedOn } : {}),
});

/** A lead's MCP set: the person's own servers come too, and a fingerprint by server name. */
export type LeadMcpSet = { userServers: boolean; servers: Record<string, string> };

/** The servers in `now` that `before` didn't have, or had otherwise, by name. */
export const newSince = (now: LeadMcpSet, before: LeadMcpSet) =>
  Object.keys(now.servers)
    .sort()
    .filter((name) => before.servers[name] !== now.servers[name]);
