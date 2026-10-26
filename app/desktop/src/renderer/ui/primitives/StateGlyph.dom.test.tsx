// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { BEAT_MS } from "../lib/beat";
import { litOn, StateGlyph } from "./StateGlyph";

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

const glyph = () => host.firstElementChild as HTMLElement | null;

it("is a 3×3 cell whose state is its shape, named for a screen reader when it has a label", () => {
  act(() => root.render(<StateGlyph state="working" label="working" />));
  expect(glyph()?.dataset["state"]).toBe("working");
  expect(glyph()?.children).toHaveLength(9);
  expect(glyph()?.getAttribute("role")).toBe("img");
  expect(glyph()?.getAttribute("aria-label")).toBe("working");
});

it("keeps its cells when its state changes, so it morphs rather than swaps", () => {
  act(() => root.render(<StateGlyph state="queued" />));
  const before = glyph();
  const cell = before?.firstElementChild;
  expect(before?.getAttribute("aria-hidden")).toBe("true");
  act(() => root.render(<StateGlyph state="done" />));
  expect(glyph()).toBe(before);
  expect(glyph()?.firstElementChild).toBe(cell);
  expect(glyph()?.dataset["state"]).toBe("done");
});

/** What a live glyph shows now: the beat its CSS reads and the cells lit on it. */
const frame = () => `${document.documentElement.dataset["beat"] ?? "-"} ${Array.from(glyph()?.children ?? [], (c) => c.getAttribute("data-lit") ?? ".").join("")}`;

it("keeps moving while you type", () => {
  act(() => root.render(<StateGlyph state="thinking" />));
  const seen = [frame()];
  // A key every 60 ms for 1.2 s, as a person typing fast: ten beats fall due, and the glyph shows each.
  for (let i = 0; i < 20; i++) {
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "a" }));
    act(() => {
      vi.advanceTimersByTime(60);
    });
    if (frame() !== seen.at(-1)) seen.push(frame());
  }
  expect(seen.length).toBeGreaterThanOrEqual(1200 / BEAT_MS);
});

it("lights a live glyph's cells from its pattern, and only those that change", () => {
  act(() => root.render(<StateGlyph state="working" phase={2} />));
  const cells = Array.from(glyph()?.children ?? []);
  const lit = cells.map((c) => c.getAttribute("data-lit"));
  // The pattern of whatever beat it mounted on.
  const beat = Array.from({ length: 24 }, (_, b) => b).find((b) => cells.every((_, i) => (litOn("working", 2, i, b) ?? null) === lit[i]));
  expect(beat).toBeDefined();
  act(() => root.render(<StateGlyph state="thinking" phase={2} />));
  expect(cells.map((c) => c.getAttribute("data-lit"))).toEqual(cells.map((_, i) => litOn("thinking", 2, i, beat ?? 0) ?? null));
});

it("walks thinking round the ring a cell a beat, its last step a shade behind, the centre dark", () => {
  const ring = [0, 1, 2, 5, 8, 7, 6, 3];
  for (let b = 0; b < 24; b++) {
    const on = [0, 1, 2, 3, 4, 5, 6, 7, 8].filter((i) => litOn("thinking", 0, i, b) === "on");
    const trail = [0, 1, 2, 3, 4, 5, 6, 7, 8].filter((i) => litOn("thinking", 0, i, b) === "trail");
    expect(on).toEqual([ring[b % 8]]);
    expect(trail).toEqual([ring[(b + 7) % 8]]);
  }
  // A phase starts it two cells further on.
  expect(litOn("thinking", 1, 2, 0)).toBe("on");
  // Working's grain lights every cell at some point, never all at once.
  for (let i = 0; i < 9; i++) expect(Array.from({ length: 24 }, (_, b) => litOn("working", 0, i, b)).some(Boolean)).toBe(true);
  for (let b = 0; b < 24; b++) expect([0, 1, 2, 3, 4, 5, 6, 7, 8].every((i) => litOn("working", 0, i, b) === "on")).toBe(false);
});
