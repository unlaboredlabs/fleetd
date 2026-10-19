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

describe("what answering a call changes", () => {
  const asks = [{ askId: "A1" }, { askId: "A2" }];
  const file: FixtureFile = {
    ...base,
    frames: [],
    calls: [
      {
        tool: "inbox_reply",
        input: { raw: "1 go" },
        outcome: { ok: true, output: { parsed: true } },
        then: {
          frames: [
            { t: "event", event: { seq: 7, type: "ask.answered" }, afterMs: 50 },
            { t: "event", event: { seq: 8, type: "ask.delivered" }, afterMs: 10_000 },
          ],
          hide: [{ tool: "asks_list", field: "asks", where: { askId: "A1" } }],
        },
      },
      {
        tool: "inbox_undo",
        outcome: { ok: true, output: {} },
        then: { show: [{ tool: "asks_list", field: "asks", where: { askId: "A1" } }] },
      },
      { tool: "asks_list", outcome: { ok: true, output: { asks } } },
    ],
  };

  it("emits the call's frames after it and leaves the rows it answered out of later reads, until undone", async () => {
    const frames: HubFrame[] = [];
    const source = new FixtureSource(file, (f) => frames.push(f));
    const ids = async () => {
      const out = await source.call({ tool: "asks_list", input: {} });
      return out.ok ? (out.output as { asks: Array<{ askId: string }> }).asks.map((a) => a.askId) : [];
    };
    expect(await ids()).toEqual(["A1", "A2"]);
    await source.call({ tool: "inbox_reply", input: { raw: "1 go" } });
    expect(await ids()).toEqual(["A2"]);
    vi.advanceTimersByTime(50);
    expect(frames.map((f) => (f.t === "event" ? f.event.type : f.t))).toEqual(["ask.answered"]);
    vi.advanceTimersByTime(10_000);
    expect(frames.map((f) => (f.t === "event" ? f.event.type : f.t))).toEqual(["ask.answered", "ask.delivered"]);
    // Numbered in the order they were sent, whatever the file said, so the app never drops one as already seen.
    expect(frames.map((f) => (f.t === "event" ? f.event.seq : 0))).toEqual([1, 2]);
    await source.call({ tool: "inbox_undo", input: { askId: "A1" } });
    expect(await ids()).toEqual(["A1", "A2"]);
  });
});
