// The text rules for a usage, rate or pool limit in claude's or a gateway's words, and the reset they name. Pure: the
// node classes a failed run with them (node/runner/host/failure.ts), and the hub reads a task's recorded error with
// them (hub/reviews/endings.ts).
import type { FailureClass } from "./sessions.ts";

// CLIProxyAPI: a model no enabled credential offers, or every credential signed out.
const UNKNOWN_PROVIDER = /unknown provider for model\s+["']?([^\s"'\\,}]+)/i;
const NO_ACCOUNT = /no available account|no auth available|auth_unavailable/i;
// CLIProxyAPI: every credential for the model is cooling down; it says when in reset_seconds.
export const COOLDOWN = /model_cooldown|are cooling down/i;
// "All credentials for model claude-opus-5-5 are cooling down", in its JSON body or as claude shows it.
export const COOLDOWN_MODEL = /credentials for model\s+["']?([^\s"'\\,}]+)["']?\s+are cooling down/i;
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
  // model X are cooling down (last error: rate_limit_error …)", now and then with "(reset after 4m15s)") is the proxy
  // resting its credentials after a 429, usually for a few minutes: a rate limit, until the reset when it names one.
  if (!COOLDOWN.test(text)) return undefined;
  const reset = resetMs(text, undefined, atMs);
  const quota = RESET_SECONDS.test(text) && reset !== undefined;
  return some<TextLimit>({ class: quota ? "usage_limit" : "rate_limit", resetMs: reset, model: COOLDOWN_MODEL.exec(text)?.[1] });
}

export function some<T extends Record<string, unknown>>(o: T): T {
  for (const k of Object.keys(o)) if (o[k] === undefined) delete o[k];
  return o;
}

/** A reset further out than this is a garbled number, not a plan: cap it rather than park for years. */
const MAX_RESET_MS = 31 * 24 * 60 * 60_000;

/** The first reset that lies after `atMs`: the structured one, then the texts; undefined when none says, which the hub
 * answers by checking the login on a backoff rather than guessing an hour. Capped at MAX_RESET_MS out. */
export function resetMs(text: string, structuredMs: number | undefined, atMs: number): number | undefined {
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
