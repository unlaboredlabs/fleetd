import { describe, expect, it } from "vitest";
import type { FleetStatus, LiveFrame, OrderCard } from "../../../shared/contracts";
import { applyFrame, ingest, initialState } from "../../src/data/store";
import type { AgentLane, LaneStatus } from "./contracts";
import { selectProjectRow } from "../../src/data/selectors";
import { projectKey } from "./lanes";
import { selectStrip, stripHeadline, stripOf, stripPrs } from "./strip";

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
  state: "running",
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
    expect(idle?.rows).toEqual([]);
    expect(idle && stripHeadline(idle)).toBe("");
  });

  it("counts agents at work, waiting on you, on hold and queued apart, and says what each is doing", () => {
    const s = stripOf([
      lane("T1", "working", { live: { laneId: "T1", status: "working", activity: { activity: { kind: "edit", path: "src/a.ts" }, since: T0 } } }),
      lane("T2", "waiting", { role: "reviewer", statusReason: "approve npm install" }),
      lane("T4", "parked", { statusReason: "usage limit until 14:00" }),
      lane("T3", "queued", { role: "verifier" }),
    ]);
    expect(stripHeadline(s)).toBe("1 agent working · 1 needs you · 1 on hold · 1 queued");
    expect(s.rows.map((r) => (r.kind === "agent" ? [r.roleWord, r.words, r.machine] : r.kind))).toEqual([
      ["writer", "editing", "src/a.ts"],
      ["reviewer", "waiting on you: approve npm install", undefined],
      ["writer", "usage limit until 14:00", undefined],
      ["verifier", "queued", undefined],
    ]);
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
    expect(s?.rows.map((r) => r.key)).toEqual(["T2"]);
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

  it("names the PRs folded: a few in full, then how many more", () => {
    expect(stripPrs([])).toBe("");
    expect(stripPrs([221])).toBe("on #221");
    expect(stripPrs([9, 10, 11])).toBe("on #9, #10 and #11");
    expect(stripPrs([9, 10, 11, 12])).toBe("on #9, #10, #11 and #12");
    expect(stripPrs([9, 10, 11, 12, 13])).toBe("on #9, #10, #11 and 2 more");
  });
});

describe("the opened strip (#232 blocker: one count per PR)", () => {
  const pr = (n: number, done: number) => ({
    changeId: `X${n}`,
    repo: "acme/storefront",
    number: n,
    url: `https://github.com/acme/storefront/pull/${n}`,
    state: "reviewing" as const,
    reviewsDone: done,
    reviewsNeeded: 3,
  });
  const on = (id: string, role: AgentLane["role"], n: number, status: LaneStatus = "working") => lane(id, status, { role, pr: pr(n, 1) });

  it("draws one line per PR with the agents on it, the PR's needed reviews, done counted from the hub and the finished reviewers", () => {
    const lanes = [lane("W", "working"), on("R1", "reviewer", 221), on("R2", "reviewer", 221), on("V1", "verifier", 221), on("I2", "implementer", 222), on("R3", "reviewer", 222)];
    const order = { ...card("W1", lanes), prs: [pr(221, 1), pr(222, 0)] };
    let s = state([order]);
    // One reviewer of #222 already finished: only the order's detail still lists it.
    s = ingest(s, { tool: "order_get", input: { workstreamId: "W1" }, output: { order, doneLanes: [on("R0", "reviewer", 222, "done")], requests: [] } });
    const strip = selectStrip(project)(s);
    expect(strip?.rows.map((r) => (r.kind === "pr" ? `#${r.number} ${r.label}` : `${r.indent ? "  " : ""}${r.key}`))).toEqual([
      "W",
      "#221 review 1/3",
      "  R1",
      "  R2",
      "  V1",
      "#222 review 1/3",
      "  I2",
      "  R3",
    ]);
    expect(strip?.prs).toEqual([221, 222]);
    expect(strip?.orders).toEqual(["W1"]);
  });
});
