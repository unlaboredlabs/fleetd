// Settings → Projects, the parts with no React: reading a pasted .env, checking a variable before it goes, and what
// a delete would lose. The hub checks the same rules (project_settings.rs); these only say so before a call.
import type { ProjectEnvVar, ProjectSettings, ProjectWorktree } from "../../../shared/contracts";

export type EnvKind = "plain" | "secret";

/** project_settings.rs EnvVarName. */
const NAME = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/u;

/** project_settings.rs env_name_reserved: what fleetd sets itself for every session, and claude's own. */
export const reservedName = (name: string): boolean =>
  ["HOME", "PATH", "USER", "TMPDIR", "TMP", "TEMP"].includes(name) || ["FLEETD_", "ANTHROPIC_", "CLAUDE"].some((p) => name.startsWith(p));

/** project_settings.rs ENV_VALUE_MAX_BYTES, plain and secret alike. */
const MAX_BYTES = 8192;

/** project_settings.rs PROJECT_ENV_MAX. */
export const ENV_MAX = 100;

/** Why `name` can't be a variable, or null. */
export function nameProblem(name: string): string | null {
  if (name === "") return "Name it.";
  if (!NAME.test(name)) return "A name is letters, digits and _, and doesn't start with a digit.";
  if (reservedName(name)) return `${name} is fleetd's or claude's own: a project can't set it.`;
  return null;
}

/** Why `value` can't be this kind of variable's value, or null. */
export function valueProblem(value: string, kind: EnvKind): string | null {
  if (kind === "secret" && value === "") return "Type or paste the value.";
  if (new TextEncoder().encode(value).length > MAX_BYTES) return `A value is at most ${MAX_BYTES} bytes.`;
  if (value.includes("\0")) return "A value can't hold a NUL character.";
  if (kind === "secret" && /[\r\n]/u.test(value)) return "A secret is one line.";
  return null;
}

/** Names that usually hold a credential: a pasted one starts as a secret. */
const SECRETISH = /(KEY|TOKEN|SECRET|PASSWORD|PASSWD|PASS|PRIVATE|CREDENTIAL|AUTH|DSN|COOKIE|SESSION)/u;

export const guessKind = (name: string): EnvKind => (SECRETISH.test(name.toUpperCase()) ? "secret" : "plain");

export interface PastedVar {
  readonly name: string;
  readonly value: string;
  readonly kind: EnvKind;
  /** Why it can't be added as it is, or null. */
  readonly problem: string | null;
}

/** A double-quoted value's escapes, as dotenv reads them. */
const unescape = (v: string) => v.replace(/\\([nrt"\\])/gu, (_, c: string) => ({ n: "\n", r: "\r", t: "\t", '"': '"', "\\": "\\" })[c] ?? c);

/**
 * A pasted .env: `NAME=value` lines, `export ` allowed, blank lines and `#` comments skipped. A value may be quoted
 * ('…' as is, "…" with \n-style escapes); an unquoted one ends at ` #`. A later line for the same name wins.
 */
export function parseDotEnv(text: string): PastedVar[] {
  const out = new Map<string, PastedVar>();
  for (const raw of text.split(/\r?\n/u)) {
    const line = raw.trim();
    if (line === "" || line.startsWith("#")) continue;
    const body = line.startsWith("export ") ? line.slice(7).trimStart() : line;
    const at = body.indexOf("=");
    if (at < 0) continue;
    const name = body.slice(0, at).trim();
    let value = body.slice(at + 1).trim();
    const quote = value[0];
    if ((quote === '"' || quote === "'") && value.length > 1 && value.endsWith(quote)) {
      value = value.slice(1, -1);
      if (quote === '"') value = unescape(value);
    } else {
      const comment = value.search(/\s#/u);
      if (comment >= 0) value = value.slice(0, comment).trimEnd();
    }
    const kind = guessKind(name);
    out.delete(name);
    out.set(name, { name, value, kind, problem: nameProblem(name) ?? valueProblem(value, kind) });
  }
  return [...out.values()];
}

/** The same variable with another kind, its problem checked again. */
export const withKind = (v: PastedVar, kind: EnvKind): PastedVar => ({ ...v, kind, problem: nameProblem(v.name) ?? valueProblem(v.value, kind) });

/** What a variable shows in the list: a plain one's value, a secret's fingerprint, never a secret's value. */
export const shownValue = (v: ProjectEnvVar): string => (v.kind === "secret" ? `secret · ${v.fingerprint ?? "saved"}` : v.value ?? "");

/** How many variables the project would have after adding `names`. */
export const countAfter = (env: readonly ProjectEnvVar[], names: readonly string[]): number => new Set([...env.map((v) => v.name), ...names]).size;

/** The worktrees a delete would lose work in: their uncommitted changes go with them. */
export const unsavedWorktrees = (settings: ProjectSettings): ProjectWorktree[] => (settings.worktrees?.worktrees ?? []).filter((w) => w.uncommitted);

