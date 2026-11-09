// `{{name}}` templates, pure: rendering, the refs that name a text, the
// warnings an edit gets, and the 3-way merge an override gets when a release changes its default.
import type { PromptWarning } from "../../shared/contracts.ts";
import { budget, placeholdersOf, type RegistryEntry, safetyRules } from "./entry.ts";

/** What `git hash-object <file>` prints for these bytes. */
export function gitBlobSha(content: string): string {
  const bytes = Buffer.from(content);
  return new Bun.CryptoHasher("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex");
}

/** `<id>@<first 10 hex of the text's git blob SHA>`. */
export const refOf = (id: string, text: string) => `${id}@${gitBlobSha(text).slice(0, 10)}`;

const words = (s: string) => s.split(/\s+/u).filter(Boolean);

/** The same words in the same order, whatever the whitespace between them. */
export function sameWords(a: string, b: string): boolean {
  const [x, y] = [words(a), words(b)];
  return x.length === y.length && x.every((w, i) => w === y[i]);
}

const isName = (s: string) => /^[A-Za-z][A-Za-z0-9_]*$/.test(s);

export type Vars = Record<string, string | number>;

/**
 * One pass over `template`: each `{{name}}` with a value is replaced, any other is left as written. Values are never
 * scanned. One trailing newline of the file is dropped.
 */
export function render(template: string, vars: Vars): string {
  let rest = template.endsWith("\n") ? template.slice(0, -1) : template;
  let out = "";
  for (;;) {
    const start = rest.indexOf("{{");
    if (start < 0) break;
    out += rest.slice(0, start);
    const after = rest.slice(start + 2);
    const end = after.indexOf("}}");
    const name = end >= 0 ? after.slice(0, end) : "";
    if (end >= 0 && isName(name) && Object.hasOwn(vars, name)) {
      out += String(vars[name]);
      rest = after.slice(end + 2);
    } else {
      out += "{{";
      rest = after;
    }
  }
  return out + rest;
}

/** Every `{{name}}` in `text`, in order, each once. */
export function placeholdersIn(text: string): string[] {
  const names: string[] = [];
  let rest = text;
  for (;;) {
    const start = rest.indexOf("{{");
    if (start < 0) break;
    const after = rest.slice(start + 2);
    const end = after.indexOf("}}");
    if (end >= 0 && isName(after.slice(0, end))) {
      const name = after.slice(0, end);
      if (!names.includes(name)) names.push(name);
      rest = after.slice(end + 2);
    } else rest = after;
  }
  return names;
}

export function rulePresent(needle: string, text: string): boolean {
  try {
    return new RegExp(needle, "iu").test(text);
  } catch {
    return false;
  }
}

/** What an edit of `entry` to `text` may break. Never a refusal. */
export function warnings(entry: RegistryEntry, text: string): PromptWarning[] {
  const out: PromptWarning[] = [];
  const declared = placeholdersOf(entry);
  const used = placeholdersIn(text);
  for (const p of declared.filter((p) => p.required && !used.includes(p.name))) {
    out.push({
      code: "placeholder_missing",
      message: `{{${p.name}}} is gone: the model no longer gets ${p.description}.`,
      placeholder: p.name,
    });
  }
  for (const name of used.filter((n) => !declared.some((p) => p.name === n))) {
    out.push({
      code: "placeholder_unknown",
      message: `fleetd does not fill in {{${name}}} here; the model reads it as written.`,
      placeholder: name,
    });
  }
  for (const rule of safetyRules(entry)) {
    if (rulePresent(rule.needle, entry.default) && !rulePresent(rule.needle, text)) {
      const consequence =
        rule.enforced === "code"
          ? "fleetd still enforces this; agents will hit refusals they were not warned about"
          : "nothing else enforces this";
      out.push({
        code: "safety_rule_missing",
        message: `The text no longer carries the rule "${rule.label}" (${rule.id}): ${consequence}.`,
        rule: rule.id,
        enforced: rule.enforced,
      });
    }
  }
  const [len, max] = [[...text].length, budget(entry)];
  if (len > max) {
    out.push({
      code: "too_long",
      message: `${len} characters, past the ${max} this prompt is sized for; every session that gets it pays for it.`,
    });
  }
  return out;
}

// ---- merge: a line diff3 (diffy's `merge`, ours = yours, theirs = the new default) ----

const lines = (s: string) => s.split(/(?<=\n)/).filter((l) => l !== "");

/** Pairs of equal line indices (a, b), increasing: the longest common subsequence. */
function lcs(a: string[], b: string[]): [number, number][] {
  const n = a.length;
  const m = b.length;
  const dp: Uint32Array[] = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      (dp[i] as Uint32Array)[j] =
        a[i] === b[j] ? ((dp[i + 1] as Uint32Array)[j + 1] as number) + 1 : Math.max((dp[i + 1] as Uint32Array)[j] as number, (dp[i] as Uint32Array)[j + 1] as number);
    }
  }
  const out: [number, number][] = [];
  let [i, j] = [0, 0];
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      out.push([i, j]);
      i++;
      j++;
    } else if (((dp[i + 1] as Uint32Array)[j] as number) >= ((dp[i] as Uint32Array)[j + 1] as number)) i++;
    else j++;
  }
  return out;
}

/** A line 3-way merge of `base` → `current` into `yours`: the text, and whether it has conflict markers. */
export function merge(base: string, current: string, yours: string): { text: string; conflicts: boolean } {
  const [o, a, b] = [lines(base), lines(yours), lines(current)];
  const ma = new Map(lcs(o, a));
  const mb = new Map(lcs(o, b));
  let out = "";
  let conflicts = false;
  let [io, ia, ib] = [0, 0, 0];
  const flush = (eo: number, ea: number, eb: number) => {
    const so = o.slice(io, eo).join("");
    const sa = a.slice(ia, ea).join("");
    const sb = b.slice(ib, eb).join("");
    if (sa === so) out += sb;
    else if (sb === so || sa === sb) out += sa;
    else {
      conflicts = true;
      const nl = (s: string) => (s === "" || s.endsWith("\n") ? s : `${s}\n`);
      out += `<<<<<<< ours\n${nl(sa)}||||||| original\n${nl(so)}=======\n${nl(sb)}>>>>>>> theirs\n`;
    }
  };
  for (let k = 0; k < o.length; k++) {
    const ja = ma.get(k);
    const jb = mb.get(k);
    if (ja === undefined || jb === undefined || ja < ia || jb < ib) continue;
    flush(k, ja, jb);
    out += o[k];
    [io, ia, ib] = [k + 1, ja + 1, jb + 1];
  }
  flush(o.length, a.length, b.length);
  return { text: out, conflicts };
}
