// Settings → Projects, the parts with no React: reading a pasted .env, checking a variable before it goes, and what
// a delete would lose. The hub checks the same rules (project_settings.rs); these only say so before a call.
import { ENV_TOTAL_MAX_BYTES, ENV_VALUE_MAX_BYTES, type ProjectEnvVar, type ProjectSettings, type ProjectWorktree } from "../../../shared/contracts";

export type EnvKind = "plain" | "secret";

/** project_settings.rs EnvVarName. */
const NAME = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/u;

/** project_settings.rs env_name_reserved: what fleetd sets itself for every session, and claude's own. */
export const reservedName = (name: string): boolean =>
  ["HOME", "PATH", "USER", "TMPDIR", "TMP", "TEMP"].includes(name) || ["FLEETD_", "ANTHROPIC_", "CLAUDE"].some((p) => name.startsWith(p));

export const byteLength = (value: string): number => new TextEncoder().encode(value).length;

/** project_settings.rs PROJECT_ENV_MAX. */
export const ENV_MAX = 100;

/** Why `name` can't be a variable, or null. */
export function nameProblem(name: string): string | null {
  if (name === "") return "Name it.";
  if (!NAME.test(name)) return "A name is letters, digits and _, and doesn't start with a digit.";
  if (reservedName(name)) return `${name} is fleetd's or claude's own: a project can't set it.`;
  return null;
}

/** Why `value` can't be this kind of variable's value, or null. Any number of lines, plain or secret. */
export function valueProblem(value: string, kind: EnvKind): string | null {
  if (kind === "secret" && value === "") return "Type or paste the value.";
  if (byteLength(value) > ENV_VALUE_MAX_BYTES) return "A value is at most 64 KiB.";
  if (value.includes("\0")) return "A value can't hold a NUL character.";
  return null;
}

/** project_settings.rs env_total_over: the project's values together after a change, past 512 KiB. */
export function totalProblem(env: readonly ProjectEnvVar[], set: ReadonlyArray<{ name: string; value: string }>, remove: readonly string[] = []): string | null {
  const sizes = new Map(env.map((v) => [v.name, v.bytes]));
  for (const name of remove) sizes.delete(name);
  for (const v of set) sizes.set(v.name, byteLength(v.value));
  const total = [...sizes.values()].reduce((a, b) => a + b, 0);
  return total > ENV_TOTAL_MAX_BYTES ? `A project's variables take at most 512 KiB together; these would take ${Math.ceil(total / 1024)} KiB.` : null;
}

/** Names that usually hold a credential: a pasted one starts as a secret. */
const SECRETISH = /(KEY|TOKEN|SECRET|PASSWORD|PASSWD|PASS|PRIVATE|CREDENTIAL|AUTH|DSN|COOKIE|SESSION)/u;

export const guessKind = (name: string): EnvKind => (SECRETISH.test(name.toUpperCase()) ? "secret" : "plain");

export interface PastedVar {
  readonly name: string;
  readonly value: string;
  readonly kind: EnvKind;
  /** What is wrong with how it was written (a quote never closed), whatever its kind; or null. */
  readonly syntax: string | null;
  /** Why it can't be added as it is, or null. */
  readonly problem: string | null;
}

/** A double-quoted value's escapes, as dotenv reads them. */
const unescape = (v: string) => v.replace(/\\([nrt"\\])/gu, (_, c: string) => ({ n: "\n", r: "\r", t: "\t", '"': '"', "\\": "\\" })[c] ?? c);

/**
 * A pasted .env: `NAME=value` lines, `export ` allowed, blank lines and `#` comments skipped. A value may be quoted,
 * over as many lines as it needs (a certificate, a key, JSON): '…' as is, "…" with \n-style escapes. An unquoted one
 * ends at the line's end or at ` #`. A quote never closed is that variable's problem, naming its line, and reading
 * goes on with the next line. A later line for the same name wins.
 */
export function parseDotEnv(text: string): PastedVar[] {
  const out = new Map<string, PastedVar>();
  const src = text.replace(/\r\n?/gu, "\n");
  const lineEnd = (from: number) => {
    const n = src.indexOf("\n", from);
    return n < 0 ? src.length : n;
  };
  const blank = (c: string | undefined) => c === " " || c === "\t";
  let at = 0;
  while (at < src.length) {
    const end = lineEnd(at);
    const line = src.slice(at, end).trim();
    if (line === "" || line.startsWith("#")) {
      at = end + 1;
      continue;
    }
    let p = at;
    while (blank(src[p])) p++;
    if (src.startsWith("export ", p)) {
      p += 7;
      while (blank(src[p])) p++;
    }
    const eq = src.indexOf("=", p);
    if (eq < 0 || eq > end) {
      at = end + 1;
      continue;
    }
    const name = src.slice(p, eq).trim();
    let v = eq + 1;
    while (v < end && blank(src[v])) v++;
    const quote = src[v];
    let value: string;
    let syntax: string | null = null;
    if (quote === '"' || quote === "'") {
      // To the closing quote, on this line or a later one; inside "…" a backslash escapes the next character.
      let k = v + 1;
      while (k < src.length && src[k] !== quote) {
        if (quote === '"' && src[k] === "\\") k++;
        k++;
      }
      if (k >= src.length) {
        // Never closed: the rest of the paste is not its value. Its own line is, as typed, and the next line reads on.
        const line = src.slice(0, at).split("\n").length;
        syntax = `Line ${line}: the ${quote === '"' ? "double" : "single"} quote that opens ${name}'s value is never closed.`;
        value = src.slice(v + 1, end);
        at = end + 1;
      } else {
        const raw = src.slice(v + 1, k);
        value = quote === '"' ? unescape(raw) : raw;
        // Whatever follows the closing quote on its line (a comment) is skipped.
        at = lineEnd(k) + 1;
      }
    } else {
      value = src.slice(v, end).trimEnd();
      const comment = value.search(/\s#/u);
      if (comment >= 0) value = value.slice(0, comment).trimEnd();
      at = end + 1;
    }
    const kind = guessKind(name);
    out.delete(name);
    out.set(name, { name, value, kind, syntax, problem: syntax ?? nameProblem(name) ?? valueProblem(value, kind) });
  }
  return [...out.values()];
}

/** The same variable with another kind, its problem checked again. */
export const withKind = (v: PastedVar, kind: EnvKind): PastedVar => ({
  ...v,
  kind,
  problem: v.syntax ?? nameProblem(v.name) ?? valueProblem(v.value, kind),
});

/** What a variable shows in the list: a plain one's value, a secret's fingerprint, never a secret's value. */
export const shownValue = (v: ProjectEnvVar): string => (v.kind === "secret" ? `secret · ${v.fingerprint ?? "saved"}` : v.value ?? "");

/** How many variables the project would have after adding `names`. */
export const countAfter = (env: readonly ProjectEnvVar[], names: readonly string[]): number => new Set([...env.map((v) => v.name), ...names]).size;

/** The worktrees a delete would lose work in: their uncommitted changes go with them. */
export const unsavedWorktrees = (settings: ProjectSettings): ProjectWorktree[] => (settings.worktrees?.worktrees ?? []).filter((w) => w.uncommitted);

