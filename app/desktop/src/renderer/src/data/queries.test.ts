import { QueryObserver } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import { boardRefreshAt, createDataLayer, DONE_HOLD_MS, type HubApi } from "./queries";
import { card, event, live, snapshot } from "./fixtures.test-util";
import type { HubFrame } from "../../../shared/hub";

const fakeHub = () => {
  let listener: (frame: HubFrame) => void = () => undefined;
  const answers: ((output: unknown) => void)[] = [];
  const calls: string[] = [];
  const inputs: unknown[] = [];
  const resyncs = vi.fn(() => Promise.resolve());
  const lives = vi.fn((_scope: unknown) => Promise.resolve());
  const hub: HubApi = {
    call: (tool, input) => {
      calls.push(tool);
      inputs.push(input);
      return new Promise((resolve) => answers.push((output) => resolve({ ok: true, output })));
    },
    subscribe: (l) => ((listener = l), () => undefined),
    resync: resyncs,
    live: lives,
    chat: () => Promise.resolve(),
  };
  return { hub, send: (f: HubFrame) => listener(f), answers, calls, inputs, resyncs, lives };
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
    const stop = new QueryObserver(layer.queryClient, layer.toolQuery("orders_board", {})).subscribe(() => undefined);
    await vi.advanceTimersByTimeAsync(0);
    // The order fails while the first board is on its way; that board still has it running.
    fake.send(event(2, "workstream.state", { workstreamId: "W1", state: "failed" }));
    await vi.advanceTimersByTimeAsync(150);
    expect(fake.calls).toEqual(["orders_board"]);
    fake.answers[0]?.(board);
    await vi.advanceTimersByTimeAsync(0);
    expect(layer.store.getState().orders).toBeUndefined();
    expect(fake.calls).toEqual(["orders_board", "orders_board"]);
    fake.answers[1]?.({ ...board, orders: [card("W1", { state: "failed" })] });
    await vi.advanceTimersByTimeAsync(0);
    expect(layer.store.getState().orders?.["W1"]?.state).toBe("failed");
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

  it("holds a finished order on the board for 10 minutes, then refetches once to drop it", async () => {
    vi.useFakeTimers();
    const t0 = Date.parse("2026-10-19T10:00:00.000Z");
    vi.setSystemTime(t0);
    const fake = fakeHub();
    const layer = createDataLayer(fake.hub);
    layer.start();
    fake.send(live());
    fake.send(snapshot(1));
    const stop = new QueryObserver(layer.queryClient, layer.toolQuery("orders_board", {})).subscribe(() => undefined);
    await vi.advanceTimersByTimeAsync(0);
    expect(fake.inputs[0]).toEqual({ includeDoneSince: new Date(t0 - DONE_HOLD_MS).toISOString() });
    // Finished 9 minutes ago: one minute of hold left.
    const done = card("W1", { state: "done", phase: "done", updatedAt: new Date(t0 - 9 * 60_000).toISOString() });
    fake.answers[0]?.({ ...board, orders: [done, card("W2")] });
    await vi.advanceTimersByTimeAsync(59_000);
    expect(fake.calls).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(fake.calls).toHaveLength(2);
    expect(fake.inputs[1]).toEqual({ includeDoneSince: new Date(t0 + 61_000 - DONE_HOLD_MS).toISOString() });
    fake.answers[1]?.({ ...board, orders: [card("W2")] });
    await vi.advanceTimersByTimeAsync(20 * 60_000);
    expect(fake.calls).toHaveLength(2);
    expect(Object.keys(layer.store.getState().orders ?? {})).toEqual(["W2"]);
    stop();
  });
});

describe("read numbers", () => {
  it("say which read the cache holds, and a read that went out before a reset never wins over a newer one", async () => {
    const fake = fakeHub();
    const layer = createDataLayer(fake.hub);
    layer.start();
    fake.send(live());
    fake.send(snapshot(1));
    const input = { limit: 100 } as const;
    const first = layer.queryClient.query(layer.toolQuery("requests_list", input));
    const mark = layer.readsStarted();
    fake.answers[0]?.({ requests: [] });
    await first;
    expect(layer.readOf("requests_list", input)).toBe(mark);

    // Two reads out at once (one a reset made moot): the newer answers first, then the older lands.
    void layer.queryClient.query({ ...layer.toolQuery("requests_list", input), staleTime: 0 }).catch(() => undefined);
    await layer.queryClient.resetQueries();
    const newer = layer.queryClient.query({ ...layer.toolQuery("requests_list", input), staleTime: 0 });
    expect(layer.readsStarted()).toBe(mark + 2);
    fake.answers[2]?.({ requests: [] });
    await newer;
    fake.answers[1]?.({ requests: [] });
    await Promise.resolve();
    expect(layer.readOf("requests_list", input)).toBe(mark + 2);
  });
});

describe("writes", () => {
  const connected = () => {
    const fake = fakeHub();
    const layer = createDataLayer(fake.hub);
    layer.start();
    fake.send(live());
    fake.send(snapshot(1));
    return { fake, layer };
  };

  it("shows a saved max agents at once, over the last live frame's slots", async () => {
    const { fake, layer } = connected();
    const ref = { machineId: "devbox", projectId: "storefront" };
    const before = { cap: 16, used: 6, queued: 0, reservedBand: 2, perProject: [{ projectRef: ref, maxAgents: 12, running: 6, queued: 0, used: 7 }] };
    fake.send({ t: "live", frame: { at: "2026-10-19T10:00:00.000Z", full: true, lanes: [], slots: before } });
    const out = layer.call("cap_set", { project: { projectRef: ref, maxAgents: 4 } });
    const after = { ...before, perProject: [{ ...before.perProject[0], maxAgents: 4 }] };
    fake.answers.at(-1)?.({ slots: after });
    await out;
    expect(layer.store.getState().live.slots?.perProject[0]?.maxAgents).toBe(4);
    expect(layer.store.getState().slots?.perProject[0]?.maxAgents).toBe(4);
  });});

describe("live scope", () => {
  it("sends only changes, and stops when nothing wants live values", () => {
    const fake = fakeHub();
    const layer = createDataLayer(fake.hub);
    layer.setLive({ board: true });
    layer.setLive({ board: true });
    layer.setLive({ board: true, focus: "W1" });
    layer.setLive({ focus: "W1" });
    layer.setLive({});
    layer.setLive({ board: false });
    expect(fake.lives.mock.calls.map(([scope]) => scope)).toEqual([
      { board: true },
      { board: true, focus: "W1" },
      { board: false, focus: "W1" },
      null,
    ]);
  });
});

describe("board hold", () => {
  const at = (iso: string) => Date.parse(iso);
  it("is the earliest hold still running, ignoring open orders and holds already over", () => {
    const now = at("2026-10-19T10:00:00.000Z");
    const orders = {
      W1: card("W1", { state: "done", updatedAt: "2026-10-19T09:55:00.000Z" }),
      W2: card("W2", { state: "done", updatedAt: "2026-10-19T09:52:00.000Z" }),
      W3: card("W3", { state: "done", updatedAt: "2026-10-19T09:40:00.000Z" }),
      W4: card("W4", { state: "running", updatedAt: "2026-10-19T09:51:00.000Z" }),
    };
    expect(boardRefreshAt(orders, now)).toBe(at("2026-10-19T10:02:00.000Z"));
    expect(boardRefreshAt({ W4: orders.W4 }, now)).toBeUndefined();
    expect(boardRefreshAt(undefined, now)).toBeUndefined();
  });
});
