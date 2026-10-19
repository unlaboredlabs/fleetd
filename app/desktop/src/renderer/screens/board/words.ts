// The board's vocabulary: one word per status, role and PR stage, and the lines built from them. Amber is "needs
// you", danger only on failure words, and everything that is just working stays quiet.
import type { AgentLane, AgentRole, ChangeState, LaneStatus, LoginLimit, MachineLive, OrderPhase, PrRef } from "./contracts";
import { fmtAgo, fmtElapsed, parseMs } from "./format";

export type Tone = "quiet" | "loud" | "warning" | "danger" | "success";

export const isFinal = (s: LaneStatus): boolean => s === "done" || s === "failed" || s === "cancelled";

/** Statuses with a clock running. */
export const isRunning = (s: LaneStatus): boolean =>
  s === "starting" || s === "working" || s === "waiting" || s === "stalled" || s === "parked" || s === "idle";

export const isWorking = (s: LaneStatus): boolean => s === "starting" || s === "working";

export const isChecker = (role: AgentRole): boolean => role === "reviewer" || role === "verifier" || role === "qa";

export const ROLE_WORD: Record<AgentRole, string> = {
  lead: "lead",
  implementer: "implementer",
  reader: "reader",
  reviewer: "reviewer",
  verifier: "verifier",
  qa: "qa",
};

/** The tint family: writers (implementers, readers), reviewers, verifiers (and QA), the lead. */
export type Tint = "writer" | "reviewer" | "verifier" | "lead";
export const roleTint = (role: AgentRole): Tint => {
  switch (role) {
    case "implementer":
    case "reader":
      return "writer";
    case "reviewer":
      return "reviewer";
    case "verifier":
    case "qa":
      return "verifier";
    case "lead":
      return "lead";
  }
};

/**
 * One activity line: words in the UI voice, then machine text (a command, path or pattern) in mono. `thinking`
 * marks waiting on the model: true, but the quiet state; tool work is what reads loud.
 */
export interface Line {
  readonly words: string;
  readonly machine?: string;
  readonly tone: Tone;
  readonly thinking: boolean;
}

const say = (words: string, tone: Tone = "quiet"): Line => ({ words, tone, thinking: false });
const doing = (words: string, machine: string): Line => ({ words, machine, tone: "loud", thinking: false });

/** What a lane is doing now, in literal present tense. With nothing specific to say, it says no more than the status. */
export const describe = (lane: AgentLane): Line => {
  const reason = lane.statusReason?.trim() ? lane.statusReason : undefined;
  switch (lane.status) {
    case "queued":
      return say(reason ? `queued · ${reason}` : "queued");
    case "waiting":
      return say(reason ? `waiting on you: ${reason}` : "waiting on you", "warning");
    case "parked":
      return say(reason ?? "usage limit");
    case "stalled":
      return say(reason ? `stalled: ${reason}` : "stalled", "warning");
    case "cancelled":
      return say("cancelled");
    case "failed":
      return say(reason ? `failed: ${reason}` : "failed", "danger");
    case "idle":
      return say("idle");
    case "done": {
      const a = parseMs(lane.startedAt);
      const b = parseMs(lane.endedAt);
      const took = a !== undefined && b !== undefined ? `done in ${fmtElapsed(b - a)}` : "done";
      return say(lane.pr ? `${took} · #${lane.pr.number}` : took);
    }
    case "starting":
    case "working": {
      const act = lane.live?.activity?.activity;
      if (act === undefined) return lane.status === "starting" ? say("starting") : { ...say("thinking"), thinking: true };
      switch (act.kind) {
        case "command":
          // The whole command: the row cuts it once, in the middle, to the room it has (parts.tsx MiddleCut).
          return doing("running", act.text);
        case "edit":
          return doing("editing", act.path);
        case "read":
          if (act.pattern) return doing("searching", act.pattern);
          if (act.path) return doing("reading", act.path);
          return { ...say("reading"), tone: "loud" };
        case "tool":
          return act.detail ? doing(act.name, act.detail) : { ...say(act.name), tone: "loud" };
        case "writing":
          return { ...say("writing"), tone: "loud" };
        case "compacting":
          return say("compacting context");
        case "retrying":
          return say(`retrying (${act.attempt} of ${act.of}): ${act.reason}`, "warning");
        case "thinking":
          return { ...say("thinking"), thinking: true };
      }
    }
  }
};

/**
 * What the fleet is doing, from the lanes drawn: "3 writing · 2 reviewing · 1 verifying", each running agent
 * counted by what its role does, the ones that need you or failed first. Empty when no lane is at work.
 */
export const fleetActivity = (lanes: readonly AgentLane[]): string => {
  const count = (pred: (l: AgentLane) => boolean) => lanes.filter(pred).length;
  const byRole = (roles: readonly AgentRole[]) => count((l) => isWorking(l.status) && roles.includes(l.role));
  const parts: [number, string][] = [
    [count((l) => l.status === "waiting"), "need you"],
    [count((l) => l.status === "failed"), "failed"],
    [byRole(["implementer"]), "writing"],
    [byRole(["reader"]), "reading"],
    [byRole(["reviewer"]), "reviewing"],
    [byRole(["verifier", "qa"]), "verifying"],
    [byRole(["lead"]), "planning"],
    [count((l) => l.status === "stalled"), "stalled"],
    [count((l) => l.status === "parked"), "parked"],
    [count((l) => l.status === "queued"), "queued"],
  ];
  const out = parts.filter(([n]) => n > 0).map(([n, w]) => `${n} ${w}`);
  if (out[0] === "1 need you") out[0] = "1 needs you";
  return out.join(" · ");
};

export const STAGE_WORD: Record<ChangeState, string> = {
  queued: "queued",
  reviewing: "review",
  ready: "ready",
  rebasing: "rebasing",
  ci: "CI",
  merging: "merging",
  merged: "merged",
  needs_rebase: "needs rebase",
  ci_failed: "CI failed",
  refused: "refused",
  abandoned: "abandoned",
};

export const stageTone = (s: ChangeState): Tone =>
  s === "needs_rebase" ? "warning" : s === "ci_failed" || s === "refused" ? "danger" : s === "merged" ? "success" : "quiet";

/** "reviewing 1/2", "in CI", "merged", "queued, position 2". */
export const prLabel = (pr: PrRef): string => {
  switch (pr.state) {
    case "reviewing":
      return `reviewing ${pr.reviewsDone}/${pr.reviewsNeeded}`;
    case "ci":
      return "in CI";
    case "queued":
      return pr.position === undefined ? "queued" : `queued, position ${pr.position + 1}`;
    default:
      return STAGE_WORD[pr.state];
  }
};

/** The review fraction a PR reports itself. */
export const prReview = (pr: PrRef): number => (pr.reviewsNeeded <= 0 ? 1 : pr.reviewsDone / pr.reviewsNeeded);

/**
 * How full each of the track's three segments is, 0..1: review (checks done of needed), CI (half while it runs,
 * full once it passed), merged. Undefined for states off the main line, which say so in words instead.
 */
export const trackFill = (state: ChangeState, review: number): readonly [number, number, number] | undefined => {
  const r = Math.min(1, Math.max(0, review));
  switch (state) {
    case "queued":
    case "reviewing":
      return [r, 0, 0];
    case "ready":
      return [1, 0, 0];
    case "rebasing":
    case "ci":
      return [1, 0.5, 0];
    case "merging":
      return [1, 1, 0];
    case "merged":
      return [1, 1, 1];
    default:
      return undefined;
  }
};

export const PHASE_WORD: Record<OrderPhase, string> = {
  waiting_on_you: "needs you",
  failed: "failed",
  stopped: "stopped",
  working: "working",
  reviewing: "reviewing",
  merging: "merging",
  verifying: "checking",
  queued: "queued",
  planning: "planning",
  idle: "waiting for the lead",
  done: "done",
};

export const phaseTone = (p: OrderPhase): Tone =>
  p === "waiting_on_you" ? "warning" : p === "failed" ? "danger" : p === "done" ? "success" : "quiet";

/** One machine's strip parts: "6 running", "load 3.1/32", "mem 41%", "claude 58% 5h · 41% wk"; offline is one part. */
export const machineParts = (m: MachineLive, nowMs: number): readonly (readonly [string, Tone])[] => {
  if (m.status === "offline") {
    const at = parseMs(m.asOf);
    return [[at === undefined ? "offline" : `offline ${fmtAgo(nowMs - at)}`, "warning"]];
  }
  const out: [string, Tone][] = [[`${m.running} running`, "quiet"]];
  if (m.status === "degraded") out.unshift(["degraded", "warning"]);
  if (m.slept && nowMs - m.slept.toMs < 3_600_000) {
    out.push([`slept ${fmtElapsed(m.slept.toMs - m.slept.fromMs)}`, "warning"]);
  }
  if (m.load) {
    out.push([`load ${m.load.load1.toFixed(1)}/${m.load.cpus}`, "quiet"]);
    if (m.load.memUsedPct !== undefined) out.push([`mem ${m.load.memUsedPct}%`, "quiet"]);
    const limits = m.load.limits.flatMap(limitPart);
    if (limits.length > 0) {
      const worst = limits.some(([, t]) => t === "danger") ? "danger" : limits.some(([, t]) => t === "warning") ? "warning" : "quiet";
      out.push([`claude ${limits.map(([s]) => s).join(" · ")}`, worst]);
    }
  }
  return out;
};

const WINDOW_WORD: Record<string, string> = { five_hour: "5h", seven_day: "wk", seven_day_opus: "opus wk", seven_day_sonnet: "sonnet wk" };

const limitPart = (l: LoginLimit): [string, Tone][] => {
  if (l.utilization === undefined) return [];
  const tone: Tone = l.status === "rejected" ? "danger" : l.status === "allowed_warning" ? "warning" : "quiet";
  return [[`${Math.round(l.utilization * 100)}% ${WINDOW_WORD[l.limitType] ?? l.limitType}`, tone]];
};

/** "slots 8/40 (2 leads) · 1 queued": the board's own count of what holds a slot, against the hub's cap. */
export const slotsText = (cap: number, use: { readonly agents: number; readonly leads: number; readonly queued: number }): string =>
  `slots ${use.agents + use.leads}/${cap}${use.leads > 0 ? ` (${use.leads} lead${use.leads === 1 ? "" : "s"})` : ""}${use.queued > 0 ? ` · ${use.queued} queued` : ""}`;
