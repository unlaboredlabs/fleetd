// The brief's floor under a pinned playbook: its required check types, and for research the pre-registered fields.
// Pure; Workstreams.briefCreate applies it at freeze and on every amend.
import { type Brief, type CheckType, type Playbook, RESEARCH_FIELDS_FIX, ResearchBrief } from "@fleetd/contracts";
import * as Schema from "effect/Schema";

/** The lead may leave `tier` out of a brief; the playbook's default fills it. */
export const withTierDefault = (raw: unknown, playbook: Playbook): unknown =>
  raw !== null && typeof raw === "object" && !Array.isArray(raw) && !("tier" in raw) ? { ...raw, tier: playbook.tierDefault } : raw;

const typeList = (types: ReadonlyArray<CheckType>) =>
  types.length === 1 ? types[0]! : `${types.slice(0, -1).join(", ")} or ${types[types.length - 1]!}`;

const decodeResearch = Schema.decodeUnknownExit(ResearchBrief);

/** Why the brief falls short of the playbook, e.g. "bugfix needs a failing repro check (type test or cmd)"; undefined when it doesn't. */
export const floorRefusal = (playbook: Playbook, brief: Brief): string | undefined => {
  const types = new Set(brief.doneWhen.map((c) => c.type));
  const unmet = playbook.requiredChecks
    .filter((required) => !required.anyOf.some((t) => types.has(t)))
    .map((required) => `${playbook.name} needs ${required.label ?? "a check"} (type ${typeList(required.anyOf)})`);
  if (playbook.name === "research") {
    const research = decodeResearch(brief);
    if (research._tag === "Failure") {
      // The schema's issue names the missing fields after the fix text.
      const error = research.cause.reasons.find((r) => r._tag === "Fail")?.error;
      const message = error instanceof Error ? error.message : "";
      const at = message.indexOf(RESEARCH_FIELDS_FIX);
      unmet.push(at === -1 ? RESEARCH_FIELDS_FIX : message.slice(at).split("\n", 1)[0]!);
    }
  }
  return unmet.length === 0 ? undefined : unmet.join("; ");
};
