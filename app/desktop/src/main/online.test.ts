import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ONLINE_CHECK_MS, watchOnline } from "./online";

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

it("dials once each time the network comes back, never while it stays up or down", () => {
  let online = true;
  const back = vi.fn();
  const stop = watchOnline(() => online, back);
  vi.advanceTimersByTime(ONLINE_CHECK_MS * 3);
  expect(back).not.toHaveBeenCalled();
  online = false;
  vi.advanceTimersByTime(ONLINE_CHECK_MS * 3);
  expect(back).not.toHaveBeenCalled();
  online = true;
  vi.advanceTimersByTime(ONLINE_CHECK_MS);
  expect(back).toHaveBeenCalledTimes(1);
  vi.advanceTimersByTime(ONLINE_CHECK_MS * 3);
  expect(back).toHaveBeenCalledTimes(1);
  stop();
  online = false;
  vi.advanceTimersByTime(ONLINE_CHECK_MS);
  online = true;
  vi.advanceTimersByTime(ONLINE_CHECK_MS);
  expect(back).toHaveBeenCalledTimes(1);
});
