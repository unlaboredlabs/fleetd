import { describe, expect, it } from "vitest";
import type { ChatMessage, FleetStatus, LiveFrame, OrderCard } from "../../../shared/contracts";
import { applyFrame, ingest, initialState } from "../../src/data/store";
import type { AgentLane, LaneStatus } from "../board/contracts";
import { isEventLine } from "./EventLine";
import { FOLDED_LINES, selectStrip, stripHeadline, stripOf } from "./strip";

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
  s = ingest(s, { tool: "asks_list", input: { state: "open" }, output: { batches: [], asks: [] } });
  for (const f of frames) [s] = applyFrame(s, { t: "live", frame: f }, Date.parse(f.at));
  return s;
};

describe("the live strip", () => {
  it("draws nothing until the board loaded, and nothing when no agent is at work", () => {
    expect(selectStrip(project)(state(undefined))).toBeUndefined();
    const idle = selectStrip(project)(state([card("W1", [lane("T1", "done"), lane("L", "working", { role: "lead" })])]));
    expect(idle?.lines).toEqual([]);
    expect(idle && stripHeadline(idle)).toBe("");
  });

  it("counts agents at work, waiting on you and queued apart, and says what each is doing", () => {
    const s = stripOf([
      lane("T1", "working", { live: { laneId: "T1", status: "working", activity: { activity: { kind: "edit", path: "src/a.ts" }, since: T0 } } }),
      lane("T2", "waiting", { role: "reviewer", statusReason: "approve npm install" }),
      lane("T3", "queued", { role: "verifier" }),
    ]);
    expect(stripHeadline(s)).toBe("1 agent working · 1 needs you · 1 queued");
    expect(s.lines.map((l) => [l.roleWord, l.words, l.machine])).toEqual([
      ["implementer", "editing", "src/a.ts"],
      ["reviewer", "waiting on you: approve npm install", undefined],
      ["verifier", "queued", undefined],
    ]);
  });

  it("keeps the same object while only a lane's tokens and bars change, so the chat doesn't redraw", () => {
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

  it("folds past a handful of lines", () => {
    const many = stripOf(Array.from({ length: 20 }, (_, i) => lane(`T${i}`, "working")));
    expect(many.lines).toHaveLength(20);
    expect(FOLDED_LINES).toBeLessThan(20);
    expect(stripHeadline(many)).toBe("20 agents working");
  });
});

describe("event lines", () => {
  const message = (author: "system" | "lead", text: string): ChatMessage => ({
    messageId: "m1",
    projectRef: project,
    seq: 1,
    author,
    text,
    createdAt: T0,
    state: "final",
  });

  it("are fleetd's own messages with text, not the lead's", () => {
    expect(isEventLine(message("system", "#221 merged"))).toBe(true);
    expect(isEventLine(message("lead", "#221 merged"))).toBe(false);
    expect(isEventLine(message("system", "  "))).toBe(false);
  });
});
