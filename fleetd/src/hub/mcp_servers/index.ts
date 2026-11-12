// The MCP servers fleetd gives its agents: one `mcp_servers` row per
// server (a global one's machine and project are empty) and `mcp_settings.user_servers`. A secret value is sealed in
// the desktop app to each machine's box key; the hub relays each box to its node and keeps only the fingerprint that
// node computed, per machine. A session's launch carries its project's servers with each secret by name only.
import { createHash } from "node:crypto";
import type { McpScope, McpServer, ProjectRef } from "../../shared/contracts.ts";
import type { Hub } from "../api/hub.ts";
import { sortedValue } from "../integrations/policy.ts";
import { holders } from "../repos/store.ts";
import type { HubDb } from "../store/db.ts";
import { anyRole, canonical, forSession, isOauthToken, type LeadMcpSet, type McpSecretScope, type McpSessionConfig, type McpSessionServer, parse, scopeKey, value, valuesOf } from "./model.ts";

export {
  forSession,
  isOauthToken,
  type LeadMcpSet,
  MCP_SERVERS_MAX,
  type McpField,
  type McpSecretScope,
  type McpSessionConfig,
  type McpSessionServer,
  type McpSessionValue,
  newSince,
  OAUTH_HEADER,
  oneSwitch,
  scopeKey,
  secretScope,
  secretsMissingOn,
  signedIn,
  transportOf,
  valuesOf,
} from "./model.ts";

// The node link's MCP types (fleetd-contracts mcp_servers.rs), which only Rust renders.
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
