import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { HubFrame } from "../../shared/hub";
import { FixtureSource, fixtureRequest, loadFixture, matches, type FixtureFile } from "./fixture";

const base: FixtureFile = {
  version: 1,
  name: "board-busy",
  note: "20 lanes",
  now: "2026-10-19T09:00:00Z",
  state: { phase: "live", hub: "http://devbox:4790", protocol: 1 },
  frames: [
    { t: "snapshot", snapshot: { cursor: 5, projects: [] } },
    { t: "event", event: { seq: 6, type: "task.started" } },
    { t: "live", frame: { full: true, lanes: [] }, afterMs: 250 },
  ],
  calls: [
    { tool: "order_get", input: { workstreamId: "ws-1" }, outcome: { ok: true, output: { title: "Ship the storefront" } } },
    { tool: "order_get", outcome: { ok: false, error: { code: "not_found", message: "No such order." } } },
    { tool: "digest_get", outcome: { ok: true, output: {} }, delayMs: 100 },
  ],
};

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "fleetd-fixture-"));
  vi.useFakeTimers();
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  vi.useRealTimers();
});

describe("matches", () => {
  it("is a deep subset on objects and equality on arrays and scalars", () => {
    expect(matches({ a: { b: 1 } }, { a: { b: 1, c: 2 }, d: 3 })).toBe(true);
    expect(matches({ a: { b: 1 } }, { a: { b: 2 } })).toBe(false);
    expect(matches({ a: [1, 2] }, { a: [1, 2] })).toBe(true);
    expect(matches({ a: [1] }, { a: [1, 2] })).toBe(false);
    expect(matches({ a: null }, { a: undefined })).toBe(false);
    expect(matches({}, "x")).toBe(false);
  });
});

describe("fixtureRequest", () => {
  it("takes FLEETD_FIXTURE in a development build", () => {
    expect(fixtureRequest({ FLEETD_FIXTURE: "board-busy" }, false)).toEqual({ kind: "fixture", name: "board-busy" });
    expect(fixtureRequest({}, false)).toEqual({ kind: "none" });
    expect(fixtureRequest({ FLEETD_FIXTURE: "" }, true)).toEqual({ kind: "none" });
  });

  it("ignores a stray FLEETD_FIXTURE in a release build unless FLEETD_DEV_FIXTURES=1 is set too", () => {
    expect(fixtureRequest({ FLEETD_FIXTURE: "board-busy" }, true).kind).toBe("ignored");
    expect(fixtureRequest({ FLEETD_FIXTURE: "board-busy", FLEETD_DEV_FIXTURES: "yes" }, true).kind).toBe("ignored");
    expect(fixtureRequest({ FLEETD_FIXTURE: "board-busy", FLEETD_DEV_FIXTURES: "1" }, true)).toEqual({ kind: "fixture", name: "board-busy" });
  });
});

describe("loadFixture", () => {
  it("finds a name in the fixture dir, or takes an absolute path", () => {
    writeFileSync(join(dir, "board-busy.json"), JSON.stringify(base));
    expect(loadFixture("board-busy", dir).name).toBe("board-busy");
    expect(loadFixture(join(dir, "board-busy.json"), "/nowhere").name).toBe("board-busy");
  });

  it("says how to make a missing file, and what's wrong with a bad one", () => {
    expect(() => loadFixture("nope", dir)).toThrow(/not found; run pnpm fixtures/u);
    writeFileSync(join(dir, "bad.json"), JSON.stringify({ ...base, frames: [{ t: "event", event: { seq: "6" } }] }));
    expect(() => loadFixture("bad", dir)).toThrow(/doesn't match the format/u);
  });
});

describe("FixtureSource", () => {
  it("replays every frame in order with its delay, and a resync restarts the replay", () => {
    const frames: Array<HubFrame> = [];
    const source = new FixtureSource(base, (f) => frames.push(f));
    source.resync();
    expect(frames.map((f) => f.t)).toEqual(["snapshot", "event"]);
    source.resync();
    vi.advanceTimersByTime(250);
    expect(frames.map((f) => f.t)).toEqual(["snapshot", "event", "snapshot", "event", "live"]);
    expect(frames.at(-1)).toEqual({ t: "live", frame: { full: true, lanes: [] } });
  });

  it("replays nothing unless the fixture's state is live", () => {
    const frames: Array<HubFrame> = [];
    new FixtureSource({ ...base, state: { phase: "refused", hub: "http://devbox:4790", message: "No." } }, (f) => frames.push(f)).resync();
    expect(frames).toEqual([]);
  });

  it("answers a call from the first entry whose input matches, after its delay", async () => {
    const source = new FixtureSource(base, () => undefined);
    await expect(source.call({ tool: "order_get", input: { workstreamId: "ws-1", full: true } })).resolves.toMatchObject({ ok: true });
    await expect(source.call({ tool: "order_get", input: { workstreamId: "ws-2" } })).resolves.toMatchObject({ ok: false });
    const slow = source.call({ tool: "digest_get", input: {} });
    vi.advanceTimersByTime(100);
    await expect(slow).resolves.toEqual({ ok: true, output: {} });
  });

  it("answers a call it has no entry for with not_found, loudly", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const source = new FixtureSource(base, () => undefined);
    await expect(source.call({ tool: "status_get", input: { a: 1 } })).resolves.toEqual({
      ok: false,
      error: { code: "not_found", message: 'fixture board-busy has no answer for status_get {"a":1}' },
    });
    expect(warn).toHaveBeenCalledOnce();
  });
});
