import { describe, expect, it, vi } from "vitest";
import { type FixtureFile, FixtureSource, fixtureRequest } from "./fixture";

describe("fixtureRequest", () => {
  it("takes FLEETD_FIXTURE in a development build", () => {
    expect(fixtureRequest({ FLEETD_FIXTURE: "board-busy" }, false)).toEqual({ kind: "fixture", name: "board-busy" });
    expect(fixtureRequest({}, false)).toEqual({ kind: "none" });
    expect(fixtureRequest({ FLEETD_FIXTURE: "" }, true)).toEqual({ kind: "none" });
  });

  it("ignores FLEETD_FIXTURE in a release build", () => {
    expect(fixtureRequest({ FLEETD_FIXTURE: "board-busy" }, true).kind).toBe("ignored");
  });
});

describe("FixtureSource rows", () => {
  const file = (over: Partial<FixtureFile>): FixtureFile => ({
    version: 1,
    name: "rows",
    note: "",
    now: "2026-10-19T10:30:00.000Z",
    state: { phase: "live", hub: "http://devbox:4790", protocol: 1 },
    frames: [],
    calls: [{ tool: "pr_list", outcome: { ok: true, output: { prs: [{ number: 1, state: "open" }, { number: 1, state: "merged" }] } } }],
    ...over,
  });
  const states = async (source: FixtureSource) => {
    const out = await source.call({ tool: "pr_list", input: {} });
    return out.ok ? (out.output as { prs: Array<{ state: string }> }).prs.map((p) => p.state) : [];
  };
  const merged = { tool: "pr_list", field: "prs", where: { state: "merged" } };
  const open = { tool: "pr_list", field: "prs", where: { state: "open" } };

  it("leaves out the file's hidden rows until a rows frame shows them", async () => {
    vi.useFakeTimers();
    try {
      const source = new FixtureSource(file({ hidden: [merged], frames: [{ t: "rows", hide: [open], show: [merged], afterMs: 500 }] }), () => {});
      source.resync();
      expect(await states(source)).toEqual(["open"]);
      vi.advanceTimersByTime(500);
      expect(await states(source)).toEqual(["merged"]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("plays a call's rows frames after it, without sending them to the window", async () => {
    vi.useFakeTimers();
    try {
      const sent: string[] = [];
      const calls = [
        { tool: "chat_send", outcome: { ok: true as const, output: {} }, then: { frames: [{ t: "rows" as const, hide: [open], show: [merged], afterMs: 300 }] } },
        ...file({}).calls,
      ];
      const source = new FixtureSource(file({ hidden: [merged], calls }), (frame) => sent.push(frame.t));
      await source.call({ tool: "chat_send", input: {} });
      expect(await states(source)).toEqual(["open"]);
      vi.advanceTimersByTime(300);
      expect(await states(source)).toEqual(["merged"]);
      expect(sent).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("FixtureSource chat_send", () => {
  it("answers with the message under the sender's clientRequestId, as a hub keeps it", async () => {
    const message = { messageId: "m10", text: "hi", clientRequestId: "qa-10" };
    const source = new FixtureSource(
      {
        version: 1,
        name: "send",
        note: "",
        now: "2026-10-19T10:30:00.000Z",
        state: { phase: "live", hub: "http://devbox:4790", protocol: 1 },
        frames: [],
        calls: [{ tool: "chat_send", outcome: { ok: true, output: { message } } }],
      },
      () => undefined,
    );
    const out = await source.call({ tool: "chat_send", input: { text: "hi", clientRequestId: "c-1" } });
    expect(out).toEqual({ ok: true, output: { message: { ...message, clientRequestId: "c-1" } } });
  });
});
