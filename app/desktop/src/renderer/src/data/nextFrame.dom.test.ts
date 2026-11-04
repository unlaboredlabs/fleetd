// @vitest-environment happy-dom
// The data layer's batch: the next painted frame, at once in a hidden window, and never a batch left waiting.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { nextFrame } from "./queries";

let visibility: DocumentVisibilityState = "visible";
let frames: Map<number, FrameRequestCallback>;

beforeEach(() => {
  vi.useFakeTimers();
  visibility = "visible";
  frames = new Map();
  let id = 0;
  Object.defineProperty(document, "visibilityState", { configurable: true, get: () => visibility });
  vi.stubGlobal("requestAnimationFrame", (f: FrameRequestCallback) => (frames.set(++id, f), id));
  vi.stubGlobal("cancelAnimationFrame", (id: number) => frames.delete(id));
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

const paint = () => {
  const due = [...frames.values()];
  frames.clear();
  for (const f of due) f(performance.now());
};

const hide = () => {
  visibility = "hidden";
  document.dispatchEvent(new Event("visibilitychange"));
};

describe("nextFrame", () => {
  it("goes on the next frame, once", () => {
    const flush = vi.fn();
    nextFrame(flush);
    expect(flush).not.toHaveBeenCalled();
    paint();
    expect(flush).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(1_000);
    hide();
    expect(flush).toHaveBeenCalledTimes(1);
  });

  it("goes at once in a hidden window, which paints no frames", () => {
    visibility = "hidden";
    const flush = vi.fn();
    nextFrame(flush);
    expect(flush).toHaveBeenCalledTimes(1);
    expect(frames.size).toBe(0);
  });

  it("goes as the window hides, not when it shows again", () => {
    const flush = vi.fn();
    nextFrame(flush);
    hide();
    expect(flush).toHaveBeenCalledTimes(1);
    paint();
    expect(flush).toHaveBeenCalledTimes(1);
  });

  it("goes anyway when no frame comes", () => {
    const flush = vi.fn();
    nextFrame(flush);
    vi.advanceTimersByTime(99);
    expect(flush).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(flush).toHaveBeenCalledTimes(1);
    expect(frames.size).toBe(0);
  });

  it("a cancelled batch never goes", () => {
    const flush = vi.fn();
    nextFrame(flush)();
    paint();
    hide();
    vi.advanceTimersByTime(1_000);
    expect(flush).not.toHaveBeenCalled();
  });
});
