// The MCP server tools. Saving a server relays each secret's boxes to
// the nodes they were sealed to and records the fingerprints they answer; the boxes are never stored, logged or
// returned.
import type { McpScope, McpSealedOn, McpServer, McpServerSetInput, McpTestResult, McpValue, McpValueSet, ProjectRef } from "../../shared/contracts.ts";
import { ToolError } from "../../shared/errors.ts";
import { requireRole } from "../api/grants.ts";
import type { Hub } from "../api/hub.ts";
import type { Caller, Registry } from "../api/registry.ts";
import { linked, nodeCan, offline, sessionCall } from "../link/node_port.ts";
import { toolPolicy } from "../integrations/policy.ts";
import * as oauth from "../mcp_oauth/index.ts";
import { discover, offersSignIn } from "../mcp_oauth/oauth.ts";
import { vault } from "../vault/index.ts";
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
import { syncVault } from "./vault_sync.ts";
import { keptVaultValue, vaultProblem } from "./vault_values.ts";
import { CAP_MCP_SERVERS, CAP_ONE_LEAD_MODE, checkInput, checkScope, mayChange, mayConnect, notFound, sameTransport, signsInOnly } from "./rules.ts";

export { CAP_MCP_SERVERS, CAP_ONE_LEAD_MODE, checkScope, mayChange, notFound } from "./rules.ts";

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
    const s = mcpServers(hub);
    const before = s.get(scope, input.name);
    // The team's signed-in server is its connector's or an admin's to disconnect; anything else as before.
    if (scope.kind === "global" && before?.oauth !== undefined) mayConnect(caller, before);
    else mayChange(caller, scope);
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

/** A save of a bot's server that went to the team as it signed in (D592), from an app that still shows it as the
 * bot's (Add's second save, of the tools that only read): the team's server is saved, not a new bot copy without its
 * sign-in that would hide it from the bot. */
function toTeamsOwn(hub: Hub, input: McpServerSetInput): McpServerSetInput {
  const scope = checkScope(input.scope);
  if (scope.kind === "global" || !signsInOnly(input) || mcpServers(hub).get(scope, input.name)) return input;
  const team = mcpServers(hub).get({ kind: "global" }, input.name);
  return team?.oauth !== undefined && sameTransport(team.transport, input.transport) ? { ...input, scope: { kind: "global" } } : input;
}

/** The server, or for a bot's that moved to the team when it signed in (D592), the team's of that name: an app that
 * still shows it as the bot's reaches it. */
export function teamOr(hub: Hub, scope: McpScope, name: string): McpServer | undefined {
  const s = mcpServers(hub);
  const own = s.get(scope, name);
  if (own || scope.kind === "global") return own;
  const team = s.get({ kind: "global" }, name);
  return team?.oauth !== undefined ? team : undefined;
}

export function projectOf(hub: Hub, scope: McpScope): ProjectRef | undefined {
  if (scope.kind !== "project") return undefined;
  const r = { machineId: scope.machineId, projectId: scope.projectId };
  if (!store(hub).projectGet(r)) {
    throw new ToolError("not_found", `No bot ${r.projectId} on ${r.machineId}.`, `Call project_get with machineId ${r.machineId} and no projectId.`);
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

const byMachine = (a: { machineId: string }, b: { machineId: string }) => (a.machineId < b.machineId ? -1 : a.machineId > b.machineId ? 1 : 0);

async function set(hub: Hub, caller: Caller, given: McpServerSetInput) {
  const input = toTeamsOwn(hub, given);
  const scope = checkScope(input.scope);
  // A service the team signs in to (no key of its own) is connected once for every bot, by any person (D592).
  const team = scope.kind === "global" && signsInOnly(input);
  const existing = team ? mcpServers(hub).get(scope, input.name) : undefined;
  if (team && (existing === undefined || existing.oauth !== undefined || existing.connectedBy !== undefined)) mayConnect(caller, existing);
  else mayChange(caller, scope);
  checkInput(input);
  const project = projectOf(hub, scope);
  if (input.integration && !project && !team) {
    // Only a project's lead asks before a tool runs: one saved for every project would reach agents unasked.
    throw new ToolError(
      "invalid",
      "An integration asks you before its tools send anything, which only a bot's lead does.",
      "Add it in one bot's settings: its lead asks you before each send.",
    );
  }
  if (project && input.integration && !nodeCan(hub, project.machineId, CAP_ONE_LEAD_MODE)) {
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
    const place = scope.kind === "global" ? "for every bot" : "in this bot";
    throw new ToolError("invalid", `There are already ${MCP_SERVERS_MAX} MCP servers ${place}, the most fleetd takes.`, "Remove one first.");
  }
  const savedSecret = (field: McpField, name: string): McpValue | undefined =>
    before ? valuesOf(before).find(([f, v]) => f === field && v.name === name && v.kind === "secret")?.[1] : undefined;
  // A vault value saved before from the same item, which its machines keep until the sync seals it again.
  const savedVault = (field: McpField, v: McpValueSet): McpValue | undefined =>
    v.kind !== "vault" || !before
      ? undefined
      : valuesOf(before).find(([f, x]) => f === field && x.name === v.name && x.kind === "vault" && x.itemId === v.itemId && x.prefix === (v.prefix || undefined) && x.field === v.field)?.[1];
  for (const field of ["env", "header"] as const) {
    for (const v of field === "env" ? (input.env ?? []) : (input.headers ?? [])) {
      if (v.kind !== "vault") continue;
      const problem = vaultProblem(scope, vault(hub).store.get(v.itemId), v.field);
      if (problem !== undefined) throw new ToolError("invalid", `${v.name}: ${problem}`);
    }
  }
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
              `${v.name} is sealed to ${x.machineId}, but the bot's machine is ${project.machineId}.`,
              "Seal a bot server's secrets to its own machine.",
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
        } else if (v.kind === "vault" && (savedVault(field, v)?.sealedOn ?? []).some((y) => y.machineId === m)) {
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
      if (v.kind === "vault") {
        // What a machine kept of the same item; the sync after the save seals the rest.
        const saved = savedVault(field, v);
        const sealedOn = saved ? [...(held.get(`${field}\u0000${v.name}`) ?? []), ...(saved.sealedOn ?? []).filter((x) => !reached.has(x.machineId))] : [];
        return keptVaultValue(v, vault(hub).store.get(v.itemId), sealedOn.sort(byMachine), undefined);
      }
      const sealedOn = [...(held.get(`${field}\u0000${v.name}`) ?? [])];
      // A kept secret stays recorded on a machine this save didn't reach: its node still has it.
      if (v.kind === "keep") {
        const saved = savedSecret(field, v.name);
        if (saved) sealedOn.push(...(saved.sealedOn ?? []).filter((x) => !reached.has(x.machineId)));
      }
      sealedOn.sort(byMachine);
      return { name: v.name, kind: "secret", ...(sealedOn.length > 0 ? { sealedOn } : {}) };
    });
  // The person who connected a team sign-in, kept through later saves.
  const connectedBy = !team ? undefined : before ? before.connectedBy : caller.person?.personId;
  // Read again: a renewal may have changed the sign-in while the nodes answered. A new URL with no key of its own
  // that offers OAuth is saved as signed out, so the app offers Sign in before any Test.
  const signIn = signsIn ? s.get(scope, input.name)?.oauth : typedToken || hasKey(input) ? undefined : await offered(input.transport);
  const server: McpServer = {
    scope,
    name: input.name,
    ...oneSwitch(input.roles, input.enabled),
    transport: input.transport,
    env: values("env"),
    headers: values("header"),
    ...(input.integration ? { integration: input.integration } : {}),
    ...(signIn ? { oauth: signIn } : {}),
    ...(connectedBy !== undefined ? { connectedBy } : {}),
    ...(scope.kind === "global" && input.projects !== undefined ? { projects: input.projects } : {}),
    updatedAt: isoMs(hub.clock.now()),
  };
  s.put(server);
  await syncVault(hub, server);
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

/** Whether a save gives the server a key of its own: any header or env that isn't plain. */
const hasKey = (input: McpServerSetInput) => [...(input.headers ?? []), ...(input.env ?? [])].some((v) => v.kind !== "plain");

/** How long a save waits to learn whether a new URL signs in. */
export const DISCOVER_WAIT_MS = 5_000;

/** A URL server's sign-in, signed out, when it offers OAuth; undefined when it doesn't, or doesn't say in time. */
async function offered(t: McpServer["transport"]): Promise<McpServer["oauth"]> {
  if (t.type === "stdio") return undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const found = await Promise.race([
      discover(t.url, t.type === "sse"),
      new Promise<undefined>((resolve) => (timer = setTimeout(() => resolve(undefined), DISCOVER_WAIT_MS))),
    ]);
    return found ? { status: "signed_out", issuer: found.issuer } : undefined;
  } catch {
    return undefined;
  } finally {
    clearTimeout(timer);
  }
}

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
  const given = checkScope(scopeIn);
  const server = teamOr(hub, given, name);
  if (!server) throw notFound(given, name);
  const scope = server.scope;
  const project = projectOf(hub, scope);
  let machineId: string;
  if (project) machineId = project.machineId;
  else if (asked !== undefined) machineId = asked;
  // The team's, asked for as a bot's: tested where that bot's agents reach it.
  else if (given.kind === "project") machineId = given.machineId;
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
  if (session.tailnet) result = result.error === undefined ? { ...result, via: "tailnet" } : { ...result, error: tailnetHint(result.error, machineId) };
  return { machineId, result };
}

/** A tailnet server the machine couldn't reach: the fix, when the words don't name one already. */
export const tailnetHint = (error: string, m: string) =>
  /tailscale/iu.test(error) ? error : `${error}. It's on your tailnet: put ${m} on it, or connect Tailscale in Connections so fleetd reaches it for ${m}.`;

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
