// The duplicate check at a writer's spawn: its title, prompt, item, PR and
// paths against the work in flight on its project's repo and base (`work(hub).checkObserved`), whichever project,
// agent or person's session holds it. The intent itself is the work area's (`work(hub).matcher.intent`).
//
// - exact (the item or PR the spawn names, held elsewhere): refused. `notDuplicateOf` with a reason lets it through,
//   except over a person's own claim: that work is theirs, and the lead asks in chat.
// - strong: refused once; the same call naming the ids in `notDuplicateOf`, with `notDuplicateWhy`, goes through.
// - weak: listed in the result.
import type { MatchStrength, TaskId, WorkItem, WorkMatch } from "../../shared/contracts.ts";
import { ToolError } from "../../shared/errors.ts";

/** Lines of work elsewhere in a spawn's result and in a writer's prompt. */
export const ELSEWHERE_MAX = 3;
/** Matches named in a refusal. */
const REFUSED_MAX = 5;

/** The spawn's note when its project has no repo and base to check in. */
export const UNBOUND = "no repo bound; duplicate check skipped";
/** The spawn's note while its project's repo and base are still being read, in the background. */
export const BINDING = "no repo bound yet; duplicate check skipped";

const RANK: Record<MatchStrength, number> = { weak: 0, strong: 1, exact: 2 };
const atLeastStrong = (m: WorkMatch) => RANK[m.strength] >= RANK.strong;

const humanClaim = (item: WorkItem) => item.kind === "claim" && item.owner?.kind === "human_session";

function holder(item: WorkItem): string {
  const owner = item.owner;
  if (owner) {
    const who = owner.kind === "human_session" ? "a person's session" : owner.kind === "agent_key" ? "an agent key" : "a lead";
    return owner.label !== undefined ? `${who}, ${owner.label}` : who;
  }
  return item.projectRef ? `project ${item.projectRef.projectId}` : "outside fleetd";
}

/** `T12 "dark mode toggle" (running, project shop): same item P5`; a writer whose node didn't say is "changes unknown". */
export function line(m: WorkMatch, unknown: Set<TaskId>): string {
  const item = m.item;
  const unseen = item.taskId !== undefined && unknown.has(item.taskId) ? ", changes unknown" : "";
  return `${item.id} "${item.title}" (${item.state}, ${holder(item)}${unseen}): ${m.why}`;
}

const ids = (matches: WorkMatch[]) => matches.map((m) => `"${m.item.id}"`).join(", ");

function lines(matches: WorkMatch[], unknown: Set<TaskId>): string {
  const out = matches.slice(0, REFUSED_MAX).map((m) => line(m, unknown));
  if (matches.length > REFUSED_MAX) out.push(`+${matches.length - REFUSED_MAX} more`);
  return out.join("; ");
}

/** What a spawn the check let through says, and what it overrode. */
export type Passed = {
  /** Weak matches, and those `notDuplicateOf` let through, at most `ELSEWHERE_MAX`. */
  elsewhere: string[];
  /** The exact and strong matches `notDuplicateOf` let through. */
  overridden: string[];
};

/** Refuses the spawn over the matches (a thrown ToolError), or says what it lets through. */
export function judge(matches: WorkMatch[], notDuplicateOf: string[] | undefined, unknown: Set<TaskId>): Passed {
  const acked = new Set(notDuplicateOf ?? []);
  const human = matches.filter((m) => m.strength === "exact" && humanClaim(m.item));
  if (human.length > 0) {
    throw new ToolError(
      "invalid",
      `Taken by a person: ${lines(human, unknown)}. A person's claim can't be passed over with notDuplicateOf.`,
      "It is theirs and nothing passes it: ask them in chat to release it (`fleetd work done`, or drop it) if they no longer need it, or pick other work.",
    );
  }
  const refused = matches.filter((m) => atLeastStrong(m) && !acked.has(m.item.id));
  if (refused.some((m) => m.strength === "exact")) {
    throw new ToolError(
      "invalid",
      `Taken: ${lines(refused, unknown)}.`,
      `It is already in flight: leave it to whoever holds it, or ask in chat. If this is different work, call again with notDuplicateOf: [${ids(refused)}] and notDuplicateWhy.`,
    );
  }
  if (refused.length > 0) {
    throw new ToolError(
      "invalid",
      `Possible duplicate: ${lines(refused, unknown)}.`,
      `If this is different work, call again with notDuplicateOf: [${ids(refused)}] and notDuplicateWhy; if not, don't spawn it.`,
    );
  }
  return {
    elsewhere: matches.slice(0, ELSEWHERE_MAX).map((m) => line(m, unknown)),
    overridden: matches.filter(atLeastStrong).map((m) => m.item.id),
  };
}

/** The matches a writer's prompt lists: the work in flight it may overlap, itself left out. */
export const forWriter = (matches: WorkMatch[], taskId: TaskId): string[] =>
  matches
    .filter((m) => m.item.taskId !== taskId)
    .slice(0, ELSEWHERE_MAX)
    .map((m) => line(m, new Set()));
