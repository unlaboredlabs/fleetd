// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { BEAT_MS, BEATS, INPUT_RIDE_MS, useBeat, useBeatRef } from "./beat";

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

it("keeps stepping while you type, click and scroll", () => {
  act(() => root.render(<Live on />));
  steps = [];
  const input = (i: number) => (i % 3 === 0 ? new KeyboardEvent("keydown", { key: "a" }) : i % 3 === 1 ? new PointerEvent("pointerdown") : new WheelEvent("wheel"));
  // A key, a click or a wheel every 50 ms for 2.4 s: 20 beats fall due.
  for (let i = 0; i < 48; i++) {
    window.dispatchEvent(input(i));
    wait(50);
  }
  expect(steps.length).toBeGreaterThanOrEqual(19);
  expect(new Set(steps).size).toBe(steps.length);
});

it("steps with your next key, so the two draw on one frame, and by itself once you stop", () => {
  act(() => root.render(<Live on />));
  wait(BEAT_MS / 2);
  steps = [];
  window.dispatchEvent(new KeyboardEvent("keydown", { key: "a" }));
  // The beat falls due while you type: it waits for your next key...
  wait(BEAT_MS / 2);
  expect(steps).toHaveLength(0);
  window.dispatchEvent(new KeyboardEvent("keydown", { key: "b" }));
  expect(steps).toHaveLength(1);
  // ...but never longer than a beat.
  wait(BEAT_MS * 2);
  expect(steps).toHaveLength(2);
  // Once you have stopped, it steps on every beat again.
  wait(INPUT_RIDE_MS);
  const before = steps.length;
  wait(BEAT_MS * 4);
  expect(steps.length - before).toBe(4);
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
