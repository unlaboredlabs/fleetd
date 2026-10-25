// @vitest-environment happy-dom
// Show's mark on one bubble: focus once per press, the ring while it fades, then a plain bubble again.
import { act, useRef } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { SHOWN_MS, useShown, type ShownMark } from "./shown";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function Bubble({ mark }: { mark: ShownMark | undefined }) {
  const box = useRef<HTMLDivElement>(null);
  const shown = useShown(box, mark);
  return (
    <div ref={box} data-bubble tabIndex={shown ? -1 : undefined} data-on={shown ? "" : undefined}>
      Merge #12 now?
    </div>
  );
}

let host: HTMLDivElement;
let root: Root;
let box: HTMLTextAreaElement;
beforeEach(() => {
  vi.useFakeTimers();
  host = document.createElement("div");
  box = document.createElement("textarea");
  document.body.append(host, box);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  box.remove();
  vi.useRealTimers();
});

const render = (mark: ShownMark | undefined, mounted = true) => act(() => root.render(mounted ? <Bubble mark={mark} /> : null));
const bubble = () => host.querySelector<HTMLElement>("[data-bubble]");

it("takes focus once per press: remounted after you moved on, it leaves the focus where you put it", () => {
  const mark = { id: "m2", part: "1", n: 1, at: Date.now() };
  render(mark);
  expect(document.activeElement).toBe(bubble());
  box.focus();
  // The list drops the row as you scroll away and mounts it again as you come back.
  render(mark, false);
  render(mark);
  expect(document.activeElement).toBe(box);
  // Still ringing, though.
  expect(bubble()?.dataset["shown"]).toBe("1");
});

it("is a plain bubble once the ring has faded, but not from under the focus", () => {
  const mark = { id: "m2", part: "1", n: 2, at: Date.now() };
  render(mark);
  expect(bubble()?.dataset["shown"]).toBe("0");
  act(() => {
    vi.advanceTimersByTime(SHOWN_MS);
  });
  expect(bubble()?.dataset["shown"]).toBeUndefined();
  // Focus is still on it: it stays focusable until focus leaves.
  expect(document.activeElement).toBe(bubble());
  expect(bubble()?.getAttribute("tabindex")).toBe("-1");
  act(() => box.focus());
  expect(bubble()?.hasAttribute("tabindex")).toBe(false);
  expect(bubble()?.hasAttribute("data-on")).toBe(false);
  // Remounted later, it stays plain.
  render(mark, false);
  render(mark);
  expect([bubble()?.hasAttribute("tabindex"), bubble()?.dataset["shown"], document.activeElement]).toEqual([false, undefined, box]);
});

it("ends at once when focus has already left by the time it fades", () => {
  const mark = { id: "m2", part: "1", n: 3, at: Date.now() };
  render(mark);
  box.focus();
  act(() => {
    vi.advanceTimersByTime(SHOWN_MS);
  });
  expect(bubble()?.hasAttribute("tabindex")).toBe(false);
});
