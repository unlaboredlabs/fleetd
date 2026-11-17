// The hub calls behind a project's named services on its screen (Named.tsx), as the desktop's MCP servers make them:
// mcp_servers_get for the project's servers, Connect's mcp_server_set (the record the manual form saves, with no key:
// namedRequest), mcp_oauth_start for its sign-in page, mcp_server_test, Turn On (mcp_server_set again) and Disconnect
// (mcp_server_remove). And what each row shows and does on a tap.
import { namedRequest, setInput, turnOnRequest, type McpServer, type McpTestResult, type Named, type NamedState, type ProjectRef } from "../../desktop";
import type { Hub, Result } from "./api";

/** A test reaches the server from the project's machine, as the desktop's waits for it. */
export const TEST_MS = 45_000;

const scopeOf = (p: ProjectRef) => ({ kind: "project" as const, machineId: p.machineId, projectId: p.projectId });

export const readServers = async (hub: Hub, p: ProjectRef): Promise<Result<McpServer[]>> => {
  const r = await hub.call("mcp_servers_get", { project: { machineId: p.machineId, projectId: p.projectId } });
  return r.ok ? { ok: true, value: r.output.project ?? [] } : r;
};

const save = async (hub: Hub, request: ReturnType<typeof turnOnRequest>): Promise<Result<McpServer>> => {
  const input = request === null ? null : setInput(request);
  // The entries carry no key, and a turned-off one keeps its own: there is never one to seal here.
  if (input === null) return { ok: false, error: { code: "invalid", message: "This one has a key to type: change it in the desktop app." } };
  const r = await hub.call("mcp_server_set", input);
  return r.ok ? { ok: true, value: r.output.server } : r;
};

/** Saved as the manual form would save it, under its own name or the first free one. */
export const connect = (hub: Hub, entry: Named, p: ProjectRef, servers: readonly McpServer[]): Promise<Result<McpServer>> =>
  save(
    hub,
    namedRequest(
      entry,
      scopeOf(p),
      servers.map((s) => s.name),
    ),
  );

export const turnOn = (hub: Hub, server: McpServer): Promise<Result<McpServer>> => save(hub, turnOnRequest(server));

/**
 * Its sign-in page, to open in the browser. The hub picks where the service sends the browser back (its https
 * address where it has one). A service that lets no app register itself needs the person's own OAuth app, whose
 * secret only the desktop seals.
 */
export const signInPage = async (hub: Hub, server: McpServer, label: string): Promise<Result<string>> => {
  const r = await hub.call("mcp_oauth_start", { scope: server.scope, name: server.name });
  if (!r.ok) return r;
  if (r.output.authorizeUrl !== undefined) return { ok: true, value: r.output.authorizeUrl };
  return { ok: false, error: { code: "invalid", message: `${label} needs an OAuth app of your own: sign in from the desktop app, which sets it up.` } };
};

export const test = async (hub: Hub, server: McpServer): Promise<Result<{ machineId: string; result: McpTestResult }>> => {
  const r = await hub.call("mcp_server_test", { scope: server.scope, name: server.name }, TEST_MS);
  return r.ok ? { ok: true, value: { machineId: r.output.machineId, result: r.output.result } } : r;
};

export const disconnect = async (hub: Hub, server: McpServer): Promise<Result<null>> => {
  const r = await hub.call("mcp_server_remove", { scope: server.scope, name: server.name });
  return r.ok ? { ok: true, value: null } : r;
};

/** What a tap on the row does: Connect, Sign in, Turn on, or the sheet with Test and Disconnect. */
export type Press = "connect" | "signin" | "on" | "sheet";

/** The row's value, its tone, and its tap. */
export const rowOf = (state: NamedState): { value: string; tone: "accent" | "quiet" | "danger"; press: Press } => {
  switch (state.kind) {
    case "add":
      return { value: "Connect", tone: "accent", press: "connect" };
    case "signin":
      return { value: "Sign In", tone: "danger", press: "signin" };
    case "signing":
      return { value: "Signing In…", tone: "quiet", press: "signin" };
    case "off":
      return { value: "Off", tone: "quiet", press: "sheet" };
    case "connected":
      return { value: "Connected", tone: "quiet", press: "sheet" };
  }
};

/** A test's line under the row: where it works, or why not, with the sign-in it wants. */
export const testLine = (t: { machineId: string; result: McpTestResult }, machine: string): { text: string; signIn: boolean } => {
  if (t.result.signIn === true) return { text: "Sign in needed.", signIn: true };
  if (t.result.error !== undefined) return { text: `Failed on ${machine}: ${t.result.error}`, signIn: false };
  const n = (t.result.tools ?? []).length;
  return { text: `Works on ${machine}: ${String(n)} ${n === 1 ? "tool" : "tools"}.`, signIn: false };
};
