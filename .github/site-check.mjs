// The fleetd.sh page may only promise what fleetd has. Run by CI's `site` job from the repo root:
//   node .github/site-check.mjs <file holding `fleetd help` output>
// Fails on an index.* in site/, on a line of site/.stale-terms in the page's text, and on a `fleetd <command>` written
// as code in the hand-written text that `fleetd help` doesn't list. Capture blocks are fleetd's own output
// (tests/lab/site-capture.ts), so the command check skips them; the stale terms still apply there, since a block nobody
// re-captured goes stale too.
import fs from "node:fs";

const FILES = ["site/home.html", "site/fleetd.txt", "site/README.md"];
const help = fs.readFileSync(process.argv[2], "utf8");
const errors = [];

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
  fs.readFileSync(file, "utf8")
    .split("\n")
    .forEach((line, i) => {
      const where = `${file}:${i + 1}`;
      for (const term of terms) if (term.test(line)) errors.push(`${where}: matches ${term} from site/.stale-terms: ${line.trim()}`);
      if (/<!-- capture:[\w-]+ -->/u.test(line)) inCapture = true;
      if (/<!-- \/capture:[\w-]+ -->/u.test(line)) inCapture = false;
      if (inCapture) return;
      // A command is written as code: <code>fleetd …</code>, `fleetd …`, or a "$ fleetd …" line. Prose ("the fleetd app") isn't one.
      for (const [, html, tick, shell] of line.matchAll(/<code[^>]*>(.*?)<\/code>|`([^`]+)`|^\s*\$ (.*)$/gu)) {
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
