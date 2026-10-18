// The fleetd.sh page may only promise what fleetd has. Run by CI's `site` job from the repo root:
//   node .github/site-check.mjs <file holding `fleetd help` output>
// Fails on an index.* at the root of site/, on a line of site/.stale-terms in the page's text or the docs' sources
// (docs/site/*.md), and on a `fleetd <command>` written as code in hand-written text that `fleetd help` doesn't list.
// Capture blocks (home.html's markers, the docs' ```console capture=NAME) are fleetd's own output
// (tests/lab/site-capture.ts), so the command check skips them; the stale terms still apply there, since a block nobody
// re-captured goes stale too. site/docs/ is generated from the sources (CI checks it's up to date) and its CLI reference
// is fleetd's own help, so it isn't checked here.
import fs from "node:fs";

const DOCS = fs
  .readdirSync("docs/site")
  .filter((n) => n.endsWith(".md"))
  .map((n) => `docs/site/${n}`);
const FILES = ["site/home.html", "site/fleetd.txt", "site/README.md", ...DOCS];
const help = fs.readFileSync(process.argv[2], "utf8");
const errors = [];

// The twin's capture blocks are found by their shape; a marker there would be shown to its readers.
if (fs.readFileSync("site/fleetd.txt", "utf8").includes("<!--")) errors.push("site/fleetd.txt: no <!-- markers in the plain-text twin");

// Only the root: site/docs/index.html is /docs and harmless.
for (const name of fs.readdirSync("site")) {
  // Vercel serves index.* at / before applying rewrites, so curl -fsSL https://fleetd.sh would get it, not install.sh.
  if (/^index\./iu.test(name)) errors.push(`site/${name}: Vercel would serve it at / instead of install.sh; rename it`);
}

const terms = fs
  .readFileSync("site/.stale-terms", "utf8")
  .split("\n")
  .map((l) => l.trim())
  .filter((l) => l !== "" && !l.startsWith("#"))
  .map((l) => new RegExp(l, "iu"));

// "  machine add <ssh-host> ..." -> ["machine", "add"]; "  init [--home <dir>] ..." -> ["init", undefined].
const commands = help.split("\n").flatMap((l) => {
  const m = /^ {2}([a-z][a-z-]*)(?: ([a-z][a-z-]*))?/u.exec(l);
  return m ? [[m[1], m[2]]] : [];
});
if (commands.length < 10) errors.push(`${process.argv[2]} doesn't look like \`fleetd help\` output`);

for (const file of FILES) {
  let inCapture = false;
  // In markdown: the open fence's language, or undefined outside a fence.
  let fence;
  fs.readFileSync(file, "utf8")
    .split("\n")
    .forEach((line, i) => {
      const where = `${file}:${i + 1}`;
      for (const term of terms) if (term.test(line)) errors.push(`${where}: matches ${term} from site/.stale-terms: ${line.trim()}`);
      if (/<!-- capture:[\w-]+ -->/u.test(line)) inCapture = true;
      if (/<!-- \/capture:[\w-]+ -->/u.test(line)) inCapture = false;
      let code = [];
      if (file.endsWith(".md") && /^```/u.test(line)) {
        if (fence === undefined) {
          fence = line.slice(3).trim().split(/\s+/u)[0] || "text";
          inCapture = /\bcapture=/u.test(line);
        } else {
          fence = undefined;
          inCapture = false;
        }
        return;
      }
      if (inCapture) return;
      if (fence === "sh") code = [line];
      else if (fence === "console") code = line.startsWith("$ ") ? [line.slice(2)] : [];
      else if (fence !== undefined) return;
      // A command is written as code: <code>fleetd …</code>, `fleetd …`, or a "$ fleetd …" line. Prose ("the fleetd app") isn't one.
      const found = fence === undefined ? [...line.matchAll(/<code[^>]*>(.*?)<\/code>|`([^`]+)`|^\s*\$ (.*)$/gu)] : code.map((c) => [c, undefined, undefined, c]);
      for (const [, html, tick, shell] of found) {
        const m = /^fleetd ([a-z][a-z-]*)(?: ([a-z][a-z-]*))?/u.exec(html ?? tick ?? shell);
        if (m === null) continue;
        const [, word, sub] = m;
        const known = commands.some(([c, s]) => c === word && (sub === undefined || s === undefined || s === sub));
        if (!known) errors.push(`${where}: \`fleetd ${word}${sub ? ` ${sub}` : ""}\` is not a command in \`fleetd help\``);
      }
    });
}

for (const e of errors) console.log(`::error::${e}`);
if (errors.length > 0) process.exit(1);
console.log(`site check: ${FILES.join(", ")} ok (${terms.length} stale terms, ${commands.length} commands in fleetd help)`);
