// Classifies a failed run from what claude said, structured fields first and text second.
// The limit text rules (gateway texts and reset parsing included) are shared/limit_text.ts, so the node decides once.
import { constants } from "node:os";
import { COOLDOWN, COOLDOWN_MODEL, gatewayLimit, gatewayModel, resetMs, some, textLimit } from "../../../shared/limit_text.ts";
import type { FailureClass, RunFailure } from "../../../shared/sessions.ts";
import type { ExitInfo, RateLimit } from "./events.ts";

export { clockResetMs, gatewayLimit, gatewayModel, textLimit, type TextLimit } from "../../../shared/limit_text.ts";

/** What claude left behind for one failed run. */
export type FailureEvidence = {
  /** The result's `is_error`. */
  isError: boolean;
  /** The synthetic assistant message's `error`: authentication_failed, rate_limit, overloaded, server_error, …. */
  assistantError?: string;
  apiErrorStatus?: number;
  /** The result text, else the assistant error text, else the result's `errors` joined. */
  text: string;
  terminalReason?: string;
  /** The result's `startup_failure_reason` (claude refused to start the turn: org pin, gateway sign-in, …). */
  startupFailureReason?: string;
  /** The latest `rate_limit_event` of the session. */
  rateLimit?: RateLimit;
  /** Set when the process ended without a result. */
  exit?: ExitInfo;
  /** The tail of claude's stderr so far; when empty, `exit`'s tail is used. */
  stderr: string;
  /** Epoch ms, for relative resets ("reset after 1h2m"). */
  nowMs: number;
};

export const evidence = (e: Partial<FailureEvidence>): FailureEvidence => ({ isError: false, text: "", stderr: "", nowMs: 0, ...e });

const MESSAGE_MAX = 4000;
const STDERR_MARK = "\n--- stderr tail ---\n";

/** The Agent SDK's `USAGE_LIMIT_ERROR_PREFIXES` (0.3.302): the texts claude starts a plan-limit error with. */
export const USAGE_LIMIT_ERROR_PREFIXES = [
  "You've hit your",
  "You've reached your",
  "You're out of usage credits",
  "Your org is out of usage · add funds to continue",
  "Your org is out of usage · contact your admin",
  "Your seat type doesn't include usage credits",
  "Your seat type doesn't include usage",
  "Your usage allocation has been disabled by your admin",
  "Your group's usage limit is set to $0",
  "Fable 5 requires usage credits",
  "You're out of extra usage",
  "Your seat type doesn't include extra usage",
];

/** `SDKAssistantMessageError`s that only a person signing in again can fix. */
const AUTH_ERRORS = ["authentication_failed", "oauth_org_not_allowed", "verification_required", "cloud_credential_error"];

/** claude's own stderr tag for a model name it doesn't know. */
const UNRECOGNIZED_MODEL = "[claude-code:unrecognized_model]";

// The API's model_not_found, as claude shows it: "There's an issue with the selected model (x)."
const SELECTED_MODEL = /issue with the selected model \(([^)\s]+)\)/i;
const OVERLOADED = /\boverloaded\b|\bapi error:? 5\d\d\b/i;
const NETWORK = /ECONNREFUSED|ECONNRESET|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|EPIPE|connection (?:refused|reset|error)|socket hang up|request timed out|network error/i;
const CONTEXT_FULL = /prompt is too long|context (?:window|length)|maximum context|exceeds? the model's context/i;

/** Undefined when the evidence shows no failure: a clean result, or an interrupt (`aborted_*`), which the runner
 * reports as Interrupted. */
export function classify(e: FailureEvidence): RunFailure | undefined {
  if (e.terminalReason?.startsWith("aborted")) return undefined;
  const failed = e.isError || e.assistantError !== undefined || e.startupFailureReason !== undefined || e.exit !== undefined;
  if (!failed) return undefined;
  const stderr = e.exit && !e.stderr ? e.exit.stderr_tail : e.stderr;
  const [cls, reset] = decide(e, stderr);
  const message = loudMessage(e.text, stderr, e.exit);
  const model = cls === "invalid_request" ? refusedModel(e, stderr) : gatewayModelOf(cls, message);
  return some({
    class: cls,
    message,
    apiStatus: e.apiErrorStatus,
    resetAt: reset === undefined ? undefined : timestamp(reset),
    retries: 0,
    model,
  });
}

/** The model an invalid request was refused for, and only then: the API's `model_not_found`, or a gateway's "unknown
 * provider for model x" that claude also tags as unknown. */
function refusedModel(e: FailureEvidence, stderr: string): string | undefined {
  if (e.assistantError === "model_not_found") return SELECTED_MODEL.exec(e.text)?.[1];
  return stderr.includes(UNRECOGNIZED_MODEL) ? gatewayModel(e.text) : undefined;
}

/** The model a gateway named in the failure: the one it has no account for, or the one whose credentials cool down. */
function gatewayModelOf(cls: FailureClass, message: string): string | undefined {
  if (cls === "pool_exhausted") return gatewayModel(message);
  if ((cls === "usage_limit" || cls === "rate_limit") && COOLDOWN.test(message)) return COOLDOWN_MODEL.exec(message)?.[1];
  return undefined;
}

function decide(e: FailureEvidence, stderr: string): [FailureClass, number | undefined] {
  const now = e.nowMs;
  const error = e.assistantError;
  const status = e.apiErrorStatus;
  const reason = e.terminalReason;
  const text = e.text;
  if (e.startupFailureReason !== undefined) return [startupClass(e.startupFailureReason), undefined];
  if (error === "model_not_found") return ["invalid_request", undefined];
  const limit = gatewayLimit(text, now);
  if (limit) {
    // claude tags every model name it doesn't know, gateway aliases and models newer than the pin included, so the
    // tag alone decides nothing. It only turns the gateway's "unknown provider for model X" from a drained pool into
    // a bad model name, which neither claude nor the gateway knows; a cooldown naming its model stays a limit.
    if (limit.class === "pool_exhausted" && limit.model !== undefined && stderr.includes(UNRECOGNIZED_MODEL)) return ["invalid_request", undefined];
    return [limit.class, limit.resetMs];
  }
  if ((error !== undefined && AUTH_ERRORS.includes(error)) || status === 401) return ["auth", undefined];
  const limited = error === "rate_limit" || status === 429;
  if (e.rateLimit?.status === "rejected" && (limited || reason === "blocking_limit")) {
    const at = e.rateLimit.resets_at;
    return ["usage_limit", resetMs(text, at === null || at === undefined ? undefined : at * 1000, now)];
  }
  const planText = USAGE_LIMIT_ERROR_PREFIXES.some((p) => text.trimStart().startsWith(p));
  if (reason === "blocking_limit" || (error === "rate_limit" && planText)) return ["usage_limit", resetMs(text, undefined, now)];
  const found = textLimit(text, now);
  if (found) return [found.class, found.resetMs];
  if (limited || reason === "rapid_refill_breaker") return ["rate_limit", resetMs(text, undefined, now)];
  const server = error === "overloaded" || error === "server_error";
  if (error === "overloaded" || (status !== undefined && status >= 500 && status < 600) || OVERLOADED.test(text)) return ["overloaded", undefined];
  if ((server && status === undefined) || NETWORK.test(text)) return ["network", undefined];
  if (
    error === "invalid_request" ||
    reason === "prompt_too_long" ||
    reason === "image_error" ||
    CONTEXT_FULL.test(text) ||
    (status !== undefined && status >= 400 && status < 500)
  )
    return ["invalid_request", undefined];
  if (e.exit && error === undefined && !e.isError) return ["process_exited", undefined];
  // billing_error, account_on_hold, max_output_tokens, max turns or budget, model_error, …: no retry.
  return ["other", undefined];
}

/** `startup_failure_reason`s: a sign-in or org refusal needs a person, a "retrying may succeed" one is transient,
 * everything else is a setup problem that won't fix itself. */
function startupClass(reason: string): FailureClass {
  switch (reason) {
    case "org_pin_api_key_conflict":
    case "org_verify_failed":
    case "org_pin_mismatch":
    case "gateway_signin_required":
    case "gateway_access_denied":
    case "org_config_refused":
      return "auth";
    case "org_config_required_unavailable":
    case "remote_settings_required_unavailable":
    case "worktree_unverified":
      return "network";
    default:
      return "invalid_request";
  }
}

/** A run that ran out of context, from a recorded failure's message. */
export const contextFullText = (message: string) => CONTEXT_FULL.test(message);

/** A signal's name ("SIGKILL"), as nix prints it; `signal N` for one it doesn't know. */
export function signalName(sig: number): string {
  for (const [name, n] of Object.entries(constants.signals)) if (n === sig) return name;
  return `signal ${sig}`;
}

/** claude's own words first, then how the process ended, then the tail of its stderr; at most 4000 UTF-16 units. */
export function loudMessage(text: string, stderr: string, exit: ExitInfo | undefined): string {
  let head = text.trim();
  if (exit) {
    const how =
      exit.signal !== null
        ? `claude was killed by ${signalName(exit.signal)} before the run finished`
        : exit.code !== null
          ? `claude exited with code ${exit.code} before the run finished`
          : "claude exited before the run finished";
    head = head ? `${head}\n${how}` : how;
  }
  if (!head) head = "claude reported an error without any text";
  const tail = stderr.trim();
  let message: string;
  if (!tail) message = headUnits(head, MESSAGE_MAX);
  else {
    const h = headUnits(head, MESSAGE_MAX / 2);
    message = `${h}${STDERR_MARK}${tailUnits(tail, MESSAGE_MAX - h.length - STDERR_MARK.length)}`;
  }
  return message || "?";
}

/** The start of `s` within `max` UTF-16 units, never splitting a character. */
export function headUnits(s: string, max: number): string {
  if (s.length <= max) return s;
  const end = s.charCodeAt(max - 1) >= 0xd800 && s.charCodeAt(max - 1) <= 0xdbff ? max - 1 : max;
  return s.slice(0, end);
}

/** The end of `s` within `max` UTF-16 units, never splitting a character. */
export function tailUnits(s: string, max: number): string {
  if (s.length <= max) return s;
  let at = s.length - max;
  if (s.charCodeAt(at) >= 0xdc00 && s.charCodeAt(at) <= 0xdfff) at++;
  return s.slice(at);
}

/** RFC 3339 with milliseconds and `Z`, as chrono's `to_rfc3339_opts(Millis, true)`. */
export const timestamp = (ms: number) => new Date(ms).toISOString();
