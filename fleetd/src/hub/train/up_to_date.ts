// A base that requires a PR's branch to be up to date before it merges (a ruleset's "Require branches to be up to date
// before merging", or classic protection's strict status checks). GitHub then refuses a PR whose base moved since its
// CI, so in "Merge, then verify" PRs side by side still land one CI run at a time: each one GitHub refuses is rebased and
// its CI runs again, never counted as a failure. The apps say so under the control, and an admin turns that one setting
// off from there (`turnOff`), nothing else of the rule.
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { UpToDateRule } from "../../shared/contracts.ts";
import type { TrainGitHub } from "./github.ts";
import type { Train } from "./service.ts";

/** Where a base requires up-to-date branches: the repo's rulesets that do, an organization's that do, classic protection. */
export type UpToDate = { rulesets: number[]; orgRulesets: number[]; classic: boolean };

export const NONE: UpToDate = { rulesets: [], orgRulesets: [], classic: false };

/** Whether `u` requires up-to-date branches anywhere. */
export const required = (u: UpToDate) => u.rulesets.length > 0 || u.orgRulesets.length > 0 || u.classic;

/** From a base's rules (`rules/branches/<base>`) and its classic protection (GraphQL's `branchProtectionRule`). */
export function upToDateFrom(rules: unknown, classic: unknown): UpToDate {
  const out: UpToDate = { rulesets: [], orgRulesets: [], classic: false };
  if (Array.isArray(rules)) {
    for (const rule of rules as Record<string, any>[]) {
      if (rule.type !== "required_status_checks" || rule.parameters?.strict_required_status_checks_policy !== true) continue;
      const id = rule.ruleset_id;
      if (typeof id !== "number") continue;
      const list = rule.ruleset_source_type === "Organization" ? out.orgRulesets : out.rulesets;
      if (!list.includes(id)) list.push(id);
    }
  }
  const c = classic as Record<string, any> | null | undefined;
  if (c?.requiresStrictStatusChecks === true) out.classic = true;
  return out;
}

/** GitHub's words for a merge it refuses because the PR's branch is behind its base. */
export const behind = (message: string) => /not up to date|base branch was modified|head branch is not up to date|branch is out-of-date/i.test(message);

/** A ruleset's rules with up-to-date branches no longer required, every other rule and parameter as it was. */
export function withoutUpToDate(rules: unknown): unknown[] {
  if (!Array.isArray(rules)) return [];
  return rules.map((rule) => {
    if (rule?.type !== "required_status_checks") return rule;
    return { ...rule, parameters: { ...(rule.parameters ?? {}), strict_required_status_checks_policy: false } };
  });
}

/** The line the apps show under the control while `base` of `repo` requires up-to-date branches; the apps add the fix. */
export function upToDateLine(repo: string, base: string, u: UpToDate): string {
  const org = u.rulesets.length === 0 && !u.classic && u.orgRulesets.length > 0;
  const line = `${repo}'s ${base} requires branches to be up to date, so PRs still land one at a time.`;
  return org ? `${line} An organization owner turns that off in its ruleset.` : line;
}

/**
 * Turns off "require branches to be up to date" on `base` of `repo`, in its own rulesets and classic protection, and
 * nothing else. An organization's ruleset is its owners': it says so and changes nothing.
 */
export async function turnOff(github: TrainGitHub, repo: string, base: string, u: UpToDate): Promise<void> {
  if (u.rulesets.length === 0 && !u.classic && u.orgRulesets.length > 0) {
    throw new Error(`${repo}'s ${base} has it from an organization ruleset: an organization owner turns it off there`);
  }
  const dir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "fleetd-up-to-date-"));
  try {
    for (const id of u.rulesets) {
      const path = `repos/${repo}/rulesets/${id}`;
      const got = await github.get(path);
      if (!got.ok) throw new Error(`gh api ${path} failed: ${got.message}`);
      const file = join(dir, `ruleset-${id}.json`);
      writeFileSync(file, JSON.stringify({ rules: withoutUpToDate((got.value as { rules?: unknown })?.rules) }));
      await github.putJson(path, file);
    }
    if (u.classic) {
      const file = join(dir, "classic.json");
      writeFileSync(file, JSON.stringify({ strict: false }));
      await github.putJson(`repos/${repo}/branches/${base}/protection/required_status_checks`, file, "PATCH");
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** The rule on `repo`'s default branch as the apps show it; undefined where it requires none, or can't be read now. */
export async function ruleOf(t: Train, repo: string): Promise<UpToDateRule | undefined> {
  let base: string;
  try {
    base = await t.github.defaultBranch(repo);
  } catch {
    return undefined;
  }
  const rules = await t.rules(repo, base);
  const u = rules.upToDate ?? NONE;
  if (!required(u)) return undefined;
  const own = u.rulesets.length > 0 || u.classic;
  return { repo, base, line: upToDateLine(repo, base, u), canTurnOff: own && rules.admin === true };
}

/** Turns the rule off on `repo`'s default branch, as `turnOff`, and reads its rules again. */
export async function turnOffOn(t: Train, repo: string): Promise<void> {
  const base = await t.github.defaultBranch(repo);
  const u = (await t.rules(repo, base)).upToDate ?? NONE;
  if (!required(u)) return;
  await turnOff(t.github, repo, base, u);
  t.ciConfigs.delete(`${repo}\u0000${base}`);
}
