// A node link frame from the other end that doesn't decode (a newer peer's field, a value out of range)
// (crates/fleetd/src/link_frames.rs): that frame alone is refused, logged by its tag, id, size and the decode error
// (never its payload), answered when it was a request, and the link carries on. Only a flood of them ends the link:
// a peer that sends that much it can't be read is broken.

/** Undecodable frames one link takes within a minute; the next one ends it. */
export const BAD_FRAMES_PER_MINUTE = 20;

/** A link's undecodable frames, counted per minute. */
export class BadFrames {
  private sinceMs = 0;
  private count = 0;

  /** Counts one at `nowMs`: false once the minute's count is past the limit. */
  take(nowMs: number): boolean {
    if (this.count === 0 || nowMs - this.sinceMs >= 60_000) {
      this.sinceMs = nowMs;
      this.count = 0;
    }
    this.count++;
    return this.count <= BAD_FRAMES_PER_MINUTE;
  }
}

/** Why a frame doesn't decode, thrown where the link reads one. */
export class FrameError extends Error {}

/** What a frame that doesn't decode is logged and answered by: its `t`, its `id` and the error, each cut short. */
export type Undecodable = { tag: string; id?: string; error: string };

/** The first `max` UTF-8 bytes of `s`, never splitting a character. */
function cut(s: string, max: number): string {
  const bytes = Buffer.from(s);
  if (bytes.length <= max) return s;
  let end = max;
  while (end > 0 && ((bytes[end] ?? 0) & 0xc0) === 0x80) end--;
  return bytes.subarray(0, end).toString();
}

export function undecodable(text: string, error: string): Undecodable {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {}
  const field = (name: string) => {
    const v = value && typeof value === "object" ? (value as Record<string, unknown>)[name] : undefined;
    return typeof v === "string" ? v : undefined;
  };
  const tag = field("t");
  const id = field("id");
  return {
    tag: tag === undefined ? "(none)" : cut(tag, 64),
    ...(id !== undefined && id !== "" && Buffer.byteLength(id) <= 128 ? { id } : {}),
    error: cut(error, 300),
  };
}
