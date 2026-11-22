// A recording's upload over a link that keeps dropping (a flapping network): each try goes on from the last piece the
// hub took, so the recording arrives whole however often a try is cut short; a hub that lost its copy gets it whole.
import { expect, test } from "bun:test";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { upload } from "../../src/node/browser/record.ts";
import { RECORDING_PART_BYTES } from "../../src/shared/screens_wire.ts";
import { tempHome } from "../helpers.ts";

/** A finished recording's folder, its video `pieces` pieces long. */
function recording(root: string, pieces: number) {
  const dir = join(root, "rec-1");
  mkdirSync(dir, { recursive: true });
  const meta = { sessionId: "b1", kind: "browser", threadId: "t1", cwd: root, purpose: "look", startedAt: "2026-11-08T10:00:00Z", endedAt: "2026-11-08T10:05:00Z", credentialsFilled: 0 };
  writeFileSync(join(dir, "session.json"), JSON.stringify(meta));
  const video = Buffer.alloc(pieces * RECORDING_PART_BYTES - 1000);
  for (let i = 0; i < video.length; i += 4096) video[i] = i % 251;
  writeFileSync(join(dir, "video.webm"), video);
  return { dir, video };
}

/** The hub's side as hub/browser/calls.ts has it: a piece at most at what it holds, which it truncates to; every
 * `dropEvery`th call lost with the link. */
function hub(dropEvery: number) {
  let held = Buffer.alloc(0);
  let calls = 0;
  let pieceBytes = 0;
  const call = async (_thread: string, _cwd: string, op: string, args: Record<string, unknown>) => {
    if (++calls % dropEvery === 0) throw new Error("the hub link dropped");
    if (op !== "browser_recording_part") {
      if (args.state === "recorded" && (args.files as { bytes: number }[]).some((f) => f.bytes !== held.length)) {
        throw Object.assign(new Error(`The hub holds ${held.length} bytes.`), { fix: "upload the file again from offset 0" });
      }
      return {};
    }
    const offset = Number(args.offset);
    if (offset > held.length) throw new Error(`The hub holds ${held.length} bytes of b1's video; a piece at ${offset} would leave a gap.`);
    const data = Buffer.from(String(args.dataB64), "base64");
    pieceBytes += data.length;
    held = Buffer.concat([held.subarray(0, offset), data]);
    return { bytes: offset + data.length };
  };
  return { call, held: () => held, pieceBytes: () => pieceBytes, lose: () => void (held = Buffer.alloc(0)) };
}

async function tries(dir: string, call: Parameters<typeof upload>[0], max: number): Promise<number> {
  for (let n = 1; n <= max; n++) {
    try {
      await upload(call, dir);
      return n;
    } catch {}
  }
  return Number.POSITIVE_INFINITY;
}

test("an upload cut short goes on from the hub's last piece, and arrives whole", async () => {
  const home = tempHome();
  const { dir, video } = recording(home.dir, 8);
  const h = hub(3);
  // From the start each time, a drop every third call would never get 8 pieces through.
  expect(await tries(dir, h.call, 20)).toBeLessThanOrEqual(9);
  expect(h.held().equals(video)).toBe(true);
  // Each piece crossed once, but for those whose answer was lost.
  expect(h.pieceBytes()).toBe(video.length);
  expect(existsSync(dir)).toBe(false);
  home.done();
});

test("a hub that lost its copy gets the file whole on the next try", async () => {
  const home = tempHome();
  const { dir, video } = recording(home.dir, 4);
  const h = hub(4);
  // The first try gets two pieces through before its link drops; then the hub loses them.
  expect(await tries(dir, h.call, 1)).toBe(Number.POSITIVE_INFINITY);
  h.lose();
  expect(await tries(dir, h.call, 10)).toBeLessThanOrEqual(10);
  expect(h.held().equals(video)).toBe(true);
  home.done();
});
