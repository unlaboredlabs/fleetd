// What a call to another hub's link comes to, without the network (client.ts makes the calls): its answer read, the
// failures, the words for a hub out of reach or a link that no longer works, and the retry waits.
import { ToolError } from "../../shared/errors.ts";

/** How long a feed read waits past the other hub's own wait. */
export const FEED_MARGIN_MS = 10_000;

/** The most a call there reads back. */
export const BODY_MAX = 1024 * 1024;

/** What one call there came to, when not an answer. */
export type Failure =
  | { kind: "unreachable"; why: string }
  /** It refused the key: the link is dead. */
  | { kind: "dead"; error: ToolError }
  /** It refused this request. */
  | { kind: "refused"; error: ToolError };

export class CallFailed extends Error {
  constructor(readonly failure: Failure) {
    super(failure.kind === "unreachable" ? failure.why : failure.error.message);
  }
}

export function reason(error: unknown): string {
  const e = error as { name?: string; code?: string };
  if (e.name === "TimeoutError" || e.name === "AbortError") return "it didn't answer in time";
  if (e.code === "ConnectionRefused" || e.code === "ECONNREFUSED" || e.code === "ConnectionClosed" || e.code === "FailedToOpenSocket") {
    return "the connection failed";
  }
  return "the request failed";
}

export const toolError = (v: { code?: unknown; message?: unknown; fix?: unknown }) =>
  new ToolError(v.code as never, String(v.message ?? ""), typeof v.fix === "string" ? v.fix : undefined);

/** What a call's answer says: its JSON when it is fleetd's and ok, else the CallFailed it comes to. */
export function readAnswer<T>(response: { status: number; statusText: string; ok: boolean }, bytes: Uint8Array): T {
  if (bytes.length > BODY_MAX) throw new CallFailed({ kind: "unreachable", why: `it answered with more than ${BODY_MAX} bytes` });
  const status = `${response.status} ${response.statusText}`.trim();
  let body: unknown;
  try {
    body = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    body = undefined;
  }
  if (response.ok) {
    if (body === undefined) throw new CallFailed({ kind: "unreachable", why: `it answered ${status} with something that isn't fleetd's` });
    return body as T;
  }
  const refusal = body as { code?: unknown; message?: unknown; dead?: unknown } | undefined;
  if (!refusal || typeof refusal.code !== "string" || typeof refusal.message !== "string") {
    throw new CallFailed({
      kind: "unreachable",
      why:
        `it answered ${status} without fleetd's own words (a proxy in the way, or no fleetd hub of this ` +
        "version or newer at that URL)",
    });
  }
  // Only the hub's own word that the key is dead for good revokes the link here; any other 401 is a refusal.
  throw new CallFailed(
    response.status === 401 && refusal.dead === true
      ? { kind: "dead", error: toolError(refusal) }
      : { kind: "refused", error: toolError(refusal) },
  );
}

/** The plain words for a hub this one can't reach, for the project and the app alike. */
export const unreachable = (label: string, url: string, why: string) =>
  new ToolError(
    "failed",
    `Can't reach ${label} at ${url}: ${why}.`,
    `A hub link needs ${label}'s hub reachable from this hub, over a tailnet or HTTPS. Check it is up and its URL ` +
      "in the project's Linked hubs; nothing was sent.",
  );

export const noLongerWorks = (label: string, message: string) =>
  new ToolError(
    "forbidden",
    `The link to ${label} no longer works: ${message}`,
    `Ask the person to make a new link on ${label} and add it in the project's Linked hubs.`,
  );

/** The wait before calling a hub again after failed read `attempt` (0 first) in a row, `jitter` in 0.8..1.2. */
export const retryDelayMs = (attempt: number, jitter: number) =>
  Math.round(Math.min(30_000, 1000 * 2 ** Math.min(attempt, 16)) * jitter);

/** The failed reads in a row once one more, which took `tookMs`, failed: one that failed after waiting starts again. */
export const failedReads = (before: number, tookMs: number) => (tookMs >= FEED_MARGIN_MS ? 1 : before + 1);
