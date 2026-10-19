// The staged order as structure, not a log: the writers still writing, then one group per PR with the checkers on
// it, then the finish. Pure, so every count the board shows comes from one place: the rows it draws and the PRs.
import type { AgentLane, AskSummary, ChangeState, OrderCard, OrderPhase, PrRef } from "./contracts";
import { PHASE_ORDER } from "./contracts";
import { fmtElapsed, parseMs, plural } from "./format";
import { PHASE_WORD, STAGE_WORD, fleetActivity as fleetActivityOf, isChecker, isFinal, isWorking } from "./words";

export interface Group {
  readonly pr: PrRef;
  /** The writer that opened it, once known (it leaves the rows when it finishes). */
  readonly writer?: AgentLane;
  /** Its checkers still drawn (working, or holding their check before they fold away). */
  readonly rows: readonly AgentLane[];
  readonly checksDone: number;
  readonly checksNeeded: number;
}

export interface Fleet {
  /** Writers without a PR yet, in row order. */
  readonly writers: readonly AgentLane[];
  readonly groups: readonly Group[];
  /** Anyone else drawn: a checker whose PR the card doesn't list. */
  readonly others: readonly AgentLane[];
}

const pastReview = (s: ChangeState): boolean =>
  s === "ready" || s === "rebasing" || s === "ci" || s === "merging" || s === "merged";

/** The review segment's fill, 0..1, from the checks the rows under it show. */
export const reviewProgress = (g: Group): number =>
  g.checksNeeded === 0 ? (pastReview(g.pr.state) ? 1 : 0) : g.checksDone / g.checksNeeded;

/** "review 1/3", "ready · 2/3 checks", "reviewed", "CI", "merged": the same numbers the track draws. */
export const groupLabel = (g: Group): string => {
  const all = g.checksDone >= g.checksNeeded;
  switch (g.pr.state) {
    case "queued":
    case "reviewing":
      return `review ${g.checksDone}/${g.checksNeeded}`;
    case "ready":
      return all ? "reviewed" : `ready · ${g.checksDone}/${g.checksNeeded} checks`;
    default:
      return STAGE_WORD[g.pr.state];
  }
};

/** "written in 0:18" once the PR's writer finished; nothing before. */
export const writtenIn = (g: Group): string | undefined => {
  const w = g.writer;
  if (w?.status !== "done") return undefined;
  const a = parseMs(w.startedAt);
  const b = parseMs(w.endedAt);
  return a !== undefined && b !== undefined ? `written in ${fmtElapsed(b - a)}` : undefined;
};

/**
 * Groups `rows` (the lanes drawn now) under `prs`; `seen` is every lane the order has had, finished ones included,
 * for the counts and the writers that already left the rows.
 */
export const fleet = (rows: readonly AgentLane[], seen: readonly AgentLane[], prs: readonly PrRef[]): Fleet => {
  const prOf = (l: AgentLane) => l.pr?.number;
  const groups: Group[] = [...prs]
    .sort((a, b) => a.number - b.number)
    .map((pr) => {
      const wrote = (l: AgentLane) =>
        !isChecker(l.role) && ((pr.taskId !== undefined && l.taskId === pr.taskId) || prOf(l) === pr.number);
      // A row drawn now is fresher than one remembered.
      const writer = rows.find(wrote) ?? seen.find(wrote);
      const checkers = seen.filter((l) => isChecker(l.role) && prOf(l) === pr.number);
      // Counted from the lanes, as the rows show them: the hub's verdict count lags a finished check.
      const done = checkers.filter((l) => l.status === "done").length;
      const working = checkers.filter((l) => !isFinal(l.status)).length;
      const needed = Math.max(pr.reviewsNeeded, 0, checkers.length);
      // Past review with no checker at work (or none seen: the app joined late): every check is in.
      const checksDone = pastReview(pr.state) && working === 0 ? needed : Math.min(done, needed);
      return {
        pr,
        ...(writer ? { writer } : {}),
        rows: rows.filter((l) => isChecker(l.role) && prOf(l) === pr.number),
        checksDone,
        checksNeeded: needed,
      };
    });
  const grouped = (l: AgentLane) =>
    groups.some((g) => g.pr.number === prOf(l) || g.writer?.laneId === l.laneId);
  return {
    writers: rows.filter((l) => !isChecker(l.role) && !grouped(l)),
    groups,
    others: rows.filter((l) => isChecker(l.role) && !grouped(l)),
  };
};

/** The order is finished on the stage once every PR merged and no agent is left at work. */
export const finished = (rows: readonly AgentLane[], prs: readonly PrRef[]): boolean =>
  prs.length > 0 && prs.every((p) => p.state === "merged") && rows.every((l) => isFinal(l.status));

/** "✓ 3 PRs merged · 1:52 · 12 agents", or "merged 3/3 · lead closing · …" while the lead still has to close it. */
export const finishHeadline = (prs: number, closed: boolean, tookMs: number | undefined, agents: number): string =>
  [
    closed ? `${plural(prs, "PR")} merged` : `merged ${prs}/${prs} · lead closing`,
    ...(tookMs === undefined ? [] : [fmtElapsed(tookMs)]),
    plural(agents, "agent"),
  ].join(" · ");

/** The stage header when nobody is at work: never a blank line. */
export const idleHeadline = (prs: readonly PrRef[]): string => {
  const moving = prs.filter((p) => p.state !== "merged").length;
  return moving === 0 ? "agents done" : `agents done · ${plural(moving, "PR")} in the train`;
};

/** Open asks per order, from the live ask state: the source of "needs you", not the board's last snapshot. */
export const openAsksByOrder = (asks: readonly AskSummary[]): ReadonlyMap<string, number> => {
  const out = new Map<string, number>();
  for (const a of asks) {
    if (a.state === "open" && a.workstreamId !== undefined) out.set(a.workstreamId, (out.get(a.workstreamId) ?? 0) + 1);
  }
  return out;
};

/**
 * The order's phase with "needs you" taken from live state: an open ask for it or a lane waiting on a permission.
 * A card the hub still marks waiting after the ask was answered falls to what its lanes and PRs say, so the amber
 * never outlives the question.
 */
export const livePhase = (card: OrderCard, lanes: readonly AgentLane[], openAsks: number): OrderPhase => {
  if (openAsks > 0 || lanes.some((l) => l.status === "waiting")) return "waiting_on_you";
  if (card.phase !== "waiting_on_you") return card.phase;
  if (lanes.some((l) => l.status === "failed")) return "failed";
  if (lanes.some((l) => isWorking(l.status) && (l.role === "implementer" || l.role === "reader"))) return "working";
  if (card.prs.some((p) => p.state === "reviewing") || lanes.some((l) => isWorking(l.status) && isChecker(l.role))) {
    return "reviewing";
  }
  if (card.prs.some((p) => p.state === "ready" || p.state === "rebasing" || p.state === "ci" || p.state === "merging")) {
    return "merging";
  }
  if (lanes.length > 0 && lanes.every((l) => l.status === "queued")) return "queued";
  return "idle";
};

const closed = (p: OrderPhase) => p === "done" || p === "stopped";

/** Done orders stay on the board this long after they finish. */
export const ORDER_DONE_HOLD_MS = 600_000;

export const onBoard = (card: OrderCard, nowMs: number): boolean =>
  !closed(card.phase) || nowMs - (parseMs(card.updatedAt) ?? 0) < ORDER_DONE_HOLD_MS;

/** By phase, then most recently updated. */
export const sortCards = <T extends { readonly phase: OrderPhase; readonly updatedAt: string }>(cards: readonly T[]): T[] =>
  [...cards].sort(
    (a, b) => PHASE_ORDER.indexOf(a.phase) - PHASE_ORDER.indexOf(b.phase) || b.updatedAt.localeCompare(a.updatedAt),
  );

/**
 * The order that takes the stage: the only open one; or, with none open, the one that finished last, so its finish
 * holds the stage until it leaves the board.
 */
export const stagePick = (cards: readonly OrderCard[]): OrderCard | undefined => {
  const open = cards.filter((c) => !closed(c.phase));
  if (open.length === 1) return open[0];
  if (open.length > 1) return undefined;
  return cards.filter((c) => c.phase === "done").sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0];
};

/**
 * Keeps a list where the eye left it: ids still present stay in `held` order, new ids go in after whatever came
 * before them in `now`, gone ids drop out.
 */
export const hold = (held: readonly string[], now: readonly string[]): string[] => {
  const out = held.filter((id) => now.includes(id));
  now.forEach((id, ix) => {
    if (out.includes(id)) return;
    const before = now.slice(0, ix).map((p) => out.indexOf(p)).filter((p) => p >= 0);
    out.splice(before.length === 0 ? 0 : Math.max(...before) + 1, 0, id);
  });
  return out;
};

/** The lane whose activity speaks for a card without rows: one waiting on you, else the one that changed last. */
export const nowLane = (lanes: readonly AgentLane[]): AgentLane | undefined =>
  lanes.find((l) => l.status === "waiting") ??
  lanes
    .filter((l) => ["working", "starting", "queued", "parked", "stalled"].includes(l.status))
    .sort((a, b) => (b.live?.activity?.since ?? "").localeCompare(a.live?.activity?.since ?? ""))[0];

/** The quiet phases the fleet's own lines already say; the chip speaks only for what they can't. */
export const chipHidden = (phase: OrderPhase, card: OrderCard, lanes: readonly AgentLane[]): boolean => {
  const busy = lanes.some((l) => l.role !== "lead" && !isFinal(l.status));
  return (
    phase === "working" ||
    phase === "reviewing" ||
    phase === "merging" ||
    phase === "verifying" ||
    phase === "done" ||
    (phase === "idle" && (busy || card.prs.length > 0))
  );
};

/**
 * The phase chip's words. "Needs you" counts the open asks from live state; a working order counts its fleet from
 * the lanes, which move with every agent event; otherwise the hub's detail where it reads on its own.
 */
export const phaseLabel = (phase: OrderPhase, card: OrderCard, lanes: readonly AgentLane[], openAsks: number): string => {
  if (phase === "waiting_on_you") {
    if (openAsks > 0) return `needs you · ${plural(openAsks, "question")}`;
    return lanes.some((l) => l.status === "waiting") ? "needs you · a permission" : "needs you";
  }
  const detail = card.phaseDetail?.trim() ? card.phaseDetail : undefined;
  if (phase === "working") {
    const doing = fleetActivityOf(lanes);
    if (doing !== "") return doing;
  }
  if (detail === undefined || phase !== card.phase) return PHASE_WORD[phase];
  if (phase === "failed") return `failed: ${detail}`;
  if (phase === "stopped") return `stopped: ${detail}`;
  return detail;
};
