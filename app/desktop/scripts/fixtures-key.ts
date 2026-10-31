// `node scripts/fixtures-key.ts`: a hash of every file `pnpm fixtures` reads, the key CI caches its output under
// (desktop-qa.yml, ci.yml). That is every file under fixtures/ but the output, the app's modules they import (followed
// through each relative import), the files those read by `new URL("<relative path>", import.meta.url)`, the hub's JSON
// Schemas and the lockfile. A file missed here would leave a stale fixture in the cache, so an import or a read it
// can't resolve fails it rather than being left out. Read files outside fixtures/ only that way, or add them here.
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const APP = path.resolve(import.meta.dirname, "..");
const FIXTURES = path.join(APP, "fixtures");
const SCHEMA = path.resolve(APP, "../../crates/fleetd-contracts/schema");

const filesUnder = (dir: string) =>
  fs
    .readdirSync(dir, { withFileTypes: true, recursive: true })
    .filter((e) => e.isFile())
    .map((e) => path.join(e.parentPath, e.name));
// The build's output: fixtures/<name>.json and its staging directory (both ignored by git).
const output = (file: string) =>
  file.startsWith(path.join(FIXTURES, ".staging") + path.sep) ||
  (path.dirname(file) === FIXTURES && file.endsWith(".json"));

const resolveImport = (from: string, spec: string) => {
  const base = path.resolve(path.dirname(from), spec);
  const tries = [base, `${base}.ts`, `${base}.tsx`, path.join(base, "index.ts"), path.join(base, "index.tsx")];
  const found = tries.find((p) => fs.statSync(p, { throwIfNoEntry: false })?.isFile());
  if (found === undefined) throw new Error(`${path.relative(APP, from)}: can't resolve the import "${spec}"`);
  return found;
};

const seen = new Set<string>();
const queue = [...filesUnder(FIXTURES).filter((f) => !output(f)), ...filesUnder(SCHEMA), path.join(APP, "pnpm-lock.yaml")];
for (let file = queue.pop(); file !== undefined; file = queue.pop()) {
  if (seen.has(file)) continue;
  seen.add(file);
  if (!/\.(ts|tsx|js|mjs)$/u.test(file)) continue;
  // Static imports and re-exports at the start of a line: not an import inside a string (a diff in a fixture).
  const text = fs.readFileSync(file, "utf8");
  for (const [, spec] of text.matchAll(/^\s*(?:import|export)\s[^"';]*["'](\.{1,2}\/[^"']+)["']/gmu)) {
    queue.push(resolveImport(file, spec ?? ""));
  }
  // A file read beside the module: a data file outside fixtures/ (the settings registry).
  for (const [, spec] of text.matchAll(/new URL\(\s*["'](\.{1,2}\/[^"']+)["'],\s*import\.meta\.url\s*\)/gu)) {
    queue.push(resolveImport(file, spec ?? ""));
  }
}

const hash = createHash("sha256");
for (const file of [...seen].toSorted()) {
  hash.update(`${path.relative(APP, file)}\0`);
  hash.update(fs.readFileSync(file));
}
console.log(hash.digest("hex"));
