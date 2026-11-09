// The MCP servers fleetd configures for its agents, on the node: their
// secrets (`mcp_secrets`), in `<node home>/mcp-secrets/global.json` and `<node home>/mcp-secrets/projects/<project>.json`;
// each session's servers as its launch or a later send gave them, in `<session dir>/mcp-servers.json`; and the
// `--mcp-config` written for each start of a session's claude, fleetd's own tools server always in it and last, so
// nothing replaces it. Same files as the Rust node: a secret is opened with the node's box key, files are written
// atomically at mode 0600 in 0700 directories, and errors name a value, never show it.
import { readFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import type { McpServerName, McpTransport } from "../../shared/contracts.ts";
import type { McpAgentRole, McpField, McpSecretKey, McpSecretSaved, McpSecretScope, McpSecretSet, McpSessionConfig, McpSessionServer } from "../../shared/sessions.ts";
import { mkdirPrivate } from "../config.ts";
import type { NodeBoxKey } from "../identity.ts";
import type { Vars } from "../secrets/env.ts";
import { ENV_VALUE_MAX_BYTES, fingerprintOf, writeAtomic } from "../secrets/files.ts";
import { nowIso } from "../util.ts";
import { ioWhy, openB64, readIfThere, removeIfThere, utf8 } from "./refusal.ts";

const DIR = "mcp-secrets";
const KEPT = "mcp-servers.json";
/** fleetd's own tools server, which no configured one replaces. */
export const FLEETD_SERVER = "fleetd";

/** Each server's secrets, by `env/NAME` or `header/NAME`. */
type SecretsFile = { servers: Record<string, Record<string, { value: string }>> };

const key = (field: McpField, name: string) => `${field}/${name}`;
const relative = (scope: McpSecretScope) => (scope.kind === "global" ? join(DIR, "global.json") : join(DIR, "projects", `${scope.projectId}.json`));

function readSecrets(home: string, scope: McpSecretScope): SecretsFile {
  const bytes = readIfThere(() => readFileSync(join(home, relative(scope))));
  if (!bytes) return { servers: {} };
  try {
    const file = JSON.parse(bytes.toString("utf8")) as SecretsFile;
    if (!file || typeof file.servers !== "object") throw new Error();
    return file;
  } catch {
    throw new Error("the file does not parse");
  } finally {
    bytes.fill(0);
  }
}

/** Keys sorted at every level, as the Rust node's BTreeMaps write them. */
const sorted = (file: SecretsFile): SecretsFile => ({
  servers: Object.fromEntries(
    Object.keys(file.servers)
      .sort()
      .map((s) => [s, Object.fromEntries(Object.keys(file.servers[s]!).sort().map((k) => [k, file.servers[s]![k]!]))]),
  ),
});

/** Applies one `mcp_secrets`: afterwards the server's secrets are those in `set` and those in `keep` it had, all or
 * nothing. The fingerprint of each it holds. */
export function applySecrets(
  home: string,
  scope: McpSecretScope,
  server: McpServerName,
  set: McpSecretSet[],
  keep: McpSecretKey[],
  boxKey: NodeBoxKey | undefined,
): McpSecretSaved[] {
  const shown = relative(scope);
  let file: SecretsFile;
  try {
    file = readSecrets(home, scope);
  } catch (error) {
    throw new Error(`cannot read ${shown}: ${ioWhy(error)}`);
  }
  const had = file.servers[server] ?? {};
  delete file.servers[server];
  const now: Record<string, { value: string }> = {};
  const saved: McpSecretSaved[] = [];
  for (const k of keep) {
    const secret = had[key(k.field, k.name)];
    if (!secret) continue;
    saved.push({ field: k.field, name: k.name, fingerprint: fingerprintOf(secret.value) });
    now[key(k.field, k.name)] = secret;
  }
  for (const change of set) {
    const name = change.name;
    if (!boxKey) throw new Error("this node takes no secrets: it has no box key");
    const plain = openB64(boxKey, change.sealed);
    if (!plain) throw new Error(`${server}'s ${name} was not sealed to this machine's current box key: seal it to its boxPubKey again`);
    try {
      if (!plain.length) throw new Error(`${server}'s ${name} is empty`);
      if (plain.length > ENV_VALUE_MAX_BYTES) throw new Error(`${server}'s ${name} is over 64 KiB`);
      if (plain.includes(0)) throw new Error(`${server}'s ${name} holds a NUL character`);
      // A header can't hold a line break.
      if (change.field === "header" && (plain.includes(13) || plain.includes(10))) throw new Error(`${server}'s header ${name} holds a line break`);
      const value = utf8(plain);
      if (value === undefined) throw new Error(`${server}'s ${name} is not UTF-8 text`);
      saved.push({ field: change.field, name, fingerprint: fingerprintOf(plain) });
      now[key(change.field, name)] = { value };
    } finally {
      plain.fill(0);
    }
  }
  if (Object.keys(now).length) file.servers[server] = now;
  const path = join(home, shown);
  try {
    mkdirPrivate(dirname(path));
  } catch (error) {
    throw new Error(`cannot make ${dirname(path)}: ${ioWhy(error)}`);
  }
  if (!Object.keys(file.servers).length) {
    try {
      removeIfThere(() => rmSync(path));
    } catch (error) {
      throw new Error(`cannot remove ${shown}: ${ioWhy(error)}`);
    }
    return saved;
  }
  const bytes = Buffer.from(JSON.stringify(sorted(file)));
  try {
    writeAtomic(path, bytes);
  } catch (error) {
    throw new Error(`cannot write ${shown}: ${ioWhy(error)}`);
  } finally {
    bytes.fill(0);
  }
  return saved;
}

/** Deletes a project's secrets file, when its project goes. */
export function forgetSecrets(home: string, projectId: string): void {
  try {
    removeIfThere(() => rmSync(join(home, relative({ kind: "project", projectId }))));
  } catch (error) {
    console.log(`${nowIso()} WARN MCP secrets not removed: ${ioWhy(error)} {"projectId":"${projectId}"}`);
  }
}

/** A session's servers as the node keeps them between its starts. */
export type Kept = { role: McpAgentRole; config: McpSessionConfig };

/** Keeps a session's servers in its directory for its next start. */
export function keep(dir: string, kept: Kept): void {
  mkdirPrivate(dir);
  writeAtomic(join(dir, KEPT), JSON.stringify(kept));
}

/** The servers a session was given; none for a plain thread or a session from before MCP servers. */
export function kept(dir: string): Kept | undefined {
  try {
    return JSON.parse(readFileSync(join(dir, KEPT), "utf8")) as Kept;
  } catch {
    return undefined;
  }
}

/** A server with its secrets resolved: what claude gets. */
export type Resolved = {
  name: string;
  transport: McpTransport;
  /** Env (stdio) or headers (HTTP, SSE). */
  values: Vars;
  /** Its secrets as `<server>.<NAME>`, for masking. */
  secrets: Vars;
};

/** The server's entry in claude's `mcpServers`. */
export function entry(r: Resolved): Record<string, unknown> {
  const values = Object.fromEntries(r.values);
  const t = r.transport;
  return t.type === "stdio" ? { type: "stdio", command: t.command, args: t.args ?? [], env: values } : { type: t.type, url: t.url, headers: values };
}

const hasRole = (roles: McpSessionServer["roles"], role: McpAgentRole) => (role === "lead" ? roles.lead : role === "writer" ? roles.writers : roles.reviewers);

/** `server` with each secret's value from the node's files; throws the names of those it doesn't hold. */
export function resolve(home: string, server: McpSessionServer): Resolved {
  let file: SecretsFile;
  try {
    file = readSecrets(home, server.secrets);
  } catch (error) {
    console.log(`${nowIso()} WARN MCP secrets not read: ${ioWhy(error)} {"server":${JSON.stringify(server.name)}}`);
    file = { servers: {} };
  }
  const held = file.servers[server.name];
  const field: McpField = server.transport.type === "stdio" ? "env" : "header";
  const resolved: Resolved = { name: server.name, transport: server.transport, values: [], secrets: [] };
  const missing: string[] = [];
  for (const v of (field === "env" ? server.env : server.headers) ?? []) {
    if (v.kind === "plain") {
      resolved.values.push([v.name, v.value]);
      continue;
    }
    const secret = held?.[key(field, v.name)];
    if (!secret) {
      missing.push(v.name);
      continue;
    }
    resolved.values.push([v.name, secret.value]);
    resolved.secrets.push([`${server.name}.${v.name}`, secret.value]);
  }
  if (missing.length) throw new MissingSecrets(missing);
  return resolved;
}

export class MissingSecrets extends Error {
  constructor(readonly names: string[]) {
    super(names.join(", "));
  }
}

/** The servers of the kept config that a session of its role gets. */
const ofRole = (k: Kept) => (k.config.servers ?? []).filter((s) => hasRole(s.roles, k.role));

/** The secrets of a session's servers as the node holds them now, for masking what it reports. */
export function sessionSecrets(home: string, dir: string): Vars {
  const k = kept(dir);
  if (!k) return [];
  return ofRole(k).flatMap((s) => {
    try {
      return resolve(home, s).secrets;
    } catch {
      return [];
    }
  });
}

/** What a session's claude starts with: its `--mcp-config` text, the secrets in it, and whether
 * `--strict-mcp-config` keeps the person's own servers out. */
export type SessionMcp = { json: string; secrets: Vars; strict: boolean };

/** The session's `--mcp-config`: the configured servers of its role (one whose secrets the node doesn't all hold is
 * left out, with a warning naming them), then fleetd's own server, which no configured one can replace. */
export function sessionConfig(home: string, k: Kept | undefined, fleetd: Record<string, unknown> | undefined, sessionId: string): SessionMcp {
  const servers: Record<string, unknown> = {};
  const secrets: Vars = [];
  for (const server of k ? ofRole(k) : []) {
    if (server.name.toLowerCase() === FLEETD_SERVER) continue;
    try {
      const resolved = resolve(home, server);
      servers[resolved.name] = entry(resolved);
      secrets.push(...resolved.secrets);
    } catch (error) {
      if (!(error instanceof MissingSecrets)) throw error;
      console.log(
        `${nowIso()} WARN MCP server left out: this node doesn't hold its ${error.message} {"session":"${sessionId}","server":${JSON.stringify(server.name)}}`,
      );
    }
  }
  if (fleetd) servers[FLEETD_SERVER] = fleetd;
  return { json: `${JSON.stringify({ mcpServers: servers })}\n`, secrets, strict: !!k && !k.config.userServers };
}

/** The role a session takes its servers for when a send carries them and it has none kept: what it is. */
export function roleOf(role: string | undefined, branch: string | undefined): McpAgentRole | undefined {
  if (role === "lead" || role === "assistant") return "lead";
  if (role === "worker") return branch ? "writer" : "reviewer";
  return undefined;
}
