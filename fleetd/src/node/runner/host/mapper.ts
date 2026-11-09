// claude's stream-json, both ways, as a pure state machine: stdout
// lines in, RunnerEvents out, and the stdin lines fleetd writes (user messages, permission answers, interrupts). No I/O
// and no clock: the session feeds it lines and the time, so every fixture replays through exactly the code that runs in
// production.
//
// Run accounting: every `send` opens a run, and every open run ends with exactly one RunEnded: from its `result`, from
// a `command_lifecycle` cancelled/completed that came without one (a queued message cancelled by an interrupt), or from
// the process exit (a crash, a refusal such as "Session ID … is already in use", or a kill).
import type { ItemKind, ItemStatus, PermissionDecision, RunFailure, RunUsage, SendMode, SendNow, ThreadItem, ToolClass } from "../../../shared/sessions.ts";
import type { SpanStatus } from "../../../shared/contracts.ts";
import { headUtf16, tailUtf16 } from "../../util.ts";
import { agentLike, missingInitCapabilities, SEND_NOW_CAPABILITY } from "./conformance.ts";
import type { DecidedBy, ExitInfo, RateLimit, RunOutcome, RunnerEvent } from "./events.ts";
import { evidence, type FailureEvidence } from "./failure.ts";
import type { Assistant, Block, CommandLifecycle, ControlRequest, Input, Line, ResultLine, StreamEvent, System, User } from "./protocol.ts";
import { SpanBuilder } from "./spans.ts";

/** Turns what claude left behind into a failure (failure.ts `classify` in production). */
export type Classify = (e: FailureEvidence) => RunFailure | undefined;

const STDERR_TAIL = 4000;
const MESSAGE_MAX = 4000;
const THINKING_TITLE_MAX = 120;

/** The time a line was read. */
export type Now = { at: string; ms: number };
export const systemNow = (): Now => {
  const ms = Date.now();
  return { at: new Date(ms).toISOString(), ms };
};

/** What one stdout line produced. */
export type Mapped = { events: RunnerEvent[]; replies: Input[] };

type OpenTool = { runId?: string; title: string; startedAt: string; kind: ItemKind };
/** A control request fleetd sent whose answer it reads: a mode-`now` send's stop, or a withdraw. */
type Control = { stop: true; runId: string; stoppedTool?: string } | { stop: false; runId: string; byStop: boolean };
type PendingPermission = { input: unknown; toolName: string; summary: string };
/** The synthetic assistant message claude sends before an API-error `result`. */
type AssistantError = { error?: string; status?: number; text: string };

const emptyUsage = (): RunUsage => ({ inputTokens: 0, outputTokens: 0, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 });
const remove = (list: string[], item: string) => {
  for (let i = list.length - 1; i >= 0; i--) if (list[i] === item) list.splice(i, 1);
};
/** The first of `s`'s lines, as Rust's `lines()` reads it. */
const firstLine = (s: string) => (s.split("\n")[0] ?? "").replace(/\r$/, "");

export class StreamMapper {
  /** Runs sent and not yet ended, oldest first. */
  #openRuns: string[] = [];
  /** The run claude is executing (`command_lifecycle` started). */
  #activeRun: string | undefined;
  #tools = new Map<string, OpenTool>();
  #permissions = new Map<string, PendingPermission>();
  /** The streaming message's id and the text-block ids by content-block index, so deltas and the complete
   * AssistantText share an id. */
  #streaming: string | undefined;
  #streamTextBlocks = new Map<number, string>();
  #streamTextCount = 0;
  /** The active run's usage: the messages it finished, and the one streaming now. */
  #usageDone = emptyUsage();
  #usageNow = emptyUsage();
  /** Text blocks already emitted per complete message id: claude sends one `assistant` line per block. */
  #textBlocks: [string, number] | undefined;
  #assistantError: AssistantError | undefined;
  #rateLimit: RateLimit | undefined;
  #compacting = false;
  /** The id of an interrupt in flight; tool errors until the run ends are cancellations, not failures. */
  #interrupt: string | undefined;
  #interruptsSent = 0;
  /** Shutdown was requested: a run cut by the exit is Interrupted, not Failed. */
  #stopping = false;
  #stderrTail = "";
  #runStderr = "";
  #minted = 0;
  #warnedCapabilities = false;
  #spans: SpanBuilder;
  /** The latest `system/init` capabilities; none before the process's first turn. */
  #capabilities: string[] | undefined;
  /** Steers (`boundary`, `now`) sent while a turn ran and not yet started: an aborted `result` then supersedes. */
  #steersWaiting: string[] = [];
  /** A mode-`now` send waiting for its `queued` before fleetd asks claude to send it now. */
  #sendNow: string | undefined;
  #controls = new Map<string, Control>();
  /** Steers that waited on a turn a person stopped: claude drops them, and they end withdrawn, not failed. */
  #droppedByStop: string[] = [];
  /** Runs an older claude merged into the running turn; they end with its `result`. */
  #joined: string[] = [];
  #withdrawsSent = 0;
  /** The run of a turn claude started by itself, for a background task's notice while no run of fleetd's was open. */
  #woken: string | undefined;

  constructor(
    readonly sessionId: string,
    readonly classify: Classify,
    readonly warn: (message: string) => void = () => {},
  ) {
    this.#spans = new SpanBuilder(sessionId);
  }

  /** The stdin lines that start run `runId`. claude echoes the uuid on `command_lifecycle` and the `result`.
   *
   * `plain` is today's send. `boundary` asks for `priority: "now"`: the running turn ends at its next tool boundary and
   * the message gets its own turn. `now` sends the message, then on its `queued` asks claude to send it now, which
   * stops the running step; without `interrupt_send_now_v1` it first interrupts the running message
   * (`interrupt_receipt_v1`), else interrupts plainly. Between turns every mode is a plain new turn. */
  send(runId: string, text: string, mode: SendMode): Input[] {
    const out: Input[] = [];
    const running = this.#activeRun;
    if (mode !== "plain" && running !== undefined) this.#steersWaiting.push(runId);
    if (mode === "now" && running !== undefined) {
      const caps = this.#capabilities ?? [];
      if (caps.includes(SEND_NOW_CAPABILITY) && caps.includes("msg_lifecycle_v1")) this.#sendNow = runId;
      else {
        const request = caps.includes("interrupt_receipt_v1") ? { for_user_message_uuids: [running], subtype: "interrupt" } : { subtype: "interrupt" };
        out.push(this.#stopRequest(runId, request));
      }
    }
    this.#openRuns.push(runId);
    out.push({
      type: "user",
      message: { role: "user", content: text },
      parent_tool_use_id: null,
      session_id: "",
      uuid: runId,
      ...(mode === "boundary" ? { priority: "now" as const } : {}),
    });
    return out;
  }

  /** `cancel_async_message` for a send claude still holds queued; undefined once it has started. */
  withdraw(runId: string): Input | undefined {
    const waiting = this.#openRuns.includes(runId) && this.#activeRun !== runId && !this.#joined.includes(runId);
    return waiting ? this.#withdrawRequest(runId, false) : undefined;
  }

  #withdrawRequest(runId: string, byStop: boolean): Input {
    this.#withdrawsSent++;
    const requestId = `fleetd-withdraw-${this.#withdrawsSent}`;
    this.#controls.set(requestId, { stop: false, runId, byStop });
    return { type: "control_request", request_id: requestId, request: { message_uuid: runId, subtype: "cancel_async_message" } };
  }

  interrupt(): Input {
    return this.#interruptRequest({ subtype: "interrupt" });
  }

  /** A person's (or the watchdog's) stop: the interrupt, then a withdraw of every steer that waited on the turn. The
   * turn ends interrupted, not superseded, and the steers end withdrawn, never as a new turn after the stop. */
  stop(): Input[] {
    const waiting = this.#steersWaiting;
    this.#steersWaiting = [];
    this.#sendNow = undefined;
    const out = [this.interrupt()];
    for (const runId of waiting) {
      this.#droppedByStop.push(runId);
      out.push(this.#withdrawRequest(runId, true));
    }
    return out;
  }

  #interruptRequest(request: Record<string, unknown>): Input {
    this.#interruptsSent++;
    const requestId = `fleetd-int-${this.#interruptsSent}`;
    this.#interrupt = requestId;
    return { type: "control_request", request_id: requestId, request };
  }

  /** An interrupt that stops the running step for steer `runId`; its answer becomes SendNow. */
  #stopRequest(runId: string, request: Record<string, unknown>): Input {
    const input = this.#interruptRequest(request);
    if (input.type === "control_request") {
      const stoppedTool = this.#runningTool();
      this.#controls.set(input.request_id, { stop: true, runId, ...(stoppedTool !== undefined ? { stoppedTool } : {}) });
    }
    return input;
  }

  /** A withdraw is pending for `runId`, or it waited on a turn a person stopped. */
  #withdrawing(runId: string): boolean {
    return this.#droppedByStop.includes(runId) || [...this.#controls.values()].some((c) => !c.stop && c.runId === runId);
  }

  /** The title of the running turn's oldest unfinished tool call. */
  #runningTool(): string | undefined {
    let oldest: OpenTool | undefined;
    for (const t of this.#tools.values()) if (t.runId === this.#activeRun && (!oldest || t.startedAt < oldest.startedAt)) oldest = t;
    return oldest?.title;
  }

  /** The answer to a pending `can_use_tool`; undefined when claude no longer waits for it. An allow without an edited
   * input sends the original one: claude requires `updatedInput` on every allow. */
  answer(requestId: string, decision: PermissionDecision, by: DecidedBy | undefined, now: Now): Input | undefined {
    const pending = this.#permissions.get(requestId);
    if (!pending) return undefined;
    this.#permissions.delete(requestId);
    this.#spans.answered(requestId, by, now.ms);
    const response =
      decision.behavior === "allow"
        ? { behavior: "allow", updatedInput: decision.updatedInput === undefined || decision.updatedInput === null ? pending.input : decision.updatedInput }
        : { behavior: "deny", message: decision.message };
    return { type: "control_response", response: { request_id: requestId, response, subtype: "success" } };
  }

  hasOpenRun(): boolean {
    return this.#openRuns.length > 0;
  }

  stopping(): void {
    this.#stopping = true;
  }

  /** One stderr line. Kept for the exit and for the failure message of the run it belongs to. */
  stderr(line: string): void {
    const add = (buf: string) => {
      const next = buf ? `${buf}\n${line}` : line;
      return Buffer.byteLength(next) > STDERR_TAIL * 2 ? tailUtf16(next, STDERR_TAIL) : next;
    };
    this.#stderrTail = add(this.#stderrTail);
    this.#runStderr = add(this.#runStderr);
  }

  stderrTail(): string {
    return tailUtf16(this.#stderrTail, STDERR_TAIL);
  }

  feed(line: Line, now: Now): Mapped {
    const out: Mapped = { events: [], replies: [] };
    const turnOutput = (line.type === "assistant" || line.type === "stream_event") && line.parent_tool_use_id === undefined;
    if (turnOutput && this.#openRuns.length === 0 && !this.#stopping) this.#woke(now, out.events);
    switch (line.type) {
      case "system":
        this.#system(line, now, out.events);
        break;
      case "assistant":
        this.#assistant(line, now, out.events);
        break;
      case "user":
        this.#user(line, now, out.events);
        break;
      case "stream_event":
        this.#streamEvent(line, now, out.events);
        break;
      case "result":
        this.#result(line, now, out.events);
        break;
      case "control_request":
        this.#controlRequest(line, now, out);
        break;
      case "control_response": {
        const body = line.response;
        const control = this.#controls.get(body.request_id);
        if (control) {
          this.#controls.delete(body.request_id);
          const answer = (body.response ?? null) as Record<string, unknown> | null;
          const ok = body.subtype === "success";
          if (control.stop) {
            const outcome = sendNowOutcome(ok, answer);
            if (outcome !== "stopped" && this.#interrupt === body.request_id) this.#interrupt = undefined;
            out.events.push({ SendNow: { run_id: control.runId, outcome, stopped_tool: outcome === "stopped" ? (control.stoppedTool ?? null) : null } });
          } else {
            out.events.push({ Withdrawn: { run_id: control.runId, cancelled: ok && answer?.cancelled === true, by_stop: control.byStop } });
          }
        }
        if (body.subtype !== "success") this.warn(`claude refused control request ${body.request_id}: ${body.error ?? ""}`);
        // An interrupt with no run to stop must not mark the next run's tool errors as cancellations.
        if (this.#interrupt === body.request_id && this.#activeRun === undefined) this.#interrupt = undefined;
        break;
      }
      case "control_cancel_request": {
        const p = this.#permissions.get(line.request_id);
        if (p) {
          this.#permissions.delete(line.request_id);
          this.#spans.withdrawn(line.request_id, now.ms);
          const kind: ItemKind = { type: "permission", requestId: line.request_id, toolName: p.toolName, summary: p.summary };
          out.events.push({ Item: this.#item(line.request_id, "cancelled", `${p.toolName} ${p.summary}`, now.at, now, kind) });
        }
        break;
      }
      case "rate_limit_event": {
        const info = line.rate_limit_info;
        const limit: RateLimit = { status: info.status, resets_at: info.resetsAt ?? null, limit_type: info.rateLimitType ?? null, utilization: info.utilization ?? null };
        this.#rateLimit = limit;
        out.events.push({ RateLimit: limit });
        break;
      }
      case "command_lifecycle":
        this.#lifecycle(line, now, out);
        break;
    }
    return out;
  }

  /** The process ended: every run still open ends here, then Exited. */
  exited(exit: ExitInfo, now: Now): RunnerEvent[] {
    const events: RunnerEvent[] = [];
    for (const runId of [...this.#openRuns]) {
      let outcome: RunOutcome;
      if (this.#stopping || this.#interrupt !== undefined) outcome = "Interrupted";
      else {
        const assistant = this.#assistantError;
        this.#assistantError = undefined;
        outcome = {
          Failed: this.#failure(
            evidence({
              assistantError: assistant?.error,
              apiErrorStatus: assistant?.status,
              text: assistant?.text ?? "",
              rateLimit: this.#rateLimit,
              exit,
              stderr: this.#runStderrTail(),
              nowMs: now.ms,
            }),
          ),
        };
      }
      this.#endRun(runId, outcome, undefined, [undefined, undefined], now, events);
    }
    events.push({ Exited: exit });
    return events;
  }

  #system(system: System, now: Now, events: RunnerEvent[]): void {
    switch (system.subtype) {
      case "init": {
        const missing = missingInitCapabilities(system.capabilities ?? []);
        this.#capabilities = system.capabilities ?? [];
        if (missing.length && !this.#warnedCapabilities) {
          this.#warnedCapabilities = true;
          this.warn(`claude's stream-json lacks ${JSON.stringify(missing)}; interrupts and queued sends may misbehave`);
        }
        events.push({
          Init: {
            version: system.claude_code_version ?? "",
            model: system.model ?? "",
            cwd: system.cwd ?? "",
            agent_tools: system.tools?.length ? system.tools.filter(agentLike) : null,
          },
        });
        break;
      }
      case "status": {
        if (system.status === "requesting" && system.user_message_uuids?.length) events.push({ Seen: { run_ids: system.user_message_uuids } });
        const compacting = system.status === "compacting";
        if (compacting !== this.#compacting) {
          this.#compacting = compacting;
          this.#spans.compacting(compacting, now.ms);
          events.push({ Compacting: compacting });
        }
        break;
      }
      // A Monitor's end (it exited, failed, was stopped or ran out its time); its events in between name no tool call
      // and no status.
      case "task_notification":
        if (["completed", "failed", "stopped", "killed"].includes(system.status ?? "") && system.tool_use_id !== undefined)
          events.push({ WatchEnded: { tool_use_id: system.tool_use_id } });
        break;
      case "compact_boundary": {
        this.#spans.compacting(false, now.ms);
        const meta = system.compact_metadata;
        const id = system.uuid ?? this.#mint("compact");
        const trigger = meta?.trigger ?? "auto";
        const kind: ItemKind = {
          type: "compaction",
          trigger,
          ...(meta?.pre_tokens !== undefined ? { preTokens: meta.pre_tokens } : {}),
          ...(meta?.post_tokens !== undefined ? { postTokens: meta.post_tokens } : {}),
        };
        events.push({ Item: this.#item(id, "completed", `Compacted the context (${trigger})`, now.at, now, kind) });
        break;
      }
      case "api_retry": {
        const id = system.uuid ?? this.#mint("retry");
        const attempt = system.attempt ?? 0;
        const maxRetries = system.max_retries ?? 0;
        const error = system.error ?? "";
        this.#spans.apiRetry(attempt, system.retry_delay_ms, system.error_status, now.ms);
        const status = system.error_status !== undefined ? ` (${system.error_status})` : "";
        const kind: ItemKind = {
          type: "api_retry",
          attempt,
          maxRetries,
          ...(system.error_status !== undefined ? { errorStatus: system.error_status } : {}),
          error,
          ...(system.retry_delay_ms !== undefined ? { retryDelayMs: system.retry_delay_ms } : {}),
        };
        events.push({ Item: this.#item(id, "completed", `claude retried the API call ${attempt}/${maxRetries}: ${error}${status}`, now.at, now, kind) });
        break;
      }
    }
  }

  #lifecycle(lifecycle: CommandLifecycle, now: Now, out: Mapped): void {
    const runId = lifecycle.command_uuid;
    const open = this.#openRuns.includes(runId);
    const state = lifecycle.state;
    if (state === "queued" && open) {
      if (this.#sendNow === runId) {
        this.#sendNow = undefined;
        out.replies.push(this.#stopRequest(runId, { message_uuid: runId, send_now: true, subtype: "interrupt" }));
      }
      out.events.push({ Queued: { run_id: runId } });
    } else if (state === "started" && this.#activeRun !== undefined && this.#activeRun !== runId && this.#openRuns.includes(this.#activeRun)) {
      // A `started` while another run's turn is still open: claude joined this message to that turn.
      remove(this.#steersWaiting, runId);
      if (!open) this.#openRuns.push(runId);
      this.#joined.push(runId);
      out.events.push({ Joined: { run_id: runId } });
    } else if ((state === "cancelled" || state === "completed") && this.#joined.includes(runId)) {
      // A joined run ends with its turn's `result`.
    } else if (state === "started") {
      this.#startRun(runId, now, out.events);
    } else if (state === "cancelled" && open && this.#withdrawing(runId)) {
      // claude says `cancelled` before it answers the withdraw: that is the withdraw's success. A steer that waited on
      // a stopped turn is dropped the same way.
      const byStop = this.#droppedByStop.includes(runId);
      for (const [id, c] of this.#controls) if (!c.stop && c.runId === runId) this.#controls.delete(id);
      remove(this.#droppedByStop, runId);
      out.events.push({ Withdrawn: { run_id: runId, cancelled: true, by_stop: byStop } });
      this.#endRun(runId, "Interrupted", undefined, [undefined, undefined], now, out.events);
    } else if ((state === "cancelled" || state === "completed") && open) {
      // After a `result` these are bookkeeping; without one the message never ran to a result.
      this.#endRun(runId, state === "cancelled" ? "Interrupted" : { Completed: { text: "" } }, undefined, [undefined, undefined], now, out.events);
    }
  }

  #startRun(runId: string, now: Now, events: RunnerEvent[]): void {
    remove(this.#steersWaiting, runId);
    if (!this.#openRuns.includes(runId)) this.#openRuns.push(runId);
    this.#activeRun = runId;
    this.#runStderr = "";
    this.#assistantError = undefined;
    this.#usageDone = emptyUsage();
    this.#usageNow = emptyUsage();
    this.#spans.runStarted(runId, now.ms);
    events.push({ RunStarted: { run_id: runId } });
  }

  /** claude writes a turn while no run of fleetd's is open: it started one by itself, for a background task's notice
   * (a Monitor's event after the agent's turn ended). It runs as a run of its own, under an id of the mapper's. */
  #woke(now: Now, events: RunnerEvent[]): void {
    const runId = this.#mint(`woke-${now.ms}`);
    this.#woken = runId;
    this.#startRun(runId, now, events);
  }

  #streamEvent(event: StreamEvent, now: Now, events: RunnerEvent[]): void {
    if (event.parent_tool_use_id !== undefined) return;
    const ev = event.event;
    this.#spans.stream(ev, now.ms);
    const type = typeof ev?.type === "string" ? ev.type : "";
    const index = typeof ev?.index === "number" && Number.isInteger(ev.index) && ev.index >= 0 ? (ev.index as number) : undefined;
    if (type === "message_start") {
      this.#streaming = typeof ev.message?.id === "string" ? ev.message.id : event.api_message_id;
      this.#streamTextBlocks.clear();
      this.#streamTextCount = 0;
      addUsage(this.#usageDone, this.#usageNow);
      this.#usageNow = emptyUsage();
      this.#streamUsage(ev.message?.usage, events);
    } else if (type === "message_delta") {
      this.#streamUsage(ev.usage, events);
    } else if (type === "content_block_start" && ev.content_block?.type === "text") {
      const message = this.#streaming ?? event.api_message_id;
      if (message !== undefined && index !== undefined) {
        this.#streamTextBlocks.set(index, textId(message, this.#streamTextCount));
        this.#streamTextCount++;
      }
    } else if (type === "content_block_delta" && ev.delta?.type === "text_delta") {
      const append = typeof ev.delta.text === "string" ? (ev.delta.text as string) : "";
      const messageId = (index !== undefined ? this.#streamTextBlocks.get(index) : undefined) ?? this.#streaming ?? event.api_message_id;
      if (messageId !== undefined && append) events.push({ Delta: { message_id: messageId, append } });
    }
  }

  /** Folds a streamed usage object into the current message's and reports the run's total so far. */
  #streamUsage(usage: unknown, events: RunnerEvent[]): void {
    if (usage === null || typeof usage !== "object" || Array.isArray(usage)) return;
    const u = usage as Record<string, unknown>;
    const n = (k: string) => (typeof u[k] === "number" && Number.isInteger(u[k]) && (u[k] as number) >= 0 ? (u[k] as number) : undefined);
    const now = this.#usageNow;
    now.inputTokens = n("input_tokens") ?? now.inputTokens;
    now.outputTokens = n("output_tokens") ?? now.outputTokens;
    now.cacheReadInputTokens = n("cache_read_input_tokens") ?? now.cacheReadInputTokens;
    now.cacheCreationInputTokens = n("cache_creation_input_tokens") ?? now.cacheCreationInputTokens;
    if (this.#activeRun === undefined) return;
    const total = { ...this.#usageDone };
    addUsage(total, now);
    events.push({ Usage: { run_id: this.#activeRun, usage: total } });
  }

  #assistant(assistant: Assistant, now: Now, events: RunnerEvent[]): void {
    if (assistant.parent_tool_use_id !== undefined) return;
    const message = assistant.message;
    if (assistant.error !== undefined) {
      // Not the model speaking: claude's own error text. It becomes the run's failure, not its reply, so the hub never
      // reads "Not logged in · Please run /login" as the agent's answer.
      this.#assistantError = { error: assistant.error, ...(assistant.api_error_status !== undefined ? { status: assistant.api_error_status } : {}), text: blockTexts(message.content) };
      return;
    }
    let thinkingBlocks = 0;
    for (const block of message.content) {
      if (block.type === "text") {
        let ordinal = 0;
        if (this.#textBlocks && this.#textBlocks[0] === message.id) ordinal = this.#textBlocks[1]++;
        else this.#textBlocks = [message.id, 1];
        events.push({ AssistantText: { message_id: textId(message.id, ordinal), text: block.text } });
      } else if (block.type === "tool_use") {
        this.#spans.toolUse(block.id, block.name, block.input, now.ms);
        const [kind, title] = toolKind(block.name, block.input);
        this.#tools.set(block.id, { ...(this.#activeRun !== undefined ? { runId: this.#activeRun } : {}), title, startedAt: now.at, kind });
        events.push({ Item: this.#item(block.id, "running", title, now.at, undefined, kind) });
      } else if (block.type === "thinking" && block.thinking.trim()) {
        // `--thinking-display summarized`: claude's summary of its reasoning, kept as a finished item so the app and
        // actions_list show what the agent weighed, and the watchdog sees progress during long thinking. Never
        // AssistantText: it is not the reply. Empty or redacted blocks carry nothing to show.
        thinkingBlocks++;
        const summary = block.thinking.trim();
        const kind: ItemKind = { type: "tool", toolName: "Thinking", input: null, output: summary, outputOmitted: false };
        events.push({ Item: this.#item(`${message.id}:thinking:${thinkingBlocks}`, "completed", `Thinking: ${headUtf16(firstLine(summary), THINKING_TITLE_MAX)}`, now.at, now, kind) });
      }
    }
  }

  #user(user: User, now: Now, events: RunnerEvent[]): void {
    if (user.parent_tool_use_id !== undefined || user.is_replay) return;
    if (typeof user.message.content === "string") return;
    for (const block of user.message.content) {
      if (block.type !== "tool_result") continue;
      const tool = this.#tools.get(block.tool_use_id);
      if (!tool) continue;
      this.#tools.delete(block.tool_use_id);
      const output = resultText(block.content);
      const status: ItemStatus = !block.is_error ? "completed" : this.#interrupt !== undefined ? "cancelled" : "failed";
      const spanStatus: SpanStatus = status === "completed" ? "ok" : status === "cancelled" ? "cancelled" : "failed";
      const exit = status === "completed" ? 0 : exitCode(output);
      this.#spans.toolResult(block.tool_use_id, output, spanStatus, tool.kind.type === "command" ? exit : undefined, user.tool_use_result, now.ms);
      let kind = tool.kind;
      if (kind.type === "command")
        kind = {
          type: "command",
          command: kind.command,
          ...(kind.timeoutMs !== undefined ? { timeoutMs: kind.timeoutMs } : {}),
          output,
          outputOmitted: false,
          ...(exit !== undefined ? { exitCode: exit } : {}),
        };
      else if (kind.type === "tool")
        kind = { type: "tool", toolName: kind.toolName, input: kind.input, output, outputOmitted: false, ...(kind.class ? { class: kind.class } : {}) };
      const item = this.#item(block.tool_use_id, status, tool.title, tool.startedAt, now, kind);
      setRun(item, tool.runId);
      events.push({ Item: item });
    }
  }

  #controlRequest(request: ControlRequest, now: Now, out: Mapped): void {
    const body = request.request;
    if (body.subtype !== "can_use_tool") {
      // Anything else claude asks would wait forever for an answer nobody sends.
      out.replies.push({ type: "control_response", response: { error: `fleetd does not handle ${body.subtype}`, request_id: request.request_id, subtype: "error" } });
      return;
    }
    const toolName = body.tool_name ?? "";
    const input = body.input ?? null;
    const summary = permissionSummary(toolName, input, body.description, body.blocked_path);
    this.#spans.permission(request.request_id, body.tool_use_id ?? "", toolName, now.ms);
    this.#permissions.set(request.request_id, { input, toolName, summary });
    out.events.push({ PermissionRequest: { request_id: request.request_id, tool_use_id: body.tool_use_id ?? "", tool_name: toolName, input, summary } });
  }

  #result(result: ResultLine, now: Now, events: RunnerEvent[]): void {
    // claude's own turn for a background task's notice (on a resume it runs before the message fleetd just sent) ends
    // no run of fleetd's: taking it for the waiting run ended that run before its turn began. It ends only the run it
    // woke in, if it wrote anything.
    if (result.user_message_uuid === undefined && result.origin !== undefined && (this.#woken === undefined || this.#woken !== this.#activeRun)) return;
    const joined = this.#joined;
    this.#joined = [];
    // A turn claude merged sends into names its last one: the turn is still the run that started it, and the others
    // end with it, each once.
    const named = result.user_message_uuid;
    const runId = (named !== undefined && !joined.includes(named) ? named : undefined) ?? this.#activeRun ?? named ?? this.#openRuns[0];
    if (runId === undefined) return;
    remove(joined, runId);
    const usage: RunUsage | undefined = result.usage && {
      inputTokens: result.usage.input_tokens,
      outputTokens: result.usage.output_tokens,
      cacheReadInputTokens: result.usage.cache_read_input_tokens,
      cacheCreationInputTokens: result.usage.cache_creation_input_tokens,
      ...(result.total_cost_usd !== undefined ? { costUsd: result.total_cost_usd } : {}),
    };
    const aborted = !!result.terminal_reason?.startsWith("aborted");
    const cut = aborted || (this.#interrupt !== undefined && result.subtype === "error_during_execution");
    const superseding = this.#steersWaiting.find((r) => r !== runId);
    let outcome: RunOutcome;
    if (cut && superseding !== undefined) outcome = { Superseded: { by: superseding } };
    else if (cut) outcome = "Interrupted";
    else if (!result.is_error && result.subtype === "success") outcome = { Completed: { text: result.result ?? "" } };
    else {
      const assistant = this.#assistantError;
      this.#assistantError = undefined;
      const text = (result.result ? result.result : undefined) ?? assistant?.text ?? result.errors?.join("\n") ?? "";
      outcome = {
        Failed: this.#failure(
          evidence({
            isError: result.is_error,
            assistantError: assistant?.error,
            apiErrorStatus: result.api_error_status ?? assistant?.status,
            text,
            terminalReason: result.terminal_reason,
            startupFailureReason: result.startup_failure_reason,
            rateLimit: this.#rateLimit,
            stderr: this.#runStderrTail(),
            nowMs: now.ms,
          }),
        ),
      };
    }
    this.#endRun(runId, outcome, usage, [result.duration_ms, result.duration_api_ms], now, events);
    for (const run of joined) this.#endRun(run, outcome, undefined, [undefined, undefined], now, events);
  }

  #endRun(runId: string, outcome: RunOutcome, usage: RunUsage | undefined, durations: [number | undefined, number | undefined], now: Now, events: RunnerEvent[]): void {
    // A tool call the run never finished (killed mid-tool) must not stay "running" forever.
    const cut = [...this.#tools].filter(([, t]) => t.runId === undefined || t.runId === runId).map(([id]) => id).sort();
    for (const id of cut) {
      const tool = this.#tools.get(id)!;
      this.#tools.delete(id);
      const item = this.#item(id, "cancelled", tool.title, tool.startedAt, now, tool.kind);
      setRun(item, runId);
      events.push({ Item: item });
    }
    if (this.#compacting) {
      this.#compacting = false;
      events.push({ Compacting: false });
    }
    if (typeof outcome === "object" && "Failed" in outcome) {
      const failure = outcome.Failed;
      const item = this.#item(`${runId}-error`, "failed", firstLine(failure.message), now.at, now, { type: "error", failure });
      setRun(item, runId);
      events.push({ Item: item });
    }
    const spanStatus: SpanStatus = outcome === "Interrupted" || "Superseded" in (outcome as object) ? "cancelled" : "Completed" in (outcome as object) ? "ok" : "failed";
    const spans = this.#spans.runEnded(runId, spanStatus, durations, now.ms);
    if (spans.length) events.push({ Spans: spans });
    remove(this.#openRuns, runId);
    remove(this.#steersWaiting, runId);
    remove(this.#droppedByStop, runId);
    remove(this.#joined, runId);
    if (this.#sendNow === runId) this.#sendNow = undefined;
    if (this.#activeRun === runId) this.#activeRun = undefined;
    if (this.#woken === runId) this.#woken = undefined;
    this.#interrupt = undefined;
    this.#assistantError = undefined;
    events.push({ RunEnded: { run_id: runId, outcome, usage: usage ?? null } });
  }

  /** The classified failure. The classifier puts claude's stderr for the run under its text. */
  #failure(e: FailureEvidence): RunFailure {
    return (
      this.classify(e) ?? {
        class: e.exit ? "process_exited" : "other",
        message: headUtf16(e.text.trim(), MESSAGE_MAX) || "claude ended the run with an error",
        ...(e.apiErrorStatus !== undefined ? { apiStatus: e.apiErrorStatus } : {}),
        retries: 0,
      }
    );
  }

  /** stderr since the active run started (since the process started, before any run). */
  #runStderrTail(): string {
    return tailUtf16(this.#runStderr, STDERR_TAIL);
  }

  #item(id: string, status: ItemStatus, title: string, startedAt: string, completed: Now | undefined, kind: ItemKind): ThreadItem {
    return {
      id: id || "item",
      ...(this.#activeRun ? { runId: this.#activeRun } : {}),
      status,
      title,
      startedAt,
      ...(completed ? { completedAt: completed.at } : {}),
      updatedAt: completed ? completed.at : startedAt,
      kind,
    };
  }

  #mint(what: string): string {
    this.#minted++;
    return `${this.sessionId}-${what}-${this.#minted}`;
  }
}

/** Sets an item's run, or leaves it without one for an empty id, as `NonEmpty::new` refuses it. */
function setRun(item: ThreadItem, runId: string | undefined): void {
  if (runId) item.runId = runId;
  else delete item.runId;
}

/** claude's answer to a stop: `send_now` (interrupt_send_now_v1) or `turn` (interrupt_receipt_v1); a plain interrupt
 * answers only success. */
function sendNowOutcome(ok: boolean, answer: Record<string, unknown> | null): SendNow {
  if (!ok) return "nothing_waiting";
  const sendNow = typeof answer?.send_now === "string" ? answer.send_now : undefined;
  const turn = typeof answer?.turn === "string" ? answer.turn : undefined;
  if (sendNow === "stopped" || (sendNow === undefined && (turn === "stopped" || turn === undefined))) return "stopped";
  if (sendNow === "delivering") return "delivering";
  return "nothing_waiting";
}

/** The id of a message's `ordinal`-th text block: the message id itself for the first. */
const textId = (messageId: string, ordinal: number) => (ordinal === 0 ? messageId : `${messageId}:${ordinal}`);

const blockTexts = (blocks: Block[]) => blocks.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("\n");

/** A tool_result's content: a string, or text blocks. */
function resultText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.flatMap((b) => (b !== null && typeof b === "object" && typeof b.text === "string" ? [b.text as string] : [])).join("\n");
  return "";
}

/** Bash reports a failing command as "Exit code N" on the result's first line. */
function exitCode(output: string): number | undefined {
  if (!output.startsWith("Exit code ")) return undefined;
  const word = output.slice("Exit code ".length).trimStart().split(/\s+/)[0] ?? "";
  return /^[+-]?\d+$/.test(word) ? Number(word) : undefined;
}

function strField(input: unknown, key: string): string | undefined {
  const v = input !== null && typeof input === "object" ? (input as Record<string, unknown>)[key] : undefined;
  return typeof v === "string" && v ? v : undefined;
}

function toolKind(name: string, input: unknown): [ItemKind, string] {
  switch (name) {
    case "Bash": {
      const command = strField(input, "command") ?? "";
      const timeout = input !== null && typeof input === "object" ? (input as Record<string, unknown>).timeout : undefined;
      const timeoutMs = typeof timeout === "number" && Number.isInteger(timeout) && timeout >= 0 ? timeout : undefined;
      return [{ type: "command", command, ...(timeoutMs !== undefined ? { timeoutMs } : {}), outputOmitted: false }, strField(input, "description") ?? command];
    }
    case "Edit":
    case "MultiEdit":
    case "Write":
    case "NotebookEdit": {
      const path = strField(input, "file_path") ?? strField(input, "notebook_path") ?? "";
      return [{ type: "file_change", toolName: name, path }, `${name} ${path}`];
    }
    default: {
      const cls = toolClass(name, input);
      return [{ type: "tool", toolName: name, input, outputOmitted: false, ...(cls ? { class: cls } : {}) }, name];
    }
  }
}

/** claude's tools in fleetd's words (ToolClass), so the hub and app never read a claude tool name. */
export function toolClass(name: string, input: unknown): ToolClass | undefined {
  const field = (...keys: string[]) => {
    for (const k of keys) {
      const v = strField(input, k);
      if (v !== undefined) return v;
    }
    return undefined;
  };
  const some = <T extends Record<string, unknown>>(o: T) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as T;
  switch (name) {
    case "Read":
    case "NotebookRead":
      return some({ type: "read" as const, path: field("file_path", "notebook_path", "path") });
    case "Grep":
    case "Glob":
      return some({ type: "search" as const, pattern: field("pattern") });
    case "WebFetch":
    case "WebSearch":
      return some({ type: "web" as const, url: field("url"), query: field("query") });
    case "TodoWrite":
      return { type: "plan" };
    default: {
      // `mcp__<server>__<tool>`, as claude names an MCP server's tools.
      if (!name.startsWith("mcp__")) return undefined;
      const rest = name.slice(5);
      const at = rest.indexOf("__");
      return at < 0 ? undefined : { type: "mcp", server: rest.slice(0, at), tool: rest.slice(at + 2) };
    }
  }
}

/** One line for a person deciding: the command, the path, or the tool's own description. */
function permissionSummary(toolName: string, input: unknown, description: string | undefined, blockedPath: string | undefined): string {
  const text = (toolName === "Bash" ? strField(input, "command") : (strField(input, "file_path") ?? strField(input, "notebook_path"))) ?? (description || undefined) ?? blockedPath ?? toolName;
  const first = headUtf16(firstLine(text), 1990);
  return first.length < text.trimEnd().length ? `${first} …` : first;
}

function addUsage(total: RunUsage, more: RunUsage): void {
  total.inputTokens += more.inputTokens;
  total.outputTokens += more.outputTokens;
  total.cacheReadInputTokens += more.cacheReadInputTokens;
  total.cacheCreationInputTokens += more.cacheCreationInputTokens;
}
