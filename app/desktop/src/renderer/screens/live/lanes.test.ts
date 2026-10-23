import { describe as group, expect, it } from "vitest";
import type { FleetStatus, OrderCard } from "../../../shared/contracts";
import { selectProjectWork } from "../../src/data/selectors";
import { applyFrame as frameIn, ingest, initialState } from "../../src/data/store";
import type { AgentLane, LaneStatus, LiveFrame, LiveLane, PrRef } from "./contracts";
import { fmtElapsed, fmtTokens, middleEllipsis } from "./format";
import { describe } from "./words";

const T0 = "2026-10-18T10:00:00.000Z";
const at = (s: number) => new Date(Date.parse(T0) + s * 1000).toISOString();
const ms = (s: number) => Date.parse(T0) + s * 1000;

const lane = (laneId: string, status: LaneStatus, extra: Partial<AgentLane> = {}): AgentLane => ({
  laneId,
  role: "implementer",
  title: `task ${laneId}`,
  status,
  ...extra,
});
const live = (laneId: string, status: LaneStatus, extra: Partial<LiveLane> = {}): LiveLane => ({ laneId, status, ...extra });
const frame = (s: number, full: boolean, lanes: LiveLane[], extra: Partial<LiveFrame> = {}): LiveFrame => ({ at: at(s), full, lanes, ...extra });
const pr = (number: number, state: PrRef["state"], extra: Partial<PrRef> = {}): PrRef => ({
  changeId: `X${number}`,
  repo: "acme/storefront",
  number,
  url: `https://github.com/acme/storefront/pull/${number}`,
  state,
  reviewsDone: 0,
  reviewsNeeded: 1,
  ...extra,
});
const card = (workstreamId: string, lanes: AgentLane[]): OrderCard => ({
  workstreamId,
  projectRef: { machineId: "devbox", projectId: "storefront" },
  title: "Round cart totals once, in one place",
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
    { machineId: "devbox", projectId: "storefront", title: "storefront", workspaceRoot: "/srv/storefront", lastActivityAt: T0, threads: { running: 0, waiting: 0, idle: 0, failed: 0 } },
  ],
};
const loaded = (orders: OrderCard[]) => {
  let s = initialState();
  [s] = frameIn(s, { t: "state", state: { phase: "live", hub: "devbox:4710", protocol: 1 } }, 0);
  [s] = frameIn(s, { t: "snapshot", snapshot }, 0);
  return ingest(s, { tool: "orders_board", input: {}, output: { orders, trains: [], at: T0 } });
};

group("formatters", () => {
  it("never read a negative time or a thousand k", () => {
    expect(fmtElapsed(-5)).toBe("0:00");
    expect(fmtTokens(999_500)).toBe("1.0M");
  });

  it("cut a long command once, in the middle", () => {
    const cut = middleEllipsis("npm run lint -- --fix src/cart/total.ts src/cart/discounts.ts", 30);
    expect(cut).toHaveLength(30);
    expect(cut.split("…")).toHaveLength(2);
    expect(cut.startsWith("npm run")).toBe(true);
    expect(cut.endsWith("discounts.ts")).toBe(true);
  });
});

group("the activity line", () => {
  it("is quiet while thinking and loud on tool work; a command reaches it whole", () => {
    expect(describe(lane("T1", "working"))).toMatchObject({ words: "thinking", thinking: true });
    const edit = lane("T1", "working", { live: live("T1", "working", { activity: { activity: { kind: "edit", path: "src/a.ts" }, since: T0 } }) });
    expect(describe(edit)).toMatchObject({ words: "editing", machine: "src/a.ts", tone: "loud", thinking: false });
    expect(describe(lane("T1", "done", { startedAt: at(0), endedAt: at(18), pr: pr(221, "reviewing") })).words).toBe("done in 0:18 · #221");
    expect(describe(lane("T1", "waiting")).tone).toBe("warning");
    const text = "npm test -- cart --reporter=dot --run src/cart/total.test.ts src/cart/discounts.test.ts";
    expect(describe(lane("T1", "working", { live: live("T1", "working", { activity: { activity: { kind: "command", text }, since: T0 } }) })).machine).toBe(text);
  });
});

group("live lanes in the data layer", () => {
  const work = selectProjectWork("devbox/storefront");

  it("a lane the feed finished has an end time before the hub's own", () => {
    let s = loaded([card("W1", [lane("T1", "working", { startedAt: T0 })])]);
    [s] = frameIn(s, { t: "live", frame: frame(1, true, [live("T1", "working")]) }, ms(1));
    [s] = frameIn(s, { t: "live", frame: frame(5, false, [live("T1", "done")]) }, ms(5));
    const t1 = work(s)?.lanes[0];
    expect([t1?.status, t1?.endedAt]).toEqual(["done", at(5)]);
  });

  it("a frame that names no lane (streamed text) keeps the lanes, so nothing that reads them redraws", () => {
    let s1 = loaded([card("W1", [lane("T1", "working")])]);
    [s1] = frameIn(s1, { t: "live", frame: frame(1, true, [live("T1", "working")]) }, ms(1));
    const before = work(s1);
    const [s2] = frameIn(s1, { t: "live", frame: frame(2, false, [], { text: [{ laneId: "T1", messageId: "m1", append: "hi" }] }) }, ms(2));
    expect(s2.live.lanes).toBe(s1.live.lanes);
    expect(s2.live.ended).toBe(s1.live.ended);
    expect(work(s2)).toBe(before);
  });
});
