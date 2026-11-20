// What a change to the QA screens' own files does to them, for qa/touched.ts: the screens whose registry entry
// changed, and those whose code calls a helper that did.
//
// - own: each screen whose entry differs from the base's, its values (a moved route, a fixture added) and its open and
//   check code as written, or that the base has no entry for. Entries are told apart by label (id~variant).
// - users: each screen whose code names a registry helper whose code changed (a function or const of registry.ts, or
//   one that names such a helper in turn), or a name registry.ts imports from a changed file (scroll.ts,
//   fixtures/agents/route.ts). The harness, screens.spec.ts and dom/ run on every screen, so they pick none.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { label, type Screen } from "./registry.ts";

const QA = import.meta.dirname;

/** The screens a registry.ts source defines, imported from a copy whose imports reach this app's files. */
export const load = async (source: string): Promise<readonly Screen[]> => {
  const url = (spec: string) => (spec.startsWith(".") ? pathToFileURL(path.resolve(QA, spec)).href : import.meta.resolve(spec));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "touched-"));
  try {
    const file = path.join(dir, "registry.ts");
    fs.writeFileSync(file, source.replace(/((?<![\w$.])(?:from\s+|import\s*\(\s*|import\s+))"([^"]+)"/gu, (_, lead: string, spec: string) => `${lead}"${url(spec)}"`));
    return ((await import(pathToFileURL(file).href)) as { screens: readonly Screen[] }).screens;
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
};

/** A screen's entry as it runs: its values, and its functions' code. */
const entry = (s: Screen) => JSON.stringify(s, (_, v: unknown) => (typeof v === "function" ? v.toString() : v));

/** Code without its comments, so that one naming a helper in words doesn't count as a call. */
const uncommented = (text: string) => text.replace(/\/\*[\s\S]*?\*\//gu, "").replace(/(^|[^:\\])\/\/.*$/gmu, "$1");

/** A screen's code: its open and check functions as written. */
const code = (s: Screen) => uncommented(Object.values(s).filter((v): v is () => unknown => typeof v === "function").map(String).join("\n"));

/** Each entry by label: two entries can share one on different fixtures. */
const byLabel = (screens: readonly Screen[]) => {
  const map = new Map<string, string[]>();
  for (const s of screens) map.set(label(s), [...(map.get(label(s)) ?? []), entry(s)]);
  return new Map([...map].map(([l, es]) => [l, es.sort().join("\n")]));
};

/** registry.ts's top-level functions and consts but `screens`, by name: their code without its comments. */
const helpers = (source: string) => {
  const found = new Map<string, string>();
  let name: string | undefined;
  for (const line of source.split("\n")) {
    const start = /^(?:export )?(?:async )?(?:const|let|function\*?|class) ([\w$]+)/u.exec(line)?.[1];
    if (start !== undefined || /^(?:export )?(?:import|interface|type) /u.test(line)) name = start === "screens" ? undefined : start;
    if (name !== undefined) found.set(name, `${found.get(name) ?? ""}${line}\n`);
  }
  return new Map([...found].map(([n, text]) => [n, uncommented(text).replace(/\s+$/u, "")]));
};

/** The local names registry.ts imports (values, not types), by the file they come from, relative to the app. */
export const imports = (source: string) => {
  const from = new Map<string, string[]>();
  for (const [, what = "", spec = ""] of source.matchAll(/^import\s+(?!type\s)([^;]*?)\s+from\s+"(\.{1,2}\/[^"]+)";/gmsu)) {
    const names = what
      .replace(/[{}]/gu, ",")
      .split(",")
      .map((n) => n.trim())
      .filter((n) => n !== "" && !n.startsWith("type "))
      .map((n) => n.split(/\s+as\s+/u).at(-1) ?? n);
    from.set(path.relative(path.dirname(QA), path.resolve(QA, spec)), names);
  }
  return from;
};

const names = (text: string, of: ReadonlySet<string>) => [...of].some((n) => new RegExp(`(?<![\\w$])${n.replace(/\$/gu, "\\$")}(?![\\w$])`, "u").test(text));

/**
 * The labels of the screens a change shows: `own`, whose entries changed, and `users`, whose code names a changed
 * helper. `changed` holds the names registry.ts imports from changed files.
 */
export const changedScreens = (
  before: { source: string; screens: readonly Screen[] },
  after: { source: string; screens: readonly Screen[] },
  changed: ReadonlySet<string> = new Set(),
) => {
  const was = byLabel(before.screens);
  const is = byLabel(after.screens);
  const own = new Set([...is].filter(([l, e]) => was.get(l) !== e).map(([l]) => l));
  const old = helpers(before.source);
  const now = helpers(after.source);
  const touched = new Set([...changed, ...[...now].filter(([n, code]) => old.get(n) !== code).map(([n]) => n)]);
  for (let grew = true; grew; ) {
    grew = false;
    for (const [n, code] of now)
      if (!touched.has(n) && names(code, touched)) {
        touched.add(n);
        grew = true;
      }
  }
  const users = new Set(touched.size === 0 ? [] : after.screens.filter((s) => !own.has(label(s)) && names(code(s), touched)).map(label));
  return { own, users };
};
