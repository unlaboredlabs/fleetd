// A run's usage, request by request: from the run's proxy log when it recorded the API's usage objects (the
// authoritative count, since it sees every call), cross-checked against the claude session files, which also say which
// agent made each call. Runs recorded before the proxy kept usage (rounds 1 and 2) are counted from the session files
// alone, with the proxy's request count as the cross-check. Diagnostics point the optimization work: cache rewrites
// after an idle gap, the tool schema each request carries, and how big each agent's first request already is.
import fs from "node:fs";
import path from "node:path";
import { type ProxyRecord, readProxyLog } from "./proxy.ts";
import { jsonlFiles, type Window } from "./usage.ts";

/** USD per million tokens, claude-opus-5-5 at API list prices; cache writes priced by their TTL. */
export const PRICE = { input: 4, cacheRead: 0.2, cacheWrite5m: 5, cacheWrite1h: 8, output: 20 } as const;
/** A cache entry written with the 5 min TTL is gone after this long idle. */
export const IDLE_MS = 5 * 60_000;
/** A request after an idle gap that writes at least this many tokens, and at least half its prompt, rewrote the cache. */
const REWRITE_MIN_TOKENS = 2048;

export interface Tokens {
  requests: number;
  /** Uncached input. */
  input: number;
  cacheRead: number;
  cacheWrite5m: number;
  cacheWrite1h: number;
  output: number;
}

const zero = (): Tokens => ({ requests: 0, input: 0, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0, output: 0 });
const KEYS = Object.keys(zero()) as Array<keyof Tokens>;
const add = (to: Tokens, t: Tokens) => {
  for (const k of KEYS) to[k] += t[k];
  return to;
};
const n = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : 0);

/**
 * One API usage object as tokens. The cache write splits by TTL in `cache_creation.ephemeral_5m_input_tokens` and
 * `ephemeral_1h_input_tokens`; an object without the split counts its whole `cache_creation_input_tokens` as 5 min.
 */
export const tokensOf = (usage: Record<string, unknown>): Tokens => {
  const split = usage.cache_creation as Record<string, unknown> | null | undefined;
  const hasSplit = split != null && (split.ephemeral_5m_input_tokens !== undefined || split.ephemeral_1h_input_tokens !== undefined);
  return {
    requests: 1,
    input: n(usage.input_tokens),
    cacheRead: n(usage.cache_read_input_tokens),
    cacheWrite5m: hasSplit ? n(split.ephemeral_5m_input_tokens) : n(usage.cache_creation_input_tokens),
    cacheWrite1h: hasSplit ? n(split.ephemeral_1h_input_tokens) : 0,
    output: n(usage.output_tokens),
  };
};

export const usdOf = (t: Tokens) =>
  Math.round(t.input * PRICE.input + t.cacheRead * PRICE.cacheRead + t.cacheWrite5m * PRICE.cacheWrite5m + t.cacheWrite1h * PRICE.cacheWrite1h + t.output * PRICE.output) / 1e6;

/** Every token of a request's prompt, cached or not. */
export const promptOf = (t: Tokens) => t.input + t.cacheRead + t.cacheWrite5m + t.cacheWrite1h;
export const totalOf = (t: Tokens) => promptOf(t) + t.output;

export interface ApiRequest {
  messageId?: string;
  /** The session file it belongs to; "proxy" for a request no session recorded. */
  session: string;
  role: string;
  /** When it was sent and when its response ended, ms since the epoch. */
  start: number;
  end: number;
  tokens: Tokens;
  toolsBytes?: number;
}

const FLEETD_KINDS: Record<string, string> = { write: "writer", review: "reviewer", read: "reader" };

/**
 * Which agent a session file is, by its first prompt: fleetd's lead and task briefs name themselves (the gate's
 * reviewer gets fleetd's review brief too); any other first prompt is a plain coding session; a claude subagent lives
 * under `subagents/`.
 */
export const roleOf = (firstPrompt: string, file: string) => {
  if (file.split(path.sep).includes("subagents")) return "subagent";
  if (firstPrompt.startsWith("You are the lead")) return "lead";
  const kind = /^You are fleetd agent \S+ \((\w+)\)/u.exec(firstPrompt)?.[1];
  return kind === undefined ? "coder" : (FLEETD_KINDS[kind] ?? kind);
};
/** fleetd's `pr.fix` message, which the gate sends too: what follows it in that session is fix work. */
const FIX = /^Fix your PR /u;

/** A person's (or harness's) prompt in a user line; null for tool results and injected meta lines. */
const promptText = (entry: Record<string, any>): string | null => {
  if (entry.type !== "user" || entry.isMeta === true) return null;
  const content = entry.message?.content as unknown;
  if (typeof content === "string") return content.trim();
  if (!Array.isArray(content) || content.some((c: Record<string, unknown>) => c?.type === "tool_result")) return null;
  return content
    .filter((c: Record<string, unknown>) => c?.type === "text")
    .map((c: Record<string, unknown>) => String(c.text))
    .join("\n")
    .trim();
};

const parseLines = function* (file: string) {
  for (const line of fs.readFileSync(file, "utf8").split("\n")) {
    if (!line.startsWith("{")) continue;
    try {
      yield JSON.parse(line) as Record<string, any>;
    } catch {
      // A torn last line.
    }
  }
};

/**
 * The API requests recorded in claude session files, one per assistant message id, in order. Each assistant message
 * line carries its message's usage and a `requestRef` to the `api-request` line that sent it, whose `shapeHash` names
 * the `api-request-shape` line holding the request's system prompt and tools. With a window, only messages inside it.
 */
export const sessionRequests = (files: ReadonlyArray<string>, window?: Window): Array<ApiRequest> => {
  const byId = new Map<string, ApiRequest>();
  let anonymous = 0;
  for (const file of files) {
    const toolsByShape = new Map<string, number>();
    const sent = new Map<string, { at: number; shape: string }>();
    let sessionRole: string | undefined;
    let role = "coder";
    for (const entry of parseLines(file)) {
      const at = Date.parse(String(entry.timestamp ?? ""));
      if (entry.type === "api-request-shape" && typeof entry.shapeHash === "string") {
        toolsByShape.set(entry.shapeHash, Buffer.byteLength(JSON.stringify(entry.shape?.tools ?? [])));
        continue;
      }
      if (entry.type === "api-request" && typeof entry.id === "string") {
        sent.set(entry.id, { at, shape: String(entry.shapeHash ?? "") });
        continue;
      }
      const prompt = promptText(entry);
      if (prompt !== null) {
        sessionRole ??= roleOf(prompt, file);
        role = FIX.test(prompt) ? "fix" : sessionRole;
        continue;
      }
      const message = entry.message as Record<string, any> | undefined;
      if (entry.type !== "assistant" || message?.usage === undefined || message.model === "<synthetic>") continue;
      if (window !== undefined && (!Number.isFinite(at) || at < window.from || at > window.to)) continue;
      const id = typeof message.id === "string" ? message.id : `${file}#${anonymous++}`;
      const existing = byId.get(id);
      if (existing !== undefined) {
        // A later content block of the same message: its usage is the message's, final.
        if (existing.session !== file) continue;
        existing.tokens = tokensOf(message.usage as Record<string, unknown>);
        if (Number.isFinite(at)) existing.end = at;
        continue;
      }
      const request = sent.get(String(entry.requestRef ?? ""));
      const toolsBytes = request === undefined ? undefined : toolsByShape.get(request.shape);
      byId.set(id, {
        messageId: id,
        session: file,
        role: sessionRole === undefined ? roleOf("", file) : role,
        start: request !== undefined && Number.isFinite(request.at) ? request.at : at,
        end: at,
        tokens: tokensOf(message.usage as Record<string, unknown>),
        ...(toolsBytes === undefined ? {} : { toolsBytes }),
      });
    }
  }
  return [...byId.values()];
};

const isGeneration = (r: ProxyRecord) => r.method === "POST" && /\/messages$/u.test(r.path);

export interface RoleUsage extends Tokens {
  usd: number;
  /** Sessions that started in this role. */
  agents: number;
  /** Prompt tokens of each such agent's first request. */
  startContext: Array<number>;
  /** Mean bytes of the tool schema per request, when the requests' tools are known. */
  toolsBytes: number | null;
}

export interface Efficiency {
  /** "proxy": usage from the API responses the proxy logged; "sessions": from the claude session files alone. */
  source: "proxy" | "sessions";
  total: Tokens & { usd: number };
  byRole: Record<string, RoleUsage>;
  crossCheck: {
    /** Assistant messages in the session files. */
    sessionMessages: number;
    /** Generation requests in the proxy log; null when the run had none (an imported run). */
    proxyRequests: number | null;
    /** Proxy requests with usage that no session file recorded, and session messages the proxy never saw. */
    proxyOnly: number;
    sessionOnly: number;
    /** The proxy's tokens minus the session files', when the proxy logged usage. */
    delta: Tokens | null;
  };
  idle: {
    /** Requests sent more than IDLE_MS after the same session's previous response ended. */
    gapsOverIdle: number;
    /** Of those, the ones that wrote most of their prompt to the cache again, and what they wrote. */
    rewrites: number;
    rewriteTokens: number;
    /** What those writes cost over reading the same tokens from the cache. */
    rewriteExtraUsd: number;
  };
  /** Mean bytes of the tool schema per request, over the requests whose tools are known. */
  toolsBytesPerRequest: number | null;
}

const mean = (xs: ReadonlyArray<number>) => (xs.length === 0 ? null : Math.round(xs.reduce((a, b) => a + b, 0) / xs.length));

/** A run's efficiency from its session files and, when it has one, its proxy log. */
export const accountRun = (opts: { files: ReadonlyArray<string>; proxy: ReadonlyArray<ProxyRecord> | null; window?: Window }): Efficiency => {
  const fromSessions = sessionRequests(opts.files, opts.window);
  const generations = opts.proxy?.filter(isGeneration) ?? null;
  const logged = generations?.filter((r) => r.usage !== undefined) ?? [];
  let requests = fromSessions;
  let delta: Tokens | null = null;
  let proxyOnly = 0;
  let sessionOnly = 0;
  if (logged.length > 0) {
    const byId = new Map(fromSessions.map((r) => [r.messageId, r]));
    const matched = new Set<string>();
    requests = logged.map((r) => {
      const s = r.messageId === undefined ? undefined : byId.get(r.messageId);
      if (s === undefined) proxyOnly++;
      else matched.add(s.messageId!);
      const toolsBytes = r.toolsBytes ?? s?.toolsBytes;
      return {
        ...(r.messageId === undefined ? {} : { messageId: r.messageId }),
        session: s?.session ?? "proxy",
        role: s?.role ?? "unattributed",
        start: Date.parse(r.sentAt ?? r.at),
        end: Date.parse(r.endAt ?? r.at),
        tokens: tokensOf(r.usage!),
        ...(toolsBytes === undefined ? {} : { toolsBytes }),
      };
    });
    sessionOnly = fromSessions.filter((r) => !matched.has(r.messageId!)).length;
    const p = requests.reduce((t, r) => add(t, r.tokens), zero());
    const s = fromSessions.reduce((t, r) => add(t, r.tokens), zero());
    delta = Object.fromEntries(KEYS.map((k) => [k, p[k] - s[k]])) as unknown as Tokens;
  }

  const total = requests.reduce((t, r) => add(t, r.tokens), zero());
  const byRole: Record<string, RoleUsage> = {};
  const toolSizes: Record<string, Array<number>> = {};
  const role = (name: string) => (byRole[name] ??= { ...zero(), usd: 0, agents: 0, startContext: [], toolsBytes: null });
  for (const r of requests) {
    add(role(r.role), r.tokens);
    if (r.toolsBytes !== undefined) (toolSizes[r.role] ??= []).push(r.toolsBytes);
  }
  const idle = { gapsOverIdle: 0, rewrites: 0, rewriteTokens: 0, rewriteExtraUsd: 0 };
  const bySession = new Map<string, Array<ApiRequest>>();
  for (const r of requests) if (r.session !== "proxy") (bySession.get(r.session) ?? bySession.set(r.session, []).get(r.session)!).push(r);
  for (const session of bySession.values()) {
    session.sort((a, b) => a.start - b.start);
    const first = session[0]!;
    role(first.role).agents += 1;
    role(first.role).startContext.push(promptOf(first.tokens));
    for (let i = 1; i < session.length; i++) {
      const r = session[i]!;
      if (r.start - session[i - 1]!.end <= IDLE_MS) continue;
      idle.gapsOverIdle++;
      const written = r.tokens.cacheWrite5m + r.tokens.cacheWrite1h;
      if (written < REWRITE_MIN_TOKENS || written * 2 < promptOf(r.tokens)) continue;
      idle.rewrites++;
      idle.rewriteTokens += written;
      idle.rewriteExtraUsd += (r.tokens.cacheWrite5m * (PRICE.cacheWrite5m - PRICE.cacheRead) + r.tokens.cacheWrite1h * (PRICE.cacheWrite1h - PRICE.cacheRead)) / 1e6;
    }
  }
  idle.rewriteExtraUsd = Math.round(idle.rewriteExtraUsd * 10_000) / 10_000;
  for (const [name, r] of Object.entries(byRole)) {
    r.usd = usdOf(r);
    r.toolsBytes = mean(toolSizes[name] ?? []);
  }
  return {
    source: logged.length > 0 ? "proxy" : "sessions",
    total: { ...total, usd: usdOf(total) },
    byRole,
    crossCheck: { sessionMessages: fromSessions.length, proxyRequests: generations?.length ?? null, proxyOnly, sessionOnly, delta },
    idle,
    toolsBytesPerRequest: mean(requests.flatMap((r) => (r.toolsBytes === undefined ? [] : [r.toolsBytes]))),
  };
};

/**
 * A run's efficiency recomputed from its archive (<bench>/runs/<run>): the session files under sessions-*, and the
 * run's proxy log. The blind review's own log (review-requests.jsonl) is the bench's, not the contender's, and is left
 * out. Null when the archive has no session file.
 */
export const efficiencyOfArchive = (archive: string, window?: Window): Efficiency | null => {
  const files = fs.existsSync(archive)
    ? fs
        .readdirSync(archive)
        .filter((d) => d.startsWith("sessions-"))
        .flatMap((d) => jsonlFiles(path.join(archive, d)))
    : [];
  if (files.length === 0) return null;
  const log = path.join(archive, "requests.jsonl");
  return accountRun({ files, proxy: fs.existsSync(log) ? readProxyLog(log) : null, ...(window === undefined ? {} : { window }) });
};
