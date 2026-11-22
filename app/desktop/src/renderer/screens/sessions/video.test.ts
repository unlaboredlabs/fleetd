import { describe, expect, it } from "vitest";
import { chunkOf, CODEC, unread } from "./video";

const base = { sessionId: "B68722f97b065412024c7cda6c636fd9a", width: 1206, height: 2622, control: "agent" as const };

describe("a live screen's H.264", () => {
  it("goes to the decoder from a keyframe on, each frame a chunk at its seq, and a JPEG never does", () => {
    const key = { ...base, seq: 4, h264B64: btoa("\u0000\u0000\u0000\u0001g"), key: true };
    const delta = { ...base, seq: 5, h264B64: btoa("\u0000\u0000\u0000\u0001A") };
    // Before any keyframe, a delta is nothing to decode.
    expect(chunkOf(delta, false)).toBeUndefined();
    const first = chunkOf(key, false);
    expect(first?.type).toBe("key");
    expect(first?.timestamp).toBe(4000);
    expect([...(first?.data as Uint8Array)]).toEqual([0, 0, 0, 1, 0x67]);
    expect(chunkOf(delta, true)?.type).toBe("delta");
    expect(chunkOf({ ...base, seq: 6, jpegB64: "AA==" }, true)).toBeUndefined();
    // A High profile decoder: it takes what VideoToolbox (Main) and x264 (High) make.
    expect(CODEC.startsWith("avc1.64")).toBe(true);
  });

  it("reaches the decoder whole: every frame past the newest decoded, and a frame let go unread is a loss unless a keyframe follows", () => {
    const f = (seq: number, key = false) => ({ ...base, seq, h264B64: "AA==", ...(key ? { key: true } : {}) });
    const list = [f(4, true), f(5), f(6)];
    expect(unread(list, -1, 4).fresh.map((x) => x.seq)).toEqual([5, 6]);
    expect(unread(list, -1, 4).lost).toBe(false);
    expect(unread(list, -1, 6).fresh).toEqual([]);
    // 7..9 came and 7 was let go before the decoder (at 6) had it.
    expect(unread([f(8), f(9)], 7, 6)).toMatchObject({ lost: true });
    // Let go, but the decoder had it already.
    expect(unread([f(8), f(9)], 7, 7).lost).toBe(false);
    // Let go unread, but a keyframe comes first: nothing lost that matters.
    expect(unread([f(10, true), f(11)], 9, 6).lost).toBe(false);
  });
});
