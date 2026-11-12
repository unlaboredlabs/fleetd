// How a reviewer that ended without a verdict ended, by its recorded result. Pure, and in the package
// (`./hub/reviews/endings`), so every train that gates on reviews counts these the same.
import { gatewayLimit, textLimit } from "../../shared/limit_text.ts";

/** A task's error line in its result, as the hub writes it when the task ends: `[<failure class>] <message>`. */
const ERROR_LINE = /^\[([a-z_]+)\] (.+)$/gm;
const LIMITS = ["usage_limit", "rate_limit", "pool_exhausted"];
/** The classes a limit was taken for before the node knew its words (2026-11-12's 429 cooldowns were `invalid_request`). */
const MISREAD = ["invalid_request", "other"];

/** A reviewer stopped by a usage, rate or pool limit; `resetMs` when its words name the reset. */
export type LimitStop = { resetMs?: number };

/**
 * Whether the reviewer ended on a usage, rate or pool limit, from its result's error line: such a reviewer never
 * counts as one that ended without a verdict, and the next starts once the limit has reset. Undefined for any other
 * end. `atMs` is when it ended, which a relative reset ("reset after 4m15s") counts from.
 */
export function limitStop(resultTail: string, atMs: number): LimitStop | undefined {
  for (const [, cls, message] of resultTail.matchAll(ERROR_LINE)) {
    if (LIMITS.includes(cls!)) return stop(textOf(message!, atMs));
    if (!MISREAD.includes(cls!)) continue;
    // A gateway's "unknown provider for model x" that claude refused is a bad model name, not a drained pool.
    const found = textOf(message!, atMs);
    if (found && found.class !== "pool_exhausted") return stop(found);
  }
  return undefined;
}

const textOf = (message: string, atMs: number) => gatewayLimit(message, atMs) ?? textLimit(message, atMs);

const stop = (found: { resetMs?: number } | undefined): LimitStop => (found?.resetMs !== undefined ? { resetMs: found.resetMs } : {});
