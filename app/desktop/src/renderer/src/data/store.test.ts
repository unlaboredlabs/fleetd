import { describe, expect, it } from "vitest";
import { applyFrame, applyLive, ingest, initialState, type DataState } from "./store";
import { selectBoard, selectConnection, selectInbox, selectOrder } from "./selectors";
import { ask, card, event, lane, live, liveLane, project, snapshot } from "./fixtures.test-util";
import type { HubFrame } from "../../../shared/hub";

const run = (frames: readonly HubFrame[], from: DataState = initialState()): DataState =>
  frames.reduce((s, f) => applyFrame(s, f, Date.parse("2026-10-19T10:00:00.000Z"))[0], from);

const withBoard = (s: DataState, cards = [card("W1")]): DataState =>
  ingest(s, { tool: "orders_board", input: {}, output: { at: "2026-10-19T10:00:00.000Z", orders: cards, trains: [] } });

const withAsks = (s: DataState, asks = [ask("A1", "W1")]): DataState =>
  ingest(s, {
    tool: "asks_list",
    input: { state: "open" },
    output: { asks, batches: [{ batchId: "B1", state: "open", createdAt: "2026-10-19T10:00:00.000Z", items: [] }] },
  });

describe("connection", () => {
  it("shows skeletons until a snapshot lands after every (re)connect, and drops the old connection's call data", () => {
    let s = run([live()]);
    expect(selectConnection(s).view).toBe("skeleton");
    s = withAsks(withBoard(run([snapshot(10)], s)));
    expect(selectConnection(s).view).toBe("live");
    expect(selectBoard(s)).toHaveLength(1);

    s = run([{ t: "state", state: { phase: "retrying", hub: "devbox:4710", reason: "closed", retryAt: 1 } }, live()], s);
    expect(selectConnection(s).view).toBe("skeleton");
    expect(s.live.stale).toBe(true);
    s = run([snapshot(12)], s);
    expect(selectConnection(s).view).toBe("live");
    expect(selectBoard(s)).toBeUndefined();
    expect(selectInbox(s)).toBeUndefined();
  });

  it("ignores an event it already applied", () => {
    const s = run([live(), snapshot(10), event(9, "workstream.state", { workstreamId: "W1", state: "failed" })]);
    expect(s.cursor).toBe(10);
    expect(s.events).toHaveLength(0);
  });
});

describe("needs you", () => {
  const start = () => withAsks(withBoard(run([live(), snapshot(10)]), [card("W1", { phase: "waiting_on_you", needsYou: 1 })]));

  it("comes from the open asks now, not the count the board cached", () => {
    let s = start();
    expect(selectBoard(s)?.[0]?.phase).toEqual({ phase: "waiting_on_you", detail: "1 question" });
    s = run([event(11, "ask.closed", { askId: "A1", workstreamId: "W1", state: "answered" })], s);
    // The card still says needsYou 1 until its refetch; the phase already moved on.
    expect(s.orders?.["W1"]?.needsYou).toBe(1);
    expect(selectBoard(s)?.[0]?.phase.phase).toBe("working");
    expect(selectInbox(s)).toEqual([]);
    s = run([event(12, "ask.undone", { askId: "A1" })], s);
    expect(selectInbox(s)?.map((i) => i.ask.askId)).toEqual(["A1"]);
  });

  it("drops an open ask a fresh list or order no longer has", () => {
    let s = withAsks(start(), []);
    expect(selectOrder("W1")(s)?.asks).toEqual([]);
    s = withAsks(s, [ask("A2", "W1")]);
    s = ingest(s, {
      tool: "order_get",
      input: { workstreamId: "W1" },
      output: { order: card("W1"), asks: [], doneLanes: [lane("T0", "done")] },
    });
    expect(selectOrder("W1")(s)?.asks).toEqual([]);
    expect(selectOrder("W1")(s)?.detail?.doneLanes).toHaveLength(1);
  });

  it("counts a lane waiting on a permission, from the live feed", () => {
    let s = withAsks(start(), []);
    s = run([{ t: "live", frame: { at: "2026-10-19T10:00:01.000Z", full: true, lanes: [liveLane("T1", "waiting")] } }], s);
    expect(selectBoard(s)?.[0]?.phase).toEqual({ phase: "waiting_on_you", detail: "1 approval" });
  });
});

describe("events patch what they change", () => {
  it("moves an order's state and resorts the board", () => {
    let s = withAsks(withBoard(run([live(), snapshot(1)]), [card("W1"), card("W2", { updatedAt: "2026-10-19T09:00:00.000Z" })]), []);
    expect(selectBoard(s)?.map((o) => o.card.workstreamId)).toEqual(["W1", "W2"]);
    s = run([event(2, "workstream.state", { workstreamId: "W2", state: "failed" })], s);
    expect(selectBoard(s)?.map((o) => [o.card.workstreamId, o.phase.phase])).toEqual([
      ["W2", "failed"],
      ["W1", "working"],
    ]);
    expect(s.orderEvents["W2"]).toHaveLength(1);
  });

  it("scoped boards replace only their project's orders", () => {
    let s = withBoard(run([live(), snapshot(1)]), [card("W1"), card("W9", { projectRef: { machineId: "buildbox", projectId: "acme" } })]);
    s = ingest(s, {
      tool: "orders_board",
      input: { projectRef: project },
      output: { at: "2026-10-19T10:00:00.000Z", orders: [card("W3")], trains: [] },
    });
    expect(Object.keys(s.orders ?? {}).sort()).toEqual(["W3", "W9"]);
  });
});

describe("live frames", () => {
  const frame = (full: boolean, lanes: ReturnType<typeof liveLane>[], at = "2026-10-19T10:00:02.000Z") => ({ at, full, lanes });
  const spark = { endAt: "2026-10-19T10:00:00.000Z", samples: [1, 2, 3] };

  it("keeps a lane's sparkline across deltas that omit it, but not its activity", () => {
    let l = applyLive(initialState().live, frame(true, [liveLane("T1", "working", { spark, activity: { activity: { kind: "writing" }, since: "2026-10-19T10:00:00.000Z" } })]), 0);
    l = applyLive(l, frame(false, [liveLane("T1", "working")]), 0);
    expect(l.lanes["T1"]?.spark).toEqual(spark);
    expect(l.lanes["T1"]?.activity).toBeUndefined();
    l = applyLive(l, frame(true, [liveLane("T2", "queued")]), 0);
    expect(Object.keys(l.lanes)).toEqual(["T2"]);
  });

  it("appends streamed text per message, keeping a 2000-unit tail", () => {
    let l = applyLive(initialState().live, { ...frame(false, []), text: [{ laneId: "L", messageId: "m1", append: "Hello " }, { laneId: "L", messageId: "m1", append: "there" }] }, 0);
    expect(l.text["L"]).toEqual({ messageId: "m1", text: "Hello there" });
    l = applyLive(l, { ...frame(false, []), text: [{ laneId: "L", messageId: "m2", append: "é".repeat(1500) }, { laneId: "L", messageId: "m2", append: "x".repeat(1000) }] }, 0);
    expect(l.text["L"]?.text).toHaveLength(2000);
    expect(l.text["L"]?.text.startsWith("é")).toBe(true);
  });

  it("takes the least delayed frame's skew, resetting on a full frame", () => {
    const at = (ms: number) => new Date(ms).toISOString();
    let l = applyLive(initialState().live, frame(true, [], at(10_000)), 10_500);
    expect(l.skewMs).toBe(-500);
    l = applyLive(l, frame(false, [], at(11_000)), 11_100);
    expect(l.skewMs).toBe(-100);
    l = applyLive(l, frame(false, [], at(12_000)), 12_900);
    expect(l.skewMs).toBe(-100);
    l = applyLive(l, frame(true, [], at(13_000)), 13_700);
    expect(l.skewMs).toBe(-700);
  });
});
