// Who merges a PR, pure: a bot's Who merges (people or fleetd) and, where people merge, its risk rules. A PR whose every
// file matches a "merges itself" rule merges by the train all the same; one with any file matching an "always a person"
// rule waits for a person whatever else it holds. A rule is a path glob or one of the named kinds below. The train
// calls `decide` before every merge (service.ts `mergeDecision`), and the PR panel shows its words.
import type { Merger, RiskRules } from "../../shared/contracts.ts";

/** One file of a PR as GitHub lists it: `patch` is its unified diff's hunks, absent for a binary or too big a diff. */
export type MergeFile = { path: string; previousPath?: string; status: string; patch?: string };

/**
 * What the train does with a PR: `fleetd` merges every PR of its bot; `rule`, a bot whose people merge, merges this
 * one by its "merges itself" rules, which `rule` names; `person` holds it for a person, `why` in words.
 */
export type MergeDecision = { by: "fleetd" } | { by: "rule"; rule: string } | { by: "person"; why: string };

/** The named kinds a "merges itself" rule may be: each a few globs, or a check of the file's diff. */
export const ITSELF_KINDS = ["docs", "tests", "lockfile-bumps", "formatting"] as const;
/** The named kinds an "always a person" rule may be: each a few globs. */
export const PERSON_KINDS = ["auth", "billing", "migrations", "infra", "ci", "secrets"] as const;

/** A new bot's rules, and any bot's until a person edits them. */
export const DEFAULT_RISK_RULES: RiskRules = { itself: [...ITSELF_KINDS], person: [...PERSON_KINDS] };

/** The most rules in one list, and the longest rule. */
export const RULES_MAX = 50;
export const RULE_MAX_CHARS = 200;

/** The lockfiles `lockfile-bumps` reads, by name. */
const LOCKFILES = [
  "bun.lock",
  "bun.lockb",
  "package-lock.json",
  "npm-shrinkwrap.json",
  "pnpm-lock.yaml",
  "yarn.lock",
  "Cargo.lock",
  "go.sum",
  "poetry.lock",
  "uv.lock",
  "Pipfile.lock",
  "Gemfile.lock",
  "composer.lock",
  "mix.lock",
  "flake.lock",
];

const KIND_GLOBS: Record<string, string[]> = {
  docs: ["**/docs/**/*.{md,mdx,rst,adoc}", "**/doc/**/*.{md,mdx,rst,adoc}", "README", "README.{md,mdx,rst,adoc,txt}"],
  tests: ["**/test/**", "**/tests/**", "**/__tests__/**", "**/spec/**", "*.test.*", "*.spec.*", "*_test.go", "*_test.py", "test_*.py"],
  auth: ["**/auth/**", "auth.*", "*[._-]auth.*", "**/oauth/**", "oauth.*", "**/login/**", "login.*", "**/sessions/**"],
  billing: ["**/billing/**", "billing.*", "**/payments/**", "payment*.*", "**/stripe/**", "stripe.*", "**/checkout/**", "**/invoices/**", "invoice*.*"],
  migrations: ["**/migrations/**", "**/migrate/**", "*.sql", "schema.prisma"],
  infra: ["**/infra/**", "**/terraform/**", "*.tf", "*.tfvars", "**/k8s/**", "**/kubernetes/**", "**/helm/**", "**/deploy/**", "**/ansible/**", "**/pulumi/**", "Dockerfile*", "*.dockerfile", "docker-compose*.y*ml", "compose.y*ml"],
  ci: [".github/**", ".gitlab-ci.yml", ".circleci/**", ".buildkite/**", "Jenkinsfile", "azure-pipelines.yml", ".fleetd/**"],
  secrets: [".env*", "*secret*", "*credential*", "*.pem", "*.key", ".sops.yaml", "*.sops.*"],
};

/**
 * Markdown that steers agents rather than documents: an agent's instructions, rules, skills and prompt templates. It
 * changes what fleetd's (or any) agents do, so it is never docs, wherever it sits.
 */
const INSTRUCTIONS = [
  "CLAUDE.md",
  "CLAUDE.local.md",
  "AGENTS.md",
  "GEMINI.md",
  "SKILL.md",
  ".cursorrules",
  ".windsurfrules",
  "*.instructions.md",
  "*.prompt.md",
  "**/.claude/**",
  "**/.cursor/**",
  "**/.github/**",
  "**/.fleetd/**",
  "**/prompts/**",
  "**/skills/**",
];

/** What a rule is called in words: a kind by its name, a glob as written. */
const KIND_WORDS: Record<string, string> = { "lockfile-bumps": "lockfile-only patch or minor bumps", formatting: "formatting only", ci: "CI" };
export const ruleWords = (rule: string) => KIND_WORDS[rule] ?? rule;

const escape = (c: string) => c.replace(/[.+^$()|\\]/g, "\\$&");

/**
 * A glob as a regular expression on a path, case folded: `**` any folders, `*` and `?` within one name, `{a,b}` either,
 * `[...]` a class. A glob with no `/` matches a file's name in any folder, as in a .gitignore.
 */
export function globRegex(glob: string): RegExp {
  const g = glob.trim().replace(/^\/+/, "");
  let out = "";
  let depth = 0;
  for (let i = 0; i < g.length; i++) {
    const c = g[i]!;
    if (c === "*") {
      if (g[i + 1] === "*") {
        i++;
        if (g[i + 1] === "/") {
          i++;
          out += "(?:.*/)?";
        } else out += ".*";
      } else out += "[^/]*";
    } else if (c === "?") out += "[^/]";
    else if (c === "[") {
      const end = g.indexOf("]", i + 1);
      if (end < 0) out += "\\[";
      else {
        out += `[${g.slice(i + 1, end).replace(/^!/, "^").replace(/\\/g, "\\\\")}]`;
        i = end;
      }
    } else if (c === "{") {
      depth++;
      out += "(?:";
    } else if (c === "}" && depth > 0) {
      depth--;
      out += ")";
    } else if (c === "," && depth > 0) out += "|";
    else out += escape(c);
  }
  if (depth > 0) throw new Error(`${glob} has a { with no }`);
  const anywhere = !g.includes("/");
  return new RegExp(`^${anywhere ? "(?:.*/)?" : ""}${out}$`, "i");
}

/** Why `rule` can't be one, or undefined when it can: a named kind of its list, or a glob that compiles. */
export function ruleProblem(rule: string, kinds: readonly string[]): string | undefined {
  const r = rule.trim();
  if (r === "") return "a rule can't be empty";
  if ([...r].length > RULE_MAX_CHARS) return `a rule takes at most ${RULE_MAX_CHARS} characters`;
  if (kinds.includes(r)) return undefined;
  if ((ITSELF_KINDS as readonly string[]).includes(r) || (PERSON_KINDS as readonly string[]).includes(r)) {
    return `${r} is a kind of the other list`;
  }
  try {
    globRegex(r);
    return undefined;
  } catch (error) {
    return (error as Error).message;
  }
}

/** Every problem with `rules`, each naming its rule; none when a person may save them. */
export function rulesProblems(rules: RiskRules): string[] {
  const out: string[] = [];
  for (const [list, kinds, name] of [
    [rules.itself, ITSELF_KINDS, "merges itself"],
    [rules.person, PERSON_KINDS, "always a person"],
  ] as const) {
    if (list.length > RULES_MAX) out.push(`${name} takes at most ${RULES_MAX} rules`);
    for (const rule of list) {
      const why = ruleProblem(rule, kinds);
      if (why !== undefined) out.push(`${name}: ${rule.trim() || "(empty)"}: ${why}`);
    }
  }
  return out;
}

/** The rules with each trimmed, the empty and repeated ones dropped. */
export function tidyRules(rules: RiskRules): RiskRules {
  const tidy = (list: string[]) => [...new Set(list.map((r) => r.trim()).filter((r) => r !== ""))];
  return { itself: tidy(rules.itself), person: tidy(rules.person) };
}

const SEMVER = /\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?/g;
/** A hash or checksum a lockfile line carries beside a version, which changes with any bump: 32 characters or more,
 * a digit among them, so a package's name is never taken for one. */
const HASHLIKE = /(?=[A-Za-z0-9+/=_-]*\d)[A-Za-z0-9+/=_-]{32,}/g;

/** The removed and added lines of each hunk of a unified diff. */
function hunks(patch: string): { removed: string[]; added: string[] }[] {
  const out: { removed: string[]; added: string[] }[] = [];
  let cur: { removed: string[]; added: string[] } | undefined;
  for (const line of patch.split("\n")) {
    if (line.startsWith("@@")) {
      cur = { removed: [], added: [] };
      out.push(cur);
    } else if (!cur || line.startsWith("\\")) continue;
    else if (line.startsWith("-")) cur.removed.push(line.slice(1));
    else if (line.startsWith("+")) cur.added.push(line.slice(1));
  }
  return out;
}

/** Whether `to` is a patch or minor bump of `from`: the same major, and below 1.0.0 the same minor too. */
function minorBump(from: string, to: string): boolean {
  const [a, b] = [from, to].map((v) => v.split(/[.+-]/).map(Number));
  if (a![0] !== b![0]) return false;
  return a![0] !== 0 || a![1] === b![1];
}

/**
 * A lockfile's diff that only moves versions within a major (and within a minor below 1.0.0): every hunk takes out as
 * many lines as it puts in, each pair reads the same once versions and hashes are set aside, and each hunk moves a
 * version, so a hash changed under the same version never counts. A package added or removed doesn't either.
 */
export function lockfileBumpsOnly(patch: string | undefined): boolean {
  if (patch === undefined) return false;
  const all = hunks(patch);
  if (all.length === 0) return false;
  const shape = (l: string) => l.replace(SEMVER, "V").replace(HASHLIKE, "H");
  for (const h of all) {
    if (h.removed.length !== h.added.length) return false;
    let bumped = false;
    for (let i = 0; i < h.removed.length; i++) {
      const [from, to] = [h.removed[i]!, h.added[i]!];
      if (shape(from) !== shape(to)) return false;
      const [vf, vt] = [from.match(SEMVER) ?? [], to.match(SEMVER) ?? []];
      for (let j = 0; j < vf.length; j++) {
        if (vf[j] === vt[j]) continue;
        if (!minorBump(vf[j]!, vt[j]!)) return false;
        bumped = true;
      }
    }
    if (!bumped) return false;
  }
  return true;
}

/**
 * A diff that changes only whitespace no language reads: blank lines, and spaces or a carriage return at a line's end.
 * Each hunk's lines, those ends taken off and blank lines left out, are the same lines in the same order. Indentation
 * and spaces within a line are left as they are, since Python, YAML or a string literal read them.
 */
export function formattingOnly(patch: string | undefined): boolean {
  if (patch === undefined) return false;
  const all = hunks(patch);
  if (all.length === 0) return false;
  const kept = (lines: string[]) => lines.map((l) => l.replace(/\s+$/u, "")).filter((l) => l !== "");
  return all.every((h) => {
    const [was, now] = [kept(h.removed), kept(h.added)];
    return was.length === now.length && was.every((l, i) => l === now[i]);
  });
}

const nameOf = (path: string) => path.slice(path.lastIndexOf("/") + 1);

/** A file's paths: a rename's old one too. */
const pathsOf = (file: MergeFile) => (file.previousPath !== undefined ? [file.path, file.previousPath] : [file.path]);

/** Whether `path` matches one of `globs`; one that doesn't compile matches nothing. */
function anyGlob(globs: readonly string[], path: string): boolean {
  for (const g of globs) {
    try {
      if (globRegex(g).test(path)) return true;
    } catch {
      // A glob that doesn't compile matches nothing.
    }
  }
  return false;
}

/** Whether the file matches `rule`: a named kind's globs or its check of the diff, else the rule as a glob. */
export function matches(rule: string, file: MergeFile): boolean {
  const r = rule.trim();
  if (r === "lockfile-bumps") return LOCKFILES.includes(nameOf(file.path)) && file.status === "modified" && lockfileBumpsOnly(file.patch);
  if (r === "formatting") return file.status === "modified" && formattingOnly(file.patch);
  // Markdown that steers agents is never docs: it changes what they do.
  if (r === "docs" && pathsOf(file).some((p) => anyGlob(INSTRUCTIONS, p))) return false;
  const globs = KIND_GLOBS[r] ?? [r];
  return pathsOf(file).every((p) => anyGlob(globs, p));
}

/** Whether any of the file's paths (a rename's old one too) matches `rule`: an "always a person" rule holds on either. */
function touches(rule: string, file: MergeFile): boolean {
  if (file.previousPath === undefined) return matches(rule, file);
  return matches(rule, { ...file, previousPath: undefined }) || matches(rule, { ...file, path: file.previousPath, previousPath: undefined });
}

/**
 * Who merges a PR of a bot whose Who merges is `merges`, by its `rules` and its `files` (undefined: they couldn't be
 * read). fleetd merges every PR of a fleetd bot. Where people merge, one file under an "always a person" rule holds it;
 * else it merges itself only when every file matches a "merges itself" rule, and it waits for a person otherwise.
 */
export function decide(merges: Merger, rules: RiskRules, files: MergeFile[] | undefined): MergeDecision {
  if (merges === "fleetd") return { by: "fleetd" };
  if (files === undefined) return { by: "person", why: "people merge this bot's PRs, and this one's files couldn't be read" };
  for (const f of files) {
    const rule = rules.person.find((r) => touches(r, f));
    if (rule !== undefined) return { by: "person", why: `${f.path} matches the always-a-person rule ${ruleWords(rule)}` };
  }
  if (files.length === 0 || rules.itself.length === 0) return { by: "person", why: "people merge this bot's PRs" };
  const used: string[] = [];
  for (const f of files) {
    const rule = rules.itself.find((r) => matches(r, f));
    if (rule === undefined) return { by: "person", why: `people merge this bot's PRs, and ${f.path} matches no merges-itself rule` };
    if (!used.includes(rule)) used.push(rule);
  }
  return { by: "rule", rule: `every file matches the merges-itself rule${used.length === 1 ? "" : "s"} ${used.map(ruleWords).join(", ")}` };
}
