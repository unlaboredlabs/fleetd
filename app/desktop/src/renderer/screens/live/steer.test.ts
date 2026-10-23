import { QueryObserver } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Steer } from "../../../shared/contracts";
import { createDataLayer, type HubApi } from "../../src/data/queries";
import { card, event, live, snapshot } from "../../src/data/fixtures.test-util";
import type { HubFrame } from "../../../shared/hub";
import { composerSendOn, receiptsToShow, steerModeOn, steersFor, steerReceipt, steerTooLong } from "./steerModel";

const key = (k: Partial<Parameters<typeof steerModeOn>[0]> = {}) => ({ key: "Enter", shiftKey: false, altKey: false, metaKey: false, ctrlKey: false, isComposing: false, ...k });

const steer = (n: number, stage: Steer["stage"], more: Partial<Steer> = {}): Steer => ({
  id: `S${String(n)}`,
  target: { taskId: "T1" },
  workstreamId: "W1",
  thread: { machineId: "devbox", threadId: "t1" },
  runId: `r${String(n)}`,
  by: { kind: "human", keyName: "laptop" },
  mode: "queue",
  text: "use the store's zone",
  stage,
  queuedAt: "2026-10-19T10:00:00.000Z",
  ...more,
});

afterEach(() => vi.useRealTimers());

describe("steering keys", () => {
  it("sends ⌘Enter (Ctrl+Enter) now and Enter at the next step; Shift+Enter and an IME's Enter never send", () => {
    expect(steerModeOn(key({ metaKey: true }))).toBe("now");
    expect(steerModeOn(key({ ctrlKey: true }))).toBe("now");
    expect(steerModeOn(key())).toBe("queue");
    expect(steerModeOn(key({ shiftKey: true }))).toBeUndefined();
    expect(steerModeOn(key({ metaKey: true, isComposing: true }))).toBeUndefined();
    expect(steerModeOn(key({ key: "a", metaKey: true }))).toBeUndefined();
  });

  it("in the lead's box, ⌘Enter sends now whenever it works; otherwise, and on Enter, a plain chat message", () => {
    expect(composerSendOn(key({ metaKey: true }), true)).toBe("now");
    expect(composerSendOn(key(), true)).toBe("chat");
    expect(composerSendOn(key({ metaKey: true }), false)).toBe("chat");
    expect(composerSendOn(key({ shiftKey: true }), true)).toBeUndefined();
  });

  it("refuses a steer over steer_send's limit before it goes", () => {
    expect(steerTooLong("x".repeat(4000))).toBeUndefined();
    expect(steerTooLong("x".repeat(4001))).toMatch(/at most 4,000/);
  });
});

describe("steer receipts", () => {
  it("words every stage, offers Withdraw only while queued, and never shows the hub's ids", () => {
    const lines = (["queued", "delivered", "acknowledged", "unacknowledged", "withdrawn", "failed", "expired"] as const).map((st) => steerReceipt(steer(1, st)));
    expect(lines.map((r) => r.withdraw)).toEqual([true, false, false, false, false, false, false]);
    expect(lines.map((r) => r.tone)).toEqual(["quiet", "quiet", "quiet", "warn", "quiet", "bad", "bad"]);
    expect(steerReceipt(steer(1, "delivered", { how: "stopped", stoppedTool: "pnpm test" })).line).toMatch(/stopped its step/);
    expect(steerReceipt(steer(1, "acknowledged", { ackExcerpt: "On it." })).quote).toBe("On it.");
    expect(steerReceipt(steer(1, "failed", { detail: "thread is closed" })).detail).toBe("thread is closed");
    const waiting = steerReceipt(steer(1, "queued", { detail: "queued until T1 starts; it gets this with its next run" }));
    expect(waiting.line).toBe("Queued: it gets this when it starts");
    expect(waiting.line).not.toMatch(/T1/);
  });

  it("keeps a sent steer as the hub answered until the list has it, then the list's; never the lead's own", () => {
    const sent = [steer(7, "queued")];
    expect(receiptsToShow(undefined, sent).map((x) => x.stage)).toEqual(["queued"]);
    const listed = [steer(7, "delivered"), steer(6, "acknowledged"), steer(5, "acknowledged", { by: { kind: "lead" } })];
    expect(receiptsToShow(listed, sent).map((x) => `${x.id} ${x.stage}`)).toEqual(["S7 delivered", "S6 acknowledged"]);
  });

  it("shows an agent only its own steers from its order's", () => {
    const order = [steer(3, "queued", { target: { workstreamId: "W1" } }), steer(2, "queued", { target: { taskId: "T2" } }), steer(1, "queued")];
    expect(steersFor(order, "T1")?.map((x) => x.id)).toEqual(["S1"]);
  });
});

describe("the steer calls", () => {
  const fakeHub = () => {
    let listener: (frame: HubFrame) => void = () => undefined;
    const calls: { tool: string; input: unknown }[] = [];
    const answers: ((output: unknown) => void)[] = [];
    const hub: HubApi = {
      call: (tool, input) => {
        calls.push({ tool, input });
        return new Promise((resolve) => answers.push((output) => resolve({ ok: true, output })));
      },
      subscribe: (l) => ((listener = l), () => undefined),
      resync: () => Promise.resolve(),
      chat: () => Promise.resolve(),
      focus: () => Promise.resolve(),
    };
    return { hub, send: (f: HubFrame) => listener(f), calls, answers };
  };

  it("sends an agent's steer to that task, and reads its receipt again on each of its steer events", async () => {
    vi.useFakeTimers();
    const fake = fakeHub();
    const layer = createDataLayer(fake.hub);
    layer.start();
    fake.send(live());
    fake.send(snapshot(1));
    const target = { taskId: "T1" };
    const read = { workstreamId: "W1" };
    const answer = (stage: Steer["stage"]) => ({ order: card("W1"), doneLanes: [], requests: [], steers: [steer(7, stage)] });
    const stop = new QueryObserver(layer.queryClient, layer.toolQuery("order_get", read)).subscribe(() => undefined);
    await vi.advanceTimersByTimeAsync(0);
    fake.answers.shift()?.({ order: card("W1"), doneLanes: [], requests: [], steers: [] });

    const sending = layer.call("steer_send", { target, text: "use the store's zone", mode: "now", clientRequestId: "c1" });
    expect(fake.calls.at(-1)).toEqual({ tool: "steer_send", input: { target: { taskId: "T1" }, text: "use the store's zone", mode: "now", clientRequestId: "c1" } });
    fake.answers.shift()?.(steer(7, "queued", { mode: "now" }));
    await sending;

    for (const [seq, type] of [
      [2, "steer.delivered"],
      [3, "steer.acknowledged"],
    ] as const) {
      const before = fake.calls.length;
      fake.send(event(seq, type, { steerId: "S7", workstreamId: "W1", taskId: "T1", stage: type.slice(6) }));
      await vi.advanceTimersByTimeAsync(150);
      expect(fake.calls.slice(before).filter((c) => c.tool === "order_get")).toEqual([{ tool: "order_get", input: read }]);
      const stage = type === "steer.delivered" ? "delivered" : "acknowledged";
      fake.answers.splice(0).forEach((reply, i) => reply(fake.calls[before + i]?.tool === "order_get" ? answer(stage) : {}));
      await vi.advanceTimersByTimeAsync(0);
      expect(steersFor(layer.queryClient.getQueryData<{ steers: Steer[] }>(["call", "order_get", read])?.steers, "T1")?.[0]?.stage).toBe(stage);
    }
    stop();
  });
});
