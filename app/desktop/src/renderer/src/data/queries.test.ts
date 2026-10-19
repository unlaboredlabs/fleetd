import { QueryObserver } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDataLayer, type HubApi } from "./queries";
import { ask, card, event, live, snapshot } from "./fixtures.test-util";
import type { HubFrame } from "../../../shared/hub";

const fakeHub = () => {
  let listener: (frame: HubFrame) => void = () => undefined;
  const answers: ((output: unknown) => void)[] = [];
  const calls: string[] = [];
  const resyncs = vi.fn(() => Promise.resolve());
  const hub: HubApi = {
    call: (tool) => {
      calls.push(tool);
      return new Promise((resolve) => answers.push((output) => resolve({ ok: true, output })));
    },
    subscribe: (l) => ((listener = l), () => undefined),
    resync: resyncs,
  };
  return { hub, send: (f: HubFrame) => listener(f), answers, calls, resyncs };
};

const board = { at: "2026-10-19T10:00:00.000Z", orders: [card("W1")], trains: [] };

afterEach(() => vi.useRealTimers());

describe("data layer", () => {
  it("drops a board answer meant for the connection before a resync", async () => {
    const fake = fakeHub();
    const layer = createDataLayer(fake.hub);
    layer.start();
    fake.send(live());
    fake.send(snapshot(1));
    const query = layer.queryClient.query(layer.toolQuery("orders_board", {}));
    fake.send(snapshot(2));
    fake.answers[0]?.(board);
    await expect(query).rejects.toThrow();
    expect(layer.store.getState().orders).toBeUndefined();
  });

  it("never lets an answer older than an event overwrite what the event changed", async () => {
    vi.useFakeTimers();
    const fake = fakeHub();
    const layer = createDataLayer(fake.hub);
    layer.start();
    fake.send(live());
    fake.send(snapshot(1));
    const stop = new QueryObserver(layer.queryClient, layer.toolQuery("asks_list", { state: "open" })).subscribe(() => undefined);
    await vi.advanceTimersByTimeAsync(0);
    // The ask is answered while the first list is on its way; that list still has it open.
    fake.send(event(2, "ask.answered", { askId: "A1", workstreamId: "W1" }));
    await vi.advanceTimersByTimeAsync(150);
    expect(fake.calls).toEqual(["asks_list"]);
    fake.answers[0]?.({ asks: [ask("A1", "W1")], batches: [] });
    await vi.advanceTimersByTimeAsync(0);
    expect(layer.store.getState().asks).toBeUndefined();
    expect(fake.calls).toEqual(["asks_list", "asks_list"]);
    fake.answers[1]?.({ asks: [], batches: [] });
    await vi.advanceTimersByTimeAsync(0);
    expect(layer.store.getState().asks).toEqual({});
    stop();
  });

  it("drops every cached answer when the link goes down", async () => {
    const fake = fakeHub();
    const layer = createDataLayer(fake.hub);
    layer.start();
    fake.send(live());
    fake.send(snapshot(1));
    const query = layer.queryClient.query(layer.toolQuery("status_get", { scope: { kind: "fleet" } }));
    fake.answers[0]?.({ doc: {} });
    await query;
    expect(layer.queryClient.getQueryData(["call", "status_get", { scope: { kind: "fleet" } }])).toBeDefined();
    fake.send({ t: "state", state: { phase: "retrying", hub: "devbox:4710", reason: "closed", retryAt: 1 } });
    expect(layer.queryClient.getQueryData(["call", "status_get", { scope: { kind: "fleet" } }])).toBeUndefined();
  });

  it("coalesces a burst of events into one refetch, and refetches nothing for a repeat", async () => {
    vi.useFakeTimers();
    const fake = fakeHub();
    const layer = createDataLayer(fake.hub);
    layer.start();
    fake.send(live());
    fake.send(snapshot(1));
    // A mounted screen's query.
    const stop = new QueryObserver(layer.queryClient, layer.toolQuery("orders_board", {})).subscribe(() => undefined);
    await vi.advanceTimersByTimeAsync(0);
    fake.answers[0]?.(board);
    await vi.advanceTimersByTimeAsync(0);
    expect(fake.calls).toEqual(["orders_board"]);

    fake.send(event(2, "task.started", { workstreamId: "W1" }));
    fake.send(event(3, "task.completed", { workstreamId: "W1" }));
    await vi.advanceTimersByTimeAsync(150);
    expect(fake.calls).toEqual(["orders_board", "orders_board"]);
    fake.answers[1]?.(board);
    fake.send(event(3, "task.completed", { workstreamId: "W1" }));
    await vi.advanceTimersByTimeAsync(150);
    expect(fake.calls).toHaveLength(2);

    fake.send(event(4, "project.added"));
    expect(fake.resyncs).toHaveBeenCalledTimes(1);
    stop();
  });
});
