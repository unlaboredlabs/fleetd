import { QueryObserver } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDataLayer, type HubApi } from "./queries";
import { card, event, live, snapshot } from "./fixtures.test-util";
import type { HubFrame } from "../../../shared/hub";

const fakeHub = () => {
  let listener: (frame: HubFrame) => void = () => undefined;
  const answers: ((output: unknown) => void)[] = [];
  const calls: string[] = [];
  const inputs: unknown[] = [];
  const resyncs = vi.fn(() => Promise.resolve());
  const hub: HubApi = {
    call: (tool, input) => {
      calls.push(tool);
      inputs.push(input);
      return new Promise((resolve) => answers.push((output) => resolve({ ok: true, output })));
    },
    subscribe: (l) => ((listener = l), () => undefined),
    resync: resyncs,
    chat: () => Promise.resolve(),
    focus: () => Promise.resolve(),
  };
  return { hub, send: (f: HubFrame) => listener(f), answers, calls, inputs, resyncs };
};

const board = { at: "2026-10-19T10:00:00.000Z", orders: [card("W1")], trains: [] };

afterEach(() => vi.useRealTimers());

describe("data layer", () => {
  it("drops a board answer meant for the store before a resync, and marks the board to read again", async () => {
    const fake = fakeHub();
    const layer = createDataLayer(fake.hub);
    layer.start();
    fake.send(live());
    fake.send(snapshot(1));
    const query = layer.queryClient.query(layer.toolQuery("orders_board", {}));
    fake.send(snapshot(2));
    fake.answers[0]?.(board);
    await query;
    expect(layer.store.getState().orders).toBeUndefined();
    expect(layer.queryClient.getQueryState(["call", "orders_board", {}])?.isInvalidated).toBe(true);
  });

  it("keeps every cached answer through a resync on a link that stayed up, and reads each again", async () => {
    const fake = fakeHub();
    const layer = createDataLayer(fake.hub);
    layer.start();
    fake.send(live());
    fake.send(snapshot(1));
    const key = ["call", "status_get", { projectRef: { machineId: "devbox", projectId: "p1" } }];
    const stop = new QueryObserver(layer.queryClient, layer.toolQuery("status_get", { projectRef: { machineId: "devbox", projectId: "p1" } })).subscribe(() => undefined);
    await vi.waitFor(() => expect(fake.answers).toHaveLength(1));
    fake.answers[0]?.({ doc: { v: 1 } });
    await vi.waitFor(() => expect(layer.queryClient.getQueryData(key)).toEqual({ doc: { v: 1 } }));
    // A saved setting's project.settings event: the app asks for a snapshot, which comes on the same link.
    fake.send(event(2, "project.settings"));
    expect(fake.resyncs).toHaveBeenCalledTimes(1);
    fake.send(snapshot(2));
    await vi.waitFor(() => expect(fake.calls).toEqual(["status_get", "status_get"]));
    expect(layer.queryClient.getQueryData(key)).toEqual({ doc: { v: 1 } });
    fake.answers[1]?.({ doc: { v: 2 } });
    await vi.waitFor(() => expect(layer.queryClient.getQueryData(key)).toEqual({ doc: { v: 2 } }));
    stop();
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
    // The order stops while the first board is on its way; that board still has it running.
    fake.send(event(2, "workstream.state", { workstreamId: "W1", state: "stopped" }));
    await vi.advanceTimersByTimeAsync(150);
    expect(fake.calls).toEqual(["orders_board"]);
    fake.answers[0]?.(board);
    await vi.advanceTimersByTimeAsync(0);
    expect(layer.store.getState().orders).toBeUndefined();
    expect(layer.queryClient.getQueryState(["call", "orders_board", {}])?.isInvalidated).toBe(true);
    fake.answers[1]?.({ ...board, orders: [card("W1", { state: "stopped" })] });
    await vi.advanceTimersByTimeAsync(0);
    expect(layer.store.getState().orders?.["W1"]?.state).toBe("stopped");
    stop();
  });

  it("drops every cached answer when the link goes down", async () => {
    const fake = fakeHub();
    const layer = createDataLayer(fake.hub);
    layer.start();
    fake.send(live());
    fake.send(snapshot(1));
    const query = layer.queryClient.query(layer.toolQuery("status_get", { projectRef: { machineId: "devbox", projectId: "p1" } }));
    fake.answers[0]?.({ doc: {} });
    await query;
    expect(layer.queryClient.getQueryData(["call", "status_get", { projectRef: { machineId: "devbox", projectId: "p1" } }])).toBeDefined();
    fake.send({ t: "state", state: { phase: "retrying", hub: "devbox:4710", reason: "closed", retryAt: 1 } });
    expect(layer.queryClient.getQueryData(["call", "status_get", { projectRef: { machineId: "devbox", projectId: "p1" } }])).toBeUndefined();
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

  it("reads the work elsewhere once for a run of task and change events, two seconds after the first", async () => {
    vi.useFakeTimers();
    const fake = fakeHub();
    const layer = createDataLayer(fake.hub);
    layer.start();
    fake.send(live());
    fake.send(snapshot(1));
    const input = { projectRef: { machineId: "devbox", projectId: "storefront" }, paths: false };
    const stop = new QueryObserver(layer.queryClient, layer.toolQuery("work_list", input)).subscribe(() => undefined);
    await vi.advanceTimersByTimeAsync(0);
    fake.answers[0]?.({ scope: { repoKey: "github.com/acme/storefront", base: "main" }, items: [], recentLandings: [] });
    await vi.advanceTimersByTimeAsync(0);
    expect(fake.calls).toEqual(["work_list"]);

    for (let n = 2; n < 12; n++) {
      fake.send(event(n, n % 2 === 0 ? "task.started" : "change.state", { workstreamId: "W1" }));
      await vi.advanceTimersByTimeAsync(150);
    }
    expect(fake.calls.filter((t) => t === "work_list")).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(600);
    expect(fake.calls.filter((t) => t === "work_list")).toHaveLength(2);
    expect(fake.inputs.at(-1)).toEqual(input);
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
    const before = { cap: 16, used: 6, queued: 0, perProject: [{ projectRef: ref, maxAgents: 12, running: 6, queued: 0 }] };
    fake.send({ t: "live", frame: { at: "2026-10-19T10:00:00.000Z", full: true, lanes: [], slots: before } });
    const out = layer.call("cap_set", { project: { projectRef: ref, maxAgents: 4 } });
    const after = { ...before, perProject: [{ ...before.perProject[0], maxAgents: 4 }] };
    fake.answers.at(-1)?.({ slots: after });
    await out;
    expect(layer.store.getState().live.slots?.perProject[0]?.maxAgents).toBe(4);
    expect(layer.store.getState().slots?.perProject[0]?.maxAgents).toBe(4);
  });
});
