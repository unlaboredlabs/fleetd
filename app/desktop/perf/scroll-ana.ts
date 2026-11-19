// Reads perf/scroll.ts's recording. Each frame, the row under the view's middle should move by exactly what the wheel
// gave since the frame before (wheel deltas apply at once here: no smooth scrolling under Xvfb), or not at all
// without input; anything else moved the view under the reader. node perf/scroll-ana.ts rec.json [lines]
import { readFileSync } from "node:fs";

const [file = "rec.json", show] = process.argv.slice(2);
type Frame = [number, number, number, number | null, number, string];
const rec = JSON.parse(readFileSync(file, "utf8")) as { scenario: string; frames: Frame[]; wheels: number[][]; writes: [number, number, number, string][]; marks: [number, string][] };
const { frames, wheels, writes, marks } = rec;
/** Moves under this, px, are subpixel rounding. */
const PX = 2;
/** Per frame: how far the row moved beyond what the wheel gave, and whether the wheel gave anything. */
const offs = frames.map(([t, top, height, s, view], i): { off: number; wheel: boolean } => {
  const prev = frames[i - 1];
  if (prev === undefined || s === null) return { off: 0, wheel: false };
  const asked = wheels.filter(([w = 0]) => w > prev[0] && w <= t).reduce((sum, [, d = 0]) => sum - d, 0);
  // At either end the wheel moves less than it asks.
  const clamped = asked !== 0 && (top <= 1 || prev[1] <= 1 || top + view >= height - 1 || prev[1] + prev[4] >= prev[2] - 1);
  return { off: clamped ? (Math.sign(s) === Math.sign(asked) || s === 0 ? 0 : s) : s - asked, wheel: asked !== 0 };
});
// A wheel event that lands just after a frame is read is counted in the next: -N then +N, the view never off. Not a jump.
let late = 0;
offs.forEach((o, i) => {
  const next = offs[i + 1];
  if (next !== undefined && Math.abs(o.off) >= PX && Math.abs(o.off + next.off) < PX && (o.wheel || next.wheel)) {
    o.off = 0;
    next.off = 0;
    late++;
  }
});
let jumps = 0;
let jumpPx = 0;
let worst = 0;
const lines: string[] = [];
frames.forEach(([t, top, height, s, view, row], i) => {
  const prev = frames[i - 1];
  const off = offs[i]?.off ?? 0;
  if (prev === undefined || s === null || Math.abs(off) < PX) return;
  jumps++;
  jumpPx += Math.abs(off);
  worst = Math.max(worst, Math.abs(off));
  const mk = marks.findLast(([m]) => m <= t)?.[1] ?? "";
  const near = writes.filter(([w]) => w > prev[0] - 5 && w <= t).map(([, from, to, who]) => `write ${from.toFixed(0)}->${to.toFixed(0)} by ${who.split(" < ").slice(1, 4).join(" < ")}`);
  lines.push(`  [${mk}] ${off.toFixed(1)} px (moved ${s.toFixed(1)}) at ${t.toFixed(0)} top ${top} height ${height} (was ${prev[2]}) view ${view} row "${row}" ${near.join(" | ")}`);
});
console.log(`${rec.scenario}: ${frames.length} frames, ${wheels.length} wheels; view moved under the reader: ${jumps} frames, ${jumpPx.toFixed(0)} px, worst ${worst.toFixed(0)} px; a wheel event read a frame late: ${late}; scroll writes ${writes.length}`);
for (const l of lines.slice(0, Number(show ?? 0))) console.log(l);
