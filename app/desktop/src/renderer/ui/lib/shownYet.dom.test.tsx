// @vitest-environment happy-dom
// useShownYet in a module of its own: markShown is once per page, so this file starts with the app not yet shown.
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { markShown, useShownYet } from "./idle";

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

const Probe = ({ cap }: { cap: number }) => <p>{useShownYet(cap) ? "after" : "before"}</p>;

it("waits for the first screen, or its cap, then stays true", () => {
  act(() => root.render(<Probe cap={10_000} />));
  expect(host.textContent).toBe("before");
  act(() => {
    vi.advanceTimersByTime(9_999);
  });
  expect(host.textContent).toBe("before");
  act(() => {
    vi.advanceTimersByTime(1);
  });
  // The cap: a screen that never says it has shown doesn't hold the part back for good.
  expect(host.textContent).toBe("after");
  act(() => root.render(<Probe cap={60_000} />));
  act(() => markShown());
  expect(host.textContent).toBe("after");
  // Mounted after the chat has shown: at once.
  act(() => root.unmount());
  root = createRoot(host);
  act(() => root.render(<Probe cap={60_000} />));
  expect(host.textContent).toBe("after");
});

it("turns true the moment the chat has shown, well before the cap", () => {
  // markShown ran in the test before: a later mount reads it at once (the module keeps it for the page).
  act(() => root.render(<Probe cap={60_000} />));
  expect(host.textContent).toBe("after");
});
