import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import { ONLINE_CHECK_MS, watchOnline, watchWake } from "./online";

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

it("wakes the hubs when the computer resumes, and has them check their links when its screen unlocks or the network comes back, until stopped", () => {
  const power = new EventEmitter();
  let online = true;
  const woke = vi.fn();
  const inDoubt = vi.fn();
  const stop = watchWake(power, () => online, woke, inDoubt);
  power.emit("resume");
  expect(woke).toHaveBeenCalledTimes(1);
  power.emit("unlock-screen");
  expect(inDoubt).toHaveBeenCalledTimes(1);
  online = false;
  vi.advanceTimersByTime(ONLINE_CHECK_MS);
  online = true;
  vi.advanceTimersByTime(ONLINE_CHECK_MS);
  expect(inDoubt).toHaveBeenCalledTimes(2);
  expect(woke).toHaveBeenCalledTimes(1);
  stop();
  power.emit("resume");
  power.emit("unlock-screen");
  expect(power.listenerCount("resume") + power.listenerCount("unlock-screen")).toBe(0);
  expect(woke).toHaveBeenCalledTimes(1);
  expect(inDoubt).toHaveBeenCalledTimes(2);
});
