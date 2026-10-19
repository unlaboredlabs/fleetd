import type { HighlighterCore } from "shiki/core";

/**
 * Shiki, loaded on first use and shared. It runs the JavaScript regex engine, so the renderer needs no
 * WebAssembly (the CSP stays strict), and one css-variables theme, so the same tokens serve light and dark.
 * Grammars load per language on demand; tokens are cached so re-renders and remounts never re-highlight.
 */

const LANGS = {
  typescript: () => import("shiki/langs/typescript.mjs"),
  tsx: () => import("shiki/langs/tsx.mjs"),
  javascript: () => import("shiki/langs/javascript.mjs"),
  jsx: () => import("shiki/langs/jsx.mjs"),
  json: () => import("shiki/langs/json.mjs"),
  rust: () => import("shiki/langs/rust.mjs"),
  shellscript: () => import("shiki/langs/shellscript.mjs"),
  toml: () => import("shiki/langs/toml.mjs"),
  yaml: () => import("shiki/langs/yaml.mjs"),
  markdown: () => import("shiki/langs/markdown.mjs"),
  python: () => import("shiki/langs/python.mjs"),
  go: () => import("shiki/langs/go.mjs"),
  css: () => import("shiki/langs/css.mjs"),
  html: () => import("shiki/langs/html.mjs"),
  sql: () => import("shiki/langs/sql.mjs"),
  diff: () => import("shiki/langs/diff.mjs"),
} as const;

export type CodeLang = keyof typeof LANGS;

const ALIASES: Record<string, CodeLang> = {
  ts: "typescript",
  mts: "typescript",
  cts: "typescript",
  js: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  rs: "rust",
  sh: "shellscript",
  bash: "shellscript",
  zsh: "shellscript",
  shell: "shellscript",
  console: "shellscript",
  yml: "yaml",
  md: "markdown",
  py: "python",
  htm: "html",
  patch: "diff",
};

/** The grammar for a fence tag or a file extension, or null for plain text. */
export function resolveLang(tag: string | undefined | null): CodeLang | null {
  if (!tag) return null;
  const t = tag.trim().toLowerCase();
  if (Object.hasOwn(LANGS, t)) return t as CodeLang;
  return Object.hasOwn(ALIASES, t) ? (ALIASES[t] ?? null) : null;
}

/** The grammar for a file path, by extension. */
export function langForPath(path: string): CodeLang | null {
  const name = path.split("/").pop() ?? "";
  const dot = name.lastIndexOf(".");
  return dot > 0 ? resolveLang(name.slice(dot + 1)) : null;
}

let core: Promise<HighlighterCore> | null = null;
const loaded = new Map<CodeLang, Promise<void>>();
const THEME = "fleetd";

function highlighter(): Promise<HighlighterCore> {
  core ??= (async () => {
    const [{ createHighlighterCore, createCssVariablesTheme }, { createJavaScriptRegexEngine }] = await Promise.all([
      import("shiki/core"),
      import("shiki/engine/javascript"),
    ]);
    return createHighlighterCore({
      themes: [createCssVariablesTheme({ name: THEME, variablePrefix: "--shiki-", fontStyle: true })],
      langs: [],
      engine: createJavaScriptRegexEngine(),
    });
  })();
  return core;
}

function ensureLang(h: HighlighterCore, lang: CodeLang): Promise<void> {
  let p = loaded.get(lang);
  if (!p) {
    p = LANGS[lang]().then((m) => h.loadLanguage(m.default));
    loaded.set(lang, p);
  }
  return p;
}

export interface Token {
  content: string;
  color: string | undefined;
  italic: boolean;
}
export type Tokens = Token[][];

/*
 * Tokenizing runs on the main thread, and a TextMate grammar on one very long line (minified code, base64, a
 * one-line lockfile) can take tens of seconds. So lines past MAX_LINE stay plain, and a block past the size caps
 * is not highlighted at all.
 */
export const MAX_LINE = 1000;
export const MAX_CHARS = 100_000;
export const MAX_LINES = 5000;

/** Whether a block is small enough to highlight. */
export function canHighlight(code: string): boolean {
  if (code.length > MAX_CHARS) return false;
  let lines = 1;
  for (let i = code.indexOf("\n"); i !== -1; i = code.indexOf("\n", i + 1)) if (++lines > MAX_LINES) return false;
  return true;
}

/** A small LRU of highlighted blocks, keyed by language and text. */
const CACHE_MAX = 300;
const cache = new Map<string, Tokens>();

export function cachedTokens(code: string, lang: CodeLang): Tokens | undefined {
  const key = `${lang}\u0000${code}`;
  const hit = cache.get(key);
  if (hit) {
    cache.delete(key);
    cache.set(key, hit);
  }
  return hit;
}

/** Tokens for a block, or null when it is too big to highlight (render it plain). */
export async function highlight(code: string, lang: CodeLang): Promise<Tokens | null> {
  if (!canHighlight(code)) return null;
  const hit = cachedTokens(code, lang);
  if (hit) return hit;
  const h = await highlighter();
  await ensureLang(h, lang);
  const tokens = h.codeToTokensBase(code, { lang, theme: THEME, tokenizeMaxLineLength: MAX_LINE, tokenizeTimeLimit: 500 }).map((line) =>
    // fontStyle is a bit set; bit 1 is italic.
    line.map((t) => ({ content: t.content, color: t.color, italic: ((t.fontStyle ?? 0) & 1) === 1 })),
  );
  cache.set(`${lang}\u0000${code}`, tokens);
  if (cache.size > CACHE_MAX) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
  return tokens;
}
