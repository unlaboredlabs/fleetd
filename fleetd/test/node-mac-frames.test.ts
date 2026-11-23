// fleetd-frames' side in the node (src/node/screen/mac_frames.ts): its frames read off stdout however the chunks cut
// them, and the helper built once with a stand-in swiftc. The Swift itself runs only on a Mac (bench/screens/mac.ts).
import { afterEach, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ensureHelper, FrameReader, helperPath, type MacFrame, MacFrames, stream } from "../src/node/screen/mac_frames.ts";
import type { StreamFrame } from "../src/node/screen/live.ts";
import { tempHome } from "./helpers.ts";

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const fn of cleanups.splice(0)) fn();
});

/** One frame as fleetd-frames writes it. */
function framed(kind: 1 | 2 | 3, key: boolean, screen: [number, number], picture: [number, number], seq: number, data: number[]): Uint8Array {
  const out = new Uint8Array(28 + data.length);
  const v = new DataView(out.buffer);
  out[0] = kind;
  out[1] = key ? 1 : 0;
  [screen[0], screen[1], picture[0], picture[1], data.length, seq].forEach((n, i) => v.setUint32(4 + i * 4, n, true));
  out.set(data, 28);
  return out;
}

test("frames come whole however stdout cuts them: across chunks, several in one", () => {
  const seen: MacFrame[] = [];
  const r = new FrameReader((f) => seen.push({ ...f, data: Uint8Array.from(f.data) }));
  const a = framed(1, true, [1206, 2622], [588, 1280], 1, [0xff, 0xd8, 1, 2, 0xff, 0xd9]);
  const b = framed(2, false, [1920, 1080], [1280, 720], 2, Array.from({ length: 300 }, (_, i) => i & 0xff));
  const c = framed(2, true, [1920, 1080], [1280, 720], 3, [0, 0, 0, 1, 0x67]);
  const all = Uint8Array.from([...a, ...b, ...c]);
  // A byte at a time through the first header, then the rest in uneven pieces.
  for (let i = 0; i < 10; i++) r.push(all.subarray(i, i + 1));
  r.push(all.subarray(10, 40));
  r.push(all.subarray(40, 200));
  expect(seen.length).toBe(1);
  r.push(all.subarray(200));
  expect(seen.map((f) => [f.kind, f.key, f.screen, f.picture, f.seq, f.data.length])).toEqual([
    ["jpeg", true, [1206, 2622], [588, 1280], 1, 6],
    ["h264", false, [1920, 1080], [1280, 720], 2, 300],
    ["h264", true, [1920, 1080], [1280, 720], 3, 5],
  ]);
  expect([...seen[1]!.data.subarray(0, 4)]).toEqual([0, 1, 2, 3]);
  expect(() => r.push(framed(1, true, [1, 1], [1, 1], 4, []).fill(7, 0, 1))).toThrow("of kind 7");
});

test("the helper is built once per source, with the Mac's swiftc, and a failed build says why", async () => {
  const home = tempHome();
  cleanups.push(home.done);
  const dir = join(home.dir, "frames");
  // A stand-in swiftc: writes a script that prints one JPEG frame, and counts its builds.
  const swiftc = join(home.dir, "swiftc");
  const count = join(home.dir, "builds");
  writeFileSync(count, "");
  writeFileSync(
    swiftc,
    `#!/bin/sh
echo x >> "${count}"
for last; do :; done
printf '#!/bin/sh\\nread line\\nprintf "\\\\001\\\\001\\\\000\\\\000\\\\002\\\\000\\\\000\\\\000\\\\003\\\\000\\\\000\\\\000\\\\002\\\\000\\\\000\\\\000\\\\003\\\\000\\\\000\\\\000\\\\001\\\\000\\\\000\\\\000\\\\001\\\\000\\\\000\\\\000Z"\\n' > "$last"
`,
  );
  chmodSync(swiftc, 0o755);
  const [one, two] = await Promise.all([ensureHelper(dir, [swiftc]), ensureHelper(dir, [swiftc])]);
  expect(one).toBe(two);
  expect(one).toBe(helperPath(dir));
  expect(existsSync(one)).toBe(true);
  expect(await ensureHelper(dir, [swiftc])).toBe(one);
  expect(readFileSync(count, "utf8").trim().split("\n").length).toBe(1);

  // It runs: told something, it answers a frame, sized as it says.
  const frames: MacFrame[] = [];
  const h = new MacFrames(one, ["screen"], (f) => frames.push(f));
  h.tell("still");
  const deadline = Date.now() + 5_000;
  while (!frames.length && Date.now() < deadline) await Bun.sleep(5);
  expect(frames.map((f) => [f.kind, f.screen, f.picture, Buffer.from(f.data).toString()])).toEqual([["jpeg", [2, 3], [2, 3], "Z"]]);
  // It ended by itself: why, as it said.
  expect(await h.ended).toBe("fleetd-frames exited (0)");

  // A frame that doesn't read ends the stream, saying why, and the helper with it.
  const garbled = join(home.dir, "garbled");
  writeFileSync(garbled, "#!/bin/sh\nprintf '\\011\\001\\000\\000\\001\\000\\000\\000\\001\\000\\000\\000\\001\\000\\000\\000\\001\\000\\000\\000\\000\\000\\000\\000\\001\\000\\000\\000'\nsleep 30\n");
  chmodSync(garbled, 0o755);
  const bad = new MacFrames(garbled, [], () => {});
  expect(await bad.ended).toBe("fleetd-frames sent a frame of kind 9");

  const broken = join(home.dir, "broken");
  writeFileSync(broken, "#!/bin/sh\necho 'frames.swift:3:1: error: cannot find SCStream' >&2\nexit 1\n");
  chmodSync(broken, 0o755);
  await expect(ensureHelper(join(home.dir, "other"), [broken])).rejects.toThrow("did not build: frames.swift:3:1: error: cannot find SCStream");
});

test("a simulator's stream takes input once the helper says so, and its words are no frames", async () => {
  const home = tempHome();
  cleanups.push(home.done);
  const dir = join(home.dir, "frames");
  // The helper as built: a stand-in at its path, which says `input`, sends a JPEG, says `noinput`, and logs what it's told.
  const out = (bytes: Uint8Array) => [...bytes].map((b) => `\\${b.toString(8).padStart(3, "0")}`).join("");
  const word = (w: string) => framed(3, false, [0, 0], [0, 0], 1, [...Buffer.from(w)]);
  const told = join(home.dir, "told");
  const bin = helperPath(dir);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    bin,
    `#!/bin/sh
read line; echo "$line" >> "${told}"
printf '${out(word("input"))}${out(framed(1, true, [1206, 2622], [588, 1280], 2, [0xff, 0xd8]))}'
read line; echo "$line" >> "${told}"
printf '${out(word("noinput dtuhidd's connection ended"))}'
read line; echo "$line" >> "${told}"
`,
  );
  chmodSync(bin, 0o755);
  const frames: StreamFrame[] = [];
  const run = await stream(dir, ["sim", "set", "U1"], (f) => frames.push(f));
  const until = async (ok: () => boolean) => {
    const deadline = Date.now() + 5_000;
    while (!ok() && Date.now() < deadline) await Bun.sleep(5);
  };
  await until(() => frames.length > 0);
  expect(frames.map((f) => [f.kind, f.screen])).toEqual([["jpeg", [1206, 2622]]]);
  expect(run.input?.()).toBe(true);
  // It has said: an input no longer waits for its word (../src/node/device/ios/screen.ts Hands).
  expect(run.inputPending?.()).toBe(false);
  run.tell("touch down 600 1300 0");
  await until(() => run.input?.() === false);
  expect(run.input?.()).toBe(false);
  run.tell("still");
  await run.ended;
  expect(readFileSync(told, "utf8").trim().split("\n")).toEqual(["fps 20", "touch down 600 1300 0", "still"]);
});
