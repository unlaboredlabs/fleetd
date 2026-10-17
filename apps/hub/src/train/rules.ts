// Enqueue rules, pure: the PR body's `Source:` line, the tier, and the freeze decision key.
import { Schema } from "effect";
import { Serves, type Tier, type Workstream } from "@fleetd/contracts";

export interface Refusal {
  readonly message: string;
  readonly fix: string;
}

const isServes = Schema.is(Serves);

/** The first `Source: <serves>` line of a PR body, trimmed; markdown emphasis around the label is allowed. */
export const sourceOf = (body: string | null | undefined): string | undefined => {
  const m = /^[ \t]*(?:[*_]{1,2})?Source:(?:[*_]{1,2})?[ \t]*(.*?)[ \t]*$/mu.exec(body ?? "");
  const value = m?.[1]?.replace(/^`(.*)`$/u, "$1").trim();
  return value === undefined || value === "" ? undefined : value;
};

const addLine = (serves: string) => `add 'Source: ${serves}' to the PR body`;

/**
 * The PR's `Source:` must be a valid serves form, name an existing done-when check when it is `done:<n>`, and equal
 * `expected` (the task's or the caller's serves) when there is one. Returns the serves or why not, with the fix.
 */
export const checkSource = (
  body: string | null | undefined,
  expected: string | undefined,
  workstream: Workstream,
): { readonly serves: string } | Refusal => {
  const source = sourceOf(body);
  const example = expected ?? "done:0";
  if (source === undefined) return { message: "The PR body has no 'Source:' line.", fix: addLine(example) };
  if (!isServes(source)) {
    return { message: `'Source: ${source}' is not a valid serves form.`, fix: `${addLine(example)} (done:<n>, issue:<#n|url>, defect:<text> or ask:A<n>)` };
  }
  if (expected !== undefined && source !== expected) {
    return { message: `The PR body says 'Source: ${source}' but the work serves ${expected}.`, fix: `change the PR body's line to 'Source: ${expected}'` };
  }
  const done = /^done:(\d+)$/u.exec(source);
  const checks = workstream.brief?.doneWhen.length ?? 0;
  if (done !== null && Number(done[1]) >= checks) {
    const range = checks === 0 ? "it has no done-when checks" : `use done:0${checks > 1 ? ` to done:${checks - 1}` : ""}`;
    return { message: `'Source: ${source}' is not a done-when check of ${workstream.workstreamId}.`, fix: `${addLine("done:<n>")}; ${range}` };
  }
  return { serves: source };
};

const RANK: Record<Tier, number> = { S: 0, M: 1, L: 2 };

/** The brief's tier, raised by the task's or the caller's, never lowered by the caller. */
export const checkTier = (brief: Tier, requested: Tier | undefined, task: Tier | undefined): { readonly tier: Tier } | Refusal => {
  if (requested !== undefined && RANK[requested] < RANK[brief]) {
    return { message: `Tier ${requested} is below the brief's tier ${brief}; a tier can be raised, never lowered.`, fix: `omit --tier, or pass --tier ${brief} or higher` };
  }
  const tiers = [brief, requested, task].filter((t): t is Tier => t !== undefined);
  return { tier: tiers.reduce((a, b) => (RANK[b] > RANK[a] ? b : a)) };
};

/** `policy.freeze.<owner>.<name>`, lowercased; its value "true" holds the repo's train. */
export const freezeKey = (repo: string) => `policy.freeze.${repo.toLowerCase().replace("/", ".")}`;

export const isFrozenValue = (value: string) => /^(?:true|yes|on|1)$/iu.test(value.trim());
