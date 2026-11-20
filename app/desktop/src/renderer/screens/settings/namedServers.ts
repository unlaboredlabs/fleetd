// The services a project connects by name, one record each, at the top of its MCP servers (the desktop's Project page,
// the phone's project screen). Connect saves the same server the manual form would (mcp_server_set), then signs in to
// it with the person's own account (mcp_oauth_start): nothing to type. A server already saved by hand at an entry's URL
// is that entry, not a second one. Another service is one more record in NAMED. Pure, for both apps: it imports the
// hub's contract types alone (the phone has no zod, which the desktop's ipc.ts needs).
import type { McpScope, McpServer, McpServerSetInput, McpValue, McpValueSet } from "../../../shared/contracts";

export interface Named {
  readonly id: string;
  readonly label: string;
  /** Its hosted MCP server, reached over HTTP. */
  readonly url: string;
  /** The server's name when it is free: agents see its tools as mcp__<name>__<tool>. */
  readonly name: string;
  /** "Agents get it too": its writers and reviewers as well as its lead. */
  readonly agents: boolean;
  /** Its mark, one path drawn in one colour, and the colour of the phone's tile under it. */
  readonly mark: { readonly viewBox: string; readonly path: string; readonly tint: string };
}

export const NAMED: ReadonlyArray<Named> = [
  {
    id: "paper",
    label: "Paper",
    url: "https://mcp.paper.design",
    name: "paper",
    agents: true,
    mark: { viewBox: "0 0 21 21", path: "M3 0H21V13H13V3H3ZM0 3H3V13H13V21H0Z", tint: "#81ACEC" },
  },
];

/** A URL as two that reach the same server compare: host in lower case, no trailing slash, no query. */
const urlKey = (url: string): string | null => {
  try {
    const u = new URL(url.trim());
    if (u.protocol !== "https:" && u.protocol !== "http:") return null;
    return `${u.protocol}//${u.host.toLowerCase()}${u.pathname.replace(/\/+$/u, "")}`;
  } catch {
    return null;
  }
};

const urlOf = (server: McpServer): string | null => (server.transport.type === "stdio" ? null : server.transport.url);

/** The entry a saved server is, by its URL; none for any other server. */
export const namedOf = (server: McpServer): Named | undefined => {
  const url = urlOf(server);
  const key = url === null ? null : urlKey(url);
  return key === null ? undefined : NAMED.find((n) => urlKey(n.url) === key);
};

/** The project's server an entry is: the one at its URL, the one by its name first when there are two. */
export const serverOf = (entry: Named, servers: ReadonlyArray<McpServer>): McpServer | undefined => {
  const at = servers.filter((s) => namedOf(s)?.id === entry.id);
  return at.find((s) => s.name === entry.name) ?? at[0];
};

/** The servers the list shows as themselves: every one no entry claims. */
export const unnamed = (servers: ReadonlyArray<McpServer>): McpServer[] => {
  const claimed = new Set(NAMED.flatMap((n) => serverOf(n, servers)?.name ?? []));
  return servers.filter((s) => !claimed.has(s.name));
};

/** The entry's name, or the first free one after it (paper-2) when a server of another URL already has it. */
export const nameFor = (entry: Named, taken: ReadonlyArray<string>): string => {
  const lower = new Set(taken.map((t) => t.toLowerCase()));
  if (!lower.has(entry.name)) return entry.name;
  let n = 2;
  while (lower.has(`${entry.name}-${String(n)}`)) n++;
  return `${entry.name}-${String(n)}`;
};

/** What Connect saves: the manual form's server for the entry's URL, with no key (as mcpModel's toRequest makes it). */
export const namedInput = (entry: Named, scope: McpScope, taken: ReadonlyArray<string>): McpServerSetInput => ({
  scope,
  name: nameFor(entry, taken),
  enabled: true,
  roles: { lead: true, writers: entry.agents, reviewers: entry.agents },
  transport: { type: "http", url: entry.url },
  env: [],
  headers: [],
});

/** A server turned off, saved again on, as it is otherwise: a key it was saved with is kept. */
export const turnOnInput = (server: McpServer): McpServerSetInput => {
  const values = (list: readonly McpValue[] | undefined): McpValueSet[] =>
    (list ?? []).map((v) => (v.kind === "secret" ? { kind: "keep", name: v.name } : { kind: "plain", name: v.name, value: v.value ?? "" }));
  const t = server.transport;
  return {
    scope: server.scope,
    name: server.name,
    enabled: true,
    roles: server.roles,
    transport: t.type === "stdio" ? { type: "stdio", command: t.command, args: t.args ?? [] } : t,
    env: values(server.env),
    headers: values(server.headers),
    ...(server.integration === undefined ? {} : { integration: server.integration }),
  };
};

export type NamedState =
  | { readonly kind: "add" }
  | { readonly kind: "signin"; readonly server: McpServer; readonly problem: string | undefined }
  | { readonly kind: "signing"; readonly server: McpServer }
  | { readonly kind: "connected"; readonly server: McpServer }
  | { readonly kind: "off"; readonly server: McpServer };

/** Where an entry stands: not added, wanting a sign-in (first or again), mid sign-in, connected, or turned off. */
export const namedState = (entry: Named, servers: ReadonlyArray<McpServer>): NamedState => {
  const server = serverOf(entry, servers);
  if (server === undefined) return { kind: "add" };
  if (!server.enabled) return { kind: "off", server };
  const o = server.oauth;
  // Saved by hand with a key of its own: it doesn't sign in.
  if (o === undefined && (server.headers ?? []).length > 0) return { kind: "connected", server };
  // Signed in, but fleetd can't renew its token (the hub says why): agents are turned away, so it isn't Connected.
  if (o?.status === "connected" && o.problem === undefined) return { kind: "connected", server };
  if (o?.signingIn === true) return { kind: "signing", server };
  return { kind: "signin", server, problem: o?.problem };
};

/** The state's word beside the entry's name; none before it is added. */
export const namedWord = (state: NamedState): { text: string; tone: "quiet" | "danger" } | null => {
  switch (state.kind) {
    case "add":
      return null;
    case "connected":
      return { text: "Connected", tone: "quiet" };
    case "signing":
      return { text: "Signing in…", tone: "quiet" };
    case "off":
      return { text: "Off", tone: "quiet" };
    case "signin":
      return { text: "Sign in needed", tone: "danger" };
  }
};
