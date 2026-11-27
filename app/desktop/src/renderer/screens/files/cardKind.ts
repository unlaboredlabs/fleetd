// What a file card needs to know of a file, kept small as cards draw in the first chat: whether Open shows it inside
// fleetd (FileView) or in this computer's app, and its kind in a word or two. Pure; kind.ts has how it shows.
import { kindOf } from "../../../shared/files";

const XLSX = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

/** Text's kinds by extension, more exact than "Text". */
const WORDS: Readonly<Record<string, string>> = {
  csv: "CSV",
  tsv: "TSV",
  md: "Markdown",
  markdown: "Markdown",
  json: "JSON",
  geojson: "JSON",
  ts: "TypeScript",
  mts: "TypeScript",
  cts: "TypeScript",
  tsx: "TypeScript",
  js: "JavaScript",
  mjs: "JavaScript",
  cjs: "JavaScript",
  jsx: "JavaScript",
  rs: "Rust",
  sh: "Shell script",
  bash: "Shell script",
  zsh: "Shell script",
  toml: "TOML",
  yaml: "YAML",
  yml: "YAML",
  py: "Python",
  go: "Go",
  css: "CSS",
  html: "HTML",
  htm: "HTML",
  sql: "SQL",
  diff: "Diff",
  patch: "Diff",
};

export const extensionOf = (name: string): string => (name.includes(".") ? name.slice(name.lastIndexOf(".") + 1).toLowerCase() : "");

/** Whether fleetd shows the file itself: Open then opens it in the panel, not in another app. */
export const showsInside = (name: string, mime: string): boolean =>
  mime === "text/plain" || mime === "text/csv" || mime === XLSX || mime === "application/pdf" || mime.startsWith("image/") || extensionOf(name) === "csv";

/** A file's kind in a word or two, for its card and its head: "CSV", "Markdown", "Python", "PDF". */
export const kindWord = (name: string, mime: string): string => {
  if (mime !== "text/plain" && mime !== "text/csv") return kindOf(mime);
  return WORDS[extensionOf(name)] ?? (mime === "text/csv" ? "CSV" : "Text");
};
