// A session's skills (crates/fleetd/src/node/skills.rs). Four sources, the first that has a name winning (SkillOrigin's
// order): the checkout's `.agents/skills` (skills.sh), its `.claude/skills` (Claude Code), then the project's and the
// global skills the hub keeps, which ride on the launch and are kept beside the session's other files. At every start
// the node copies the winners into a session-only plugin, `<home>/sessions/<id>/plugin` (`--plugin-dir`), so claude
// lists each as `fleetd:<name>`; the session's settings overlay turns off (`skillOverrides`) any other skill of a
// winner's name claude would load itself. Nothing is written in the checkout.
import { copyFileSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { SkillOrigin } from "../../shared/contracts.ts";
import type { RepoSkill, SkillBundle } from "../../shared/sessions.ts";
import { mkdirPrivate } from "../config.ts";
import { nowIso } from "../util.ts";
import { removeIfThere } from "./refusal.ts";

export const PLUGIN_NAME = "fleetd";
/** Set in every session: the plugin's skills folder, where a skill the hub added after the session started is read
 * before the session's next start lists it. */
export const DIR_ENV = "FLEETD_SKILLS_DIR";
const HUB_SKILLS_FILE = "hub-skills.json";
const SKILL_FILE = "SKILL.md";
const DESCRIPTION_CAP = 1024;
const SKILL_FILES_CAP = 64;
const SKILL_BYTES_CAP = 512 * 1024;
const ORIGINS: SkillOrigin[] = ["repo_agents", "repo_claude", "project", "global"];
const REPO_DIRS: Partial<Record<SkillOrigin, string>> = { repo_agents: ".agents/skills", repo_claude: ".claude/skills" };

export const isSkillName = (name: string) => name.length <= 64 && /^[a-z0-9]+(-[a-z0-9]+)*$/.test(name);
export const skillsDir = (sessionDir: string) => join(sessionDir, "plugin", "skills");

type Candidate = { name: string; origin: SkillOrigin; from: { dir: string } | { files: [string, string][] } };
/** What a start gives the session: its `--plugin-dir` (none without skills) and the winners' names. */
export type Prepared = { pluginDir?: string; skills: string[] };

/** The overlay's `skillOverrides`: every other skill of a winner's name, off. */
export const overrides = (p: Prepared): Record<string, string> => Object.fromEntries(p.skills.map((n) => [n, "off"]));

const byOrigin = (o: SkillOrigin) => ORIGINS.indexOf(o);
const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/** One winner per name, by SkillOrigin's order, sorted by name. */
export function resolveSkills(found: Candidate[]): Candidate[] {
  const sorted = [...found].sort((a, b) => cmp(a.name, b.name) || byOrigin(a.origin) - byOrigin(b.origin));
  return sorted.filter((c, i) => i === 0 || sorted[i - 1]!.name !== c.name);
}

const isFile = (path: string) => {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
};

/** The skill folders of the checkout at `root`: each `<dir>/<name>/SKILL.md` whose folder name is a skill name. */
function repoCandidates(root: string): Candidate[] {
  const out: Candidate[] = [];
  for (const origin of ["repo_agents", "repo_claude"] as const) {
    let names: string[];
    try {
      names = readdirSync(join(root, REPO_DIRS[origin]!));
    } catch {
      continue;
    }
    for (const name of names) {
      const dir = join(root, REPO_DIRS[origin]!, name);
      if (isSkillName(name) && isFile(join(dir, SKILL_FILE))) out.push({ name, origin, from: { dir } });
    }
  }
  return out;
}

/** A plain scalar ends at a comment; a quoted one loses its quotes. */
function unquote(value: string): string {
  for (const q of ['"', "'"]) {
    if (value.length >= 2 && value.startsWith(q) && value.endsWith(q)) {
      const inner = value.slice(1, -1);
      return q === "'" ? inner.replaceAll("''", "'") : inner.replaceAll('\\"', '"').replaceAll("\\\\", "\\");
    }
  }
  return value.split(" #")[0]!.trim();
}

/** The `name` and `description` of a SKILL.md's YAML frontmatter: plain, quoted and block (`>`, `|`) scalars. */
export function frontmatter(text: string): { name?: string; description?: string } {
  const lines = text.replace(/^﻿/, "").split(/\r?\n/);
  if (lines[0]?.trimEnd() !== "---") return {};
  const end = lines.findIndex((l, i) => i > 0 && l.trimEnd() === "---");
  const block = lines.slice(1, end < 0 ? lines.length : end);
  const out: { name?: string; description?: string } = {};
  for (let i = 0; i < block.length; ) {
    const line = block[i++]!;
    if (line.startsWith(" ") || line.startsWith("\t")) continue;
    const colon = line.indexOf(":");
    if (colon < 0) continue;
    const raw = line.slice(colon + 1).trim();
    let value: string;
    if (raw.startsWith(">") || raw.startsWith("|")) {
      const parts: string[] = [];
      while (i < block.length && (block[i]!.startsWith(" ") || block[i]!.startsWith("\t") || !block[i]!.trim())) parts.push(block[i++]!.trim());
      value = parts.filter(Boolean).join(raw.startsWith(">") ? " " : "\n");
    } else value = unquote(raw);
    const k = line.slice(0, colon).trim();
    if (k === "name") out.name = value;
    else if (k === "description") out.description = value;
  }
  return out;
}

/** The description a listing shows: the frontmatter's, at most DESCRIPTION_CAP characters, on one line. */
export const descriptionOf = (text: string) => [...(frontmatter(text).description ?? "").split(/\s+/).filter(Boolean).join(" ")].slice(0, DESCRIPTION_CAP).join("");

/** The checkout's skills with their descriptions, for Settings → Projects → Agents (`skills_list`). */
export function repoSkills(root: string): RepoSkill[] {
  return repoCandidates(root)
    .sort((a, b) => byOrigin(a.origin) - byOrigin(b.origin) || cmp(a.name, b.name))
    .map((c) => {
      let text = "";
      try {
        text = readFileSync(join((c.from as { dir: string }).dir, SKILL_FILE), "utf8");
      } catch {}
      return { name: c.name, origin: c.origin, description: descriptionOf(text), path: `${REPO_DIRS[c.origin]}/${c.name}/${SKILL_FILE}` };
    });
}

/** Keeps the hub's skills from a launch or a send in the session's directory, for every start of it. */
export function keepSkills(sessionDir: string, bundles: SkillBundle[]): void {
  mkdirPrivate(sessionDir);
  const path = join(sessionDir, HUB_SKILLS_FILE);
  if (!bundles.length) return removeIfThere(() => rmSync(path));
  writeFileSync(path, JSON.stringify(bundles));
}

function keptSkills(sessionDir: string): Candidate[] {
  let bundles: SkillBundle[];
  try {
    bundles = JSON.parse(readFileSync(join(sessionDir, HUB_SKILLS_FILE), "utf8")) as SkillBundle[];
  } catch {
    return [];
  }
  return (Array.isArray(bundles) ? bundles : []).map((b) => ({ name: b.name, origin: b.origin, from: { files: b.files.map((f) => [f.path, f.text]) } }));
}

/** Writes the session's plugin afresh from the checkout at `cwd` and the hub's skills kept for it, so a start always
 * has what the sources hold now. */
export function prepare(sessionDir: string, cwd: string): Prepared {
  const winners = resolveSkills([...repoCandidates(cwd), ...keptSkills(sessionDir)]);
  const dir = join(sessionDir, "plugin");
  rmSync(dir, { recursive: true, force: true });
  if (!winners.length) return { skills: [] };
  mkdirPrivate(join(dir, ".claude-plugin"));
  const manifest = { name: PLUGIN_NAME, description: "The skills fleetd gives this session: the repo's, the project's and the hub's." };
  writeFileSync(join(dir, ".claude-plugin", "plugin.json"), `${JSON.stringify(manifest)}\n`);
  const skills: string[] = [];
  for (const c of winners) {
    const to = join(dir, "skills", c.name);
    try {
      if ("dir" in c.from) copySkill(c.from.dir, to);
      else writeFiles(to, c.from.files);
      skills.push(c.name);
    } catch (error) {
      console.log(`${nowIso()} WARN skill left out of the session: ${(error as Error).message} {"skill":"${c.name}"}`);
      rmSync(to, { recursive: true, force: true });
    }
  }
  return { pluginDir: dir, skills };
}

/** A folder-relative path that stays in the folder. */
const safeRel = (path: string) => !!path && !path.startsWith("/") && !path.includes("\\") && path.split("/").every((p) => p && p !== "." && p !== "..");

function writeFiles(to: string, files: [string, string][]): void {
  for (const [rel, text] of files) {
    if (!safeRel(rel)) throw new Error(`${rel} leaves its folder`);
    const path = join(to, rel);
    mkdirPrivate(dirname(path));
    writeFileSync(path, text);
  }
}

/** Copies a checkout's skill folder, its dot-files left out, within SKILL_FILES_CAP and SKILL_BYTES_CAP. Links are
 * followed, as skills.sh links `.claude/skills/<name>` to `.agents/skills/<name>`. */
function copySkill(from: string, to: string): void {
  let files = 0;
  let bytes = 0;
  const stack: [string, string][] = [[from, to]];
  while (stack.length) {
    const [src, dst] = stack.pop()!;
    mkdirPrivate(dst);
    for (const name of readdirSync(src)) {
      if (name.startsWith(".")) continue;
      const meta = statSync(join(src, name));
      if (meta.isDirectory()) stack.push([join(src, name), join(dst, name)]);
      else if (meta.isFile()) {
        files++;
        bytes += meta.size;
        if (files > SKILL_FILES_CAP || bytes > SKILL_BYTES_CAP) throw new Error(`${from} is past ${SKILL_FILES_CAP} files or ${SKILL_BYTES_CAP / 1024} KB`);
        copyFileSync(join(src, name), join(dst, name));
      }
    }
  }
}
