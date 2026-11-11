// The MCP server tools. Saving a server relays each secret's boxes to
// the nodes they were sealed to and records the fingerprints they answer; the boxes are never stored, logged or
// returned.
import type { McpScope, McpSealedOn, McpServer, McpServerSetInput, McpTestResult, McpValue, McpValueSet, ProjectRef } from "../../shared/contracts.ts";
import { ToolError } from "../../shared/errors.ts";
import { requireRole } from "../api/grants.ts";
import type { Hub } from "../api/hub.ts";
import type { Caller, Registry } from "../api/registry.ts";
import { isSealedSecret } from "../approvals/sink.ts";
import { allows } from "../auth/index.ts";
import { allowsEverywhere } from "../claude_accounts/people.ts";
import { linked, nodeCan, offline, sessionCall } from "../cloud/node.ts";
import { toolPolicy } from "../integrations/policy.ts";
import * as oauth from "../mcp_oauth/index.ts";
import { offersSignIn } from "../mcp_oauth/oauth.ts";
import { store } from "../store/hub_store.ts";
import { isoMs } from "../store/time.ts";
import {
  forSession,
  type McpField,
  type McpSessionServer,
  MCP_SERVERS_MAX,
  mcpServers,
  OAUTH_HEADER,
  oneSwitch,
  secretScope,
  secretsMissingOn,
  signedIn,
  valuesOf,
} from "./index.ts";

export const CAP_MCP_SERVERS = "mcp_servers";
export const CAP_ONE_LEAD_MODE = "one_lead_mode";

export function register(tools: Registry): void {
  tools.add("mcp_servers_get", (hub, caller, input) => {
    const s = mcpServers(hub);
    let project: McpServer[] = [];
    if (input.project === undefined) requireRole(caller, "read");
    else {
      requireRole(caller, "read", input.project.machineId);
      const scope: McpScope = { kind: "project", machineId: input.project.machineId, projectId: input.project.projectId };
      projectOf(hub, scope);
      project = s.list(scope);
    }
    return { global: s.list({ kind: "global" }), project, userServers: s.userServers() };
  });
  tools.add("mcp_server_set", (hub, caller, input) => set(hub, caller, input));
  tools.add("mcp_server_remove", async (hub, caller, input) => {
    const scope = checkScope(input.scope);
    mayChange(caller, scope);
    const s = mcpServers(hub);
    const before = s.get(scope, input.name);
    if (!before) throw notFound(scope, input.name);
    s.remove(scope, input.name);
    if (before.oauth) await oauth.forget(hub, scope, input.name);
    oauth.removed(hub, scope, input.name);
    // Each node holding its secrets forgets them; one offline keeps them unused until the server is saved again.
    const holders = [...new Set(valuesOf(before).flatMap(([, v]) => (v.sealedOn ?? []).map((x) => x.machineId)))].sort();
    for (const m of holders) {
      if (!ready(hub, m)) continue;
      try {
        await sessionCall(hub, m, { op: "mcp_secrets", scope: secretScope(scope), server: input.name, set: [], keep: [] });
      } catch (e) {
        console.warn(`MCP secrets of ${input.name} not forgotten on ${m}:`, (e as Error).message);
      }
    }
    return { ok: true, next: "Agents started from now on go without it; a running agent keeps it until its next start." };
  });
  tools.add("mcp_settings_set", (hub, caller, input) => {
    mayChange(caller, { kind: "global" });
    if (typeof input.userServers !== "boolean") throw new ToolError("invalid", "userServers is true or false.");
    const s = mcpServers(hub);
    s.setUserServers(input.userServers);
    return {
      userServers: s.userServers(),
      next: "Agents started from now on run this way; a running agent at its next start, after its next message.",
    };
  });
  tools.add("mcp_server_test", (hub, caller, input) => test(hub, caller, input.scope, input.name, input.machineId));
}

/**
 * A server runs whatever it is given on the machines its agents run on: only a person changes them, a project's with
 * operate on its machine; a global one takes admin on every machine (D209).
 */
export function mayChange(caller: Caller, scope: McpScope): void {
  const human = caller.kind === "human";
  const allowed = scope.kind === "project" ? allows(caller, "operate", scope.machineId) : allowsEverywhere(caller, "admin");
  if (human && allowed) return;
  if (human && scope.kind === "project") {
    throw new ToolError(
      "forbidden",
      `You can't change this project's MCP servers: that takes Operate access to ${scope.machineId}.`,
      "Ask the hub's owner or an admin to give it to you.",
    );
  }
  if (human) {
    throw new ToolError(
      "forbidden",
      "Global MCP servers reach every teammate's agents: only the hub's owners and admins change them.",
      "Ask an owner or admin (Settings › Hub › Every project › Tools & skills), or add the server to one project in its settings.",
    );
  }
  throw new ToolError(
    "forbidden",
    "Only a person changes the MCP servers agents get, with operate on every machine they reach.",
    "Change them in the desktop app: Settings › Hub › Every project › Tools & skills, or the project's settings.",
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

export function projectOf(hub: Hub, scope: McpScope): ProjectRef | undefined {
  if (scope.kind !== "project") return undefined;
  const r = { machineId: scope.machineId, projectId: scope.projectId };
  if (!store(hub).projectGet(r)) {
    throw new ToolError("not_found", `No project ${r.projectId} on ${r.machineId}.`, `Call project_get with machineId ${r.machineId} and no projectId.`);
  }
  return r;
}

/** The node can take MCP calls: online and new enough. */
export function nodeReady(hub: Hub, m: string): void {
  if (!linked(hub, m)) throw offline(m);
  if (!nodeCan(hub, m, CAP_MCP_SERVERS)) {
    throw new ToolError("invalid", `fleetd on ${m} is too old to run MCP servers.`, `Update fleetd on ${m}, then try again.`);
  }
}

const ready = (hub: Hub, m: string) => linked(hub, m) && nodeCan(hub, m, CAP_MCP_SERVERS);

export function notFound(scope: McpScope, name: string): ToolError {
  const place = scope.kind === "global" ? "global" : `project ${scope.projectId}'s`;
  return new ToolError("not_found", `No ${place} MCP server ${name}.`, "mcp_servers_get lists them.");
}

const NAME = /^[A-Za-z0-9_-]{1,64}$/;
const VALUE_NAME = /^[A-Za-z0-9!#$%&'*+.^_`|~-]{1,128}$/;
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** The contracts' checks on McpServerSetInput (mcp.rs `checked!`), with their words. */
function checkInput(input: McpServerSetInput): void {
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

const byMachine = (a: { machineId: string }, b: { machineId: string }) => (a.machineId < b.machineId ? -1 : a.machineId > b.machineId ? 1 : 0);

async function set(hub: Hub, caller: Caller, input: McpServerSetInput) {
  const scope = checkScope(input.scope);
  mayChange(caller, scope);
  checkInput(input);
  const project = projectOf(hub, scope);
  if (input.integration && !project) {
    // Only a project's lead asks before a tool runs: one saved for every project would reach agents unasked.
    throw new ToolError(
      "invalid",
      "An integration asks you before its tools send anything, which only a project's lead does.",
      "Add it in one project's settings: its lead asks you before each send.",
    );
  }
  if (project && input.integration && !nodeCan(hub, project.machineId, CAP_ONE_LEAD_MODE) && !isNavi(hub, project)) {
    // An older node runs this project's lead with full access, which would send unasked.
    throw new ToolError(
      "invalid",
      `${project.machineId}'s node is too old for its lead to ask before a send.`,
      `Run fleetd update on ${project.machineId}, then add it again.`,
    );
  }
  const s = mcpServers(hub);
  const before = s.get(scope, input.name);
  if (!before && s.list(scope).length >= MCP_SERVERS_MAX) {
    const place = scope.kind === "global" ? "for every project" : "in this project";
    throw new ToolError("invalid", `There are already ${MCP_SERVERS_MAX} MCP servers ${place}, the most fleetd takes.`, "Remove one first.");
  }
  const savedSecret = (field: McpField, name: string): McpValue | undefined =>
    before ? valuesOf(before).find(([f, v]) => f === field && v.name === name && v.kind === "secret")?.[1] : undefined;
  // A server signed in with OAuth keeps its sign-in through a save that leaves its URL and its Authorization header
  // alone; a new URL, or a typed Authorization, ends it.
  const typedToken = (input.headers ?? []).some((v) => v.name.toLowerCase() === OAUTH_HEADER.toLowerCase());
  const hadSignIn = before?.oauth !== undefined;
  const signsIn = hadSignIn && !typedToken && sameTransport(before.transport, input.transport);
  const env: McpValueSet[] = [...(input.env ?? [])];
  const headers: McpValueSet[] = [...(input.headers ?? [])];
  if (signsIn && savedSecret("header", OAUTH_HEADER)) headers.push({ kind: "keep", name: OAUTH_HEADER });
  const fieldOf = (field: McpField) => (field === "env" ? env : headers);
  // Every machine that gets a node call: those the new boxes are for, and those holding this server's secrets now.
  const targets = new Set<string>();
  for (const field of ["env", "header"] as const) {
    for (const v of fieldOf(field)) {
      if (v.kind === "secret") {
        for (const x of v.sealed) {
          if (project && x.machineId !== project.machineId) {
            throw new ToolError(
              "invalid",
              `${v.name} is sealed to ${x.machineId}, but the project's machine is ${project.machineId}.`,
              "Seal a project server's secrets to its own machine.",
            );
          }
          targets.add(x.machineId);
        }
      } else if (v.kind === "keep" && !savedSecret(field, v.name)) {
        throw new ToolError("invalid", `${v.name} has no saved secret to keep.`, "Type its value.");
      }
    }
  }
  if (before) for (const [, v] of valuesOf(before)) for (const x of v.sealedOn ?? []) targets.add(x.machineId);
  if (project && targets.size > 0) nodeReady(hub, project.machineId);
  const held = new Map<string, McpSealedOn[]>();
  const reached = new Set<string>();
  const problems: string[] = [];
  const sScope = secretScope(scope);
  for (const m of [...targets].sort()) {
    try {
      nodeReady(hub, m);
    } catch (e) {
      problems.push((e as Error).message);
      continue;
    }
    const setList: { field: McpField; name: string; sealed: string }[] = [];
    const keep: { field: McpField; name: string }[] = [];
    for (const field of ["env", "header"] as const) {
      for (const v of fieldOf(field)) {
        if (v.kind === "secret") {
          const x = v.sealed.find((y) => y.machineId === m);
          if (x) setList.push({ field, name: v.name, sealed: x.sealed });
        } else if (v.kind === "keep" && (savedSecret(field, v.name)?.sealedOn ?? []).some((y) => y.machineId === m)) {
          keep.push({ field, name: v.name });
        }
      }
    }
    try {
      const out = await sessionCall(hub, m, { op: "mcp_secrets", scope: sScope, server: input.name, set: setList, keep });
      reached.add(m);
      for (const saved of (out.secrets as { field: McpField; name: string; fingerprint: string }[] | undefined) ?? []) {
        const key = `${saved.field}\u0000${saved.name}`;
        held.set(key, [...(held.get(key) ?? []), { machineId: m, fingerprint: saved.fingerprint }]);
      }
    } catch (e) {
      // A project server's machine is the only one: all or nothing.
      if (project) throw e;
      problems.push(`${m}: ${(e as Error).message}`);
    }
  }
  const values = (field: McpField): McpValue[] =>
    fieldOf(field).map((v): McpValue => {
      if (v.kind === "plain") return { name: v.name, kind: "plain", value: v.value };
      const sealedOn = [...(held.get(`${field}\u0000${v.name}`) ?? [])];
      // A kept secret stays recorded on a machine this save didn't reach: its node still has it.
      if (v.kind === "keep") {
        const saved = savedSecret(field, v.name);
        if (saved) sealedOn.push(...(saved.sealedOn ?? []).filter((x) => !reached.has(x.machineId)));
      }
      sealedOn.sort(byMachine);
      return { name: v.name, kind: "secret", ...(sealedOn.length > 0 ? { sealedOn } : {}) };
    });
  // Read again: a renewal may have changed the sign-in while the nodes answered.
  const signIn = signsIn ? s.get(scope, input.name)?.oauth : undefined;
  const server: McpServer = {
    scope,
    name: input.name,
    ...oneSwitch(input.roles, input.enabled),
    transport: input.transport,
    env: values("env"),
    headers: values("header"),
    ...(input.integration ? { integration: input.integration } : {}),
    ...(signIn ? { oauth: signIn } : {}),
    updatedAt: isoMs(hub.clock.now()),
  };
  s.put(server);
  if (hadSignIn && !signsIn) await oauth.forget(hub, scope, input.name);
  const machines = project ? [project.machineId] : store(hub).machinesList().map((m) => m.machineId);
  const missingOn = machines.filter((m) => secretsMissingOn(server, m).length > 0);
  let next = "Agents started from now on get it; a running agent gets it at its next start, after its next message.";
  if (missingOn.length > 0) {
    next = `${next} Its secrets aren't on ${missingOn.join(", ")}, whose agents go without it until it is saved again while they are online.`;
  }
  if (problems.length > 0) next = `${next} ${problems.join(" ")}`;
  return { server: s.get(scope, input.name) ?? server, ...(missingOn.length > 0 ? { missingOn } : {}), next };
}

const sameTransport = (a: McpServer["transport"], b: McpServer["transport"]) => {
  if (a.type !== b.type) return false;
  if (a.type === "stdio" && b.type === "stdio") return a.command === b.command && JSON.stringify(a.args ?? []) === JSON.stringify(b.args ?? []);
  return (a as { url: string }).url === (b as { url: string }).url;
};

const isNavi = (hub: Hub, r: ProjectRef) =>
  hub.db.conn.query("SELECT 1 FROM project_settings WHERE machine_id = ? AND project_id = ? AND only_me = 1").get(r.machineId, r.projectId) !== null;

/** Has each online node forget the secrets queued for it; one offline, or too old, is asked again next round. */
export async function forgetQueued(hub: Hub): Promise<void> {
  const s = mcpServers(hub);
  let queued;
  try {
    queued = s.forgets();
  } catch (e) {
    console.warn("MCP secrets to forget not read:", e);
    return;
  }
  for (const [m, scope, name] of queued) {
    if (!ready(hub, m)) continue;
    try {
      await sessionCall(hub, m, { op: "mcp_secrets", scope, server: name, set: [], keep: [] });
      s.forgot(m, scope, name);
    } catch (e) {
      console.warn(`MCP secrets of ${name} not forgotten on ${m}:`, (e as Error).message);
    }
  }
}

async function test(hub: Hub, caller: Caller, scopeIn: McpScope, name: string, asked: string | undefined) {
  const scope = checkScope(scopeIn);
  const project = projectOf(hub, scope);
  const server = mcpServers(hub).get(scope, name);
  if (!server) throw notFound(scope, name);
  let machineId: string;
  if (project) machineId = project.machineId;
  else if (asked !== undefined) machineId = asked;
  else {
    const found = store(hub)
      .machinesList()
      .map((m) => m.machineId)
      .find((m) => ready(hub, m));
    if (found === undefined) throw new ToolError("machine_offline", "No machine is online to test the server on.", "Start a node, then test again.");
    machineId = found;
  }
  requireRole(caller, "operate", machineId);
  if (server.oauth && !signedIn(server)) {
    return {
      machineId,
      result: { tools: [], error: server.oauth.problem ?? `${server.name} isn't signed in yet: sign in with your own account.`, signIn: true },
      next: "mcp_oauth_start opens its sign-in.",
    };
  }
  nodeReady(hub, machineId);
  const missing = secretsMissingOn(server, machineId);
  const session = forSession(server, machineId);
  if (!session) {
    return {
      machineId,
      result: { tools: [], error: `${missing.join(", ")} isn't on ${machineId}: save the server again while ${machineId} is online.` },
    };
  }
  const projectId = project?.projectId;
  let result = await mcpTest(hub, machineId, projectId, session);
  if (result.error?.includes("401")) result = await turnedAway(hub, server, machineId, projectId, session, result);
  for (const tool of result.tools ?? []) tool.policy = toolPolicy(server, tool.name);
  return { machineId, result };
}

async function mcpTest(hub: Hub, m: string, projectId: string | undefined, server: McpSessionServer): Promise<McpTestResult> {
  const out = await sessionCall(hub, m, { op: "mcp_test", ...(projectId !== undefined ? { projectId } : {}), server });
  const { kind: _kind, ...result } = out as McpTestResult & { kind?: string };
  return { ...result, tools: result.tools ?? [] };
}

/** A test the server turned away (HTTP 401): a signed-in server's token is renewed and tested again. */
async function turnedAway(
  hub: Hub,
  server: McpServer,
  machineId: string,
  projectId: string | undefined,
  session: McpSessionServer,
  result: McpTestResult,
): Promise<McpTestResult> {
  if (server.oauth) {
    let renewed: oauth.Renewed;
    try {
      renewed = await oauth.renewNow(hub, server.scope, server.name);
    } catch (e) {
      throw new ToolError("failed", (e as Error).message);
    }
    if (renewed === "yes") {
      // Tested again as the server is now: its header may have reached the machine since the first test.
      const now = mcpServers(hub).get(server.scope, server.name);
      return mcpTest(hub, machineId, projectId, (now && forSession(now, machineId)) ?? session);
    }
    if (renewed === "signed_out") {
      const problem = mcpServers(hub).get(server.scope, server.name)?.oauth?.problem;
      return { ...result, error: problem ?? `${server.name} signed fleetd out: sign in again.`, signIn: true };
    }
    return result;
  }
  const keyed = (server.headers ?? []).some((v) => v.name.toLowerCase() === OAUTH_HEADER.toLowerCase());
  const at = oauth.urlOf(server);
  if (at && !keyed && (await offersSignIn(at[0], at[1]))) {
    return { ...result, error: `${server.name} asks you to sign in with your own account, not a key.`, signIn: true };
  }
  return result;
}
