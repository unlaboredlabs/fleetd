// Connections (D653), as pure functions for both apps: what the sheet's Connected strip counts, the custom MCPs it
// lists (every server at no named entry's URL: the team's, and a bot's own), which bots use one in words, a Test's plain
// result, a tailnet host (reached through the Tailscale connection with nothing extra), and the custom MCP form's draft
// turned into the request main sends (mcp_server_set). Headers and env come from vault items, which the hub seals to
// the machines itself: the app never holds their values. Imports the hub's contract types and pure modules alone, so
// the phone reads it as it is.
import type { McpServer, McpServerSetInput, McpTestResult, McpValueSet, ProjectRef, TailnetState } from "../../../shared/contracts";
import { onTailnet } from "../../../shared/claudeEndpoint";
import { accountLabel, accountsOf, accountState, keptValue, NAMED, unnamed, type Named } from "../settings/namedServers";

/** A Test as the sheet keeps it: where it ran and what it found, or the call's own failure. */
export type Tested = { readonly machineId: string; readonly result: McpTestResult } | { readonly error: string };

/** Whether a URL's host is on a tailnet: a MagicDNS name (`*.ts.net`) or a Tailscale address (100.64.0.0/10, fd7a:115c:a1e0::/48). */
export const isTailnetHost = (url: string): boolean => onTailnet(url);

/** A server's URL; none for a command. */
export const urlOf = (server: McpServer): string | null => (server.transport.type === "stdio" ? null : server.transport.url);

/** What identifies a custom MCP beside its name: its host, or its command as typed. */
export const whereOf = (server: McpServer): string => {
  const t = server.transport;
  if (t.type === "stdio") return [t.command, ...(t.args ?? [])].join(" ");
  try {
    const u = new URL(t.url);
    return `${u.host}${u.pathname === "/" ? "" : u.pathname}`;
  } catch {
    return t.url;
  }
};

/** Whether a server can be used now: on, and signed in when it signs in. */
export const usable = (server: McpServer): boolean =>
  server.enabled && (server.oauth === undefined || (server.oauth.status === "connected" && server.oauth.problem === undefined));

/** The custom MCPs, the team's first, then each bot's own, each by name. */
export const customOf = (team: ReadonlyArray<McpServer>, own: ReadonlyArray<McpServer>): McpServer[] => {
  const byName = (a: McpServer, b: McpServer) => a.name.localeCompare(b.name);
  return [...unnamed(team).sort(byName), ...[...own].sort(byName)];
};

export interface StripItem {
  readonly key: string;
  readonly label: string;
  /** A named entry's mark; none for a custom MCP, shown by its initial. */
  readonly named?: Named | undefined;
  readonly tailscale?: true;
}

/** What the Connected strip shows: each account of a named service connected (two Notion accounts are two, each by
 * its name), Tailscale when it is, then the custom MCPs in use. */
export const connectedOf = (team: ReadonlyArray<McpServer>, own: ReadonlyArray<McpServer>, tailnet: TailnetState | undefined): StripItem[] => [
  ...NAMED.flatMap((n) =>
    accountsOf(n, team)
      .filter((s) => accountState(s).kind === "connected")
      .map((s) => ({ key: `${n.id}:${s.name}`, label: accountLabel(n, s, team), named: n })),
  ),
  ...(tailnet?.status === "connected" ? [{ key: "tailscale", label: "Tailscale", tailscale: true as const }] : []),
  ...customOf(team, own)
    .filter(usable)
    .map((s) => ({ key: `${s.scope.kind === "global" ? "team" : s.scope.projectId}:${s.name}`, label: s.name })),
];

/** "3 connected"; none with nothing connected, which the strip then leaves out. */
export const countText = (n: number): string | null => (n === 0 ? null : `${String(n)} connected`);

/** The initial a custom MCP shows in its tile: its name's first letter or digit. */
export const initialOf = (name: string): string => (/[A-Za-z0-9]/u.exec(name)?.[0] ?? "?").toUpperCase();

const sameBot = (a: ProjectRef, b: ProjectRef) => a.machineId === b.machineId && a.projectId === b.projectId;

/** Whether `bot` gets the server: a bot's own is its alone; the team's goes to every bot unless it lists some. */
export const usedBy = (server: McpServer, bot: ProjectRef): boolean => {
  if (server.scope.kind === "project") return sameBot(server.scope, bot);
  return server.projects === undefined || server.projects.some((p) => sameBot(p, bot));
};

interface Titled extends ProjectRef {
  readonly title: string;
}

/** Which bots use a server, in words: "Every bot", "No bot", one or two by name, else how many. */
export const botsText = (server: McpServer, bots: ReadonlyArray<Titled>): string => {
  if (server.scope.kind === "project") {
    const scope = server.scope;
    return bots.find((b) => sameBot(b, scope))?.title ?? scope.projectId;
  }
  const list = server.projects;
  if (list === undefined) return "Every bot";
  return pickedText(list, bots);
};

/** Which bots use a server, beside its name on its row: none for every bot, else "Only storefront", "Only 3 bots" or
 * "No bot", so a bot's name never stands there alone. */
export const onlyText = (server: McpServer, bots: ReadonlyArray<Titled>): string | null => {
  const text = botsText(server, bots);
  return text === "Every bot" ? null : text === "No bot" ? text : `Only ${text}`;
};

/** A pick of bots in words, as the form's control shows it. */
export const pickedText = (list: ReadonlyArray<ProjectRef> | undefined, bots: ReadonlyArray<Titled>): string => {
  if (list === undefined) return "Every bot";
  const known = bots.filter((b) => list.some((p) => sameBot(p, b)));
  if (known.length === 0) return "No bot";
  if (known.length === bots.length && bots.length > 1) return "Every bot";
  if (known.length <= 2) return known.map((b) => b.title).join(", ");
  return `${String(known.length)} bots`;
};

/** A bot ticked or unticked in a pick; every bot ticked is "every bot", which also takes the bots made later. */
export const toggleBot = (list: ReadonlyArray<ProjectRef> | undefined, bot: ProjectRef, bots: ReadonlyArray<ProjectRef>): ProjectRef[] | undefined => {
  const now = (list ?? bots).map((p) => ({ machineId: p.machineId, projectId: p.projectId }));
  const next = now.some((p) => sameBot(p, bot)) ? now.filter((p) => !sameBot(p, bot)) : [...now, { machineId: bot.machineId, projectId: bot.projectId }];
  return bots.every((b) => next.some((p) => sameBot(p, b))) ? undefined : next;
};

const count = (n: number, one: string, many: string): string => `${String(n)} ${n === 1 ? one : many}`;

/** A Test in one plain line: it works (with how many tools, and through Tailscale), wants a sign-in, or why it failed. */
export const testLine = (t: Tested, machine: string, server?: McpServer): { text: string; tone: "success" | "warning" | "danger" } => {
  if ("error" in t) return { text: `Test failed: ${t.error}`, tone: "danger" };
  const r = t.result;
  if (r.signIn === true) return { text: "Asks you to sign in.", tone: "warning" };
  if (r.error !== undefined) {
    const stop = /[.!?]$/u.test(r.error) ? "" : ".";
    return { text: `Failed on ${machine}: ${r.error}${stop}`, tone: "danger" };
  }
  const tools = (r.tools ?? []).length;
  const via = r.via === "tailnet" ? " through Tailscale" : "";
  // A URL with no key and no sign-in that answered: it asks no one to sign in.
  const open = server !== undefined && server.transport.type !== "stdio" && server.oauth === undefined && (server.headers ?? []).length === 0 ? ", no sign-in needed" : "";
  return { text: tools === 0 ? `Reached on ${machine}${via}, but it lists no tools.` : `Works on ${machine}${via}: ${count(tools, "tool", "tools")}${open}.`, tone: tools === 0 ? "warning" : "success" };
};

/** Where a custom MCP stands, beside its name: off, mid sign-in, wanting one, or a sign-in fleetd can't renew. Nothing when it simply works. */
export const stateOf = (server: McpServer): { text: string; tone: "quiet" | "warning" | "danger" } | null => {
  if (!server.enabled) return { text: "Off", tone: "quiet" };
  const o = server.oauth;
  if (o !== undefined) {
    if (o.signingIn === true) return { text: "Signing in…", tone: "quiet" };
    if (o.status !== "connected") return { text: "Sign in needed", tone: "warning" };
    if (o.problem !== undefined) return { text: "Sign in again", tone: "danger" };
  }
  const gone = [...(server.headers ?? []), ...(server.env ?? [])].find((v) => v.kind === "vault" && v.problem !== undefined);
  if (gone !== undefined) return { text: `${gone.name} missing`, tone: "danger" };
  return null;
};

/** Whether a server signs in with OAuth and needs it now (first time, or again). */
export const needsSignIn = (server: McpServer, tested?: Tested): boolean => {
  const o = server.oauth;
  if (o !== undefined && o.signingIn !== true && (o.status !== "connected" || o.problem !== undefined)) return true;
  return tested !== undefined && !("error" in tested) && tested.result.signIn === true;
};

/** Whether bots get a custom MCP now, as its switch shows it: on, and not waiting on a sign-in (the workspace holds a
 * signed-out server back from every bot, so a switch left on would promise a server that can't work). */
export const onForBots = (server: McpServer, tested?: Tested): boolean => server.enabled && !needsSignIn(server, tested);

/** One header or env variable of the form: its name and the vault item it takes its value from, or a plain value. */
export interface DraftValue {
  readonly name: string;
  /** A vault item; "" while none is picked. A value saved before the vault (a sealed secret) is `keep`. */
  readonly itemId: string;
  readonly prefix: string;
  /** Saved as a secret before: kept as it is unless an item is picked. */
  readonly keep?: true;
  /** A plain value, not a secret (`LOG_LEVEL=1`): sent as typed. Absent: the value is a vault item. */
  readonly plain?: string;
}

export interface Draft {
  readonly kind: "url" | "command";
  readonly url: string;
  /** The whole command line, as typed: `npx -y @acme/mcp --read-only`. */
  readonly command: string;
  readonly name: string;
  /** Whether the person typed the name: else it follows the URL or command. */
  readonly named: boolean;
  readonly values: ReadonlyArray<DraftValue>;
  /** Which bots use it; undefined is every bot. */
  readonly bots: ReadonlyArray<ProjectRef> | undefined;
}

export const emptyDraft = (): Draft => ({ kind: "url", url: "", command: "", name: "", named: false, values: [], bots: undefined });

/** A saved server as the form edits it. */
export const draftOf = (server: McpServer): Draft => {
  const t = server.transport;
  const values = (t.type === "stdio" ? server.env : server.headers) ?? [];
  return {
    kind: t.type === "stdio" ? "command" : "url",
    url: t.type === "stdio" ? "" : t.url,
    command: t.type === "stdio" ? joinCommand([t.command, ...(t.args ?? [])]) : "",
    name: server.name,
    named: true,
    values: values.map((v) =>
      v.kind === "vault"
        ? { name: v.name, itemId: v.itemId ?? "", prefix: v.prefix ?? "" }
        : v.kind === "secret"
          ? { name: v.name, itemId: "", prefix: "", keep: true as const }
          : { name: v.name, itemId: "", prefix: "", plain: v.value ?? "" },
    ),
    bots: server.scope.kind === "global" ? server.projects : undefined,
  };
};

/** A command line split as a shell splits words: spaces between, single or double quotes around one with spaces. */
export const splitCommand = (line: string): string[] => {
  const out: string[] = [];
  let word = "";
  let quote: '"' | "'" | null = null;
  let started = false;
  for (const ch of line.trim()) {
    if (quote !== null) {
      if (ch === quote) quote = null;
      else word += ch;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
      started = true;
    } else if (/\s/u.test(ch)) {
      if (started) out.push(word);
      word = "";
      started = false;
    } else {
      word += ch;
      started = true;
    }
  }
  if (started) out.push(word);
  return out;
};

const joinCommand = (words: ReadonlyArray<string>): string => words.map((w) => (w === "" || /[\s"']/u.test(w) ? `"${w.replaceAll('"', "")}"` : w)).join(" ");

const NAME = /^[A-Za-z0-9_-]{1,64}$/u;
const HEADER = /^[A-Za-z0-9!#$%&'*+.^_`|~-]{1,128}$/u;
const ENV = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/u;

/** What is wrong with a server's name, or null: agents see its tools as mcp__<name>__<tool>. */
export const serverNameProblem = (name: string, taken: ReadonlyArray<string>): string | null => {
  if (name === "") return "Name it.";
  if (!NAME.test(name)) return "A name is letters, digits, _ and - only.";
  if (name.toLowerCase() === "fleetd") return "fleetd is fleetd's own tools: pick another name.";
  if (taken.some((t) => t.toLowerCase() === name.toLowerCase())) return `${name} is already there.`;
  return null;
};

/** A name made from what the person typed: the URL's host's first word (an address whole), or the package or program
 * the command runs. */
export const suggestedName = (draft: Pick<Draft, "kind" | "url" | "command">): string => {
  let raw: string;
  if (draft.kind === "url") {
    try {
      const host = new URL(draft.url.trim()).hostname;
      const address = host.startsWith("[") || /^\d+(\.\d+){3}$/u.test(host);
      raw = address ? host : (host.split(".").filter((p) => !["mcp", "www", "api"].includes(p))[0] ?? "");
    } catch {
      raw = "";
    }
  } else {
    const words = splitCommand(draft.command).filter((w) => !w.startsWith("-"));
    const runner = ["npx", "bunx", "uvx", "pnpx", "pipx", "docker", "node", "python", "python3", "bun", "deno", "uv", "run", "dlx", "pnpm"];
    const program = words.find((w) => !runner.includes(w)) ?? "";
    raw = program.split("/").pop()?.replace(/@[^@]*$/u, "") ?? "";
    raw = raw.replace(/^(mcp-server-|server-|mcp-)/u, "").replace(/(-mcp-server|-mcp|-server)$/u, "");
  }
  return raw.toLowerCase().replace(/[^a-z0-9_-]+/gu, "-").replace(/^-+|-+$/gu, "").slice(0, 64);
};

/** The draft's name: the one typed, else the suggested one. */
export const nameOf = (draft: Draft): string => (draft.named ? draft.name.trim() : suggestedName(draft));

const httpUrl = (url: string): boolean => {
  try {
    const u = new URL(url);
    return u.protocol === "http:" || u.protocol === "https:";
  } catch {
    return false;
  }
};

/**
 * The draft as what mcp_server_set saves, or what to fix first. A new one is the team's (scope global), used by the
 * bots picked; a bot's own server edited stays that bot's. A new one goes to every agent of a bot that uses it, the
 * lead too; an edited one keeps whether it is on and who gets it, as it was saved.
 */
export const toInput = (
  draft: Draft,
  editing: McpServer | null,
  taken: ReadonlyArray<string>,
): { ok: true; input: McpServerSetInput } | { ok: false; problem: string } => {
  const name = nameOf(draft);
  const named = serverNameProblem(name, editing?.name === name ? [] : taken);
  if (named !== null) return { ok: false, problem: named };
  const command = draft.kind === "command";
  const seen = new Set<string>();
  const values: McpValueSet[] = [];
  for (const v of draft.values) {
    const n = v.name.trim();
    if (n === "" && v.itemId === "" && (v.plain ?? "") === "") continue;
    if (!(command ? ENV : HEADER).test(n)) return { ok: false, problem: command ? `${n || "A variable"} isn't a variable name.` : `${n || "A header"} isn't a header name.` };
    if (seen.has(n.toLowerCase())) return { ok: false, problem: `${n} is there twice.` };
    seen.add(n.toLowerCase());
    if (v.plain !== undefined) {
      if (v.plain.includes("\0") || (!command && /[\r\n]/u.test(v.plain))) return { ok: false, problem: `${n}'s value can't hold a line break or NUL.` };
      // A key in plain text would sit in the hub's list for anyone to read, and without its Bearer: it comes from the
      // vault. One a server was saved with before is kept as it is.
      if (!command && isKeyHeader(n) && !savedPlain(editing, n, v.plain)) return { ok: false, problem: `${n} is a key: pick it from the vault.` };
      values.push({ kind: "plain", name: n, value: v.plain });
    } else if (v.itemId !== "") values.push({ kind: "vault", name: n, itemId: v.itemId, ...(v.prefix === "" ? {} : { prefix: v.prefix }) });
    else if (v.keep === true) values.push({ kind: "keep", name: n });
    else return { ok: false, problem: `Pick ${n}'s value from the vault.` };
  }
  let transport: McpServerSetInput["transport"];
  if (command) {
    const [program, ...args] = splitCommand(draft.command);
    if (program === undefined) return { ok: false, problem: "Give the command that starts it." };
    transport = { type: "stdio", command: program, args };
  } else {
    const url = draft.url.trim();
    if (!httpUrl(url)) return { ok: false, problem: "Give its http or https URL." };
    // A server kept on SSE stays so; a new one speaks streamable HTTP, which serves SSE too.
    transport = { type: editing?.transport.type === "sse" ? "sse" : "http", url };
  }
  const scope = editing?.scope ?? { kind: "global" as const };
  const kept = (editing?.transport.type === "stdio") === command;
  return {
    ok: true,
    input: {
      scope,
      name,
      // An edit changes what the form shows, never whether it is on or who gets it (the lead alone, say).
      enabled: editing?.enabled ?? true,
      roles: editing?.roles ?? { lead: true, writers: true, reviewers: true },
      transport,
      env: command ? values : [],
      headers: command ? [] : values,
      ...(scope.kind === "global" && draft.bots !== undefined ? { projects: draft.bots.map((b) => ({ machineId: b.machineId, projectId: b.projectId })) } : {}),
      ...(editing?.integration === undefined || !kept ? {} : { integration: editing.integration }),
    },
  };
};

/** Whether a header carries a key: Authorization, whose value comes from the vault with its prefix. */
export const isKeyHeader = (name: string): boolean => name.trim().toLowerCase() === "authorization";

/** Whether `editing` already holds this header as this plain value: one saved before the vault, sent back as it was. */
const savedPlain = (editing: McpServer | null, name: string, value: string): boolean =>
  (editing?.headers ?? []).some((h) => h.kind === "plain" && h.name.toLowerCase() === name.toLowerCase() && (h.value ?? "") === value);

/** A saved server with only its bots changed: everything else sent again as it is. */
export const withBots = (server: McpServer, bots: ReadonlyArray<ProjectRef> | undefined): McpServerSetInput => {
  const t = server.transport;
  const { projects: _old, ...rest } = {
    scope: server.scope,
    name: server.name,
    enabled: server.enabled,
    roles: server.roles,
    transport: t.type === "stdio" ? { type: "stdio" as const, command: t.command, args: t.args ?? [] } : t,
    env: (server.env ?? []).map(keptValue),
    headers: (server.headers ?? []).map(keptValue),
    ...(server.integration === undefined ? {} : { integration: server.integration }),
    projects: undefined,
  };
  return bots === undefined ? rest : { ...rest, projects: bots.map((b) => ({ machineId: b.machineId, projectId: b.projectId })) };
};

/** A saved server turned on or off: everything else, its bots included, sent again as it is. */
export const withEnabled = (server: McpServer, enabled: boolean): McpServerSetInput => ({
  ...withBots(server, server.scope.kind === "global" ? server.projects : undefined),
  enabled,
});

/** `name`, or the first of name-2, name-3… no saved server has (names compare without case). */
export const freeName = (name: string, taken: ReadonlyArray<string>): string => {
  const lower = new Set(taken.map((t) => t.toLowerCase()));
  if (!lower.has(name.toLowerCase())) return name;
  let n = 2;
  while (lower.has(`${name}-${String(n)}`.toLowerCase())) n++;
  return `${name}-${String(n)}`;
};
