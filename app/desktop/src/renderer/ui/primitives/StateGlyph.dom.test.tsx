// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it } from "vitest";
import { StateGlyph } from "./StateGlyph";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
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
