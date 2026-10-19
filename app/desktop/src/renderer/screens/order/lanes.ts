// What each agent of the order is doing, in words, and its PR's stage.

import type { AgentLane, PrRef } from "../../../shared/contracts";
import { shortElapsed } from "./format";

export interface ActivityLine {
  /** "running", "editing", "waiting on you". */
  readonly words: string;
  /** The command, path or tool detail, set in mono. */
  readonly machine?: string;
  readonly tone: "quiet" | "loud" | "danger";
}

const say = (words: string, tone: ActivityLine["tone"] = "quiet"): ActivityLine => ({ words, tone });
const withMachine = (words: string, machine: string): ActivityLine => ({ words, machine, tone: "quiet" });

export function activityLine(lane: AgentLane): ActivityLine {
  const reason = lane.statusReason?.trim() ? lane.statusReason : undefined;
  switch (lane.status) {
    case "queued":
      return say(reason ? `queued · ${reason}` : "queued");
    case "waiting":
      return say(reason ? `waiting on you: ${reason}` : "waiting on you", "loud");
    case "parked":
      return say(reason ?? "usage limit");
    case "stalled":
      return say(reason ? `stalled: ${reason}` : "stalled");
    case "cancelled":
      return say("cancelled");
    case "failed":
      return say(reason ? `failed: ${reason}` : "failed", "danger");
    case "done": {
      const a = lane.startedAt ? Date.parse(lane.startedAt) : Number.NaN;
      const b = lane.endedAt ? Date.parse(lane.endedAt) : Number.NaN;
      const took = Number.isNaN(a) || Number.isNaN(b) ? "done" : `done in ${shortElapsed(b - a)}`;
      return say(lane.pr ? `${took} · #${lane.pr.number}` : took);
    }
    case "idle":
      return say("idle");
    case "starting":
    case "working": {
      const a = lane.live?.activity?.activity;
      if (a === undefined) return say(lane.status === "starting" ? "starting" : "thinking");
      switch (a.kind) {
        case "command":
          return withMachine("running", a.text);
        case "edit":
          return withMachine("editing", a.path);
        case "read":
          return a.pattern ? withMachine("searching", a.pattern) : a.path ? withMachine("reading", a.path) : say("reading");
        case "tool":
          return a.detail ? withMachine(a.name, a.detail) : say(a.name);
        case "writing":
          return say("writing");
        case "thinking":
          return say("thinking");
        case "compacting":
          return say("compacting context");
        case "retrying":
          return say(`retrying (${a.attempt} of ${a.of}): ${a.reason}`);
      }
    }
  }
}

const STAGE: Readonly<Record<PrRef["state"], string>> = {
  queued: "queued",
  reviewing: "reviewing",
  ready: "ready to merge",
  rebasing: "rebasing",
  ci: "in CI",
  merging: "merging",
  merged: "merged",
  needs_rebase: "needs a rebase",
  ci_failed: "CI failed",
  refused: "refused",
  abandoned: "abandoned",
};

/** "reviewing 1/2", "in CI", "merged". */
export function prStage(pr: PrRef): string {
  return pr.state === "reviewing" ? `reviewing ${pr.reviewsDone}/${pr.reviewsNeeded}` : STAGE[pr.state];
}

export const prTone = (pr: PrRef): "done" | "failed" | "quiet" =>
  pr.state === "merged" ? "done" : pr.state === "ci_failed" || pr.state === "refused" ? "failed" : "quiet";
