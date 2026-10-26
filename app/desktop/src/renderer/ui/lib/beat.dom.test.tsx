// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { BEAT_MS, INPUT_HOLD_MS, useBeat } from "./beat";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  vi.useFakeTimers();
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.useRealTimers();
});

function Live({ on }: { on: boolean }) {
  useBeat(on);
  return null;
}

const beat = () => document.documentElement.dataset["beat"];

it("steps :root's beat while something live is mounted, and stops with the last of them", () => {
  act(() => root.render(<Live on={false} />));
  expect(beat()).toBeUndefined();
  act(() => root.render(<Live on />));
  const first = beat();
  expect(first).toBeDefined();
  act(() => {
    vi.advanceTimersByTime(BEAT_MS);
  });
  expect(beat()).not.toBe(first);
  act(() => root.render(<Live on={false} />));
  expect(beat()).toBeUndefined();
});

it("holds still while you type, and steps again after", () => {
  act(() => root.render(<Live on />));
  window.dispatchEvent(new KeyboardEvent("keydown", { key: "a" }));
  const held = beat();
  act(() => {
    vi.advanceTimersByTime(INPUT_HOLD_MS - BEAT_MS);
  });
  expect(beat()).toBe(held);
  act(() => {
    vi.advanceTimersByTime(BEAT_MS * 3);
  });
  expect(beat()).not.toBe(held);
});
