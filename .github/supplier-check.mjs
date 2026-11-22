// fleetd's computers are fleetd's own, whoever supplies them: nothing a person reads (the site and its docs, the apps,
// their samples and fixtures, fleetd's lines in a chat, the contracts' descriptions agents read) names the supplier.
// The provider shows as "fleetd's computers", through the one mapping in app/desktop/src/shared/providers.ts.
// Internal code keeps the name where no person reads it: the provider id ("boat", a wire value), comments, tests,
// migrations, fleetd's own scripts and CI. Run by CI's `site` job from the repo root: node .github/supplier-check.mjs
// --untracked also reads the files git doesn't track yet but doesn't ignore (scripts/check.sh, before a commit).
import { execFileSync } from "node:child_process";

const SELF = ".github/supplier-check.mjs";
// Where no person reads it: tests and their fixtures, the QA screens' steps, migrations, fleetd's own scripts and CI.
const LEFT_OUT = [
  `:!${SELF}`,
  ":!**/*.test.ts",
  ":!**/*.test.tsx",
  ":!**/test/**",
  ":!tests/**",
  ":!app/desktop/qa/**",
  ":!fleetd/src/hub/store/migrations/**",
  ":!fleetd/scripts/**",
  ":!.github/workflows/**",
];
// The supplier's domain anywhere; its short name where it reads as a word: "boat's", "boat builds", or in prose (docs,
// pages) any "boat" at all. The id "boat" in code ("boat", boat:, boat(), BOAT_API_KEY) isn't one.
const DOMAIN = /boat\.dev/iu;
const WORD_IN_CODE = /\bboat(?:'s\b|\s+[a-z])/iu;
const WORD = /\bboat\b/iu;
const CODE = /\.(?:[cm]?[jt]sx?|json|css|sh|ya?ml|swift|kt)$/u;
// Lines that hold the name for a machine only: the client's API address, and the mapping of an older hub's or cloud's
// words for it onto fleetd's computers.
const ALLOW = [
  /^fleetd\/src\/sandbox\/providers\/[a-z_]+\.ts:\d+:.*"https:\/\/boat\.dev\//u,
  /^app\/desktop\/src\/shared\/providers\.ts:\d+:.*\{ "boat\.dev": "boat" \}/u,
];

/** A code line without its comment: none for a comment line, else the line with a trailing `// …` cut. */
const codeOf = (text) => {
  const t = text.trim();
  if (t.startsWith("//") || t.startsWith("*") || t.startsWith("/*") || t.startsWith("#")) return "";
  return text.replace(/\s\/\/\s.*$/u, "");
};

let out = "";
try {
  const untracked = process.argv.includes("--untracked") ? ["--untracked"] : [];
  out = execFileSync("git", ["grep", ...untracked, "-nIi", "boat", "--", ".", ...LEFT_OUT], { encoding: "utf8", maxBuffer: 64 << 20 });
} catch (e) {
  // git grep exits 1 when nothing matches.
  if (e.status !== 1) throw e;
}
const hits = out.split("\n").filter((line) => {
  const m = /^([^:]+):(\d+):(.*)$/u.exec(line);
  if (m === null || ALLOW.some((re) => re.test(line))) return false;
  const [, path, , text] = m;
  if (!CODE.test(path)) return WORD.test(text);
  const code = codeOf(text);
  return DOMAIN.test(code) || WORD_IN_CODE.test(code);
});
if (hits.length > 0) {
  console.error(`the computers' supplier named where a person reads it (say "fleetd's computers", app/desktop/src/shared/providers.ts):\n${hits.join("\n")}`);
  process.exit(1);
}
console.log("no supplier name where a person reads it");
