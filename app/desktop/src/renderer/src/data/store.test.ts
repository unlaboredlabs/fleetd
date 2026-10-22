import { describe, expect, it } from "vitest";
import { applyFrame, applyLive, applyStreams, ingest, initialState, type DataState } from "./store";
import { projectStateWord, selectBoard, selectConnection, selectLiveAgents, selectNeedsYou, selectOrder, selectProjectList, selectProjectRow } from "./selectors";
import type { AgentRow } from "./agents-contract";
import { card, event, lane, live, liveLane, project, snapshot } from "./fixtures.test-util";
import type { HubFrame } from "../../../shared/hub";

const run = (frames: readonly HubFrame[], from: DataState = initialState()): DataState =>
  frames.reduce((s, f) => applyFrame(s, f, Date.parse("2026-10-19T10:00:00.000Z"))[0], from);

const withBoard = (s: DataState, cards = [card("W1")]): DataState =>
  ingest(s, { tool: "orders_board", input: {}, output: { at: "2026-10-19T10:00:00.000Z", orders: cards, trains: [] } });

describe("connection", () => {
  it("shows skeletons until a snapshot lands after every (re)connect, and drops the old connection's call data", () => {
    let s = run([live()]);
    expect(selectConnection(s).view).toBe("skeleton");
    s = withBoard(run([snapshot(10)], s));
    expect(selectConnection(s).view).toBe("live");
    expect(selectBoard(s)).toHaveLength(1);

    s = run([{ t: "state", state: { phase: "retrying", hub: "devbox:4710", reason: "closed", retryAt: 1 } }, live()], s);
    expect(selectConnection(s).view).toBe("skeleton");
    expect(s.live.stale).toBe(true);
    s = run([snapshot(12)], s);
    expect(selectConnection(s).view).toBe("live");
    expect(selectBoard(s)).toBeUndefined();
  });

  it("ignores an event it already applied", () => {
    const s = run([live(), snapshot(10), event(9, "workstream.state", { workstreamId: "W1", state: "failed" })]);
    expect(s.cursor).toBe(10);
    expect(s.events).toHaveLength(0);
  });
});

describe("an order's phase", () => {
  const start = () => withBoard(run([live(), snapshot(10)]), [card("W1", { phase: "waiting_on_you", needsYou: 1 })]);

  it("counts what the hub says waits on you for it, and a lane waiting on a permission from the live feed", () => {
    let s = start();
    expect(selectBoard(s)?.[0]?.phase).toEqual({ phase: "waiting_on_you", detail: "1 question" });
    s = withBoard(s, [card("W1")]);
    expect(selectBoard(s)?.[0]?.phase.phase).toBe("working");
    s = run([{ t: "live", frame: { at: "2026-10-19T10:00:01.000Z", full: true, lanes: [liveLane("T1", "waiting")] } }], s);
    expect(selectBoard(s)?.[0]?.phase).toEqual({ phase: "waiting_on_you", detail: "1 approval" });
  });

  it("an order's detail holds its finished lanes", () => {
    const s = ingest(start(), {
      tool: "order_get",
      input: { workstreamId: "W1" },
      output: { order: card("W1"), requests: [], doneLanes: [lane("T0", "done")] },
    });
    expect(selectOrder("W1")(s)?.detail?.doneLanes).toHaveLength(1);
  });
});

describe("events patch what they change", () => {
  it("moves an order's state and resorts the board", () => {
    let s = withBoard(run([live(), snapshot(1)]), [card("W1"), card("W2", { updatedAt: "2026-10-19T09:00:00.000Z" })]);
    expect(selectBoard(s)?.map((o) => o.card.workstreamId)).toEqual(["W1", "W2"]);
    s = run([event(2, "workstream.state", { workstreamId: "W2", state: "failed" })], s);
    expect(selectBoard(s)?.map((o) => [o.card.workstreamId, o.phase.phase])).toEqual([
      ["W2", "failed"],
      ["W1", "working"],
    ]);
    expect(s.orderEvents["W2"]).toHaveLength(1);
  });

  it("files an event under every order it names", () => {
    const s = run([live(), snapshot(1), event(2, "lead.woken", { workstreamIds: ["W1", "W2"] })]);
    expect(s.orderEvents["W1"]?.map((e) => e.seq)).toEqual([2]);
    expect(s.orderEvents["W2"]?.map((e) => e.seq)).toEqual([2]);
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

describe("bounds and freshness", () => {
  it("serves nothing while the link is down", () => {
    let s = withBoard(run([live(), snapshot(1)]));
    expect(selectBoard(s)).toHaveLength(1);
    s = run([{ t: "state", state: { phase: "connecting", hub: "devbox:4710", attempt: 1 } }], s);
    expect(selectBoard(s)).toBeUndefined();
    expect(selectProjectList(s)).toBeUndefined();
  });

  it("keeps event lines for the 100 most recent orders", () => {
    let s = withBoard(run([live(), snapshot(1)]));
    const frames = Array.from({ length: 120 }, (_, i) => event(10 + i, "task.started", { workstreamId: `W${i}` }));
    s = run(frames, s);
    expect(Object.keys(s.orderEvents)).toHaveLength(100);
    expect(s.orderEvents["W0"]).toBeUndefined();
    expect(s.orderEvents["W119"]).toHaveLength(1);
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

  it("keeps a lead's messages in full past the text tail, and no stream for other lanes", () => {
    const parts = Array.from({ length: 30 }, (_, i) => ({ laneId: "lead:devbox/p1", messageId: i < 20 ? "m1" : "m2", append: `${"x".repeat(299)}\n` }));
    const f = { ...frame(false, []), text: [...parts, { laneId: "T1", messageId: "t", append: "hi" }] };
    const streams = applyStreams(undefined, f);
    expect(streams?.["lead:devbox/p1"]?.map((m) => [m.messageId, m.text.length])).toEqual([["m1", 6000], ["m2", 3000]]);
    expect(applyLive(initialState().live, f, 0).text["lead:devbox/p1"]?.text).toHaveLength(2000);
    expect(streams?.["T1"]).toBeUndefined();
    expect(applyStreams(streams, frame(false, []))).toBe(streams);
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

describe("one state word per project", () => {
  // The typical fixture's billing project: the Status row (status_projects) said "idle" while its lead was
  // waiting on a reply. The hub's chat state is the one source, so the dot, the header and the row agree.
  it("takes needs-you from the hub's chat state only, whatever the Status row says", () => {
    let s = withBoard(run([live(), snapshot(1)]), []);
    s = run([{ t: "event", event: { seq: 2, at: "2026-10-19T10:00:00.000Z", type: "chat.waiting", summary: "", data: { projectRef: project, needsYou: true, leadWorking: false, lastSeq: 9 } } }], s);
    const row = selectProjectRow("devbox/storefront")(s);
    expect([row?.needsYou, row?.state]).toEqual([true, "waiting_on_you"]);
    expect(selectNeedsYou("devbox/storefront")(s)).toBe(row?.needsYou);
    expect(projectStateWord(row?.needsYou ?? false, row?.working ?? false, "idle")).toBe("waiting_on_you");
    // The row's own "waiting on you" never counts on its own; its blocked and working do.
    expect(projectStateWord(false, false, "waiting_on_you")).toBe("idle");
    expect(projectStateWord(false, false, "blocked")).toBe("blocked");
    expect(projectStateWord(false, false, "working")).toBe("working");
    expect(projectStateWord(false, true, "idle")).toBe("working");
  });
});

describe("the project list", () => {
  it("hands back the same row and list when a lane frame changes none of their fields", () => {
    const s = withBoard(run([live(), snapshot(1)]), [card("W1")]);
    const row = selectProjectRow("devbox/storefront")(s);
    const list = selectProjectList(s);
    // A spark-only frame: the lane is still working, so no row field moves.
    const next = run([{ t: "live", frame: { at: "2026-10-19T10:00:02.000Z", full: false, lanes: [liveLane("T1", "working", { spark: { endAt: "2026-10-19T10:00:02.000Z", samples: [3] } })] } }], s);
    expect(next.live.lanes).not.toBe(s.live.lanes);
    expect(selectProjectList(next)).toBe(list);
    expect(selectProjectRow("devbox/storefront")(next)).toBe(row);
    // A lane that stops working does move it.
    const idle = run([{ t: "live", frame: { at: "2026-10-19T10:00:03.000Z", full: false, lanes: [liveLane("T1", "idle")] } }], next);
    expect(selectProjectRow("devbox/storefront")(idle)?.running).toBe(0);
  });

  it("counts a lane two cards list once", () => {
    const s = withBoard(run([live(), snapshot(1)]), [card("W1"), card("W2")]);
    expect(selectProjectRow("devbox/storefront")(s)?.running).toBe(1);
  });

  it("keeps a stable order by title, whatever needs you or works", () => {
    let s = withBoard(run([live(), snapshot(1)]), []);
    const storefront = s.projects["devbox/storefront"];
    if (storefront === undefined) throw new Error("the snapshot has storefront");
    s = { ...s, projects: { ...s.projects, "devbox/acme": { ...storefront, projectId: "acme", title: "acme" } } };
    const order = () => selectProjectList(s)?.map((r) => [r.project.title, r.needsYou]);
    expect(order()).toEqual([["acme", false], ["storefront", false]]);
    s = run([{ t: "event", event: { seq: 2, at: "2026-10-19T10:00:00.000Z", type: "chat.waiting", summary: "", data: { projectRef: project, needsYou: true, leadWorking: true, lastSeq: 4 } } }], s);
    expect(order()).toEqual([["acme", false], ["storefront", true]]);
  });
});

describe("unread chats", () => {
  const waiting = (seq: number, lastSeq: number): HubFrame => ({
    t: "event",
    event: { seq, at: "2026-10-19T10:00:00.000Z", type: "chat.waiting", summary: "", data: { projectRef: project, needsYou: false, leadWorking: true, lastSeq } },
  });
  const message = (seq: number, chatSeq: number): HubFrame => ({
    t: "event",
    event: { seq, at: "2026-10-19T10:00:00.000Z", type: "chat.message", summary: "", data: { projectRef: project, messageId: `m${chatSeq}`, seq: chatSeq, author: "lead", state: "final" } },
  });

  it("follows each project's newest message, opened or not, and never moves back", () => {
    let s = withBoard(run([live(), snapshot(1), waiting(2, 4)]), []);
    expect(selectProjectRow("devbox/storefront")(s)?.lastSeq).toBe(4);
    s = run([message(3, 5)], s);
    expect(selectProjectRow("devbox/storefront")(s)?.lastSeq).toBe(5);
    // An older message read again (a gap filled) leaves it.
    s = run([message(4, 3)], s);
    expect(selectProjectRow("devbox/storefront")(s)?.lastSeq).toBe(5);
  });
});

describe("the live agents", () => {
  const row = (laneId: string, patch: Partial<AgentRow> = {}): AgentRow => ({
    laneId,
    role: "implementer",
    status: "working",
    title: `Lane ${laneId}`,
    projectRef: project,
    projectTitle: "storefront",
    startedAt: "2026-10-19T09:00:00.000Z",
    ...patch,
  });
  const listed = (s: DataState, agents: AgentRow[]): DataState =>
    ingest(s, { tool: "agents_list", input: {}, output: { agents, at: "2026-10-19T10:00:00.000Z" } });
  const frame = (lanes: ReturnType<typeof liveLane>[]): HubFrame => ({ t: "live", frame: { at: "2026-10-19T10:00:02.000Z", full: false, lanes } });

  it("lists working agents by project, the lead first and then oldest first, and never a finished one or an idle lead", () => {
    const s = listed(run([live(), snapshot(1)]), [
      row("T2", { startedAt: "2026-10-19T09:30:00.000Z" }),
      row("T1"),
      row("T3", { status: "done" }),
      row("lead:devbox/storefront", { role: "lead" }),
      row("lead:devbox/acme", { role: "lead", status: "idle", projectRef: { machineId: "devbox", projectId: "acme" }, projectTitle: "acme" }),
      row("T9", { projectRef: { machineId: "devbox", projectId: "acme" }, projectTitle: "acme", status: "queued" }),
    ]);
    expect(selectLiveAgents(s)?.map((a) => a.id)).toEqual(["devbox/acme/T9", "devbox/storefront/lead:devbox/storefront", "devbox/storefront/T1", "devbox/storefront/T2"]);
  });

  it("takes status and activity from the live feed, and keeps the list while a frame changes nothing it shows", () => {
    const s = listed(run([live(), snapshot(1)]), [row("T1"), row("T2")]);
    const list = selectLiveAgents(s);
    const spark = run([frame([liveLane("T1", "working", { spark: { endAt: "2026-10-19T10:00:02.000Z", samples: [3] } })])], s);
    expect(selectLiveAgents(spark)).toBe(list);
    const moved = run([frame([liveLane("T1", "working", { activity: { activity: { kind: "edit", path: "src/a.ts" }, since: "2026-10-19T10:00:01.000Z" } })])], spark);
    expect(selectLiveAgents(moved)?.[0]?.row.live?.activity?.activity).toEqual({ kind: "edit", path: "src/a.ts" });
    expect(selectLiveAgents(moved)?.[1]).toBe(list?.[1]);
    const finished = run([frame([liveLane("T1", "done")])], moved);
    expect(selectLiveAgents(finished)?.map((a) => a.row.laneId)).toEqual(["T2"]);
  });

  it("is undefined until this connection's list landed", () => {
    const s = listed(run([live(), snapshot(1)]), [row("T1")]);
    expect(selectLiveAgents(run([snapshot(2)], s))).toBeUndefined();
  });
});
