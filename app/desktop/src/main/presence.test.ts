import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatScope } from "../shared/ipc";
import { INPUT_WITHIN_S, PRESENCE_EVERY_MS, PresenceSetting, presenceFrame, startPresence, type PresenceDeps, type PresenceFrame } from "./presence";

const web: ChatScope = { machineId: "devbox", projectId: "web" };

const deps = (over: Partial<PresenceDeps> = {}) => {
  const sent: Array<PresenceFrame> = [];
  const asked: Array<number> = [];
  const d: PresenceDeps = {
    on: () => true,
    focused: () => true,
    active: (seconds) => {
      asked.push(seconds);
      return true;
    },
    project: () => web,
    send: (frame) => sent.push(frame),
    ...over,
  };
  return { d, sent, asked };
};

describe("app presence", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("sends nothing while it is off, and nothing is even read", () => {
    let on = false;
    const focused = vi.fn(() => true);
    const project = vi.fn(() => web);
    const { d, sent, asked } = deps({ on: () => on, focused, project });
    const stop = startPresence(d);
    vi.advanceTimersByTime(10 * PRESENCE_EVERY_MS);
    expect(sent).toEqual([]);
    expect([focused.mock.calls.length, project.mock.calls.length, asked.length]).toEqual([0, 0, 0]);
    // Turned on, the next minute is sent; off again, nothing more.
    on = true;
    vi.advanceTimersByTime(PRESENCE_EVERY_MS);
    expect(sent).toHaveLength(1);
    on = false;
    vi.advanceTimersByTime(5 * PRESENCE_EVERY_MS);
    expect(sent).toHaveLength(1);
    stop();
  });

  it("sends once a minute while a window is focused, and stops when stopped", () => {
    let focused = false;
    const { d, sent } = deps({ focused: () => focused });
    const stop = startPresence(d);
    vi.advanceTimersByTime(3 * PRESENCE_EVERY_MS);
    expect(sent).toEqual([]);
    focused = true;
    vi.advanceTimersByTime(PRESENCE_EVERY_MS - 1);
    expect(sent).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(sent).toHaveLength(1);
    stop();
    vi.advanceTimersByTime(5 * PRESENCE_EVERY_MS);
    expect(sent).toHaveLength(1);
  });

  it("carries the three facts and no content", () => {
    // A scope with more on it than the two ids: only the ids go.
    const scope = { ...web, title: "Checkout", draft: "half a message" } as ChatScope;
    const { d, asked } = deps({ project: () => scope });
    const frame = presenceFrame(d);
    expect(frame).toEqual({ focused: true, input: true, project: web });
    expect(Object.keys(frame ?? {}).sort()).toEqual(["focused", "input", "project"]);
    expect(Object.keys(frame?.project ?? {}).sort()).toEqual(["machineId", "projectId"]);
    // Input is the OS's idle state over the last minute, not keys or clicks.
    expect(asked).toEqual([INPUT_WITHIN_S]);
    // Idle, or no project on screen: said as such.
    expect(presenceFrame(deps({ active: () => false, project: () => null }).d)).toEqual({ focused: true, input: false });
  });
});

describe("the presence switch", () => {
  const dir = () => mkdtempSync(join(tmpdir(), "presence-"));

  it("is on unless it was turned off, and keeps what was chosen", () => {
    const file = join(dir(), "presence.json");
    expect(new PresenceSetting(file).on).toBe(true);
    expect(new PresenceSetting(file).set(false)).toBe(false);
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({ on: false });
    expect(new PresenceSetting(file).on).toBe(false);
    new PresenceSetting(file).set(true);
    expect(new PresenceSetting(file).on).toBe(true);
  });

  it("reads a damaged file as on, and holds a choice it couldn't save", () => {
    const file = join(dir(), "presence.json");
    writeFileSync(file, "{not json");
    expect(new PresenceSetting(file).on).toBe(true);
    const unsaved = new PresenceSetting(join(dir(), "missing", "presence.json"));
    expect(unsaved.set(false)).toBe(false);
    expect(unsaved.on).toBe(false);
  });
});
