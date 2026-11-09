// Classifies a failed run from what claude said, structured fields first and text second.
// The text rules are the hub's limit ones (gateway texts and reset
// parsing included), here so the node decides once.
import { constants } from "node:os";
import type { FailureClass, RunFailure } from "../../../shared/sessions.ts";
import type { ExitInfo, RateLimit } from "./events.ts";

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

// The hub's limit rules, unchanged. CLIProxyAPI: a model no enabled credential offers, or every credential signed out.
const UNKNOWN_PROVIDER = /unknown provider for model\s+["']?([^\s"'\\,}]+)/i;
const NO_ACCOUNT = /no available account|no auth available|auth_unavailable/i;
// CLIProxyAPI: every credential for the model is cooling down; it says when in reset_seconds.
const COOLDOWN = /model_cooldown|are cooling down/i;
// The API's model_not_found, as claude shows it: "There's an issue with the selected model (x)."
const SELECTED_MODEL = /issue with the selected model \(([^)\s]+)\)/i;
// "All credentials for model claude-opus-5-5 are cooling down", in its JSON body or as claude shows it.
const COOLDOWN_MODEL = /credentials for model\s+["']?([^\s"'\\,}]+)["']?\s+are cooling down/i;
const RESET_SECONDS = /"reset_seconds"\s*:\s*(\d+)/;
const RATE = /rate[ _-]?limit|\[429\]|\b(?:api error|status|error)\W{0,3}429\b/i;
// claude 2.1.312 calls the 5-hour window the "5-hour limit" where it said "session limit".
const USAGE = /usage limit|hit your (?:(?:usage|5-hour|weekly|session|opus) )?limit|(?:5-hour|weekly|session|opus) limit reached|out of extra usage/i;
// The CLI's "Claude AI usage limit reached|<epoch seconds>".
const PIPE_EPOCH = /limit reached\|(\d{10})\b/i;
// A proxy's "(reset after 1h2m3s)".
const RESET_AFTER = /reset after (?:(\d+)h ?)?(?:(\d+)m ?)?(?:(\d+)s)?/i;
// The CLI's plan-limit suffix, "· resets 4pm (UTC)" or "resets 4:30am (Europe/Berlin)"; only read with a zone.
const RESETS_CLOCK = /\bresets\s+(?:at\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)\s*\(([^)]+)\)/i;
const OVERLOADED = /\boverloaded\b|\bapi error:? 5\d\d\b/i;
const NETWORK = /ECONNREFUSED|ECONNRESET|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|EPIPE|connection (?:refused|reset|error)|socket hang up|request timed out|network error/i;
const CONTEXT_FULL = /prompt is too long|context (?:window|length)|maximum context|exceeds? the model's context/i;

/** A limit the text rules found. */
export type TextLimit = {
  /** usage_limit, rate_limit or pool_exhausted. */
  class: FailureClass;
  /** Epoch ms to continue at; absent when the text says none and for pool_exhausted, which waits for a person. */
  resetMs?: number;
  /** The model a gateway named. */
  model?: string;
};

/** The model a gateway's "unknown provider for model X" names. */
export const gatewayModel = (text: string): string | undefined => UNKNOWN_PROVIDER.exec(text)?.[1];

/** A limit only the text names: RATE before USAGE. */
export function textLimit(text: string, atMs: number): TextLimit | undefined {
  const cls: FailureClass | undefined = RATE.test(text) ? "rate_limit" : USAGE.test(text) ? "usage_limit" : undefined;
  if (!cls) return undefined;
  return some<TextLimit>({ class: cls, resetMs: resetMs(text, undefined, atMs) });
}

export function gatewayLimit(text: string, atMs: number): TextLimit | undefined {
  const model = gatewayModel(text);
  if (model !== undefined) return { class: "pool_exhausted", model };
  if (NO_ACCOUNT.test(text)) return { class: "pool_exhausted" };
  // A cooldown with its reset_seconds is the account's quota; one without (claude shows only "All credentials for
  // model X are cooling down (last error: rate_limit_error …)") is the proxy resting its credentials after a 429,
  // usually for a minute or two.
  if (!COOLDOWN.test(text)) return undefined;
  const reset = resetMs(text, undefined, atMs);
  return some<TextLimit>({ class: reset !== undefined ? "usage_limit" : "rate_limit", resetMs: reset, model: COOLDOWN_MODEL.exec(text)?.[1] });
}

function some<T extends Record<string, unknown>>(o: T): T {
  for (const k of Object.keys(o)) if (o[k] === undefined) delete o[k];
  return o;
}

/** A reset further out than this is a garbled number, not a plan: cap it rather than park for years. */
const MAX_RESET_MS = 31 * 24 * 60 * 60_000;

/** The first reset that lies after `atMs`: the structured one, then the texts; undefined when none says, which the hub
 * answers by checking the login on a backoff rather than guessing an hour. Capped at MAX_RESET_MS out. */
function resetMs(text: string, structuredMs: number | undefined, atMs: number): number | undefined {
  const after = (ms: number | undefined) => (ms !== undefined && ms > atMs ? ms : undefined);
  const num = (m: RegExpExecArray, i: number) => (m[i] === undefined ? 0 : Number(m[i]));
  const pipe = PIPE_EPOCH.exec(text);
  const epoch = pipe ? num(pipe, 1) * 1000 : undefined;
  const sec = RESET_SECONDS.exec(text);
  const seconds = sec ? num(sec, 1) : undefined;
  const span = RESET_AFTER.exec(text);
  const spanMs = span ? (num(span, 1) * 3600 + num(span, 2) * 60 + num(span, 3)) * 1000 : 0;
  const reset =
    after(structuredMs) ??
    after(epoch) ??
    (seconds !== undefined && seconds > 0 ? atMs + seconds * 1000 : undefined) ??
    (spanMs > 0 ? atMs + spanMs : undefined) ??
    clockResetMs(text, atMs);
  // Huge numbers come out as large floats or Infinity here, where Rust saturates: the cap ends both the same.
  return reset === undefined || Number.isNaN(reset) ? undefined : Math.min(reset, atMs + MAX_RESET_MS);
}

/** The wall-clock date and time `ms` reads as in `tz`. */
function wall(tz: Intl.DateTimeFormat, ms: number): { y: number; mo: number; d: number; h: number; mi: number } {
  const parts = Object.fromEntries(tz.formatToParts(ms).map((p) => [p.type, p.value]));
  return { y: Number(parts.year), mo: Number(parts.month), d: Number(parts.day), h: Number(parts.hour) % 24, mi: Number(parts.minute) };
}

/** The instant `y-mo-d h:mi` names in `tz`, the earliest when it reads twice; undefined when the clock skips it. */
function instant(tz: Intl.DateTimeFormat, y: number, mo: number, d: number, h: number, mi: number): number | undefined {
  const naive = Date.UTC(y, mo - 1, d, h, mi);
  const offset = (at: number) => {
    const w = wall(tz, at);
    return Date.UTC(w.y, w.mo - 1, w.d, w.h, w.mi) - Math.floor(at / 60_000) * 60_000;
  };
  const found = [naive - offset(naive - 86_400_000), naive - offset(naive + 86_400_000), naive - offset(naive)].filter((at) => {
    const w = wall(tz, at);
    return w.y === y && w.mo === mo && w.d === d && w.h === h && w.mi === mi;
  });
  return found.length ? Math.min(...found) : undefined;
}

/** "resets 4pm (UTC)": the next such wall-clock time in that zone after `atMs`. */
export function clockResetMs(text: string, atMs: number): number | undefined {
  const c = RESETS_CLOCK.exec(text);
  if (!c) return undefined;
  const hour12 = Number(c[1]);
  if (!(hour12 >= 1 && hour12 <= 12)) return undefined;
  const minute = c[2] === undefined ? 0 : Number(c[2]);
  if (minute > 59) return undefined;
  const hour = (hour12 % 12) + (c[3]!.toLowerCase() === "pm" ? 12 : 0);
  let tz: Intl.DateTimeFormat;
  try {
    tz = new Intl.DateTimeFormat("en-US", { timeZone: c[4]!.trim(), hourCycle: "h23", year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric" });
  } catch {
    return undefined;
  }
  const today = wall(tz, atMs);
  for (let day = 0; day < 2; day++) {
    const date = new Date(Date.UTC(today.y, today.mo - 1, today.d + day));
    const at = instant(tz, date.getUTCFullYear(), date.getUTCMonth() + 1, date.getUTCDate(), hour, minute);
    if (at === undefined) return undefined;
    if (at > atMs) return at;
  }
  return undefined;
}

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
    // a bad model name, which neither claude nor the gateway knows.
    if (limit.model !== undefined && stderr.includes(UNRECOGNIZED_MODEL)) return ["invalid_request", undefined];
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
