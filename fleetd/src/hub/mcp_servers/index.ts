// The MCP servers fleetd gives its agents: one `mcp_servers` row per
// server (a global one's machine and project are empty) and `mcp_settings.user_servers`. A secret value is sealed in
// the desktop app to each machine's box key; the hub relays each box to its node and keeps only the fingerprint that
// node computed, per machine. A session's launch carries its project's servers with each secret by name only.
import { createHash } from "node:crypto";
import type { McpRoles, McpScope, McpServer, McpValue, ProjectRef } from "../../shared/contracts.ts";
import type { Hub } from "../api/hub.ts";
import { sortedValue } from "../integrations/policy.ts";
import { holders } from "../repos/store.ts";
import type { HubDb } from "../store/db.ts";

// The node link's MCP types (fleetd-contracts mcp_servers.rs), which only Rust renders.
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

/** Secrets whose value the node of `machineId` doesn't hold: the server can't start there. */
export const secretsMissingOn = (s: McpServer, machineId: string) =>
  valuesOf(s)
    .filter(([, v]) => v.kind === "secret" && !(v.sealedOn ?? []).some((x) => x.machineId === machineId))
    .map(([, v]) => v.name);

/** A server that signs in with OAuth has a token; one that doesn't sign in always counts. */
export const signedIn = (s: McpServer) => !s.oauth || s.oauth.status === "connected";

/** The value is an OAuth server's access token, which the hub replaces as it renews it. */
export const isOauthToken = (s: McpServer, field: McpField, v: McpValue) =>
  s.oauth !== undefined && field === "header" && v.name.toLowerCase() === OAUTH_HEADER.toLowerCase();

const anyRole = (s: McpServer) => s.roles.lead || s.roles.writers || s.roles.reviewers;

/**
 * A server as a session on `machineId` gets it: plain values as they are, a secret by name. Undefined when that
 * machine's node doesn't hold all of its secrets, or when it signs in with OAuth and is signed out or tokenless. An
 * integration reaches the lead alone.
 */
export function forSession(s: McpServer, machineId: string): McpSessionServer | undefined {
  const tokenless = s.oauth !== undefined && !valuesOf(s).some(([f, v]) => isOauthToken(s, f, v));
  if (secretsMissingOn(s, machineId).length > 0 || !signedIn(s) || tokenless) return undefined;
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
  };
}

const parse = (data: string): McpServer | undefined => {
  try {
    return JSON.parse(data) as McpServer;
  } catch {
    return undefined;
  }
};

/** The Rust struct's key order, so a row reads the same whichever hub wrote it. */
function canonical(s: McpServer): McpServer {
  const out: Record<string, unknown> = {};
  for (const k of ["scope", "name", "enabled", "roles", "transport", "env", "headers", "integration", "oauth", "updatedAt"] as const) {
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

const value = (v: McpValue): McpValue => ({
  name: v.name,
  kind: v.kind,
  ...(v.value !== undefined && v.value !== null ? { value: v.value } : {}),
  ...(v.sealedOn && v.sealedOn.length > 0 ? { sealedOn: v.sealedOn } : {}),
});

/** A lead's MCP set: the person's own servers come too, and a fingerprint by server name. */
export type LeadMcpSet = { userServers: boolean; servers: Record<string, string> };

/** The servers in `now` that `before` didn't have, or had otherwise, by name. */
export const newSince = (now: LeadMcpSet, before: LeadMcpSet) =>
  Object.keys(now.servers)
    .sort()
    .filter((name) => before.servers[name] !== now.servers[name]);

export class McpServerStore {
  constructor(private readonly db: HubDb) {}

  /** A scope's servers, by name. */
  list(scope: McpScope): McpServer[] {
    const [m, p] = scopeKey(scope);
    return this.db.conn
      .query<{ data: string }, [string, string]>("SELECT data FROM mcp_servers WHERE machine_id = ? AND project_id = ? ORDER BY name")
      .all(m, p)
      .map((r) => parse(r.data))
      .filter((s): s is McpServer => s !== undefined);
  }

  get(scope: McpScope, name: string): McpServer | undefined {
    const [m, p] = scopeKey(scope);
    const row = this.db.conn
      .query<{ data: string }, [string, string, string]>("SELECT data FROM mcp_servers WHERE machine_id = ? AND project_id = ? AND name = ?")
      .get(m, p, name);
    return row ? parse(row.data) : undefined;
  }

  put(s: McpServer): void {
    const [m, p] = scopeKey(s.scope);
    this.db.conn
      .query(
        `INSERT INTO mcp_servers (machine_id, project_id, name, data) VALUES (?, ?, ?, ?)
         ON CONFLICT (machine_id, project_id, name) DO UPDATE SET data = excluded.data`,
      )
      .run(m, p, s.name, JSON.stringify(canonical(s)));
  }

  remove(scope: McpScope, name: string): boolean {
    const [m, p] = scopeKey(scope);
    return this.db.conn.query("DELETE FROM mcp_servers WHERE machine_id = ? AND project_id = ? AND name = ?").run(m, p, name).changes > 0;
  }

  /** The secrets a node is yet to forget for a server the hub no longer has: machine, where it keeps them, server. */
  forgets(): [string, McpSecretScope, string][] {
    return this.db.conn
      .query<{ machine_id: string; project_id: string; name: string }, []>("SELECT machine_id, project_id, name FROM mcp_secret_forgets")
      .all()
      .map((r): [string, McpSecretScope, string] => [
        r.machine_id,
        r.project_id === "" ? { kind: "global" } : { kind: "project", projectId: r.project_id },
        r.name,
      ]);
  }

  /** The node forgot them. */
  forgot(machineId: string, scope: McpSecretScope, name: string): void {
    const p = scope.kind === "global" ? "" : scope.projectId;
    this.db.conn.query("DELETE FROM mcp_secret_forgets WHERE machine_id = ? AND project_id = ? AND name = ?").run(machineId, p, name);
  }

  /** Whether agents also get the person's own MCP servers: on until a person turns it off. */
  userServers(): boolean {
    const row = this.db.conn.query<{ value: number }, []>("SELECT value FROM mcp_settings WHERE key = 'user_servers'").get();
    return row === null || row.value !== 0;
  }

  setUserServers(on: boolean): void {
    this.db.conn
      .query("INSERT INTO mcp_settings (key, value) VALUES ('user_servers', ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value")
      .run(on ? 1 : 0);
  }

  /**
   * The servers a project's sessions are configured from, by name: the global ones, the project's own over them, and
   * in a repo checkout another project holds that project's servers too; with several, the one that added it first
   * wins a name (W79).
   */
  serversFor(r: ProjectRef): McpServer[] {
    const by = new Map<string, McpServer>();
    for (const s of this.list({ kind: "global" })) by.set(s.name, s);
    const held = holders(this.db.conn, r).map((h) => h.project);
    for (const project of [r, ...held.reverse()]) {
      for (const s of this.list({ kind: "project", machineId: project.machineId, projectId: project.projectId })) by.set(s.name, s);
    }
    return [...by.keys()].sort().map((k) => by.get(k)!);
  }

  /** What a session of the project gets: `serversFor`'s enabled ones with a role, whose secrets are on its machine. */
  sessionConfig(r: ProjectRef): McpSessionConfig {
    return {
      userServers: this.userServers(),
      servers: this.serversFor(r)
        .filter((s) => s.enabled && anyRole(s))
        .map((s) => forSession(s, r.machineId))
        .filter((s): s is McpSessionServer => s !== undefined),
    };
  }

  /** What a lead's session of the project gets: each lead server as a fingerprint of what the node writes for it. */
  leadSet(r: ProjectRef): LeadMcpSet {
    const servers: Record<string, string> = {};
    for (const s of this.serversFor(r).filter((s) => s.enabled && s.roles.lead)) {
      const session = forSession(s, r.machineId);
      if (!session) continue;
      // A replaced key is a new value on the node; a renewed OAuth token isn't a change.
      const keys = valuesOf(s)
        .filter(([f, v]) => !isOauthToken(s, f, v))
        .map(([, v]) => (v.sealedOn ?? []).find((k) => k.machineId === r.machineId))
        .filter((k) => k !== undefined)
        .map((k) => k.fingerprint);
      const what = { secrets: session.secrets, transport: session.transport, env: session.env, headers: session.headers, keys };
      servers[s.name] = createHash("sha256").update(JSON.stringify(sortedValue(what))).digest("hex");
    }
    return { userServers: this.userServers(), servers };
  }
}

export const mcpServers = (hub: Hub) => hub.area("mcp_servers", (h) => new McpServerStore(h.db));
