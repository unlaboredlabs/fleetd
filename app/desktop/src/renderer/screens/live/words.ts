// The lanes' vocabulary: what an agent is doing, in words. Amber is "needs you", danger only on failure words, and
// everything that is just working stays quiet.
import type { AgentLane, AgentRole, LaneStatus } from "./contracts";
import { activityWords } from "../../src/stepWords";
import { fmtElapsed, parseMs } from "./format";

export type Tone = "quiet" | "loud" | "warning" | "danger" | "success";

export const isFinal = (s: LaneStatus): boolean => s === "done" || s === "failed" || s === "cancelled";

export const isWorking = (s: LaneStatus): boolean => s === "starting" || s === "working";

export const isChecker = (role: AgentRole): boolean => role === "reviewer" || role === "verifier" || role === "qa";

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

/** A label's first word as the lane's line has it, lowercase, as its other words are; a name ("GitHub") keeps its case. */
const lowerFirst = (words: string): string => (/^[A-Z][a-z]/u.test(words) ? `${words.charAt(0).toLowerCase()}${words.slice(1)}` : words);

/** A step's words as a line: its machine text (in backticks, shared/steps.ts) in the line's mono slot, after the words. */
const stepLine = (text: string): Line => {
  const at = text.indexOf("`");
  const end = text.lastIndexOf("`");
  if (at === -1 || end <= at) return { words: text, tone: "loud", thinking: false };
  return { words: text.slice(0, at).trimEnd(), machine: text.slice(at + 1, end), tone: "loud", thinking: false };
};

const say = (words: string, tone: Tone = "quiet"): Line => ({ words, tone, thinking: false });

/**
 * Whether a lane at work runs on a machine that is offline now (`status`: the machine's, as the snapshot has it): its
 * last word ("thinking") is stale until the machine is back. A lane in a hosted sandbox has no machine of its own here.
 */
export const onOfflineMachine = (lane: AgentLane, status: (machineId: string) => string | undefined): boolean =>
  isWorking(lane.status) && lane.sandbox === undefined && lane.threadRef !== undefined && status(lane.threadRef.machineId) === "offline";

/** What a working lane says while its machine is offline, in place of its last word. */
export const MACHINE_OFFLINE = "Machine offline";

/**
 * What a lane is doing now, in literal present tense. With nothing specific to say, it says no more than the status.
 * `offline`: its machine is (onOfflineMachine), so a lane at work says so, not "thinking" (S9).
 */
export const describe = (lane: AgentLane, offline = false): Line => {
  if (offline && isWorking(lane.status)) return say(MACHINE_OFFLINE);
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
        case "edit":
        case "read":
        case "tool":
        case "web":
        case "planning":
          // In plain words (shared/steps.ts, src/stepWords.ts): "running the tests", "editing index.html", never the
          // command or path; "working" for the moment the words take to load after the first paint.
          return stepLine(lowerFirst(activityWords(act) ?? "working"));
        case "writing":
          return { ...say("writing"), tone: "loud" };
        case "compacting":
          return say("compacting context");
        case "retrying":
          return say(`retrying (${act.attempt} of ${act.of}): ${act.reason}`, "warning");
        case "starting":
          return say(act.text);
        case "thinking":
          return { ...say("thinking"), thinking: true };
      }
    }
  }
};
