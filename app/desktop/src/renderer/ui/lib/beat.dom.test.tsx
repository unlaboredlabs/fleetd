// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { BEAT_MS, BEATS, useBeat, useBeatRef } from "./beat";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement;
let root: Root;
let steps: number[];
beforeEach(() => {
  vi.useFakeTimers();
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  steps = [];
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.useRealTimers();
});

const record = (beat: number) => steps.push(beat);

function Live({ on }: { on: boolean }) {
  useBeat(on, record);
  return null;
}

const running = () => document.documentElement.dataset["beat"] !== undefined;
const wait = (ms: number) =>
  act(() => {
    vi.advanceTimersByTime(ms);
  });

it("steps every loop while something live is mounted, and stops with the last of them", () => {
  act(() => root.render(<Live on={false} />));
  expect(running()).toBe(false);
  act(() => root.render(<Live on />));
  expect(running()).toBe(true);
  // At once, with the current beat, then one beat at a time.
  expect(steps).toHaveLength(1);
  wait(BEAT_MS * 3);
  expect(steps).toHaveLength(4);
  expect(steps.slice(1)).toEqual([1, 2, 3].map((n) => ((steps[0] ?? 0) + n) % BEATS));
  act(() => root.render(<Live on={false} />));
  expect(running()).toBe(false);
  wait(BEAT_MS * 3);
  expect(steps).toHaveLength(4);
});

it("keeps its tempo while you type, click and scroll: a step every beat, on the clock, never on your input", () => {
  act(() => root.render(<Live on />));
  steps = [];
  const at: number[] = [];
  const input = (i: number) => (i % 3 === 0 ? new KeyboardEvent("keydown", { key: "a" }) : i % 3 === 1 ? new PointerEvent("pointerdown") : new WheelEvent("wheel"));
  const start = performance.now();
  // A key, a click or a wheel every 50 ms for 2.4 s: 20 beats fall due, and each steps on time.
  for (let i = 0; i < 48; i++) {
    const before = steps.length;
    window.dispatchEvent(input(i));
    expect(steps).toHaveLength(before);
    wait(50);
    if (steps.length > before) at.push(performance.now() - start);
  }
  expect(steps).toHaveLength(20);
  expect(new Set(steps).size).toBe(steps.length);
  // Within the 50 ms the loop above waits between inputs of when each beat fell due.
  at.forEach((t, i) => expect(t - (i + 1) * BEAT_MS).toBeLessThan(50));
});

it("keeps to the clock after a long task held a step late, rather than slowing the loops down", () => {
  // A long task holds the thread for 2.4 beats: the clock moves on while no timer can fire.
  let held = 0;
  const now = performance.now.bind(performance);
  vi.spyOn(performance, "now").mockImplementation(() => now() + held);
  act(() => root.render(<Live on />));
  const first = steps[0] ?? 0;
  held = BEAT_MS * 2.4;
  // The late tick lands on the beat the clock is on, 3.4 beats in, so the 3rd...
  wait(BEAT_MS);
  expect(steps.slice(1)).toEqual([(first + 3) % BEATS]);
  // ...and the beats after it keep to the clock: the 4th 0.6 beats later, the 5th a beat after that.
  wait(BEAT_MS * 2);
  expect(steps.slice(1)).toEqual([3, 4, 5].map((n) => (first + n) % BEATS));
  vi.restoreAllMocks();
});

function Band({ on }: { on: boolean }) {
  const band = useBeatRef<HTMLSpanElement>(on);
  return <span ref={band} />;
}

it("writes the beat onto an element whose CSS steps on it, and nothing onto :root", () => {
  act(() => root.render(<Band on />));
  const band = host.querySelector("span");
  const first = band?.dataset["step"];
  expect(first).toBeDefined();
  wait(BEAT_MS);
  expect(band?.dataset["step"]).toBe(String((Number(first) + 1) % BEATS));
  expect(document.documentElement.dataset["beat"]).toBe("");
});
