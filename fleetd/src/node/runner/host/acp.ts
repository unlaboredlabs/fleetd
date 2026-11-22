// An Agent Client Protocol agent's stdio (Antigravity's `agy acp`), both ways, as a pure state machine like
// ./mapper.ts: JSON-RPC lines in, RunnerEvents out, and the lines fleetd writes back. No I/O and no clock: the session
// feeds it lines and the time.
//
// The start: `initialize`, `authenticate` with the session's method, then `session/resume` of the conversation the
// session had (its id kept in the spec's state file), else `session/new`, and the profile's model and thinking level.
// Sends that come before the session is up wait for it.
//
// Run accounting, as the mapper's: every `send` opens a run, and every open run ends with exactly one RunEnded: from
// its `session/prompt` answer, or from the process exit. One prompt runs at a time; a send while a turn runs waits
// for it (Queued), and a mode-`now` send cancels the turn, which then ends superseded by it.
import type { ItemKind, ItemStatus, PermissionDecision, RunFailure, RunUsage, SendMode, ThreadItem, ToolClass } from "../../../shared/sessions.ts";
import { headUtf16, tailUtf16 } from "../../util.ts";
import type { ExitInfo, RunOutcome, RunnerEvent } from "./events.ts";
import { evidence, type FailureEvidence } from "./failure.ts";
import type { Now } from "./mapper.ts";
import type { AcpSpec } from "../antigravity_spec.ts";

export type { AcpSpec };

/** What one line or command produced: events, and the lines to write to the agent. */
export type AcpOut = { events: RunnerEvent[]; replies: unknown[] };
export type Classify = (e: FailureEvidence) => RunFailure | undefined;

const STDERR_TAIL = 4000;
const MESSAGE_MAX = 4000;
const OUTPUT_MAX = 16_000;
const THINKING_TITLE_MAX = 120;
const CLIENT = { name: "fleetd", title: "fleetd", version: "1" };

type Pending =
  | { what: "initialize" | "authenticate" | "resume" | "new" | "config" }
  | { what: "prompt"; runId: string };
type Tool = { runId: string; title: string; startedAt: string; kind: ItemKind; toolName: string };
type Ask = { rpcId: string | number; allow: string; deny: string; toolName: string; summary: string };

const emptyUsage = (): RunUsage => ({ inputTokens: 0, outputTokens: 0, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 });
const rec = (v: unknown): Record<string, any> | undefined => (v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, any>) : undefined);
const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);
const firstLine = (s: string) => (s.split("\n")[0] ?? "").replace(/\r$/, "");

/** A glob as Claude's permission rules read one: `*` is any run of characters. */
const glob = (pattern: string, text: string) => new RegExp(`^${pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*")}$`, "s").test(text);

/** The tool's name in Claude's rule words, and what a `Name(pattern)` rule matches. */
export function ruleName(call: Record<string, any>): [string, string | undefined] {
  const input = rec(call.rawInput) ?? {};
  const server = str(input.ServerName);
  const tool = str(input.ToolName);
  if (server && tool) return [`mcp__${server}__${tool}`, undefined];
  const name = str(call.name) ?? "";
  if (call.kind === "execute" || name === "run_command") return ["Bash", str(input.CommandLine) ?? ""];
  if (name === "write_file") return ["Write", str(input.Path)];
  if (call.kind === "edit") return ["Edit", str(input.Path) ?? str(input.TargetFile)];
  if (call.kind === "fetch") return ["WebFetch", str(input.Url) ?? str(input.url)];
  if (name.includes("search_web") || name === "web_search") return ["WebSearch", str(input.query) ?? str(input.Query)];
  return [name, undefined];
}

/** True when one of `rules` names the call, as Claude reads them: `Edit`, `Bash(git *)`, and `mcp__fleetd` for every
 * tool of the server. */
export function fenced(rules: string[], call: Record<string, any>): boolean {
  const [name, target] = ruleName(call);
  return rules.some((rule) => {
    const open = rule.indexOf("(");
    if (open < 0) return rule === name || (rule.startsWith("mcp__") && !rule.slice(5).includes("__") && name.startsWith(`${rule}__`));
    return rule.slice(0, open) === name && target !== undefined && rule.endsWith(")") && glob(rule.slice(open + 1, -1), target);
  });
}

function toolKind(call: Record<string, any>): [ItemKind, string] {
  const input = rec(call.rawInput) ?? rec(call.args) ?? {};
  const name = str(call.name) ?? str(call.kind) ?? "tool";
  const title = str(call.title) ?? name;
  const path = str(rec(call.locations?.[0])?.path) ?? str(input.Path);
  const server = str(input.ServerName);
  const tool = str(input.ToolName);
  if (server && tool) return [{ type: "tool", toolName: `mcp__${server}__${tool}`, input: input.Arguments ?? input, outputOmitted: false, class: { type: "mcp", server, tool } }, `${server} ${tool}`];
  switch (call.kind) {
    case "execute":
      return [{ type: "command", command: str(input.CommandLine) ?? title, outputOmitted: false }, str(input.toolSummary) ?? title];
    case "edit":
    case "delete":
    case "move":
      return path ? [{ type: "file_change", toolName: name, path }, title] : [{ type: "tool", toolName: name, input, outputOmitted: false }, title];
  }
  const cls: ToolClass | undefined =
    call.kind === "read" ? { type: "read", ...(path ? { path } : {}) } : call.kind === "search" ? { type: "search" } : call.kind === "fetch" ? { type: "web", ...(str(input.Url) ? { url: str(input.Url)! } : {}) } : undefined;
  return [{ type: "tool", toolName: name, input, outputOmitted: false, ...(cls ? { class: cls } : {}) }, title];
}

/** A tool call's output as text: its `rawOutput.output`, else its text content. */
function outputOf(update: Record<string, any>): string | undefined {
  const raw = rec(update.rawOutput);
  if (typeof raw?.output === "string") return raw.output;
  const parts: string[] = [];
  for (const c of Array.isArray(update.content) ? update.content : []) {
    const text = str(rec(rec(c)?.content)?.text);
    if (text) parts.push(text);
  }
  return parts.length ? parts.join("\n") : undefined;
}

export class AcpDriver {
  #nextId = 0;
  #pending = new Map<number, Pending>();
  #sessionId: string | undefined;
  #version = "";
  /** Sends waiting for the session to come up or for the running turn to end, oldest first. */
  #waiting: { runId: string; text: string }[] = [];
  /** The run whose prompt is out. */
  #active: string | undefined;
  /** Every run sent and not yet ended. */
  #open: string[] = [];
  /** A mode-`now` send the cancelled turn ends superseded by. */
  #superseding: string | undefined;
  #cancelled = false;
  #stopping = false;
  #tools = new Map<string, Tool>();
  #asks = new Map<string, Ask>();
  #text = { id: "", text: "", n: 0 };
  #thought = "";
  #thoughts = 0;
  #reply = "";
  #woken: string | undefined;
  #minted = 0;
  #stderrTail = "";
  #runStderr = "";
  #startError: string | undefined;

  constructor(
    readonly spec: AcpSpec,
    readonly resumeId: string | undefined,
    readonly classify: Classify,
    readonly keep: (sessionId: string) => void = () => {},
    readonly warn: (message: string) => void = () => {},
  ) {}

  /** The lines that start the agent: its `initialize`. */
  start(): AcpOut {
    return {
      events: [],
      replies: [this.#request("initialize", { what: "initialize" }, { protocolVersion: 1, clientInfo: CLIENT, clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false } })],
    };
  }

  send(runId: string, text: string, mode: SendMode, now?: Now): AcpOut {
    const out: AcpOut = { events: [], replies: [] };
    this.#open.push(runId);
    this.#waiting.push({ runId, text });
    if (this.#active !== undefined) {
      out.events.push({ Queued: { run_id: runId } });
      if (mode === "now" && !this.#cancelled) {
        this.#superseding = runId;
        this.#cancel(out, now);
        out.events.push({ SendNow: { run_id: runId, outcome: "stopped", stopped_tool: this.#runningTool() ?? null } });
      }
      return out;
    }
    this.#next(out);
    return out;
  }

  /** A send still waiting ends withdrawn; one whose prompt is out can't be taken back. */
  withdraw(runId: string): AcpOut | undefined {
    const at = this.#waiting.findIndex((w) => w.runId === runId);
    if (at < 0) return undefined;
    this.#waiting.splice(at, 1);
    this.#open = this.#open.filter((r) => r !== runId);
    return { events: [{ Withdrawn: { run_id: runId, cancelled: true, by_stop: false } }], replies: [] };
  }

  /** A person's stop: the running turn is cancelled, and what waited on it ends withdrawn. */
  stop(now?: Now): AcpOut {
    const out: AcpOut = { events: [], replies: [] };
    for (const w of this.#waiting.splice(0)) {
      this.#open = this.#open.filter((r) => r !== w.runId);
      out.events.push({ Withdrawn: { run_id: w.runId, cancelled: true, by_stop: true } });
    }
    this.#superseding = undefined;
    if (this.#active !== undefined && !this.#cancelled) this.#cancel(out, now);
    return out;
  }

  /** The cancel a shutdown writes before it closes stdin. */
  interrupt(): unknown[] {
    const out: AcpOut = { events: [], replies: [] };
    if (this.#active !== undefined && !this.#cancelled) this.#cancel(out);
    return out.replies;
  }

  /** The answer to a permission the agent still waits for; undefined once it doesn't. */
  answer(requestId: string, decision: PermissionDecision): AcpOut | undefined {
    const ask = this.#asks.get(requestId);
    if (!ask) return undefined;
    this.#asks.delete(requestId);
    return { events: [], replies: [this.#selected(ask.rpcId, decision.behavior === "allow" ? ask.allow : ask.deny)] };
  }

  hasOpenRun(): boolean {
    return this.#open.length > 0;
  }

  stopping(): void {
    this.#stopping = true;
  }

  stderr(line: string): void {
    const add = (buf: string) => {
      const next = buf ? `${buf}\n${line}` : line;
      return next.length > STDERR_TAIL * 2 ? tailUtf16(next, STDERR_TAIL) : next;
    };
    this.#stderrTail = add(this.#stderrTail);
    this.#runStderr = add(this.#runStderr);
  }

  stderrTail(): string {
    return tailUtf16(this.#stderrTail, STDERR_TAIL);
  }

  /** One stdout line; undefined when it isn't JSON-RPC (it then counts as stderr). */
  line(raw: string, now: Now): AcpOut | undefined {
    let m: Record<string, any> | undefined;
    try {
      m = rec(JSON.parse(raw));
    } catch {
      return undefined;
    }
    if (!m || m.jsonrpc !== "2.0") return undefined;
    const out: AcpOut = { events: [], replies: [] };
    if (typeof m.method === "string") {
      if (m.id !== undefined) this.#agentRequest(m.id, m.method, rec(m.params) ?? {}, now, out);
      else if (m.method === "session/update") this.#update(rec(m.params?.update) ?? {}, now, out);
    } else if (typeof m.id === "number") {
      const pending = this.#pending.get(m.id);
      this.#pending.delete(m.id);
      if (pending) this.#answered(pending, rec(m.result), rec(m.error), now, out);
    }
    return out;
  }

  exited(exit: ExitInfo, now: Now): RunnerEvent[] {
    const out: AcpOut = { events: [], replies: [] };
    for (const runId of [...this.#open]) {
      const outcome: RunOutcome =
        this.#stopping || this.#cancelled
          ? "Interrupted"
          : { Failed: this.#failure(evidence({ isError: true, text: this.#startError ?? "", exit, stderr: tailUtf16(this.#runStderr, STDERR_TAIL), nowMs: now.ms })) };
      this.#end(runId, outcome, undefined, now, out);
    }
    out.events.push({ Exited: exit });
    return out.events;
  }

  #request(method: string, pending: Pending, params: unknown): unknown {
    const id = ++this.#nextId;
    this.#pending.set(id, pending);
    return { jsonrpc: "2.0", id, method, params };
  }

  /** `session/cancel`, and every permission the agent still waits for answered `cancelled`, as ACP has the client do:
   * the agent may wait on them before it ends the turn. Their cards close with them. */
  #cancel(out: AcpOut, now?: Now): void {
    this.#cancelled = true;
    out.replies.push({ jsonrpc: "2.0", method: "session/cancel", params: { sessionId: this.#sessionId } });
    for (const [requestId, ask] of this.#asks) {
      out.replies.push({ jsonrpc: "2.0", id: ask.rpcId, result: { outcome: { outcome: "cancelled" } } });
      if (now) {
        const kind: ItemKind = { type: "permission", requestId, toolName: ask.toolName, summary: ask.summary };
        out.events.push({ Item: this.#item(requestId, "cancelled", `${ask.toolName} ${ask.summary}`, now.at, now, kind) });
      }
    }
    this.#asks.clear();
  }

  #selected(rpcId: string | number, optionId: string): unknown {
    return { jsonrpc: "2.0", id: rpcId, result: { outcome: { outcome: "selected", optionId } } };
  }

  #setup(): Record<string, unknown> {
    return {
      cwd: this.spec.cwd,
      mcpServers: this.spec.mcpServers,
      ...(this.spec.addDirs.length ? { additionalDirectories: this.spec.addDirs } : {}),
    };
  }

  #answered(p: Pending, result: Record<string, any> | undefined, error: Record<string, any> | undefined, now: Now, out: AcpOut): void {
    const failed = error ? `${str(error.message) ?? "error"}${error.data ? `: ${typeof error.data === "string" ? error.data : JSON.stringify(error.data)}` : ""}` : undefined;
    switch (p.what) {
      case "initialize":
        this.#version = str(result?.agentInfo?.version) ?? "";
        if (failed) return this.#startFailed(`the agent refused fleetd's initialize: ${failed}`, now, out);
        if (this.spec.authMethod) out.replies.push(this.#request("authenticate", { what: "authenticate" }, { methodId: this.spec.authMethod }));
        else this.#openSession(out);
        return;
      case "authenticate":
        if (failed) return this.#startFailed(`Antigravity refused the project's Gemini API key: ${failed}`, now, out);
        this.#openSession(out);
        return;
      case "resume":
        // A conversation Antigravity no longer has starts anew.
        if (failed) {
          this.warn(`session/resume refused, starting a new conversation: ${failed}`);
          out.replies.push(this.#newSession());
          return;
        }
        this.#sessionId = this.resumeId;
        return this.#ready(result, out);
      case "new":
        if (failed && error?.code === -32000) return this.#startFailed(`Antigravity is not signed in on this machine (${failed}). Sign in with: agy acp --login`, now, out);
        if (failed) return this.#startFailed(`Antigravity didn't start a session: ${failed}`, now, out);
        this.#sessionId = str(result?.sessionId);
        if (!this.#sessionId) return this.#startFailed("Antigravity started a session with no id", now, out);
        this.keep(this.#sessionId);
        return this.#ready(result, out);
      case "config":
        if (failed) this.warn(`Antigravity refused a session option: ${failed}`);
        return;
      case "prompt":
        return this.#promptEnded(p.runId, result, failed, now, out);
    }
  }

  /** The conversation the session had, else a new one. */
  #openSession(out: AcpOut): void {
    out.replies.push(this.resumeId ? this.#request("session/resume", { what: "resume" }, { sessionId: this.resumeId, ...this.#setup() }) : this.#newSession());
  }

  #newSession(): unknown {
    const meta = this.spec.systemPrompt ? { _meta: { antigravity: { systemPrompt: { append: this.spec.systemPrompt } } } } : {};
    return this.#request("session/new", { what: "new" }, { ...this.#setup(), ...meta });
  }

  /** The session is up: its model and thinking level, then the first waiting send. */
  #ready(result: Record<string, any> | undefined, out: AcpOut): void {
    const options: Record<string, any>[] = Array.isArray(result?.configOptions) ? result!.configOptions : [];
    const option = (id: string) => options.find((o) => o?.id === id || o?.category === id);
    const values = (o: Record<string, any> | undefined) => (Array.isArray(o?.options) ? o!.options.flatMap((v: any) => (Array.isArray(v?.options) ? v.options : [v])).map((v: any) => v?.value) : []);
    const set = (configId: string, value: string) =>
      out.replies.push(this.#request("session/set_config_option", { what: "config" }, { sessionId: this.#sessionId, configId, value }));
    const model = option("model");
    if (this.spec.model && model && model.currentValue !== this.spec.model) {
      if (values(model).includes(this.spec.model)) set("model", this.spec.model);
      else this.warn(`model ${this.spec.model} isn't offered to this account; it runs on ${model.currentValue}`);
    }
    const thought = option("thought_level");
    if (this.spec.effort && thought && thought.currentValue !== this.spec.effort && values(thought).includes(this.spec.effort)) set("thought_level", this.spec.effort);
    out.events.push({ Init: { version: this.#version, model: this.spec.model || str(model?.currentValue) || "", cwd: this.spec.cwd, agent_tools: null } });
    this.#next(out);
  }

  #startFailed(message: string, now: Now, out: AcpOut): void {
    this.#startError = message;
    for (const w of this.#waiting.splice(0)) {
      this.#end(w.runId, { Failed: this.#failure(evidence({ isError: true, text: message, stderr: tailUtf16(this.#runStderr, STDERR_TAIL), nowMs: now.ms })) }, undefined, now, out);
    }
  }

  /** Sends the oldest waiting send's prompt, when the session is up and no turn runs. */
  #next(out: AcpOut): void {
    if (this.#sessionId === undefined || this.#active !== undefined || this.#startError !== undefined) return;
    const w = this.#waiting.shift();
    if (!w) return;
    this.#begin(w.runId, out);
    out.replies.push(this.#request("session/prompt", { what: "prompt", runId: w.runId }, { sessionId: this.#sessionId, prompt: [{ type: "text", text: w.text }] }));
  }

  #begin(runId: string, out: AcpOut): void {
    if (!this.#open.includes(runId)) this.#open.push(runId);
    this.#active = runId;
    this.#cancelled = false;
    this.#runStderr = "";
    this.#reply = "";
    out.events.push({ RunStarted: { run_id: runId } });
  }

  #promptEnded(runId: string, result: Record<string, any> | undefined, failed: string | undefined, now: Now, out: AcpOut): void {
    this.#flush(now, out);
    const u = rec(result?.usage);
    const usage: RunUsage | undefined = u && {
      ...emptyUsage(),
      inputTokens: Number(u.inputTokens) || 0,
      outputTokens: Number(u.outputTokens) || 0,
      cacheReadInputTokens: Number(u.cachedReadTokens) || 0,
      cacheCreationInputTokens: Number(u.cachedWriteTokens) || 0,
    };
    const reason = str(result?.stopReason);
    let outcome: RunOutcome;
    if (reason === "cancelled" || (failed && this.#cancelled)) outcome = this.#superseding ? { Superseded: { by: this.#superseding } } : "Interrupted";
    else if (failed) outcome = { Failed: this.#failure(evidence({ isError: true, text: failed, stderr: tailUtf16(this.#runStderr, STDERR_TAIL), nowMs: now.ms })) };
    else if (reason === "refusal") outcome = { Failed: this.#failure(evidence({ isError: true, text: "The model refused the request.", nowMs: now.ms })) };
    else outcome = { Completed: { text: this.#reply } };
    this.#superseding = undefined;
    this.#end(runId, outcome, usage, now, out);
    this.#next(out);
  }

  #end(runId: string, outcome: RunOutcome, usage: RunUsage | undefined, now: Now, out: AcpOut): void {
    for (const [id, tool] of [...this.#tools]) {
      if (tool.runId !== runId) continue;
      this.#tools.delete(id);
      out.events.push({ Item: { ...this.#item(id, "cancelled", tool.title, tool.startedAt, now, tool.kind), runId } });
    }
    if (typeof outcome === "object" && "Failed" in outcome) {
      out.events.push({ Item: { ...this.#item(`${runId}-error`, "failed", firstLine(outcome.Failed.message), now.at, now, { type: "error", failure: outcome.Failed }), runId } });
    }
    this.#open = this.#open.filter((r) => r !== runId);
    if (this.#active === runId) {
      this.#active = undefined;
      this.#cancelled = false;
    }
    if (this.#woken === runId) this.#woken = undefined;
    out.events.push({ RunEnded: { run_id: runId, outcome, usage: usage ?? null } });
  }

  #failure(e: FailureEvidence): RunFailure {
    return (
      this.classify(e) ?? {
        class: e.exit ? "process_exited" : "other",
        message: headUtf16(e.text.trim(), MESSAGE_MAX) || "Antigravity ended the run with an error",
        retries: 0,
      }
    );
  }

  #runningTool(): string | undefined {
    for (const t of this.#tools.values()) if (t.runId === this.#active) return t.title;
    return undefined;
  }

  /** Output with no prompt open: the agent woke by itself (a background job ended). It runs as a run of its own. */
  #wake(now: Now, out: AcpOut): string {
    const runId = `woke-${now.ms}-${++this.#minted}`;
    this.#woken = runId;
    this.#begin(runId, out);
    return runId;
  }

  #update(u: Record<string, any>, now: Now, out: AcpOut): void {
    const kind = str(u.sessionUpdate);
    const output = kind === "agent_message_chunk" || kind === "agent_thought_chunk" || kind === "tool_call" || kind === "tool_call_update";
    if (output && this.#active === undefined && !this.#stopping && this.#sessionId !== undefined) this.#wake(now, out);
    const runId = this.#active;
    switch (kind) {
      case "agent_message_chunk": {
        const text = str(u.content?.text);
        if (!text || runId === undefined) return;
        this.#flushThought(now, out);
        if (!this.#text.id) this.#text = { id: `${runId}:m${++this.#text.n}`, text: "", n: this.#text.n };
        this.#text.text += text;
        out.events.push({ Delta: { message_id: this.#text.id, append: text } });
        return;
      }
      case "agent_thought_chunk": {
        const text = str(u.content?.text);
        if (!text) return;
        this.#flushText(out);
        this.#thought += text;
        return;
      }
      case "tool_call":
      case "tool_call_update": {
        if (runId === undefined) return;
        this.#flush(now, out);
        const id = str(u.toolCallId);
        if (!id) return;
        const status = str(u.status);
        let tool = this.#tools.get(id);
        if (!tool) {
          const [k, title] = toolKind(u);
          tool = { runId, title, startedAt: now.at, kind: k, toolName: str(u.name) ?? "tool" };
          this.#tools.set(id, tool);
          if (status !== "completed" && status !== "failed") out.events.push({ Item: { ...this.#item(id, "running", tool.title, now.at, undefined, tool.kind), runId } });
        }
        if (status === "completed" || status === "failed") {
          this.#tools.delete(id);
          const text = outputOf(u);
          const exit = typeof u.rawOutput?.exit_code === "number" ? u.rawOutput.exit_code : undefined;
          const itemStatus: ItemStatus = status === "completed" ? "completed" : this.#cancelled ? "cancelled" : "failed";
          let k = tool.kind;
          const capped = text === undefined ? undefined : headUtf16(text, OUTPUT_MAX);
          if (k.type === "command") k = { ...k, ...(capped !== undefined ? { output: capped } : {}), outputOmitted: false, ...(exit !== undefined ? { exitCode: exit } : {}) };
          else if (k.type === "tool") k = { ...k, ...(capped !== undefined ? { output: capped } : {}), outputOmitted: false };
          out.events.push({ Item: { ...this.#item(id, itemStatus, tool.title, tool.startedAt, now, k), runId: tool.runId } });
        }
        return;
      }
      case "usage_update":
        // A woken turn has no prompt whose answer ends it: its reply ends with the usage that follows it.
        if (this.#woken !== undefined && this.#woken === runId && (this.#text.text || this.#reply)) {
          this.#flush(now, out);
          this.#end(runId, { Completed: { text: this.#reply } }, undefined, now, out);
          this.#next(out);
        }
        return;
    }
  }

  #flush(now: Now, out: AcpOut): void {
    this.#flushThought(now, out);
    this.#flushText(out);
  }

  #flushText(out: AcpOut): void {
    if (!this.#text.id) return;
    out.events.push({ AssistantText: { message_id: this.#text.id, text: this.#text.text } });
    this.#reply = this.#text.text;
    this.#text = { id: "", text: "", n: this.#text.n };
  }

  #flushThought(now: Now, out: AcpOut): void {
    const summary = this.#thought.trim();
    this.#thought = "";
    if (!summary || this.#active === undefined) return;
    const kind: ItemKind = { type: "tool", toolName: "Thinking", input: null, output: summary, outputOmitted: false };
    out.events.push({ Item: { ...this.#item(`${this.#active}:thinking:${++this.#thoughts}`, "completed", `Thinking: ${headUtf16(firstLine(summary), THINKING_TITLE_MAX)}`, now.at, now, kind), runId: this.#active } });
  }

  /** A request from the agent: a permission to answer, or one fleetd doesn't serve (it would wait forever). */
  #agentRequest(rpcId: string | number, method: string, params: Record<string, any>, now: Now, out: AcpOut): void {
    if (method !== "session/request_permission") {
      out.replies.push({ jsonrpc: "2.0", id: rpcId, error: { code: -32601, message: `fleetd does not serve ${method}` } });
      return;
    }
    const call = rec(params.toolCall) ?? {};
    const options: Record<string, any>[] = Array.isArray(params.options) ? params.options : [];
    const pick = (kinds: string[]) => str(options.find((o) => kinds.includes(o?.kind))?.optionId);
    const allow = pick(["allow_once", "allow_always"]) ?? "allow";
    const deny = pick(["reject_once", "reject_always"]) ?? "deny";
    if (fenced(this.spec.deny, call)) {
      out.replies.push(this.#selected(rpcId, deny));
      return;
    }
    if (!this.spec.approval || fenced(this.spec.allow, call)) {
      out.replies.push(this.#selected(rpcId, allow));
      return;
    }
    this.#flush(now, out);
    const [toolName, target] = ruleName(call);
    const requestId = `acp-${String(rpcId)}`;
    const input = call.rawInput ?? null;
    const summary = target ?? str(call.title) ?? "";
    this.#asks.set(requestId, { rpcId, allow, deny, toolName, summary });
    out.events.push({ PermissionRequest: { request_id: requestId, tool_use_id: str(call.toolCallId) ?? "", tool_name: toolName, input, summary } });
  }

  #item(id: string, status: ItemStatus, title: string, startedAt: string, completed: Now | undefined, kind: ItemKind): ThreadItem {
    return {
      id,
      ...(this.#active ? { runId: this.#active } : {}),
      status,
      title,
      startedAt,
      ...(completed ? { completedAt: completed.at } : {}),
      updatedAt: completed ? completed.at : startedAt,
      kind,
    };
  }
}
