// The link inflaters (the hub's, which /app reuses, and the node's) against a frame built to fill memory, and one that
// isn't DEFLATE at all.
import { expect, test } from "bun:test";
import zlib from "node:zlib";
import * as hub from "../src/hub/link/deflate.ts";
import * as node from "../src/node/link/deflate.ts";
import { deflateBomb } from "./helpers.ts";

const CAP = 1 << 20;
/** node:zlib's default chunk: what one `data` event holds at most. */
const CHUNK = 16 * 1024;

/** Every byte an Inflater's zlib stream emits while `fn` runs, counted beside it. */
async function counted<T>(fn: () => Promise<T>): Promise<{ result: T; emitted: () => number }> {
  let emitted = 0;
  const real = zlib.createInflateRaw;
  zlib.createInflateRaw = ((options?: zlib.ZlibOptions) => {
    const z = real(options);
    z.on("data", (chunk: Buffer) => (emitted += chunk.length));
    return z;
  }) as typeof zlib.createInflateRaw;
  try {
    return { result: await fn(), emitted: () => emitted };
  } finally {
    zlib.createInflateRaw = real;
  }
}

// Bun 1.4.3: `await expect(p).rejects` never settles (README), so each rejection is caught.
const outcome = (p: Promise<unknown>) => p.then(() => "inflated", (e: Error) => e.message);

for (const [side, { Deflater, Inflater }] of [["hub", hub], ["node", node]] as const) {
  test(`${side}: a small frame that inflates to 64 times the cap is refused at the cap, and zlib stops there`, async () => {
    const bomb = await deflateBomb(64);
    expect(bomb.length).toBeLessThan(CAP / 8);
    const { result, emitted } = await counted(async () => {
      const inflater = new Inflater(CAP);
      const why = await outcome(inflater.inflate(bomb));
      inflater.close();
      return why;
    });
    expect(result).toContain(`inflates past ${CAP} bytes`);
    expect(emitted()).toBeLessThanOrEqual(CAP + CHUNK);
    // Given time, it still never inflates the rest: the work stopped rather than being thrown away.
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(emitted()).toBeLessThanOrEqual(CAP + CHUNK);
  });

  test(`${side}: a frame that isn't DEFLATE rejects at once, and so does every later one`, async () => {
    const d = new Deflater();
    const i = new Inflater(CAP);
    const msg = JSON.stringify({ t: "hb", pad: "x".repeat(500) });
    expect(await i.inflate(await d.deflate(msg))).toBe(msg);
    expect(await outcome(i.inflate(new Uint8Array(16).fill(0xff)))).not.toBe("inflated");
    expect(await outcome(i.inflate(await d.deflate(msg)))).not.toBe("inflated");
    i.close();
    d.close();
  }, 1000);
}

test("well-formed messages still share their window, each up to the cap", async () => {
  const d = new hub.Deflater();
  const i = new hub.Inflater(CAP);
  const full = "y".repeat(CAP);
  const first = await d.deflate(full);
  const second = await d.deflate(full);
  expect(second.length).toBeLessThan(first.length);
  expect(await i.inflate(first)).toBe(full);
  expect(await i.inflate(second)).toBe(full);
  i.close();
  d.close();
});
