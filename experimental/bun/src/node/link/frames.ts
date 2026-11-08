// A hub frame that doesn't decode (a newer hub's request, no JSON object): a live link refuses that frame alone, logs
// it by its tag, id, size and why (never its payload), answers it when it was a request, and keeps the link (Rust's
// link_frames). One bad frame closing the whole link blipped every agent's stream on the machine. Only a flood of them
// (BadFrames) ends the link: a hub that sends that much the node can't read is broken.
import { headUtf16 } from "../util.ts";
import type { HubFrame, NodeFrame } from "../wire.ts";

/** Undecodable frames one link takes within a minute; the next one ends it. */
export const BAD_FRAMES_PER_MINUTE = 20;

/** A link's undecodable frames, counted per minute. */
export class BadFrames {
  #since = 0;
  #count = 0;
  /** Counts one at `nowMs` (any clock that doesn't go back): false once the minute's count is past the limit. */
  take(nowMs: number): boolean {
    if (this.#count === 0 || nowMs - this.#since >= 60_000) {
      this.#since = nowMs;
      this.#count = 0;
    }
    this.#count += 1;
    return this.#count <= BAD_FRAMES_PER_MINUTE;
  }
}

/** What a frame that doesn't decode is logged and answered by: its `t`, its `id` and why, each cut short. */
export type Undecodable = {
  tag: string;
  /** A request's id, to answer it by; absent when it has none or one too long to be ours. */
  id?: string;
  error: string;
};

/** What a frame is known by in its log line and refusal, with `error` for why. */
export function knownBy(obj: Record<string, unknown> | undefined, error: string): Undecodable {
  const field = (name: string) => (typeof obj?.[name] === "string" ? (obj[name] as string) : undefined);
  const t = field("t");
  const id = field("id");
  return { tag: t === undefined ? "(none)" : headUtf16(t, 64), ...(id && id.length <= 128 ? { id } : {}), error: headUtf16(error, 300) };
}

/** A hub frame (an object whose `t` the node knows), or what it is known by when it isn't one. */
export function readHubFrame(raw: string, tags: readonly string[]): { frame: HubFrame } | { bad: Undecodable } {
  let value: unknown;
  let error: string | undefined;
  try {
    value = JSON.parse(raw);
  } catch (e) {
    error = `not JSON: ${(e as Error).message}`;
  }
  const obj = typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
  const t = typeof obj?.t === "string" ? obj.t : undefined;
  if (obj && t !== undefined && tags.includes(t)) return { frame: obj as HubFrame };
  error ??= !obj ? "not a JSON object" : t === undefined ? "missing field `t`" : `unknown variant \`${t}\``;
  return { bad: knownBy(obj, error) };
}

/** The error answer to a hub request the node couldn't read, so the hub's wait ends now. A `gated_resume` gets none:
 * the node can't say whether its command ran, and the hub asks again on its own. */
export function refusal(bad: Undecodable): NodeFrame | undefined {
  const id = bad.id;
  if (!id) return undefined;
  const why = `the node could not read this ${bad.tag} (it and the hub may run different fleetd versions): ${bad.error}`;
  const answer: Record<string, Record<string, unknown>> = {
    cmd_check: { t: "cmd_result", id, exitCode: null, outputTail: why, timedOut: false },
    secret_deliver: { t: "secret_result", id, error: why },
    gated_run: { t: "gated_result", id, exitCode: null, outputTail: "", timedOut: false, error: why },
    node_action: { t: "node_action_result", id, ok: false, message: why },
    session_call: { t: "session_reply", id, result: { err: { code: "invalid", message: why } } },
    mac_call: { t: "mac_result", id, error: { code: "invalid", message: why } },
  };
  return Object.hasOwn(answer, bad.tag) ? (answer[bad.tag] as NodeFrame) : undefined;
}
