// How a file sent in the chat shows inside fleetd (FileView): by its type and, for the text the workspace takes as
// text/plain (notes, data, code), by its name. What fleetd can't show opens in this computer's own app. Pure.
import type { CodeLang } from "../../ui/markdown/highlighter";
import { extensionOf } from "./cardKind";

const XLSX = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

export type FileShow =
  | { readonly as: "table"; readonly sep: "," | "\t" }
  | { readonly as: "sheet" }
  | { readonly as: "markdown" }
  | { readonly as: "json" }
  | { readonly as: "pdf" }
  | { readonly as: "code"; readonly lang: CodeLang }
  | { readonly as: "text" }
  | { readonly as: "image" }
  /** Word, PowerPoint, a zip: this computer's app for its type. */
  | { readonly as: "app" };

/**
 * Code by its extension, as the highlighter names its grammars (ui/markdown/highlighter.ts's langForPath, which a
 * test holds this to): a table of its own, so a file card in the first chat doesn't load the highlighter's.
 */
export const CODE: Readonly<Record<string, CodeLang>> = {
  ts: "typescript",
  mts: "typescript",
  cts: "typescript",
  tsx: "tsx",
  js: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  jsx: "jsx",
  rs: "rust",
  sh: "shellscript",
  bash: "shellscript",
  zsh: "shellscript",
  toml: "toml",
  yaml: "yaml",
  yml: "yaml",
  py: "python",
  go: "go",
  css: "css",
  html: "html",
  htm: "html",
  sql: "sql",
  diff: "diff",
  patch: "diff",
};


export const showOf = (name: string, mime: string): FileShow => {
  const ext = extensionOf(name);
  if (mime === "text/csv" || ext === "csv") return { as: "table", sep: "," };
  if (mime === XLSX) return { as: "sheet" };
  if (mime === "application/pdf") return { as: "pdf" };
  if (mime.startsWith("image/")) return { as: "image" };
  if (mime !== "text/plain") return { as: "app" };
  if (ext === "tsv") return { as: "table", sep: "\t" };
  if (ext === "md" || ext === "markdown") return { as: "markdown" };
  if (ext === "json" || ext === "geojson") return { as: "json" };
  const lang = CODE[ext];
  return lang === undefined ? { as: "text" } : { as: "code", lang };
};


/** How much of a file each kind reads at most: enough to read, never the whole 25 MB just to look. */
export const READ_CAP = {
  /** Text, code and Markdown: a long log's first megabyte. */
  text: 1024 * 1024,
  /** A table's first rows. */
  table: 4 * 1024 * 1024,
  /** JSON folds only once it parses: a document up to this, else its start as text. */
  json: 8 * 1024 * 1024,
} as const;

/** The rows a table or sheet shows at most. */
export const MAX_ROWS = 10_000;
