// Settings → Skills and the composer's `$`: the first project's repo has a skill in .agents/skills (which outranks the
// project's own of the same name) and one in .claude/skills; the project keeps one more; the hub keeps two global
// skills, one installed from a skills.sh source and pinned. Other projects see the global ones. Made-up data.
import type { Fixture } from "../kit/fixture.ts";
import { asText, isObject, type JsonObject } from "../kit/json.ts";

const AT = "2026-10-19T10:21:00.000Z";
const PIN = "4f2a9c1e7b3d5a8c0e6f1b2d4a7c9e0f3b5d8a1c";

const md = (name: string, description: string, body: string): string => `---\nname: ${name}\ndescription: ${description}\n---\n\n${body}`;

interface Skill {
  readonly summary: JsonObject;
  readonly text: string;
}

const skill = (name: string, origin: string, description: string, body: string, extra: JsonObject = {}): Skill => ({
  summary: { name, origin, description, files: [], ...extra },
  text: md(name, description, body),
});

const GLOBAL: Skill[] = [
  skill(
    "pr-review",
    "global",
    "Review a pull request: correctness first, then tests, then naming. Use when asked to review or check a PR.",
    "# pr-review\n\n1. Read the description and the linked task.\n2. Run the tests the change touches.\n3. Report blocking findings first.\n",
    {
      install: { source: "acme/agent-skills@pr-review", url: "https://github.com/acme/agent-skills.git", ref: "HEAD", commit: PIN, path: "skills/pr-review", installedAt: AT },
      files: ["checklist.md"],
      updatedAt: AT,
    },
  ),
  skill("standup", "global", "Write the daily standup from yesterday's merged PRs and open tasks.", "# standup\n\nThree lines: done, doing, blocked.\n", { updatedAt: AT }),
];

const PROJECT: Skill[] = [
  skill("checkout-qa", "project", "Walk the checkout flow end to end on staging before a release.", "# checkout-qa\n\n1. Add an item.\n2. Pay with the test card.\n3. Check the receipt email.\n", { updatedAt: AT }),
  skill("release", "project", "Cut a release of the shop: tag, changelog, deploy to staging.", "# release\n\nTag, changelog, staging.\n", {
    shadowedBy: "repo_agents",
    updatedAt: AT,
  }),
];

const REPO: Skill[] = [
  skill("release", "repo_agents", "Cut a release: bump the version, tag it, write the changelog, deploy to staging then production.", "# release\n\n1. `pnpm version`.\n2. Push the tag.\n", {
    path: ".agents/skills/release/SKILL.md",
  }),
  skill("triage", "repo_claude", "Sort new issues: label, reproduce, link duplicates.", "# triage\n\nLabel, reproduce, link.\n", { path: ".claude/skills/triage/SKILL.md" }),
];

export function skills(f: Fixture) {
  const projects = isObject(f.snapshot) && Array.isArray(f.snapshot["projects"]) ? f.snapshot["projects"].filter(isObject) : [];
  const ref = (p: JsonObject): JsonObject => ({ machineId: asText(p["machineId"]), projectId: asText(p["projectId"]) });
  const list = (rows: Skill[]) => rows.map((s) => s.summary);
  f.answer("skills_list", undefined, { skills: list(GLOBAL) });
  for (const s of GLOBAL) f.answer("skill_get", { origin: "global", name: asText(s.summary["name"]) }, { skill: s.summary, text: s.text });
  for (const [i, p] of projects.entries()) {
    const projectRef = ref(p);
    const rows = i === 0 ? [...REPO, ...PROJECT, ...GLOBAL] : GLOBAL;
    f.answer("skills_list", { projectRef }, { skills: list(rows) });
    for (const s of rows) {
      const input = { origin: asText(s.summary["origin"]), name: asText(s.summary["name"]), projectRef };
      f.answer("skill_get", input, { skill: s.summary, text: s.text });
    }
  }
  const first = GLOBAL[1]?.summary ?? {};
  f.answer("skill_set", undefined, { skill: first, next: "Saved. Sessions get it from their next start." });
  f.answer("skill_delete", undefined, { ok: true });
  f.answer("skill_install", undefined, { installed: [GLOBAL[0]?.summary ?? first], next: "Pinned to 4f2a9c1e7b3d. Sessions get it from their next start; Update fetches newer commits." });
  f.answer("skill_update", undefined, { skill: GLOBAL[0]?.summary ?? first, updated: false, next: "Already at the newest commit." });
}
