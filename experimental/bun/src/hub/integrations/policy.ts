// The per-tool policy the hub enforces on a session's MCP tools (crates/fleetd/src/hub/integrations/policy.rs). Every
// tool resolves to a rule: first the blocked list, by the words of the tool's name, for every server; then the
// server's tools the person marked as reading; then a tool whose name says it only reads and whose input links
// nowhere; anything else asks, with an action guessed from its name. A gateway's call is judged by the tool it calls.
// An asking tool whose input looks like it holds a credential is blocked too.
import type { McpServer, ToolAction, ToolPolicy, ToolPreview } from "../../shared/contracts.ts";
import { redact } from "../redact.ts";

export type Never = "money" | "trading" | "accounts" | "credential";
export type Rule = { read: true } | { ask: ToolAction } | { blocked: Never };
export type Verdict = { allow: true } | { ask: ToolPreview } | { block: string };

const WHY: Record<Never, string> = {
  money:
    "Blocked by fleetd: an assistant never moves money between accounts, even with your approval. Tell the person " +
    "what you wanted to do; they make the transfer themselves.",
  trading:
    "Blocked by fleetd: an assistant never trades, even with your approval. Tell the person what you wanted to do; " +
    "they place the trade themselves.",
  accounts:
    "Blocked by fleetd: an assistant never creates accounts in the person's name, even with their approval. Tell the " +
    "person; they sign up themselves.",
  credential:
    "Blocked by fleetd: this would send or store what looks like a password, key or token, which never leaves through " +
    "an assistant, even with approval. Leave the value out; a secret goes through request_secret.",
};
export const neverWhy = (n: Never) => WHY[n];

export const TOO_LARGE =
  "Blocked by fleetd: this call is too large to show on an approval card in full, and fleetd never asks you to " +
  "approve what you can't see. Split it into smaller calls.";
export const PREVIEW_INPUT_MAX = 100_000;
export const FLEETD_SERVER = "fleetd";

/** A tool name's words, lower case: `create_account`, `createAccount` and `API-create-account` are all `[create, account]`. */
export function words(name: string): string[] {
  const out: string[] = [];
  let word = "";
  let prevLower = false;
  for (const c of name) {
    if (!/[\p{L}\p{N}]/u.test(c)) {
      if (word) out.push(word), (word = "");
      prevLower = false;
      continue;
    }
    const upper = /\p{Lu}/u.test(c);
    if (upper && prevLower && word) out.push(word), (word = "");
    prevLower = /\p{Ll}/u.test(c) || /[0-9]/.test(c);
    word += c.toLowerCase();
  }
  if (word) out.push(word);
  return out;
}

const MONEY = ["transfer", "transfers", "payout", "payouts", "withdraw", "withdrawal", "withdrawals", "wire", "remit", "remittance", "money", "fund", "funds"];
const MONEY_SENT: [string[], string[]] = [["send", "sign", "submit", "broadcast"], ["transaction", "transactions", "tx"]];
const TRADING = ["trade", "trades", "trading", "sell", "swap", "stake", "unstake", "stock", "stocks", "equity", "equities", "crypto", "bitcoin", "btc"];
const TRADED: [string[], string[]] = [["buy", "place", "submit", "open", "close"], ["order", "orders", "share", "shares", "position", "positions"]];
const SPEND = ["pay", "payment", "payments", "purchase", "buy", "checkout", "charge", "book", "reserve", "subscribe", "rent"];
const SPENT = ["order", "orders", "booking", "bookings", "reservation", "reservations", "ticket", "tickets", "subscription"];
const READS = ["get", "list", "search", "find", "read", "show", "fetch", "view", "lookup", "query", "describe", "track", "status", "cancel"];
const READ_ONLY = ["get", "list", "search", "find", "read", "show", "fetch", "view", "lookup", "describe", "status", "count"];
const ACTS = [
  "create", "add", "new", "update", "upsert", "set", "edit", "modify", "change", "write", "put", "patch", "insert",
  "upload", "save", "move", "rename", "archive", "mark", "label", "run", "execute", "exec", "cancel", "approve",
  "accept", "decline", "reject", "submit", "complete", "close", "open", "start", "stop", "enable", "disable", "sync",
  "import", "export", "schedule", "assign", "merge", "restore", "copy", "apply", "toggle", "trigger", "clear", "reset",
  "draft", "delete", "remove", "trash", "destroy", "erase", "purge", "drop", "send", "reply", "forward", "post",
  "publish", "invite", "notify", "tweet", "share", "grant", "pay", "purchase", "buy", "checkout", "charge", "book",
  "reserve", "subscribe", "rent", "replace", "respond", "comment", "react", "resolve", "revoke", "unshare",
  "unsubscribe", "deploy", "push", "commit", "sign",
];
const DELETE = ["delete", "remove", "trash", "destroy", "erase", "purge", "drop"];
const SEND = ["send", "reply", "forward", "email", "message", "post", "publish", "invite", "notify", "tweet"];
const SHARE = ["share", "grant", "permission", "permissions"];

const hasAny = (w: string[], list: string[]) => w.some((x) => list.includes(x));

/** What the name alone refuses, on any server. */
export function never(tool: string): Never | undefined {
  const w = words(tool);
  const both = ([verbs, nouns]: [string[], string[]]) => hasAny(w, verbs) && hasAny(w, nouns);
  if (hasAny(w, MONEY) || both(MONEY_SENT)) return "money";
  if (hasAny(w, TRADING) || both(TRADED)) return "trading";
  const signsUp = w.some((x) => x === "signup" || x === "register") || w.some((x, i) => x === "sign" && w[i + 1] === "up");
  const opensAccount = hasAny(w, ["create", "open", "new"]) && hasAny(w, ["account", "accounts"]);
  return signsUp || opensAccount ? "accounts" : undefined;
}

/** What an unknown tool would do, from its name. */
export function guess(tool: string): ToolAction {
  const w = words(tool);
  if (hasAny(w, SPEND) || (hasAny(w, SPENT) && !hasAny(w, READS))) return "spend";
  if (hasAny(w, DELETE)) return "delete";
  if (hasAny(w, SHARE)) return "share";
  if (hasAny(w, SEND)) return "send";
  return "write";
}

/** Whether a tool's name says it only reads: a word of READ_ONLY, and none of ACTS. */
export const reads = (tool: string) => {
  const w = words(tool);
  return hasAny(w, READ_ONLY) && !hasAny(w, ACTS);
};

/** A gateway's tool, running another it names in its input: `call_tool`, `call_read_tool`, `run_tool`. */
export const gateway = (tool: string) => {
  const w = words(tool);
  return w.includes("tool") && hasAny(w, ["call", "run", "invoke", "use", "execute", "exec", "dispatch", "proxy"]);
};

const CALLED = ["name", "tool", "tool_name", "toolName", "toolname", "method"];
const ARGUMENTS = ["arguments", "args", "params", "parameters", "input", "payload"];

/** serde_json's map order: keys sorted, as the Rust hub's `Value` holds them. */
const entries = (o: Record<string, unknown>) => Object.keys(o).sort().map((k) => [k, o[k]] as const);

/** The tool a gateway's call runs: the first string under a key of CALLED, level by level, outside its arguments. */
export function called(tool: string, input: unknown): string | undefined {
  if (!gateway(tool)) return undefined;
  let level: unknown[] = [input];
  while (level.length > 0) {
    const next: unknown[] = [];
    for (const v of level) {
      if (Array.isArray(v)) next.push(...v);
      else if (v !== null && typeof v === "object") {
        for (const [k, x] of entries(v as Record<string, unknown>)) {
          if (ARGUMENTS.includes(k)) continue;
          if (typeof x === "string" && CALLED.includes(k)) return x;
          next.push(x);
        }
      }
    }
    level = next;
  }
  return undefined;
}

/** Whether a call's names say it only reads: its own, and a gateway's the tool it calls too. */
export function namedReads(tool: string, input: unknown): boolean {
  if (!gateway(tool)) return reads(tool);
  const inner = called(tool, input);
  return inner !== undefined && reads(inner) && !hasAny(words(tool), ACTS);
}

const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g;
const BARE_LINK = /\bwww\.[a-z0-9-]+\.|\b(?:[a-z0-9-]+\.)+[a-z]{2,}(?::\d+)?[/?#]/i;
const LINK_KEYS = ["url", "uri", "link", "href", "site", "host", "hostname", "domain", "endpoint", "website"];

/** Whether `input` holds a link: a string with a scheme or shaped like one, or any value under a key of LINK_KEYS. */
function links(input: unknown): boolean {
  if (typeof input === "string") return input.includes("://") || BARE_LINK.test(input.replace(EMAIL, " "));
  if (Array.isArray(input)) return input.some(links);
  if (input !== null && typeof input === "object") {
    return Object.entries(input).some(
      ([k, v]) => links(v) || (LINK_KEYS.includes(k.toLowerCase()) && typeof v === "string" && v.trim() !== ""),
    );
  }
  return false;
}

function action(tool: string, input: unknown): ToolAction {
  const inner = called(tool, input);
  const a = inner !== undefined ? guess(inner) : undefined;
  return a !== undefined && a !== "write" ? a : guess(tool);
}

const readsOf = (server: McpServer | undefined): string[] => server?.integration?.readTools ?? [];

/** The rule for one call. */
export function rule(readTools: string[], tool: string, input: unknown): Rule {
  const inner = called(tool, input);
  const n = never(tool) ?? (inner !== undefined ? never(inner) : undefined);
  if (n) return { blocked: n };
  if (readTools.includes(tool)) return { read: true };
  if (namedReads(tool, input)) return !links(input) && !holdsCredential(input) ? { read: true } : { ask: "write" };
  return { ask: action(tool, input) };
}

/** A tool's policy by its name alone, as the connect screen lists it. */
export function toolPolicy(server: McpServer, tool: string): ToolPolicy {
  const r = rule(readsOf(server), tool, null);
  return "read" in r ? "read" : "ask" in r ? "ask" : "blocked";
}

/** `mcp__<server>__<tool>` split at a configured server's name, or at the first `__` after the prefix. */
function split(toolName: string, servers: McpServer[]): [string, string] | undefined {
  if (!toolName.startsWith("mcp__")) return undefined;
  const rest = toolName.slice(5);
  for (const s of servers) {
    if (rest.startsWith(s.name) && rest.slice(s.name.length).startsWith("__")) {
      const tool = rest.slice(s.name.length + 2);
      return tool ? [s.name, tool] : undefined;
    }
  }
  const at = rest.indexOf("__");
  if (at < 0) return undefined;
  const tool = rest.slice(at + 2);
  return tool ? [rest.slice(0, at), tool] : undefined;
}

/** serde_json's `Value` with its keys sorted, so its text reads as the Rust hub writes it. */
export function sortedValue(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sortedValue);
  if (v !== null && typeof v === "object") {
    return Object.fromEntries(entries(v as Record<string, unknown>).map(([k, x]) => [k, sortedValue(x)]));
  }
  return v;
}

const pretty = (input: unknown) => JSON.stringify(sortedValue(input), null, 2) ?? "null";

/**
 * The hub's answer to a permission prompt for `toolName` with `input`, given the session's MCP servers. Undefined for
 * anything but a configured or the person's own MCP server's tool. A server saved without `integration` runs all its
 * tools unasked (D310).
 */
export function verdict(toolName: string, input: unknown, servers: McpServer[]): Verdict | undefined {
  const parts = split(toolName, servers);
  if (!parts) return undefined;
  const [serverName, tool] = parts;
  if (serverName.toLowerCase() === FLEETD_SERVER) return undefined;
  const server = servers.find((s) => s.name === serverName);
  if (server && !server.integration) return { allow: true };
  const r = rule(readsOf(server), tool, input);
  if ("read" in r) return { allow: true };
  if ("blocked" in r) return { block: WHY[r.blocked] };
  if (holdsCredential(input)) return { block: WHY.credential };
  if (pretty(input).length > PREVIEW_INPUT_MAX) return { block: TOO_LARGE };
  const p = preview(serverName, tool, r.ask, input);
  return p ? { ask: p } : { block: "Blocked by fleetd: this tool's name can't be shown on an approval card." };
}

/** Whether any part of `input` looks like a credential: the whole of it, and each string in it on its own. */
function holdsCredential(input: unknown): boolean {
  const shows = (text: string) => redact(text) !== text;
  const all: string[] = [];
  const strings = (v: unknown) => {
    if (typeof v === "string") all.push(v);
    else if (Array.isArray(v)) v.forEach(strings);
    else if (v !== null && typeof v === "object") Object.values(v).forEach(strings);
  };
  strings(input);
  return shows(JSON.stringify(sortedValue(input)) ?? "null") || all.some(shows);
}

/** What a session's claude gets at launch: the read tools in `--allowedTools`, refused ones in `--disallowedTools`. */
export function launchRules(servers: McpServer[]): { allowed: string[]; disallowed: string[] } {
  const out = { allowed: [] as string[], disallowed: [] as string[] };
  for (const s of servers.filter((s) => s.enabled && s.roles.lead)) {
    if (!s.integration) {
      out.allowed.push(`mcp__${s.name}`);
      continue;
    }
    for (const tool of readsOf(s)) (never(tool) ? out.disallowed : out.allowed).push(`mcp__${s.name}__${tool}`);
  }
  return out;
}

/** `text` cut to `max` UTF-16 units, ending in `…` when cut. */
export function clipUtf16(text: string, max: number): string {
  if (text.length <= max) return text;
  let out = "";
  for (const c of text) {
    if (out.length + c.length > Math.max(0, max - 1)) break;
    out += c;
  }
  return `${out}…`;
}

/** The card for an asking call: its title, and the whole input it runs with. */
export function preview(server: string, tool: string, act: ToolAction, input: unknown): ToolPreview | undefined {
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(server) || !/^[A-Za-z0-9_.:/-]{1,128}$/.test(tool)) return undefined;
  const title = clipUtf16(`Use ${tool} on ${server}`.split(/\s+/).filter(Boolean).join(" "), 200);
  return { server, tool, action: act, title, input: pretty(input) };
}
