// The composer's `$`: typing `$` and a few letters offers the project's skills (skills_list); picking one puts
// `$name` in the box, and a sent message names every `$name` that is a skill, so the lead's copy lists them. Pure, so
// it is tested without a screen.

/** At most this many skills named per message (chat_send's cap). */
export const SKILLS_PER_MESSAGE = 8;

export interface SkillOption {
  readonly name: string;
  readonly description: string;
}

/** The `$word` the caret is at the end of, from its `$`; a `$` inside a word (`a$b`) is no token. */
export function skillToken(text: string, caret: number): { readonly start: number; readonly query: string } | null {
  const m = /(^|\s)\$([a-z0-9-]*)$/u.exec(text.slice(0, caret));
  if (m === null) return null;
  const query = m[2] ?? "";
  return { start: caret - query.length - 1, query };
}

/** The skills whose names fit `query`: starting with it first, then containing it; one row per name. */
export function completions(query: string, skills: ReadonlyArray<SkillOption>, limit = 6): SkillOption[] {
  const seen = new Set<string>();
  const unique = skills.filter((s) => !seen.has(s.name) && seen.add(s.name));
  const q = query.toLowerCase();
  const starts = unique.filter((s) => s.name.startsWith(q));
  const contains = unique.filter((s) => !s.name.startsWith(q) && s.name.includes(q));
  return [...starts, ...contains].slice(0, limit);
}

/** The box after picking `name` for the token at `start`: `$name ` in its place, the caret after it. */
export function pick(text: string, caret: number, start: number, name: string): { readonly text: string; readonly caret: number } {
  const put = `$${name} `;
  const rest = text.slice(caret).replace(/^\S*/u, "").replace(/^ /u, "");
  return { text: text.slice(0, start) + put + rest, caret: start + put.length };
}

/** The skills a message names: each `$name` that is one of `known`, once, in order. */
export function namedSkills(text: string, known: ReadonlySet<string>): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(/(?:^|\s)\$([a-z0-9]+(?:-[a-z0-9]+)*)(?=$|[\s.,;:!?)])/gu)) {
    const name = m[1] ?? "";
    if (known.has(name) && !out.includes(name)) out.push(name);
  }
  return out.slice(0, SKILLS_PER_MESSAGE);
}
