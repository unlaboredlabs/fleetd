// claude's stream-json lines, decoded to the fields fleetd reads.
// Unknown fields are ignored and unknown line types decode to `other`, so a newer claude adds without breaking us; a
// field fleetd reads with the wrong type fails the whole line, as serde does, and the line then counts as stderr.

export type System = {
  type: "system";
  subtype: string;
  session_id?: string;
  /** The line's own id; fleetd uses it as the item id of compactions and retries. */
  uuid?: string;
  claude_code_version?: string;
  model?: string;
  cwd?: string;
  capabilities?: string[];
  /** Tool names the session offers (claude's own and `mcp__<server>__<tool>`). */
  tools?: string[];
  status?: string;
  /** `requesting`: the user messages this model request carries. */
  user_message_uuids?: string[];
  compact_result?: string;
  compact_metadata?: { trigger: string; pre_tokens?: number; post_tokens?: number };
  attempt?: number;
  max_retries?: number;
  retry_delay_ms?: number;
  error_status?: number;
  error?: string;
  /** task_started, task_notification: the tool call whose background job (a Monitor) it is. */
  tool_use_id?: string;
};

export type Block =
  | { type: "text"; text: string }
  | { type: "thinking"; thinking: string }
  | { type: "tool_use"; id: string; name: string; input: unknown }
  | { type: "tool_result"; tool_use_id: string; content: unknown; is_error: boolean }
  | { type: "other" };

export type Assistant = {
  type: "assistant";
  message: { id: string; model?: string; content: Block[] };
  parent_tool_use_id?: string;
  /** Set on synthetic error messages: authentication_failed, rate_limit, overloaded, server_error, unknown, …. */
  error?: string;
  api_error_status?: number;
};

export type User = {
  type: "user";
  message: { content: string | Block[] };
  parent_tool_use_id?: string;
  /** The tool's structured output (Bash: stdout, stderr, interrupted), or an error string. */
  tool_use_result?: unknown;
  is_replay: boolean;
};

/** `--include-partial-messages`: one Messages API streaming event. */
export type StreamEvent = { type: "stream_event"; event: any; parent_tool_use_id?: string; api_message_id?: string };

export type Usage = { input_tokens: number; output_tokens: number; cache_read_input_tokens: number; cache_creation_input_tokens: number };

export type ResultLine = {
  type: "result";
  /** success (also for API errors, with is_error) or error_during_execution, error_max_turns, …. */
  subtype: string;
  is_error: boolean;
  result?: string;
  terminal_reason?: string;
  api_error_status?: number;
  errors?: string[];
  /** Why claude refused to start the turn (gateway sign-in, org pin, …). */
  startup_failure_reason?: string;
  usage?: Usage;
  total_cost_usd?: number;
  user_message_uuid?: string;
  duration_ms?: number;
  duration_api_ms?: number;
  user_message_uuids?: string[];
  /** What started the turn when no user message did, such as `{"kind": "task-notification"}`. */
  origin?: unknown;
};

/** claude -> fleetd. Only `can_use_tool` is expected; any other subtype gets an error response. */
export type ControlRequest = {
  type: "control_request";
  request_id: string;
  request: {
    subtype: string;
    tool_name?: string;
    input?: unknown;
    tool_use_id?: string;
    description?: string;
    blocked_path?: string;
    decision_reason?: string;
  };
};

/** The answer to one of fleetd's own control requests (interrupt, withdraw). */
export type ControlResponse = {
  type: "control_response";
  response: { subtype: string; request_id: string; response?: unknown; error?: string };
};

export type ControlCancel = { type: "control_cancel_request"; request_id: string };

export type RateLimitEvent = {
  type: "rate_limit_event";
  rate_limit_info: { status: string; resetsAt?: number; rateLimitType?: string; utilization?: number };
};

/** One user message's lifecycle: queued, started, completed, cancelled. */
export type CommandLifecycle = { type: "command_lifecycle"; command_uuid: string; state: string };

/** One stdout line. */
export type Line = System | Assistant | User | StreamEvent | ResultLine | ControlRequest | ControlResponse | ControlCancel | RateLimitEvent | CommandLifecycle | { type: "other" };

/** stdin lines fleetd writes. */
export type Input =
  | {
      type: "user";
      message: { role: "user"; content: string };
      parent_tool_use_id: null;
      session_id: string;
      uuid: string;
      /** `now`: the running turn ends at its next tool boundary and this message gets its own turn. Absent = `next`. */
      priority?: "now";
    }
  | { type: "control_request"; request_id: string; request: Record<string, unknown> }
  | { type: "control_response"; response: Record<string, unknown> };

class Bad extends Error {}
const bad = (): never => {
  throw new Bad();
};
const obj = (v: unknown): Record<string, any> => (v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, any>) : bad());
const str = (v: unknown): string => (typeof v === "string" ? v : bad());
const bool = (v: unknown): boolean => (typeof v === "boolean" ? v : bad());
const uint = (v: unknown, max = Number.MAX_SAFE_INTEGER): number => (typeof v === "number" && Number.isInteger(v) && v >= 0 && v <= max ? v : bad());
const int = (v: unknown): number => (typeof v === "number" && Number.isInteger(v) ? v : bad());
const num = (v: unknown): number => (typeof v === "number" ? v : bad());
const strs = (v: unknown): string[] => (Array.isArray(v) ? v.map(str) : bad());
/** serde's Option: absent and null are both none. */
const opt = <T>(v: unknown, f: (v: unknown) => T): T | undefined => (v === undefined || v === null ? undefined : f(v));
const U16 = 65_535;
const U32 = 4_294_967_295;

/** Drops the keys whose value is undefined, so a decoded line reads as serde's (`"x" in line` means it was set). */
function some<T extends Record<string, unknown>>(o: T): T {
  for (const k of Object.keys(o)) if (o[k] === undefined) delete o[k];
  return o;
}

function block(v: unknown): Block {
  const b = obj(v);
  switch (str(b.type)) {
    case "text":
      return { type: "text", text: str(b.text) };
    case "thinking":
      return { type: "thinking", thinking: b.thinking === undefined ? "" : str(b.thinking) };
    case "tool_use":
      return { type: "tool_use", id: str(b.id), name: str(b.name), input: "input" in b ? b.input : bad() };
    case "tool_result":
      return { type: "tool_result", tool_use_id: str(b.tool_use_id), content: b.content ?? null, is_error: b.is_error === undefined ? false : bool(b.is_error) };
    default:
      return { type: "other" };
  }
}

function decodeValue(v: unknown): Line {
  const m = obj(v);
  switch (str(m.type)) {
    case "system": {
      const meta = opt(m.compact_metadata, (c) => {
        const o = obj(c);
        return some({ trigger: str(o.trigger), pre_tokens: opt(o.pre_tokens, uint), post_tokens: opt(o.post_tokens, uint) });
      });
      return some({
        type: "system",
        subtype: str(m.subtype),
        session_id: opt(m.session_id, str),
        uuid: opt(m.uuid, str),
        claude_code_version: opt(m.claude_code_version, str),
        model: opt(m.model, str),
        cwd: opt(m.cwd, str),
        capabilities: opt(m.capabilities, strs),
        tools: opt(m.tools, strs),
        status: opt(m.status, str),
        user_message_uuids: opt(m.user_message_uuids, strs),
        compact_result: opt(m.compact_result, str),
        compact_metadata: meta,
        attempt: opt(m.attempt, (n) => uint(n, U32)),
        max_retries: opt(m.max_retries, (n) => uint(n, U32)),
        retry_delay_ms: opt(m.retry_delay_ms, uint),
        error_status: opt(m.error_status, (n) => uint(n, U16)),
        error: opt(m.error, str),
        tool_use_id: opt(m.tool_use_id, str),
      });
    }
    case "assistant": {
      const message = obj(m.message);
      return some({
        type: "assistant",
        message: some({ id: str(message.id), model: opt(message.model, str), content: Array.isArray(message.content) ? message.content.map(block) : bad() }),
        parent_tool_use_id: opt(m.parent_tool_use_id, str),
        error: opt(m.error, str),
        api_error_status: opt(m.api_error_status, (n) => uint(n, U16)),
      });
    }
    case "user": {
      const message = obj(m.message);
      const content = typeof message.content === "string" ? message.content : Array.isArray(message.content) ? message.content.map(block) : bad();
      return some({
        type: "user",
        message: { content },
        parent_tool_use_id: opt(m.parent_tool_use_id, str),
        tool_use_result: opt(m.tool_use_result, (x) => x),
        is_replay: m.isReplay === undefined ? false : bool(m.isReplay),
      });
    }
    case "stream_event":
      return some({
        type: "stream_event",
        event: "event" in m ? m.event : bad(),
        parent_tool_use_id: opt(m.parent_tool_use_id, str),
        api_message_id: opt(m.api_message_id, str),
      });
    case "result": {
      const usage = opt(m.usage, (u) => {
        const o = obj(u);
        const n = (x: unknown) => (x === undefined ? 0 : uint(x));
        return {
          input_tokens: n(o.input_tokens),
          output_tokens: n(o.output_tokens),
          cache_read_input_tokens: n(o.cache_read_input_tokens),
          cache_creation_input_tokens: n(o.cache_creation_input_tokens),
        };
      });
      return some({
        type: "result",
        subtype: str(m.subtype),
        is_error: bool(m.is_error),
        result: opt(m.result, str),
        terminal_reason: opt(m.terminal_reason, str),
        api_error_status: opt(m.api_error_status, (n) => uint(n, U16)),
        errors: opt(m.errors, strs),
        startup_failure_reason: opt(m.startup_failure_reason, str),
        usage,
        total_cost_usd: opt(m.total_cost_usd, num),
        user_message_uuid: opt(m.user_message_uuid, str),
        duration_ms: opt(m.duration_ms, uint),
        duration_api_ms: opt(m.duration_api_ms, uint),
        user_message_uuids: opt(m.user_message_uuids, strs),
        origin: opt(m.origin, (x) => x),
      });
    }
    case "control_request": {
      const r = obj(m.request);
      return {
        type: "control_request",
        request_id: str(m.request_id),
        request: some({
          subtype: str(r.subtype),
          tool_name: opt(r.tool_name, str),
          input: opt(r.input, (x) => x),
          tool_use_id: opt(r.tool_use_id, str),
          description: opt(r.description, str),
          blocked_path: opt(r.blocked_path, str),
          decision_reason: opt(r.decision_reason, str),
        }),
      };
    }
    case "control_response": {
      const r = obj(m.response);
      return {
        type: "control_response",
        response: some({ subtype: str(r.subtype), request_id: str(r.request_id), response: opt(r.response, (x) => x), error: opt(r.error, str) }),
      };
    }
    case "control_cancel_request":
      return { type: "control_cancel_request", request_id: str(m.request_id) };
    case "rate_limit_event": {
      const i = obj(m.rate_limit_info);
      return {
        type: "rate_limit_event",
        rate_limit_info: some({ status: str(i.status), resetsAt: opt(i.resetsAt, int), rateLimitType: opt(i.rateLimitType, str), utilization: opt(i.utilization, num) }),
      };
    }
    case "command_lifecycle":
      return { type: "command_lifecycle", command_uuid: str(m.command_uuid), state: str(m.state) };
    default:
      return { type: "other" };
  }
}

/** A parsed stdout line as fleetd reads it; undefined when it isn't one (a field fleetd reads has the wrong type). */
export function decode(value: unknown): Line | undefined {
  try {
    return decodeValue(value);
  } catch (error) {
    if (error instanceof Bad) return undefined;
    throw error;
  }
}

/** One raw stdout line; undefined when it isn't stream-json (a warning printed to stdout). */
export function decodeLine(line: string): Line | undefined {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    return undefined;
  }
  return decode(value);
}
