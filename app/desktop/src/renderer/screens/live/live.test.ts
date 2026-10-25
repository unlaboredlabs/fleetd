import { describe, expect, it } from "vitest";
import type { FleetStatus, LiveFrame, OrderCard } from "../../../shared/contracts";
import { applyFrame, ingest, initialState } from "../../src/data/store";
import type { AgentLane, LaneStatus } from "./contracts";
import { selectProjectRow } from "../../src/data/selectors";
import { projectKey } from "./lanes";
import { NOW_DWELL_MS, nowAgent, selectStrip, stripHeadline, stripOf, stripPrs } from "./strip";

const T0 = "2026-10-18T10:00:00.000Z";
const project = { machineId: "devbox", projectId: "storefront" } as const;

const lane = (laneId: string, status: LaneStatus, extra: Partial<AgentLane> = {}): AgentLane => ({
  laneId,
  role: "implementer",
  title: `task ${laneId}`,
  status,
  ...extra,
});

const card = (workstreamId: string, lanes: AgentLane[]): OrderCard => ({
  workstreamId,
  projectRef: project,
  title: "Round cart totals once",
  state: "open",
  phase: "working",
  needsYou: 0,
  settled: 0,
  total: lanes.length,
  lanes,
  prs: [],
  createdAt: T0,
  updatedAt: T0,
});

const snapshot: FleetStatus = {
  cursor: 0,
  attention: [],
  machines: [{ machineId: "devbox", name: "devbox", nodeVersion: "1", status: "online", lastSeenAt: T0, tags: [] }],
  projects: [
    { ...project, title: "storefront", workspaceRoot: "/srv/storefront", lastActivityAt: T0, threads: { running: 0, waiting: 0, idle: 0, failed: 0 } },
  ],
};

const state = (orders: OrderCard[] | undefined, frames: LiveFrame[] = []) => {
  let s = initialState();
  [s] = applyFrame(s, { t: "state", state: { phase: "live", hub: "devbox:4710", protocol: 1 } }, 0);
  [s] = applyFrame(s, { t: "snapshot", snapshot }, 0);
  if (orders !== undefined) s = ingest(s, { tool: "orders_board", input: {}, output: { orders, trains: [], at: T0 } });
  for (const f of frames) [s] = applyFrame(s, { t: "live", frame: f }, Date.parse(f.at));
  return s;
};

describe("the live strip", () => {
  it("draws nothing until the board loaded, and nothing when no agent is at work", () => {
    expect(selectStrip(project)(state(undefined))).toBeUndefined();
    const idle = selectStrip(project)(state([card("W1", [lane("T1", "done"), lane("L", "working", { role: "lead" })])]));
    expect(idle?.agents).toBe(0);
    expect(idle && stripHeadline(idle)).toBe("");
  });

  it("counts agents at work, waiting on you, on hold and queued apart", () => {
    const s = stripOf([
      lane("T1", "working", { live: { laneId: "T1", status: "working", activity: { activity: { kind: "edit", path: "src/a.ts" }, since: T0 } } }),
      lane("T2", "waiting", { role: "reviewer", statusReason: "approve npm install" }),
      lane("T4", "parked", { statusReason: "usage limit until 14:00" }),
      lane("T3", "queued", { role: "qa" }),
    ]);
    expect(stripHeadline(s)).toBe("1 agent working · 1 needs you · 1 on hold · 1 queued");
    expect(s.agents).toBe(4);
  });

  // The lab saw the strip say one more agent than max agents allows for a moment: a finished agent's session stops
  // (its slot frees and the next agent starts) a beat before its task books the result.
  it("counts an agent as working until its session stops, as max agents does, never one too many", () => {
    const at = (s: number) => new Date(Date.parse(T0) + s * 1000).toISOString();
    const base = state(
      [card("W1", [lane("T1", "working"), lane("T2", "queued")])],
      [{ at: at(1), full: true, lanes: [{ laneId: "T1", status: "working" }] }],
    );
    // T1's session stopped (its task still running, so the hub says idle) and T2 took the freed slot.
    const [next] = applyFrame(
      base,
      { t: "live", frame: { at: at(2), full: false, lanes: [{ laneId: "T1", status: "idle" }, { laneId: "T2", status: "starting" }] } },
      Date.parse(at(2)),
    );
    const s = selectStrip(project)(next);
    expect(s && stripHeadline(s)).toBe("1 agent working");
    expect(s?.agents).toBe(1);
    expect(s?.working).toBe(selectProjectRow(projectKey(project))(next)?.running);
  });

  it("keeps the same object while only a lane's tokens change, so the chat doesn't redraw", () => {
    const at = (s: number) => new Date(Date.parse(T0) + s * 1000).toISOString();
    const base = state([card("W1", [lane("T1", "working")])], [{ at: at(1), full: true, lanes: [{ laneId: "T1", status: "working" }] }]);
    const sel = selectStrip(project);
    const first = sel(base);
    const [next] = applyFrame(
      base,
      { t: "live", frame: { at: at(2), full: false, lanes: [{ laneId: "T1", status: "working", tokens: { input: 9, output: 9, cacheRead: 0, live: true } }] } },
      Date.parse(at(2)),
    );
    expect(sel(next)).toBe(first);
  });

  it("names the PRs: a few in full, then how many more", () => {
    const words = (prs: number[]) => stripPrs(prs).map((p) => (typeof p === "number" ? `#${p}` : p)).join("");
    expect(words([])).toBe("");
    expect(words([221])).toBe("on #221");
    expect(words([9, 10, 11])).toBe("on #9, #10 and #11");
    expect(words([9, 10, 11, 12])).toBe("on #9, #10, #11 and #12");
    expect(words([9, 10, 11, 12, 13])).toBe("on #9, #10, #11 and 2 more");
    // The numbers are apart from the words, so each one is a link.
    expect(stripPrs([9, 10])).toEqual(["on ", 9, " and ", 10]);
  });
});

describe("the strip's dots and now-line", () => {
  const busy = (laneId: string, samples: number[], activity: NonNullable<AgentLane["live"]>["activity"] = { activity: { kind: "thinking" }, since: T0 }) =>
    lane(laneId, "working", { live: { laneId, status: "working", activity, spark: { endAt: T0, samples } } });

  it("has a dot per agent: waiting on you first, then at work, on hold and queued, the board's order within", () => {
    const s = stripOf([
      lane("Q", "queued"),
      lane("A", "working"),
      lane("H", "stalled"),
      lane("W", "waiting", { role: "reviewer", statusReason: "approve npm install" }),
      lane("B", "starting"),
      lane("P", "parked"),
    ]);
    expect(s.lanes.map((a) => [a.laneId, a.state])).toEqual([
      ["W", "needsYou"],
      ["A", "working"],
      ["B", "working"],
      ["H", "onHold"],
      ["P", "onHold"],
      ["Q", "queued"],
    ]);
    // Each agent's line is the agents view's.
    expect(s.lanes[0]?.line).toMatchObject({ words: "waiting on you: approve npm install", tone: "warning" });
    expect(s.lanes[0]?.role).toBe("reviewer");
  });

  it("puts the busiest agent at work first: most recent work, then tool work over thinking, then the board's order", () => {
    const edit = { activity: { kind: "edit" as const, path: "src/a.ts" }, since: T0 };
    const s = stripOf([
      busy("calm", [1, 1, 1]),
      // Old work, past the last 16 seconds, doesn't count.
      busy("was", [90, 90, 90, 0, 0, 0, 0, 0, 0, 0, 0]),
      busy("hot", [20, 30, 40]),
      busy("thinks", [2, 2, 2]),
      busy("edits", [2, 2, 2], edit),
      lane("W", "waiting"),
    ]);
    expect(s.now).toEqual(["hot", "edits", "thinks", "calm", "was"]);
  });

  it("with no agent at work, says what the agent waiting on you waits for; with only queued ones, nothing", () => {
    expect(stripOf([lane("Q", "queued"), lane("W", "waiting"), lane("P", "parked")]).now).toEqual(["W"]);
    expect(stripOf([lane("Q", "queued"), lane("P", "parked")]).now).toEqual([]);
  });

  it("stays on the agent it shows for a while, so the line turns over gently, never flickering", () => {
    const at = 1_000_000;
    expect(nowAgent(["A", "B"], undefined, at)).toBe("A");
    // B got busier a moment after A came on: A stays until its turn is up, then B takes the line.
    expect(nowAgent(["B", "A"], { laneId: "A", since: at }, at + NOW_DWELL_MS - 1)).toBe("A");
    expect(nowAgent(["B", "A"], { laneId: "A", since: at }, at + NOW_DWELL_MS)).toBe("B");
    // An agent that stopped working gives the line up at once.
    expect(nowAgent(["B"], { laneId: "A", since: at }, at + 1)).toBe("B");
    expect(nowAgent([], { laneId: "A", since: at }, at + 1)).toBeUndefined();
  });

  it("redraws when an agent's activity changes, not when only its tokens do", () => {
    const at = (s: number) => new Date(Date.parse(T0) + s * 1000).toISOString();
    const base = state([card("W1", [lane("T1", "working")])], [{ at: at(1), full: true, lanes: [{ laneId: "T1", status: "working" }] }]);
    const sel = selectStrip(project);
    const first = sel(base);
    const [next] = applyFrame(
      base,
      { t: "live", frame: { at: at(2), full: false, lanes: [{ laneId: "T1", status: "working", activity: { activity: { kind: "edit", path: "src/a.ts" }, since: at(2) } }] } },
      Date.parse(at(2)),
    );
    const second = sel(next);
    expect(second).not.toBe(first);
    expect(second?.lanes[0]?.line).toMatchObject({ words: "editing", machine: "src/a.ts" });
  });
});

describe("the PRs the strip names", () => {
  const pr = (n: number, taskId?: string) => ({
    changeId: `X${n}`,
    repo: "acme/storefront",
    number: n,
    url: `https://github.com/acme/storefront/pull/${n}`,
    state: "reviewing" as const,
    reviewsDone: 0,
    reviewsNeeded: 1,
    ...(taskId === undefined ? {} : { taskId }),
  });

  it("are those an agent at work is on: checking it, or the writer whose task opened it; lowest first", () => {
    const lanes = [
      lane("W", "working"),
      lane("R1", "working", { role: "reviewer", pr: pr(222) }),
      // The writer of #221, its PR known only from the task that opened it.
      lane("T7", "working", { taskId: "T7" }),
      // A reviewer whose task id happens to match: a checker is on a PR only by its PR.
      lane("R9", "working", { role: "reviewer", taskId: "T9" }),
    ];
    const order = { ...card("W1", lanes), prs: [pr(222), pr(221, "T7"), pr(223, "T9"), pr(224)] };
    expect(selectStrip(project)(state([order]))?.prs).toEqual([221, 222]);
  });
});
