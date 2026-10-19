// This repo is public, so tracked files use neutral fixtures (devbox, buildbox, laptop, homeserver,
// hub.your-tailnet.ts.net, acme/storefront, ada-lovelace) and never a maintainer's own machine, login or home directory.
// Run by CI's `site` job from the repo root: node .github/personal-check.mjs
import { execFileSync } from "node:child_process";

const TOKENS = String.raw`\bforge\b|\bwynn\b|/home/wynn\b`;
// "forge" is also an English verb; a line that uses it that way may stay.
const ALLOW = [/\bforge (?:a|an|the|its|their)\b/iu];
const SELF = ".github/personal-check.mjs";

let out = "";
try {
  out = execFileSync("git", ["grep", "-nIiE", TOKENS, "--", ".", `:!${SELF}`], { encoding: "utf8", maxBuffer: 64 << 20 });
} catch (e) {
  // git grep exits 1 when nothing matches.
  if (e.status !== 1) throw e;
}
const hits = out.split("\n").filter((line) => line !== "" && !ALLOW.some((re) => re.test(line)));
if (hits.length > 0) {
  console.error(`personal identifiers in tracked files (use a neutral fixture instead):\n${hits.join("\n")}`);
  process.exit(1);
}
console.log("no personal identifiers in tracked files");
