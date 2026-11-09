// A SKILL.md's rules: its frontmatter, its description, its checks.
import { linesOf } from "../memory/index.ts";

export const SKILL_FILE = "SKILL.md";
export const SKILL_TEXT_CAP = 64_000;
export const DESCRIPTION_CAP = 1_024;
export const SKILL_FILES_CAP = 64;
export const SKILL_BYTES_CAP = 512 * 1024;
export const SCOPE_CAP = 200;
export const SKILL_VERSIONS_KEPT = 100;
export const WHY_CAP = 300;

export const isSkillName = (s: string) => s.length <= 64 && /^[a-z0-9]+(-[a-z0-9]+)*$/.test(s);

export type Frontmatter = { name?: string; description?: string };

function unquote(value: string): string {
  for (const q of ['"', "'"]) {
    if (value.length >= 2 && value.startsWith(q) && value.endsWith(q)) {
      const inner = value.slice(1, -1);
      return q === "'" ? inner.replaceAll("''", "'") : inner.replaceAll('\\"', '"').replaceAll("\\\\", "\\");
    }
  }
  // A plain scalar ends at a comment.
  return (value.split(" #")[0] ?? value).trim();
}

/** The `name` and `description` of a SKILL.md's YAML frontmatter: plain, quoted and block (`>`, `|`) scalars. */
export function frontmatter(raw: string): Frontmatter {
  const text = raw.startsWith("﻿") ? raw.slice(1) : raw;
  const lines = linesOf(text);
  if ((lines[0] ?? "").trimEnd() !== "---") return {};
  const block: string[] = [];
  for (const l of lines.slice(1)) {
    if (l.trimEnd() === "---") break;
    block.push(l);
  }
  const out: Frontmatter = {};
  let i = 0;
  while (i < block.length) {
    const line = block[i] as string;
    i++;
    if (line.startsWith(" ") || line.startsWith("\t")) continue;
    const at = line.indexOf(":");
    if (at < 0) continue;
    const key = line.slice(0, at).trim();
    let value = line.slice(at + 1).trim();
    if (value.startsWith(">") || value.startsWith("|")) {
      const folded = value.startsWith(">");
      const parts: string[] = [];
      while (i < block.length && ((block[i] as string).startsWith(" ") || (block[i] as string).startsWith("\t") || !(block[i] as string).trim())) {
        parts.push((block[i] as string).trim());
        i++;
      }
      value = parts.filter(Boolean).join(folded ? " " : "\n");
    } else value = unquote(value);
    if (key === "name") out.name = value;
    else if (key === "description") out.description = value;
  }
  return out;
}

/** The description a listing shows: the frontmatter's, at most DESCRIPTION_CAP characters, on one line. */
export const descriptionOf = (text: string) => [...(frontmatter(text).description ?? "").split(/\s+/u).filter(Boolean).join(" ")].slice(0, DESCRIPTION_CAP).join("");

/** What is wrong with `text` as the SKILL.md of a skill called `name`, or undefined. */
export function checkSkillMd(name: string, text: string): string | undefined {
  if ([...text].length > SKILL_TEXT_CAP) return `SKILL.md is past its cap of ${SKILL_TEXT_CAP} characters.`;
  const front = frontmatter(text);
  if (front.name === undefined && front.description === undefined && !text.trimStart().startsWith("---")) {
    return "SKILL.md starts with frontmatter: ---, name and description, ---.";
  }
  if (front.name !== undefined && front.name !== name) return `The frontmatter names it ${front.name}, and its folder is ${name}: they must match.`;
  const d = front.description?.trim();
  if (!d) return "The frontmatter needs a description: what the skill does and when to use it.";
  if ([...d].length > DESCRIPTION_CAP) return `The description is past its cap of ${DESCRIPTION_CAP} characters.`;
  return undefined;
}

/** A new skill's SKILL.md, which the app's New starts from. */
export const template = (name: string) =>
  `---\nname: ${name}\ndescription: What this skill does, and when an agent should use it.\n---\n\n# ${name}\n\nSteps the agent follows, in order.\n`;
