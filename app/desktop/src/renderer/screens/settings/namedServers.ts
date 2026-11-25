// The services the team connects by name, one record each, at the top of Connections (the desktop's sheet,
// the phone's Connections screen). Connect saves the same server the manual form would (mcp_server_set), then signs in to
// it with the person's own account (mcp_oauth_start): nothing to type. Each account of a service is one more server at
// its URL (notion, notion-2, or a name the person gives it), signed in, given bots and disconnected on its own; one
// saved by hand at an entry's URL is an account of it too. Another service is one more record in NAMED. Pure, for both apps: it imports the
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
  {
    // Notion's hosted MCP server: OAuth with dynamic client registration, so Connect is a sign-in and nothing else.
    id: "notion",
    label: "Notion",
    url: "https://mcp.notion.com/mcp",
    name: "notion",
    agents: true,
    mark: { viewBox: "0 0 21 21", path: "M4 2.5H8.2L13.6 11.6V2.5H17V18.5H12.9L7.4 9.3V18.5H4Z", tint: "#191919" },
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

/** The entry's accounts: every saved server at its URL, the one by its own name first, then by name. */
export const accountsOf = (entry: Named, servers: ReadonlyArray<McpServer>): McpServer[] =>
  servers.filter((s) => namedOf(s)?.id === entry.id).sort((a, b) => (a.name === entry.name ? -1 : b.name === entry.name ? 1 : a.name.localeCompare(b.name)));

/** The servers the list shows as themselves: every one at no entry's URL. */
export const unnamed = (servers: ReadonlyArray<McpServer>): McpServer[] => servers.filter((s) => namedOf(s) === undefined);

/** An account as a list names it: the service's name while it is the only one, else its own (notion-work). */
export const accountLabel = (entry: Named, server: McpServer, servers: ReadonlyArray<McpServer>): string =>
  accountsOf(entry, servers).length > 1 ? server.name : entry.label;

/** The entry's name, or the first free one after it (paper-2) when another server, an account of it or not, has it. */
export const nameFor = (entry: Named, taken: ReadonlyArray<string>): string => {
  const lower = new Set(taken.map((t) => t.toLowerCase()));
  if (!lower.has(entry.name)) return entry.name;
  let n = 2;
  while (lower.has(`${entry.name}-${String(n)}`)) n++;
  return `${entry.name}-${String(n)}`;
};

/** What Connect saves: the custom MCP form's server for the entry's URL, with no key (connections/model.ts toInput).
 * Another account is saved by the name the person gave it, else the first free one. */
export const namedInput = (entry: Named, scope: McpScope, taken: ReadonlyArray<string>, name?: string): McpServerSetInput => ({
  scope,
  name: name ?? nameFor(entry, taken),
  enabled: true,
  roles: { lead: true, writers: entry.agents, reviewers: entry.agents },
  transport: { type: "http", url: entry.url },
  env: [],
  headers: [],
});

/** A saved value, sent again as it is: a secret kept, a vault item by its id, a plain value with it. */
export const keptValue = (v: McpValue): McpValueSet => {
  if (v.kind === "secret") return { kind: "keep", name: v.name };
  if (v.kind === "vault" && v.itemId !== undefined) {
    return { kind: "vault", name: v.name, itemId: v.itemId, ...(v.field === undefined ? {} : { field: v.field }), ...(v.prefix === undefined ? {} : { prefix: v.prefix }) };
  }
  return { kind: "plain", name: v.name, value: v.value ?? "" };
};

/** A server turned off, saved again on, as it is otherwise: a key it was saved with is kept. */
export const turnOnInput = (server: McpServer): McpServerSetInput => {
  const values = (list: readonly McpValue[] | undefined): McpValueSet[] =>
    (list ?? []).map((v) => keptValue(v));
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
    ...(server.projects === undefined ? {} : { projects: server.projects }),
  };
};

export type NamedState =
  | { readonly kind: "add" }
  | { readonly kind: "signin"; readonly server: McpServer; readonly problem: string | undefined }
  | { readonly kind: "signing"; readonly server: McpServer }
  | { readonly kind: "connected"; readonly server: McpServer }
  | { readonly kind: "off"; readonly server: McpServer };

/** Where an entry stands: not added, else where its first account stands (accountState). */
export const namedState = (entry: Named, servers: ReadonlyArray<McpServer>): NamedState => {
  const first = accountsOf(entry, servers)[0];
  return first === undefined ? { kind: "add" } : accountState(first);
};

/** Where one account stands: wanting a sign-in (first or again), mid sign-in, connected, or turned off. */
export const accountState = (server: McpServer): Exclude<NamedState, { kind: "add" }> => {
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
