// hub/browser/flow.ts on a simulated link: a screen at 30 fps whose encoder follows the budget it's told, through a
// link of a given rate and round trip, every time simulated (no clock but the test's). A slow, long link brings the
// budget down to what it carries and keeps the picture current instead of queueing; a fast one is never cut.
import { expect, test } from "bun:test";
import { FrameSender, MIN_KBPS, START_KBPS } from "../src/hub/browser/flow.ts";

function run(kbitPerSec: number, rttMs: number, seconds = 30) {
  let now = 0;
  const bytesPerMs = kbitPerSec / 8;
  let budget: number | undefined;
  let keys = 0;
  let wantKey = false;
  let wireFree = 0;
  const acks: [number, number][] = [];
  const made = new Map<number, number>();
  const shown: { seq: number; lag: number; at: number }[] = [];
  const sender = new FrameSender<null>(
    {
      send: (f) => {
        // Serialized onto the link at its rate, then half a round trip; the ack comes back the other half.
        wireFree = Math.max(wireFree, now) + f.bytes / bytesPerMs;
        const at = wireFree + rttMs / 2;
        shown.push({ seq: f.seq, lag: at - made.get(f.seq)!, at });
        acks.push([at + rttMs / 2, f.seq]);
      },
      key: () => {
        keys++;
        wantKey = true;
      },
      budget: (k) => (budget = k),
    },
    undefined,
    false,
    () => now,
  );
  let seq = 0;
  for (let next = 0; now < seconds * 1000; now += 1) {
    acks.sort((a, b) => a[0] - b[0]);
    while (acks[0] && acks[0][0] <= now) sender.ack(acks.shift()![1]);
    if (now >= next) {
      next += 1000 / 30;
      seq++;
      made.set(seq, now);
      const kbps = budget ?? START_KBPS;
      const key = seq === 1 || wantKey;
      wantKey = false;
      sender.offer({ seq, bytes: Math.round((kbps * 1000) / 8 / 30), h264: true, key, data: null });
    }
  }
  sender.end();
  const late = shown.filter((s) => s.at > (seconds - 10) * 1000);
  const lags = late.map((s) => s.lag).sort((a, b) => a - b);
  return { budget, keys, fps: late.length / 10, lagP95: lags[Math.floor(lags.length * 0.95)] ?? Infinity, lagP50: lags[Math.floor(lags.length / 2)] ?? Infinity };
}

test("a 1 Mbit/s link 150 ms away: the budget comes down to what it carries, and the picture stays current", () => {
  const r = run(1_000, 150);
  expect(r.budget).toBeDefined();
  // It probes a tenth above what the link carries, and falls back a quarter: it stays near the link's rate.
  expect(r.budget!).toBeGreaterThanOrEqual(MIN_KBPS);
  expect(r.budget! / 1_000).toBeLessThan(1.3);
  // Frames still flow at most of the screen's rate, each shown within a few round trips of being made.
  expect(r.fps).toBeGreaterThan(15);
  expect(r.lagP95 / 150).toBeLessThan(4);
});

test("a link that keeps up is never cut, and its frames lag by only the trip", () => {
  const r = run(40_000, 150);
  expect(r.budget).toBeUndefined();
  expect(r.keys).toBe(0);
  expect(r.fps).toBeGreaterThan(29);
  expect(r.lagP95 / 75).toBeLessThan(1.5);
});
