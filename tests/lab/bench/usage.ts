// Claude usage from claude's own session files (`<config dir>/projects/<cwd>/<session>.jsonl`, subagents under
// `<session>/subagents/`): tokens per model and their API-equivalent dollars. claude writes one line per content block
// of an assistant message, each carrying the message's usage, so a message counts once, by its id.
import fs from "node:fs";
import path from "node:path";

/** USD per million tokens, Anthropic first-party API list prices (cache writes: 5 min 1.25x input, 1 h 2x input). */
export const PRICES: Readonly<Record<string, { readonly input: number; readonly output: number; readonly cacheRead: number }>> = {
  "claude-opus-5-5": { input: 4, output: 20, cacheRead: 0.2 },
  "claude-sonnet-5-5": { input: 2, output: 10, cacheRead: 0.2 },
  "claude-haiku-5-5": { input: 0.1, output: 0.5, cacheRead: 0.01 },
};

export interface ModelUsage {
  messages: number;
  input: number;
  output: number;
  cacheWrite5m: number;
  cacheWrite1h: number;
  cacheRead: number;
  /** Null when the model has no price here. */
  usd: number | null;
}

export interface Usage {
  byModel: Record<string, ModelUsage>;
  /** Distinct claude sessions (a subagent is its own session). */
  sessions: number;
  totalTokens: number;
  usd: number;
  /** Models with no price, left out of `usd`. */
  unpriced: Array<string>;
}

/** A run's time span: session lines stamped outside it belong to other work in the same session directory. */
export interface Window {
  readonly from: number;
  readonly to: number;
}

/** The parsed lines of claude session files, in order; with a window, only lines stamped inside it. */
const sessionLines = function* (files: ReadonlyArray<string>, window?: Window) {
  for (const file of files) {
    for (const line of fs.readFileSync(file, "utf8").split("\n")) {
      if (!line.startsWith("{")) continue;
      let entry: Record<string, any>;
      try {
        entry = JSON.parse(line) as Record<string, any>;
      } catch {
        continue;
      }
      if (window !== undefined) {
        const at = Date.parse(String(entry.timestamp ?? ""));
        if (!Number.isFinite(at) || at < window.from || at > window.to) continue;
      }
      yield { file, entry };
    }
  }
};

/** The session files with at least one line inside `window`. */
export const filesIn = (files: ReadonlyArray<string>, window: Window) => [...new Set([...sessionLines(files, window)].map((l) => l.file))];

/** Every .jsonl file under `dir`, recursively. */
export const jsonlFiles = (dir: string): Array<string> => {
  if (!fs.existsSync(dir)) return [];
  const out: Array<string> = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...jsonlFiles(p));
    else if (e.name.endsWith(".jsonl")) out.push(p);
  }
  return out;
};

const priced = (model: string, u: Omit<ModelUsage, "usd" | "messages">): number | null => {
  const price = PRICES[model.replace(/\[.*\]$/u, "")];
  if (price === undefined) return null;
  const perM = u.input * price.input + u.output * price.output + u.cacheRead * price.cacheRead + u.cacheWrite5m * price.input * 1.25 + u.cacheWrite1h * price.input * 2;
  return perM / 1_000_000;
};

/** Sums the usage in `files` (claude session JSONL). Lines that are not assistant messages with usage are skipped. */
export const usageOf = (files: ReadonlyArray<string>, window?: Window): Usage => {
  const messages = new Map<string, { model: string; usage: Record<string, any> }>();
  const sessions = new Set<string>();
  let anonymous = 0;
  for (const { file, entry } of sessionLines(files, window)) {
    const message = entry.message as Record<string, any> | undefined;
    if (entry.type !== "assistant" || message?.usage === undefined || typeof message.model !== "string" || message.model === "<synthetic>") continue;
    sessions.add(`${entry.sessionId ?? file}:${entry.agentId ?? ""}`);
    const id = typeof message.id === "string" ? message.id : `${file}#${anonymous++}`;
    messages.set(id, { model: message.model, usage: message.usage });
  }
  const byModel: Record<string, ModelUsage> = {};
  for (const { model, usage } of messages.values()) {
    const m = (byModel[model] ??= { messages: 0, input: 0, output: 0, cacheWrite5m: 0, cacheWrite1h: 0, cacheRead: 0, usd: 0 });
    m.messages += 1;
    m.input += usage.input_tokens ?? 0;
    m.output += usage.output_tokens ?? 0;
    m.cacheRead += usage.cache_read_input_tokens ?? 0;
    const split = usage.cache_creation as { ephemeral_5m_input_tokens?: number; ephemeral_1h_input_tokens?: number } | undefined;
    if (split !== undefined && (split.ephemeral_5m_input_tokens !== undefined || split.ephemeral_1h_input_tokens !== undefined)) {
      m.cacheWrite5m += split.ephemeral_5m_input_tokens ?? 0;
      m.cacheWrite1h += split.ephemeral_1h_input_tokens ?? 0;
    } else {
      m.cacheWrite5m += usage.cache_creation_input_tokens ?? 0;
    }
  }
  let usd = 0;
  let totalTokens = 0;
  const unpriced: Array<string> = [];
  for (const [model, m] of Object.entries(byModel)) {
    m.usd = priced(model, m);
    if (m.usd === null) unpriced.push(model);
    else usd += m.usd;
    totalTokens += m.input + m.output + m.cacheRead + m.cacheWrite5m + m.cacheWrite1h;
  }
  return { byModel, sessions: sessions.size, totalTokens, usd: Math.round(usd * 10_000) / 10_000, unpriced };
};

export interface Pinning {
  /** True when every request and every recorded message used the pinned model and effort. */
  readonly valid: boolean;
  /** API requests seen by the run's proxy, by `model effort`; generation requests only (POST .../messages). */
  readonly requests: Record<string, number>;
  /** Assistant messages in the session files, by `model effort` (requested model when it differs). */
  readonly messages: Record<string, number>;
  /** The claude CLI versions the session files were written by, with their line counts. */
  readonly cliVersions: Record<string, number>;
  readonly violations: Array<string>;
  /** False when the run had no proxy log (a run recorded with --finish): only the session files were checked. */
  readonly proxyChecked: boolean;
}

/**
 * Whether a run used only `model` at `effort` on the `cli` version: every generation request its proxy saw, and every
 * assistant message in its session files (claude 2.1+ records `effort`, `requestedModel` and `version` per line). A
 * run with no assistant message at all is a violation too: nothing was verified.
 */
export const pinningOf = (
  files: ReadonlyArray<string>,
  requests: ReadonlyArray<{ method: string; path: string; model?: string; effort?: string }> | null,
  pin: { model: string; effort: string; cli: string },
  window?: Window,
): Pinning => {
  const { model, effort } = pin;
  const violations: Array<string> = [];
  const seen: Record<string, number> = {};
  for (const r of requests ?? []) {
    if (r.method !== "POST" || !/\/messages$/u.test(r.path)) continue;
    const key = `${r.model ?? "?"} ${r.effort ?? "-"}`;
    seen[key] = (seen[key] ?? 0) + 1;
  }
  for (const [key, n] of Object.entries(seen)) if (key !== `${model} ${effort}`) violations.push(`${n} request(s) with ${key}`);
  const messages: Record<string, number> = {};
  const cliVersions: Record<string, number> = {};
  const ids = new Set<string>();
  for (const { entry } of sessionLines(files, window)) {
    if (typeof entry.version === "string") cliVersions[entry.version] = (cliVersions[entry.version] ?? 0) + 1;
    const m = entry.message as Record<string, any> | undefined;
    if (entry.type !== "assistant" || typeof m?.model !== "string" || m.model === "<synthetic>") continue;
    if (typeof m.id === "string") {
      if (ids.has(m.id)) continue;
      ids.add(m.id);
    }
    const used = typeof entry.requestedModel === "string" && entry.requestedModel !== m.model ? `${m.model}(asked ${entry.requestedModel})` : m.model;
    const key = `${used} ${entry.effort ?? "-"}`;
    messages[key] = (messages[key] ?? 0) + 1;
  }
  for (const [key, n] of Object.entries(messages)) if (key !== `${model} ${effort}`) violations.push(`${n} message(s) with ${key}`);
  if (Object.keys(messages).length === 0) violations.push("no assistant message in the session files: nothing to verify");
  for (const [version, n] of Object.entries(cliVersions)) if (version !== pin.cli) violations.push(`${n} session line(s) from claude ${version}, not ${pin.cli}`);
  return { valid: violations.length === 0, requests: seen, messages, cliVersions, violations, proxyChecked: requests !== null };
};
