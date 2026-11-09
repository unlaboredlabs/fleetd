// The work matcher: compares a new intent with the work already in flight and
// says which of it the intent may repeat, how sure it is, and why ("3 shared words: dark, mode, toggle; same file
// app/theme.ts"). Pure and deterministic. It knows nothing of tasks, claims or the store: callers turn their rows into
// `Candidate`s, keep only the ones in the scope's repo and base, and decide what each strength does.
//
// - exact: the same item held by another owner, or the same issue, PR or branch, declared by the intent and declared
//   or written in a title by the other. Ids someone chose on purpose, so it is the only tier that may refuse outright.
// - strong: titles that share most of their words, or share words and most of their files; or a key the intent only
//   writes ("fix: regression from #57"). A one-time refusal: the caller passes the id in `notDuplicateOf`.
// - weak: two shared words, or one shared file. Only listed.
//
// Rust's regex `\b` and `\w` are Unicode; the patterns below spell those classes out, since JavaScript's are ASCII.
import { shortRemote } from "./repo_key.ts";

/** Strong on text alone: this share of the smaller title's words, and at least `STRONG_SHARED` of them. */
export const STRONG_SCORE = 0.6;
export const STRONG_SHARED = 3;
/** Strong on text and files: this share of words, at least 2 of them, and this share of the smaller path list. */
export const STRONG_FILE_SCORE = 0.4;
export const STRONG_PATH_SHARE = 0.5;
/** Weak: this many shared words, or any shared file. */
export const WEAK_SHARED = 2;

/** An id that names one piece of work: an issue, PR or tracker ref (`#12`, `ABC-123`, `owner/repo#12`), or a branch. */
export type MatchKey = { ref: string } | { branch: string };

export const sameKey = (a: MatchKey, b: MatchKey) =>
  "ref" in a ? "ref" in b && a.ref === b.ref : "branch" in b && a.branch === b.branch;

const keyText = (k: MatchKey) => ("ref" in k ? k.ref : `branch ${k.branch}`);

/** Rust's derived `Ord`: refs before branches, then by text. */
function keyOrder(a: MatchKey, b: MatchKey): number {
  const [ka, kb] = ["ref" in a ? 0 : 1, "ref" in b ? 0 : 1];
  if (ka !== kb) return ka - kb;
  const [ta, tb] = ["ref" in a ? a.ref : a.branch, "ref" in b ? b.ref : b.branch];
  return ta < tb ? -1 : ta > tb ? 1 : 0;
}

/** Where a key came from, surest first. */
export const enum From {
  /** A field the caller set: a task's item, a Change's PR, a claim's `--issue`. */
  Declared = 0,
  /** Written in a title. */
  Title = 1,
  /** Mentioned in a prompt's body. */
  Body = 2,
}

export type Key = { key: MatchKey; from: From };
export const declared = (key: MatchKey): Key => ({ key, from: From.Declared });

/** The repo and base being matched in: `repo` turns its own PR and issue URLs into `#12`; `base` is never a work branch. */
export type Scope = { repo?: string; base?: string };

/** One piece of work, new or in flight. */
export type Work = { owner?: string; title: string; keys: Key[]; paths: string[] };

/** The keys and paths in a title and a prompt. Callers add what was declared. */
export function readWork(owner: string | undefined, title: string, body: string, scope: Scope): Work {
  return {
    owner,
    title,
    keys: [
      ...keysIn(title, scope).map((key) => ({ key, from: From.Title })),
      ...keysIn(body, scope).map((key) => ({ key, from: From.Body })),
    ],
    paths: [...pathsIn(title), ...pathsIn(body)],
  };
}

export type Candidate = { id: string; work: Work; weakOnly: boolean };

export const enum Strength {
  Weak = 0,
  Strong = 1,
  Exact = 2,
}

export type Match = { id: string; strength: Strength; why: string };

/** strength, shared keys, the words' share in thousandths, shared words, shared files. */
type Rank = [number, number, number, number, number];

/** Every candidate the intent may repeat, strongest first; the rest are left out. */
export function matches(intent: Work, candidates: Candidate[], scope: Scope): Match[] {
  const words = wordsOf(intent.title);
  const found = candidates.flatMap((c) => {
    const m = compare(intent, words, c, scope);
    return m ? [m] : [];
  });
  found.sort(([a, am], [b, bm]) => {
    for (let i = 0; i < 5; i++) if (a[i] !== b[i]) return b[i]! - a[i]!;
    return am.id < bm.id ? -1 : am.id > bm.id ? 1 : 0;
  });
  return found.map(([, m]) => m);
}

function compare(intent: Work, words: Words, c: Candidate, scope: Scope): [Rank, Match] | undefined {
  const sameOwner = intent.owner !== undefined && intent.owner === c.work.owner;
  const base: MatchKey | undefined = scope.base !== undefined ? { branch: scope.base } : undefined;
  const firm: MatchKey[] = [];
  const mentioned: MatchKey[] = [];
  const add = (set: MatchKey[], k: MatchKey) => {
    if (!set.some((o) => sameKey(o, k))) set.push(k);
  };
  for (const k of intent.keys) {
    if (base && sameKey(k.key, base)) continue;
    const there = c.work.keys.filter((o) => sameKey(o.key, k.key)).map((o) => o.from);
    if (there.length === 0) continue;
    const surest = Math.min(...there);
    if (k.from === From.Declared && surest <= From.Title && !sameOwner) add(firm, k.key);
    else add(mentioned, k.key);
  }
  const mentionedOnly = mentioned.filter((k) => !firm.some((f) => sameKey(f, k)));
  firm.sort(keyOrder);
  mentionedOnly.sort(keyOrder);

  const theirs = wordsOf(c.work.title);
  const shared = words.filter(([s]) => theirs.some(([t]) => t === s)).map(([, w]) => w);
  const smaller = Math.min(words.length, theirs.length);
  const score = smaller === 0 ? 0 : shared.length / smaller;
  const [paths, pathShare] = sharedPaths(intent.paths, c.work.paths);

  const sameWords = shared.length > 0 && shared.length === words.length && shared.length === theirs.length;
  let strength: Strength;
  if (firm.length > 0) strength = Strength.Exact;
  else if (
    sameWords ||
    (score >= STRONG_SCORE && shared.length >= STRONG_SHARED) ||
    (score >= STRONG_FILE_SCORE && shared.length >= WEAK_SHARED && pathShare >= STRONG_PATH_SHARE) ||
    (mentionedOnly.length > 0 && !sameOwner)
  ) {
    strength = Strength.Strong;
  } else if (shared.length >= WEAK_SHARED || paths.length > 0 || mentionedOnly.length > 0) strength = Strength.Weak;
  else return undefined;
  if (c.weakOnly) strength = Math.min(strength, Strength.Weak) as Strength;

  const why: string[] = [];
  if (firm.length > 0) why.push(`same ${list(firm.map(keyText))}`);
  if (mentionedOnly.length > 0 && sameOwner) why.push(`same ${list(mentionedOnly.map(keyText))} (yours)`);
  else if (mentionedOnly.length > 0) why.push(`both mention ${list(mentionedOnly.map(keyText))}`);
  if (sameWords && shared.length < STRONG_SHARED) why.push(`same words: ${shared.join(", ")}`);
  else if (shared.length >= WEAK_SHARED) why.push(`${shared.length} shared words: ${shared.join(", ")}`);
  if (paths.length === 1) why.push(`same file ${paths[0]}`);
  else if (paths.length > 1) why.push(`${paths.length} same files: ${list(paths)}`);
  const rank: Rank = [strength, firm.length + mentionedOnly.length, Math.floor(score * 1000), shared.length, paths.length];
  return [rank, { id: c.id, strength, why: why.join("; ") }];
}

/** The first three, then "+N more". */
function list(items: string[]): string {
  const out = items.slice(0, 3).join(", ");
  return items.length > 3 ? `${out} +${items.length - 3} more` : out;
}

// ---- titles ----

/** Unicode letters and digits, as Rust's `char::is_alphanumeric`. */
const ALNUM = "\\p{Alphabetic}\\p{N}";
/** Rust regex's Unicode `\w`. */
const WORD = "\\p{Alphabetic}\\p{M}\\p{Nd}\\p{Pc}\\p{Join_Control}";
/** Rust regex's Unicode `\b` right after a word character: the next one isn't one. */
const END = `(?![${WORD}])`;

/** Conventional-commit types, dropped with their `(scope)` wherever they open a clause. */
const COMMIT_TYPE = /(?:^|[^\p{L}\p{N}])(?:feat|fix|chore|docs|refactor|perf|tests?|ci|build|style|revert|batch)(?:\([^)]*\))?!?:/gu;

/** Words that say what kind of change, not which: they would pair unrelated work. */
const STOP = new Set([
  "the", "and", "for", "with", "without", "from", "into", "onto", "its", "this", "that", "these", "those", "when",
  "then", "than", "not", "all", "any", "every", "one", "can", "now", "new", "add", "adds", "added", "update",
  "updates", "updated", "make", "makes", "support", "supports", "use", "uses", "fix", "fixes", "fixed", "via", "per",
  "who", "what", "which", "while", "also", "only", "just", "more", "less", "after", "before", "own", "their", "they",
  "our", "you", "your", "has", "have", "was", "were", "been", "does", "done", "are", "but", "out", "off", "too",
  "very", "some", "each", "here", "there", "how", "why", "should", "must", "will", "would", "could", "get", "gets",
  "set", "sets", "let", "lets", "work",
]);

/** A title's words in order, each once: [stem, the word as first written]. */
type Words = [string, string][];

const NOT_ALNUM = new RegExp(`[^${ALNUM}]`, "u");

function wordsOf(title: string): Words {
  const lower = title.toLowerCase().replace(COMMIT_TYPE, " ");
  const out: Words = [];
  for (const word of lower.split(NOT_ALNUM)) {
    if ([...word].length < 3 || /^[0-9]*$/.test(word) || STOP.has(word)) continue;
    const s = stem(word);
    if (!out.some(([t]) => t === s)) out.push([s, word]);
  }
  return out;
}

/** Plurals meet their singular: "replies" and "reply", "orders" and "order"; "status" and "class" stay whole. */
function stem(word: string): string {
  const n = [...word].length;
  if (n > 4 && word.endsWith("ies")) return `${word.slice(0, -3)}y`;
  if (n > 3 && word.endsWith("s") && !["ss", "us", "is"].some((e) => word.endsWith(e))) return word.slice(0, -1);
  return word;
}

// ---- keys ----

const URL_RE = /https?:\/\/[^\s<>()[\]{}"'`]+/gu;
/** `#12` and `!12` standing alone: not `&#12;`, `C#12` or `wow!12`. */
const NUMBER = new RegExp(`(?:^|[\\s(\\[{,;:])([#!][1-9][0-9]{0,6})${END}`, "gu");
/** `owner/repo#12`, `group/proj!12`: GitHub's cross-repo refs and GitLab's merge message. */
const REPO_NUMBER = new RegExp(`(?:^|[^\\p{L}\\p{N}_./-])((?:[${WORD}.-]+/)+[${WORD}.-]+)([#!][1-9][0-9]{0,6})${END}`, "gu");
/** A tracker key, `ABC-123`. */
const TICKET = new RegExp(`(?:^|[^\\p{L}\\p{N}_-])([A-Z][A-Z0-9]{1,9}-[1-9][0-9]{0,6})${END}`, "gu");
const TICKET_WHOLE = new RegExp(`^(?:[A-Z][A-Z0-9]{1,9}-[1-9][0-9]{0,6})${END}`, "u");
/** Upper-case prefixes of standards and versions, not tracker keys: `UTF-8`, `SHA-256`, `RFC-3339`. */
const NOT_TICKETS = new Set([
  "API", "AV", "CUDA", "DDR", "GCC", "GO", "HEVC", "IOS", "JAVA", "JDK", "JEP", "JRE", "JSR", "LLVM", "LTE", "MAC",
  "MPEG", "NODE", "OS", "PCI", "PHP", "PY", "PYTHON", "SDK", "USB", "VP", "WIN", "AES", "ANSI", "ARM", "CRC", "CVE",
  "ECMA", "ES", "GPT", "HTTP", "IEC", "IEEE", "IPV", "ISO", "MD", "MP", "PEP", "RFC", "RSA", "SHA", "SSL", "TLS", "UCS",
  "UTF", "WCAG",
]);

/** The issue, PR and tracker keys written in `text`. "P1" is not one: it is as often a priority. */
export function keysIn(text: string, scope: Scope): MatchKey[] {
  const keys: MatchKey[] = [];
  for (const m of text.matchAll(URL_RE)) {
    const k = urlKey(m[0], scope);
    if (k) keys.push(k);
  }
  const rest = text.replace(URL_RE, " ");
  for (const m of rest.matchAll(REPO_NUMBER)) keys.push(repoRef(m[1]!, m[2]!, scope));
  for (const m of rest.matchAll(NUMBER)) keys.push({ ref: m[1]! });
  for (const m of rest.matchAll(TICKET)) {
    const key = m[1]!;
    const end = m.index! + m[0].length;
    const prefix = key.split("-")[0] ?? "";
    // "ISO-8601-1", "CVE-2024-1234", "X-1.2": a standard or a version, not a key.
    const after = rest.slice(end);
    const continues = (after.startsWith("-") || after.startsWith(".")) && /^[0-9]/.test(after.slice(1));
    if (!NOT_TICKETS.has(prefix) && !continues) keys.push({ ref: key });
  }
  const out: MatchKey[] = [];
  for (const k of keys) if (!out.some((o) => sameKey(o, k))) out.push(k);
  return out;
}

/** A PR, merge request or issue URL on any host, or a tracker's `/browse/ABC-123`. */
function urlKey(raw: string, scope: Scope): MatchKey | undefined {
  const url = (raw.split(/[?#]/)[0] ?? "").replace(/[.,;:!/]+$/, "");
  const parts = shortRemote(url).split("/");
  const number = (i: number) => {
    const n = parts[i];
    return n !== undefined && /^[0-9]+$/.test(n) ? n : undefined;
  };
  for (let i = 1; i < parts.length; i++) {
    const part = parts[i];
    const next = parts[i + 1];
    if (part === "browse" && next !== undefined && TICKET_WHOLE.test(next)) return { ref: next };
    let sigil: string;
    let n: string | undefined;
    if (part === "-" && next === "merge_requests") [sigil, n] = ["!", number(i + 2)];
    else if (part === "-" && next === "issues") [sigil, n] = ["#", number(i + 2)];
    else if ((part === "pull" || part === "pulls" || part === "pull-requests" || part === "issues") && i >= 3) [sigil, n] = ["#", number(i + 1)];
    else continue;
    if (n === undefined) continue;
    return repoRef(parts.slice(1, i).join("/"), `${sigil}${n}`, scope);
  }
  return undefined;
}

/** `#12` in the scope's repo, `owner/repo#12` in another. Repos compare by path, whatever the host. */
function repoRef(repo: string, number: string, scope: Scope): MatchKey {
  let ours = false;
  if (scope.repo !== undefined) {
    const short = shortRemote(scope.repo);
    const slash = short.indexOf("/");
    ours = slash >= 0 && asciiLower(short.slice(slash + 1)) === asciiLower(repo);
  }
  return { ref: ours ? number : `${repo}${number}` };
}

const asciiLower = (s: string) => s.replace(/[A-Z]/g, (c) => c.toLowerCase());

// ---- paths ----

const TRIM = "`'\"()[]{}<>,;:!?";
const PATH_CHARS = new RegExp(`^[${ALNUM}/._\\-*+@~]*$`, "u");

/**
 * The tokens in `text` that look like repo paths: they have a directory (`a/b.ts`, `docs/`, `a/b/c`, `src/**`), so
 * `read/write` and `10/25` stay prose. Bare file names are left out: they are in most changes, so say nothing.
 */
export function pathsIn(text: string): string[] {
  const out: string[] = [];
  for (const raw of text.split(/\s+/u)) {
    if (raw === "") continue;
    let token = trimChars(raw, TRIM).replace(/\.+$/, "");
    while (token.startsWith("./")) token = token.slice(2);
    if (
      !token.includes("/") ||
      token.includes("://") ||
      !PATH_CHARS.test(token) ||
      token.split("/").every((s) => /^[0-9]*$/.test(s))
    ) {
      continue;
    }
    const last = token.slice(token.lastIndexOf("/") + 1);
    const dot = last.lastIndexOf(".");
    const ext = dot >= 0 ? last.slice(dot + 1) : "";
    const hasExt = dot > 0 && ext.length >= 1 && ext.length <= 10 && /^[A-Za-z0-9]+$/.test(ext);
    const pathlike = token.endsWith("/") || token.includes("*") || hasExt || token.split("/").length - 1 >= 2;
    if (pathlike && !out.includes(token)) out.push(token);
  }
  return out;
}

function trimChars(s: string, chars: string): string {
  let a = 0;
  let b = s.length;
  while (a < b && chars.includes(s[a]!)) a++;
  while (b > a && chars.includes(s[b - 1]!)) b--;
  return s.slice(a, b);
}

/** The paths of `a` that meet one of `b`'s, and the larger of the two sides' shares that meet. */
function sharedPaths(a: string[], b: string[]): [string[], number] {
  const [pa, pb] = [paths(a), paths(b)];
  const hitsA = pa.all.filter((p) => meets(pb, p));
  if (hitsA.length === 0) return [hitsA, 0];
  const hitsB = pb.all.filter((q) => meets(pa, q)).length;
  return [hitsA, Math.max(hitsA.length / pa.all.length, hitsB / pb.all.length)];
}

/** A path list, each once, its plain paths looked up by value: a writer's changes run to hundreds. */
type Paths = { all: string[]; plain: Set<string>; globs: string[] };

function paths(list: string[]): Paths {
  const out: Paths = { all: [], plain: new Set(), globs: [] };
  for (const raw of list) {
    const p = normPath(raw);
    if (p === "") continue;
    let added: boolean;
    if (isGlob(p)) {
      added = !out.globs.includes(p);
      if (added) out.globs.push(p);
    } else {
      added = !out.plain.has(p);
      out.plain.add(p);
    }
    if (added) out.all.push(p);
  }
  return out;
}

function meets(set: Paths, p: string): boolean {
  if (isGlob(p)) return [...set.plain].some((q) => glob(p, q)) || set.globs.some((g) => globsMeet(p, g));
  return set.plain.has(p) || set.globs.some((g) => glob(g, p));
}

/** `./a/b` is `a/b`; a directory `a/` covers `a/**`. */
function normPath(raw: string): string {
  let p = raw.trim();
  while (p.startsWith("./")) p = p.slice(2);
  if (p.endsWith("/") && p.length > 1) return `${p.slice(0, -1)}/**`;
  return p;
}

const isGlob = (p: string) => p.includes("*") || p.includes("?");

/** Two globs meet when one's fixed directory holds the other's. */
function globsMeet(a: string, b: string): boolean {
  const [x, y] = [fixedDir(a), fixedDir(b)];
  return x.startsWith(y) || y.startsWith(x);
}

/** The directories before a glob's first wildcard, with their trailing `/`. */
function fixedDir(p: string): string {
  const wild = p.search(/[*?]/);
  const head = wild < 0 ? p : p.slice(0, wild);
  return head.slice(0, head.lastIndexOf("/") + 1);
}

/** `**` is any number of directories; `*` and `?` stay within one. Neither backtracks. */
export function glob(pattern: string, path: string): boolean {
  const s = path.split("/");
  let reach = new Array<boolean>(s.length + 1).fill(false);
  reach[0] = true;
  for (const seg of pattern.split("/")) {
    const next = new Array<boolean>(s.length + 1).fill(false);
    if (seg === "**") {
      let any = false;
      for (let j = 0; j <= s.length; j++) {
        any ||= reach[j]!;
        next[j] = any;
      }
    } else {
      for (let j = 0; j < s.length; j++) next[j + 1] = reach[j]! && segment(seg, s[j]!);
    }
    reach = next;
  }
  return reach[s.length]!;
}

/** One directory's name against `*` and `?`: the last `*` takes one more character at each miss. */
function segment(pattern: string, name: string): boolean {
  const [p, s] = [[...pattern], [...name]];
  let [i, j] = [0, 0];
  let star: [number, number] | undefined;
  while (j < s.length) {
    if (i < p.length && (p[i] === "?" || p[i] === s[j])) {
      i++;
      j++;
    } else if (i < p.length && p[i] === "*") {
      star = [i, j];
      i++;
    } else if (star) {
      i = star[0] + 1;
      j = star[1] + 1;
      star = [star[0], star[1] + 1];
    } else return false;
  }
  return p.slice(i).every((c) => c === "*");
}
