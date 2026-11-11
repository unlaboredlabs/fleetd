// The MCP servers pages' pure parts: a server's one-line summary, who gets it in words, which global servers a project
// replaces, and the editor's draft turned into the request main seals and sends (mcp_server_set). A saved secret
// left blank in the editor is kept as it is; typing a value replaces it.
import type { McpRoles, McpScope, McpServer, McpValue } from "../../../shared/contracts";
import type { McpServerRequest } from "../../../shared/ipc";

export type TransportKind = "stdio" | "http" | "sse";

export interface DraftValue {
  readonly name: string;
  readonly secret: boolean;
  /** A plain value, or a secret's new value; "" for a saved secret keeps it. */
  readonly value: string;
  /** It was saved as a secret: blank keeps it. */
  readonly saved: boolean;
}

export interface Draft {
  readonly name: string;
  readonly enabled: boolean;
  /** "Agents get it too": its writers and reviewers as well as its lead. */
  readonly agents: boolean;
  readonly kind: TransportKind;
  readonly command: string;
  /** One argument per line. */
  readonly args: string;
  readonly url: string;
  /** Env for a command, headers for HTTP and SSE. */
  readonly values: ReadonlyArray<DraftValue>;
}

/** A server for the lead alone. */
export const LEAD_ONLY: McpRoles = { lead: true, writers: false, reviewers: false };
/** One every agent of the project gets too. */
export const EVERYONE: McpRoles = { lead: true, writers: true, reviewers: true };

/** Its agents get it too: the hub saves any roles past the lead's as every agent's. */
export const agentsGet = (r: McpRoles): boolean => r.writers || r.reviewers;

export const emptyDraft = (): Draft => ({ name: "", enabled: true, agents: true, kind: "stdio", command: "", args: "", url: "", values: [] });

const valuesOf = (s: McpServer): ReadonlyArray<McpValue> => (s.transport.type === "stdio" ? (s.env ?? []) : (s.headers ?? []));

export const draftOf = (s: McpServer): Draft => ({
  name: s.name,
  enabled: s.enabled,
  agents: agentsGet(s.roles),
  kind: s.transport.type,
  command: s.transport.type === "stdio" ? s.transport.command : "",
  args: s.transport.type === "stdio" ? (s.transport.args ?? []).join("\n") : "",
  url: s.transport.type === "stdio" ? "" : s.transport.url,
  values: valuesOf(s).map((v) => ({ name: v.name, secret: v.kind === "secret", value: v.kind === "plain" ? (v.value ?? "") : "", saved: v.kind === "secret" })),
});

/** "Lead and agents", or "Lead only". */
export const rolesText = (r: McpRoles): string => (agentsGet(r) ? "Lead and agents" : "Lead only");

/** `npx -y @acme/mcp --read-only`, or the URL with its transport. */
export const transportText = (s: McpServer): string =>
  s.transport.type === "stdio" ? [s.transport.command, ...(s.transport.args ?? [])].join(" ") : `${s.transport.type === "http" ? "HTTP" : "SSE"} ${s.transport.url}`;

/** Each value as the list shows it: a plain one's value, a secret only as such. */
export const valuesText = (s: McpServer): string =>
  valuesOf(s)
    .map((v) => `${v.name}=${v.kind === "secret" ? "secret" : (v.value ?? "")}`)
    .join(" · ");

/** Machines among `machines` whose node lacks one of the server's secrets: their agents go without it. */
export const missingOn = (s: McpServer, machines: ReadonlyArray<string>): string[] => {
  const secrets = valuesOf(s).filter((v) => v.kind === "secret");
  return machines.filter((m) => secrets.some((v) => !(v.sealedOn ?? []).some((o) => o.machineId === m)));
};

/** The global servers a project sees, each marked when the project has one of its own by that name. */
export const globalsFor = (global: ReadonlyArray<McpServer>, project: ReadonlyArray<McpServer>): Array<{ server: McpServer; replaced: boolean }> =>
  global.map((server) => ({ server, replaced: project.some((p) => p.name === server.name) }));

const SERVER_NAME = /^[A-Za-z0-9_-]{1,64}$/u;
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/u;
const HEADER_NAME = /^[A-Za-z0-9!#$%&'*+.^_`|~-]{1,128}$/u;

export const nameProblem = (name: string, taken: ReadonlyArray<string>): string | null => {
  if (name === "") return null;
  if (!SERVER_NAME.test(name)) return "Letters, digits, _ and - only, at most 64.";
  if (name.toLowerCase() === "fleetd") return "fleetd is fleetd's own tools server: pick another name.";
  if (taken.includes(name)) return `${name} is already there: edit it instead.`;
  return null;
};

const httpUrl = (url: string): boolean => {
  try {
    const u = new URL(url);
    return u.protocol === "http:" || u.protocol === "https:";
  } catch {
    return false;
  }
};

/** The editor's draft as the request for main, or what to fix first. */
export const toRequest = (
  draft: Draft,
  scope: McpScope,
  boxes: McpServerRequest["boxes"],
): { ok: true; request: McpServerRequest } | { ok: false; problem: string } => {
  const name = draft.name.trim();
  if (name === "") return { ok: false, problem: "Name it." };
  if (!SERVER_NAME.test(name) || name.toLowerCase() === "fleetd") return { ok: false, problem: nameProblem(name, []) ?? "Pick another name." };
  const stdio = draft.kind === "stdio";
  const seen = new Set<string>();
  const values: McpServerRequest["env"] = [];
  for (const v of draft.values) {
    const n = v.name.trim();
    if (n === "" && v.value === "") continue;
    if (!(stdio ? ENV_NAME : HEADER_NAME).test(n)) return { ok: false, problem: stdio ? `${n || "A variable"} is not an environment variable name.` : `${n || "A header"} is not a header name.` };
    if (seen.has(n.toLowerCase())) return { ok: false, problem: `${n} is there twice.` };
    seen.add(n.toLowerCase());
    if (v.value.includes("\0")) return { ok: false, problem: `${n}'s value holds a NUL character.` };
    if (!stdio && /[\r\n]/u.test(v.value)) return { ok: false, problem: `The header ${n} can't hold a line break.` };
    if (!v.secret) values.push({ kind: "plain", name: n, value: v.value });
    else if (v.value !== "") values.push({ kind: "secret", name: n, value: v.value });
    else if (v.saved) values.push({ kind: "keep", name: n });
    else return { ok: false, problem: `Type ${n}'s secret value.` };
  }
  let transport: McpServerRequest["transport"];
  if (stdio) {
    const command = draft.command.trim();
    if (command === "") return { ok: false, problem: "Give the command that starts it." };
    const args = draft.args.split("\n").map((a) => a.trim()).filter((a) => a !== "");
    transport = { type: "stdio", command, args };
  } else {
    const url = draft.url.trim();
    if (!httpUrl(url)) return { ok: false, problem: "Give its http or https URL." };
    transport = { type: draft.kind, url };
  }
  const secrets = values.some((v) => v.kind === "secret");
  if (secrets && boxes.length === 0) return { ok: false, problem: "No machine can keep a key yet: update fleetd on it first." };
  return {
    ok: true,
    request: {
      scope,
      name,
      enabled: draft.enabled,
      roles: draft.agents ? EVERYONE : LEAD_ONLY,
      transport,
      env: stdio ? values : [],
      headers: stdio ? [] : values,
      boxes: secrets ? [...boxes] : [],
    },
  };
};
