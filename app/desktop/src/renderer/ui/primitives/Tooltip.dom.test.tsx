// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import s from "./Overlay.module.css";
import { Tooltip, TooltipProvider } from "./Tooltip";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// In the app Radix reads the tooltip as starting its fade just as it closes (Popper holds `animation: none` until
// the tooltip is placed, and the start can go unseen: always with reduced motion's 0 ms fade, sometimes on a press),
// so it waits for an animationend that never comes. A fade only on the closed tooltip reads the same way here,
// where happy-dom fires no animation events at all.
const fade = document.createElement("style");
fade.textContent = `.${s.tooltip}[data-state="closed"] { animation-name: fade; animation-duration: 120ms; }`;
document.head.appendChild(fade);

let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  vi.useFakeTimers();
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  act(() =>
    root.render(
      <TooltipProvider>
        <Tooltip content="Open the board">
          <button type="button">Board</button>
        </Tooltip>
      </TooltipProvider>,
    ),
  );
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.useRealTimers();
});

const button = () => {
  const found = host.querySelector("button");
  if (!found) throw new Error("no trigger");
  return found;
};
const tip = () => document.querySelector(`.${s.tooltip}`);
const settle = () => {
  act(() => {
    vi.advanceTimersByTime(1000);
  });
};

it("a tooltip dismissed by a mouse press leaves the page", () => {
  act(() => {
    button().dispatchEvent(new PointerEvent("pointermove", { pointerType: "mouse", bubbles: true }));
  });
  settle();
  expect(tip()?.textContent).toBe("Open the board");
  act(() => {
    button().dispatchEvent(new PointerEvent("pointerdown", { pointerType: "mouse", button: 0, bubbles: true }));
  });
  settle();
  expect(tip()).toBeNull();
});

it("a tooltip opened by keyboard focus leaves the page when focus moves on", () => {
  act(() => {
    button().focus();
  });
  settle();
  expect(tip()?.textContent).toBe("Open the board");
  act(() => {
    button().blur();
  });
  settle();
  expect(tip()).toBeNull();
});
