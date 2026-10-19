// The lanes' vocabulary: one word per status, role and PR stage, and the lines built from them. Amber is "needs
// you", danger only on failure words, and everything that is just working stays quiet.
import type { AgentLane, AgentRole, ChangeState, LaneStatus } from "./contracts";
import { fmtElapsed, parseMs } from "./format";

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
