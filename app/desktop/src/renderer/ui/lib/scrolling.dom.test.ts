// @vitest-environment happy-dom
import { afterEach, expect, it, vi } from "vitest";
import { followScrolling } from "./scrolling";

afterEach(() => vi.useRealTimers());

it("marks a list while it scrolls and clears it a moment after its last scroll", () => {
  vi.useFakeTimers();
  const list = document.body.appendChild(document.createElement("div"));
  const stop = followScrolling();
  list.dispatchEvent(new Event("scroll"));
  expect(list.hasAttribute("data-scrolling")).toBe(true);
  vi.advanceTimersByTime(600);
  list.dispatchEvent(new Event("scroll"));
  vi.advanceTimersByTime(600);
  expect(list.hasAttribute("data-scrolling")).toBe(true);
  vi.advanceTimersByTime(400);
  expect(list.hasAttribute("data-scrolling")).toBe(false);
  stop();
  list.dispatchEvent(new Event("scroll"));
  expect(list.hasAttribute("data-scrolling")).toBe(false);
});
