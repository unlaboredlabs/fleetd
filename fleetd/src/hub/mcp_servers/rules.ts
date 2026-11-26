// Who may change an MCP server, and the contracts' checks on one (tools.ts runs the tools): its scope, its input, and
// the node capabilities its calls need.
import type { AgentKeyInfo, McpScope, McpServer, McpServerSetInput } from "../../shared/contracts.ts";
import { ToolError } from "../../shared/errors.ts";
import { isSealedSecret } from "../approvals/sink.ts";
import { allows, allowsEverywhere } from "../auth/allows.ts";
import { VAULT_PREFIX_MAX } from "./vault_values.ts";

export const CAP_MCP_SERVERS = "mcp_servers";
export const CAP_ONE_LEAD_MODE = "one_lead_mode";

/**
 * A server runs whatever it is given on the machines its agents run on: only a person changes them, a project's with
 * operate on its machine; a global one takes admin on every machine (D209).
 */
export function mayChange(caller: AgentKeyInfo, scope: McpScope): void {
  const human = caller.kind === "human";
  const allowed = scope.kind === "project" ? allows(caller, "operate", scope.machineId) : allowsEverywhere(caller, "admin");
  if (human && allowed) return;
  if (human && scope.kind === "project") {
    throw new ToolError(
      "forbidden",
      `You can't change this bot's MCP servers: that takes Operate access to ${scope.machineId}.`,
      "Ask the workspace's owner or an admin to give it to you.",
    );
  }
  if (human) {
    throw new ToolError(
      "forbidden",
      "Global MCP servers reach every teammate's agents: only the workspace's owners and admins change them.",
      "Ask an owner or admin to add it in Connections.",
    );
  }
  throw new ToolError(
    "forbidden",
    "Only a person changes the MCP servers agents get, with operate on every machine they reach.",
    "Change them in the app's Connections.",
  );
}

/**
 * A server reached by URL with no key of its own: it signs in with an account, or asks no one to sign in. One that
 * signs in is connected once for the whole team (scope global, D592), and any person on the hub connects it, as anyone
 * adds to the team vault; one that asks no one is the admins' (`mayAddPlain`).
 */
export const signsInOnly = (input: Pick<McpServerSetInput, "transport" | "env" | "headers">) =>
  input.transport.type !== "stdio" &&
  (input.env ?? []).length === 0 &&
  (input.headers ?? []).every((v) => v.kind === "keep" && v.name.toLowerCase() === "authorization");

/**
 * Whether `caller` may connect, change or disconnect the team's signed-in server `server` (none: a new one): any
 * person may connect one; once it is there, the one who connected it or an admin (as with vault items).
 */
export function mayConnect(caller: AgentKeyInfo, server: McpServer | undefined): void {
  if (caller.kind !== "human" || caller.person === undefined) {
    throw new ToolError("forbidden", "Only a person connects a service for the team.", "Connect it in the app's Connections.");
  }
  if (server === undefined || allowsEverywhere(caller, "admin") || server.connectedBy === caller.person.personId) return;
  throw new ToolError(
    "forbidden",
    `${server.name} was connected for the team by someone else: only they or an admin change or disconnect it.`,
    "Ask them or an admin. You can still sign in to it again with Sign in.",
  );
}

/**
 * Whether `caller` may add for the team a server reached by `transport` with no key that asks no one to sign in: it
 * reaches every bot's agents as it is, so only the hub's owners and admins add one, as with a key.
 */
export function mayAddPlain(caller: AgentKeyInfo, transport: McpServer["transport"]): void {
  if (caller.kind !== "human" || allowsEverywhere(caller, "admin")) return mayChange(caller, { kind: "global" });
  const at = transport.type === "stdio" ? "It" : (() => {
    try {
      return new URL(transport.url).host;
    } catch {
      return "It";
    }
  })();
  throw new ToolError(
    "forbidden",
    `${at} doesn't ask anyone to sign in, so every bot's agents would get it as it is: only the workspace's owners and admins add such a server.`,
    "Ask an owner or admin to add it in Connections.",
  );
}

/** A scope as the contracts take it. */
export function checkScope(scope: unknown): McpScope {
  const s = scope as McpScope | undefined;
  if (s?.kind === "global") return { kind: "global" };
  if (s?.kind === "project" && typeof s.machineId === "string" && typeof s.projectId === "string") {
    return { kind: "project", machineId: s.machineId, projectId: s.projectId };
  }
  throw new ToolError("invalid", "scope is { kind: global } or { kind: project, machineId, projectId }.");
}

export function notFound(scope: McpScope, name: string): ToolError {
  const place = scope.kind === "global" ? "global" : `bot ${scope.projectId}'s`;
  return new ToolError("not_found", `No ${place} MCP server ${name}.`, "mcp_servers_get lists them.");
}

export const NAME = /^[A-Za-z0-9_-]{1,64}$/;
export const VALUE_NAME = /^[A-Za-z0-9!#$%&'*+.^_`|~-]{1,128}$/;
export const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const VAULT_ITEM = /^V[0-9a-f]{32}$/;
/** The most bots one team server names. */
export const PROJECTS_MAX = 500;

/** The contracts' checks on McpServerSetInput (mcp.rs `checked!`), with their words. */
export function checkInput(input: McpServerSetInput): void {
  const bad = (why: string) => new ToolError("invalid", why);
  if (typeof input.name !== "string" || !NAME.test(input.name)) throw bad("name is 1 to 64 letters, digits, _ or -.");
  if (input.name.toLowerCase() === "fleetd") throw bad("fleetd is fleetd's own tools server: pick another name");
  if (typeof input.enabled !== "boolean" || typeof input.roles !== "object" || input.roles === null) throw bad("enabled and roles are required.");
  const t = input.transport as McpServer["transport"] | undefined;
  if (t?.type === "stdio") {
    if (typeof t.command !== "string" || t.command.length > 4096 || t.command.includes("\0")) throw bad("command is at most 4 KiB with no NUL");
  } else if (t?.type === "http" || t?.type === "sse") {
    if (typeof t.url !== "string" || t.url.length > 2048 || !/^https?:\/\/[^\s/]+/.test(t.url)) throw bad("url is an http or https URL of at most 2048 characters");
  } else throw bad("transport is stdio, http or sse.");
  if (input.projects !== undefined) {
    if (!Array.isArray(input.projects) || input.projects.length > PROJECTS_MAX) throw bad(`projects is a list of at most ${PROJECTS_MAX} bots.`);
    for (const r of input.projects) {
      if (typeof r?.machineId !== "string" || typeof r.projectId !== "string") throw bad("each of projects is { machineId, projectId }.");
    }
  }
  const env = input.env ?? [];
  const headers = input.headers ?? [];
  if (env.length > 50 || headers.length > 50) throw bad("a server holds at most 50 env values and 50 headers.");
  if (t.type === "stdio" && headers.length > 0) throw bad("a stdio server takes env, not headers");
  if (t.type !== "stdio" && env.length > 0) throw bad("an HTTP or SSE server takes headers, not env");
  for (const list of [env, headers]) {
    const seen = new Set<string>();
    for (const v of list) {
      if (typeof v?.name !== "string" || !VALUE_NAME.test(v.name)) throw bad("each value has a name of at most 128 token characters.");
      if (seen.has(v.name.toLowerCase())) throw bad(`${v.name} is set twice`);
      seen.add(v.name.toLowerCase());
    }
  }
  for (const v of env) if (!ENV_NAME.test(v.name) || v.name.length > 128) throw bad(`${v.name} is not an environment variable name`);
  for (const v of headers) if (v.kind === "plain" && /[\r\n]/.test(v.value)) throw bad(`the header ${v.name} holds a line break`);
  for (const v of [...env, ...headers]) {
    if (v.kind === "plain" && (typeof v.value !== "string" || Buffer.byteLength(v.value) > 65536 || v.value.includes("\0"))) {
      throw bad(`${v.name}'s value is at most 64 KiB with no NUL`);
    }
    if (v.kind === "vault") {
      if (typeof v.itemId !== "string" || !VAULT_ITEM.test(v.itemId)) throw bad(`${v.name}'s itemId is a vault item's id`);
      if (v.field !== undefined && v.field !== "password" && v.field !== "value") throw bad(`${v.name}'s field is password or value`);
      if (v.prefix !== undefined && (typeof v.prefix !== "string" || v.prefix.length > VAULT_PREFIX_MAX || /[\r\n\0]/.test(v.prefix))) {
        throw bad(`${v.name}'s prefix is at most ${VAULT_PREFIX_MAX} characters on one line`);
      }
      continue;
    }
    if (v.kind !== "secret") continue;
    if (!Array.isArray(v.sealed) || v.sealed.length === 0) throw bad(`${v.name} is sealed to no machine`);
    const machines = new Set<string>();
    for (const s of v.sealed) {
      if (typeof s?.machineId !== "string" || typeof s.sealed !== "string" || !isSealedSecret(s.sealed)) {
        throw bad(`${v.name}'s seals are { machineId, sealed }, sealed a sealed box in standard base64.`);
      }
      if (machines.has(s.machineId)) throw bad(`${v.name} is sealed to a machine twice`);
      machines.add(s.machineId);
    }
  }
}

export const sameTransport = (a: McpServer["transport"], b: McpServer["transport"]) => {
  if (a.type !== b.type) return false;
  if (a.type === "stdio" && b.type === "stdio") return a.command === b.command && JSON.stringify(a.args ?? []) === JSON.stringify(b.args ?? []);
  return (a as { url: string }).url === (b as { url: string }).url;
};
