// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it } from "vitest";
import { onChatFocus, onChatKey } from "./keys";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement;
let root: Root;

const Line = ({ n }: { n: number }) => (
  <div data-line="">
    <div data-bubble="text" tabIndex={-1}>
      message {n}
    </div>
    <span data-line-actions="">
      <button type="button" tabIndex={-1} aria-label="Reply" />
    </span>
  </div>
);

beforeEach(() => {
  host = document.body.appendChild(document.createElement("div"));
  root = createRoot(host);
  act(() =>
    root.render(
      <>
        <button type="button">before</button>
        <div role="list" tabIndex={0} onKeyDown={onChatKey} onFocus={onChatFocus} data-testid="list">
          {[1, 2, 3].map((n) => (
            <Line key={n} n={n} />
          ))}
        </div>
      </>,
    ),
  );
  // Every row in view.
  for (const el of host.querySelectorAll<HTMLElement>("[role=list], [data-bubble]"))
    el.getBoundingClientRect = () => ({ top: 0, bottom: 100, left: 0, right: 100, width: 100, height: 100, x: 0, y: 0, toJSON: () => ({}) });
  for (const el of host.querySelectorAll<HTMLElement>("[data-bubble], button")) el.scrollIntoView = () => undefined;
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

const must = <T,>(el: T | null | undefined): T => {
  if (el == null) throw new Error("not drawn");
  return el;
};
const list = () => must(host.querySelector<HTMLElement>("[role=list]"));
const bubble = (n: number) => must(host.querySelectorAll<HTMLElement>("[data-bubble]")[n - 1]);
const press = (key: string, shiftKey = false) => act(() => void document.activeElement?.dispatchEvent(new KeyboardEvent("keydown", { key, shiftKey, bubbles: true })));

it("is one Tab stop: tabbing in lands on the newest bubble in view, and no bubble or action is a stop of its own", () => {
  const tabbable = [...host.querySelectorAll<HTMLElement>("[tabindex]")].filter((el) => el.tabIndex >= 0);
  expect(tabbable).toEqual([list()]);
  act(() => list().focus());
  expect(document.activeElement).toBe(bubble(3));
});

it("goes from bubble to bubble with ↑ and ↓, into a bubble's actions with → and back with ←", () => {
  act(() => list().focus());
  press("ArrowUp");
  expect(document.activeElement).toBe(bubble(2));
  press("ArrowUp");
  press("ArrowDown");
  expect(document.activeElement).toBe(bubble(2));
  press("ArrowRight");
  expect(document.activeElement?.getAttribute("aria-label")).toBe("Reply");
  press("ArrowLeft");
  expect(document.activeElement).toBe(bubble(2));
});

it("leaves the list with Tab from a bubble, through the list itself rather than each message", () => {
  act(() => list().focus());
  press("ArrowUp");
  press("Tab", true);
  // The browser's own Tab then moves on from the list: what matters is that it starts there, not at a bubble.
  expect(document.activeElement).toBe(list());
});
