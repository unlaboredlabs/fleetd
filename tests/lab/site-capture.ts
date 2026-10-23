// `node tests/lab/site-capture.ts`: rewrites the landing page's real-output blocks from the product.
// `node tests/lab/site-capture.ts --docs` only recaptures the docs' ```console capture=NAME blocks.
// The setup CLI in a throwaway HOME (`fleetd init` and `fleetd machine add --dry-run`, with your claude and gh logins
// copied in, sanitized) fills the `<!-- capture:NAME -->` blocks in site/home.html and the same blocks in
// site/fleetd.txt; the merge train's lines come from the newest lab m7 run, when there is one. No hub, node or claude
// turn. The page's app screenshots come from app/desktop's fixtures instead (app/desktop/qa/site.ts).
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { type Body, claudeLoginEnv, check, fleetdCommand, LAB, log, REPO, SLOT, scrubbedEnv } from "./harness.ts";

const DOCS_ONLY = process.argv.includes("--docs");
const SITE = path.join(REPO, "site");

/** Undone last to first in `finally`. */
const cleanups: Array<() => Promise<void> | void> = [];

// ---- Setup transcripts and train lines ----

const INIT = 'fleetd init --listen 127.0.0.1:4778 --git-identity "Demo <demo@users.noreply.github.com>" --no-service';

/** The GitHub login the lab's machines borrow; a public transcript says "demo" instead. */
const GH_USER = (() => {
  try {
    return /^\s+user:\s*(\S+)/mu.exec(fs.readFileSync(path.join(os.homedir(), ".config/gh/hosts.yml"), "utf8"))?.[1];
  } catch {
    return undefined;
  }
})();

/** This machine on its tailnet, as the wizard finds it (`tailscale status --json`), when it is on one. */
const TAILNET = (() => {
  if (execFileSync("sh", ["-c", "command -v tailscale || true"], { env: scrubbedEnv(), encoding: "utf8" }).trim() === "") return undefined;
  try {
    const self = (JSON.parse(execFileSync("tailscale", ["status", "--json"], { env: scrubbedEnv(), encoding: "utf8" })) as Body).Self as Body | undefined;
    return { name: String(self?.DNSName ?? "").replace(/\.$/u, ""), ips: (self?.TailscaleIPs ?? []) as Array<string> };
  } catch {
    return undefined;
  }
})();

/** This machine as a reader may see it: its tailnet name and addresses as placeholders, the gh login as "demo". */
const sanitizeSetup = (text: string) => {
  let out = text;
  if (TAILNET?.name) out = out.replaceAll(TAILNET.name, "hub.your-tailnet.ts.net");
  for (const ip of TAILNET?.ips ?? []) out = out.replaceAll(ip, "<tailnet-ip>");
  out = out.replace(/\b(?!127\.0\.0\.1\b)\d{1,3}(?:\.\d{1,3}){3}\b/gu, "<lan-ip>");
  // How this machine's claude logs in (a token, a gateway, a proxy and where it is set) is the capturing machine's
  // own setup, not something a reader has: the page says only that claude is logged in.
  out = out.replace(/(claude [\d.]+, logged in)[^\n]*/gu, "$1");
  return GH_USER === undefined ? out : out.replaceAll(GH_USER, "demo");
};

/** A throwaway HOME (user demo) with this fleetd on its PATH; `run` gives a command's output with that HOME as `~`,
 * sanitized. `logins` gives it the lab's claude and gh logins (0600, gone with the HOME), as a set-up machine has. */
function demoHome(opts: { readonly logins?: boolean } = {}) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "fleetd-site-"));
  cleanups.push(() => fs.rmSync(base, { recursive: true, force: true }));
  const home = path.join(base, "demo");
  fs.mkdirSync(path.join(home, ".local/bin"), { recursive: true });
  fs.copyFileSync(fleetdCommand([])[0], path.join(home, ".local/bin/fleetd"));
  const dirs = [`${home}/.local/bin`, "/usr/bin:/bin"];
  if (opts.logins) {
    // The demo user's own claude setup: their login variables in ~/.claude/settings.json, as claude keeps them.
    fs.mkdirSync(path.join(home, ".claude"), { mode: 0o700 });
    fs.writeFileSync(path.join(home, ".claude/settings.json"), `${JSON.stringify({ env: claudeLoginEnv() }, null, 2)}\n`, { mode: 0o600 });
    const gh = path.join(os.homedir(), ".config/gh/hosts.yml");
    if (fs.existsSync(gh)) {
      fs.mkdirSync(path.join(home, ".config/gh"), { recursive: true, mode: 0o700 });
      fs.copyFileSync(gh, path.join(home, ".config/gh/hosts.yml"));
      fs.chmodSync(path.join(home, ".config/gh/hosts.yml"), 0o600);
    }
    const claude = execFileSync("sh", ["-c", "command -v claude || true"], { env: scrubbedEnv(), encoding: "utf8" }).trim();
    if (claude !== "") dirs.splice(1, 0, path.dirname(claude));
  }
  return (cmd: string) => {
    const r = spawnSync("bash", ["-c", `cd ~ && ${cmd} 2>&1`], {
      env: { HOME: home, USER: "demo", LOGNAME: "demo", LANG: "C.UTF-8", PATH: dirs.join(":") },
      encoding: "utf8",
      timeout: 60_000,
    });
    return { cmd, status: r.status ?? 1, out: sanitizeSetup(r.stdout.replace(/\n$/u, "").replaceAll(home, "~")) };
  };
}

/** The `fleetd init` wizard (--yes: every default) and `machine add --dry-run` after it, on a machine with the claude
 * and gh logins. --no-service: with a service, init drives the real systemd user manager. */
function setupTranscripts() {
  const exec = demoHome({ logins: true });
  const run = (cmd: string) => {
    const r = exec(cmd);
    check(r.status === 0, `${cmd}: exit ${r.status} ${r.out}`);
    return { cmd, out: `${r.out}\n[exit ${r.status}]` };
  };
  const init = run('fleetd init --yes --no-service --git-identity "Demo <demo@users.noreply.github.com>"');
  const add = run("fleetd machine add builder-1 --dry-run");
  // The page shows the plan, not the shell command indented under each step or the trailing notes.
  add.out = add.out.split("\n").filter((l) => !/^\s/u.test(l) && !l.startsWith("note:")).join("\n");
  return { init, add };
}

// ---- The docs' capture blocks (docs/site/src/content/docs/**/*.md and .mdx) ----

const DOCS = path.join(REPO, "docs/site/src/content/docs");
// A block may be indented, as a step of a numbered list; its lines carry the same indent.
const DOCS_BLOCK = /^( *)```console capture=([a-z0-9-]+)\n([\s\S]*?)^\1```$/gmu;

/** The `$ ` commands of a transcript, a trailing backslash continuing one onto the next line. */
export function docsCommands(body: string) {
  const commands: Array<string> = [];
  let continued = false;
  for (const line of body.split("\n")) {
    if (continued) commands[commands.length - 1] += `\n${line}`;
    else if (line.startsWith("$ ")) commands.push(line.slice(2));
    else continue;
    continued = line.endsWith("\\");
  }
  return commands;
}

const dedent = (body: string, indent: string) => body.split("\n").map((l) => (l.startsWith(indent) ? l.slice(indent.length) : l)).join("\n");
const reindent = (body: string, indent: string) => body.replace(/^(?=.)/gmu, indent);

/** Each block's `$ ` commands run in a fresh throwaway HOME where the standard `fleetd init` already ran (unless the
 * block's first command is `fleetd init`), each followed by its output; `[exit N]` only when N isn't 0. Blocks named
 * in `given` (output only a lab run has) take that text instead; without it they're left alone. */
export function docsBlocks(given: Record<string, string>) {
  const blocks = new Map<string, { file: string; body: string }>();
  const names = fs.readdirSync(DOCS, { recursive: true, encoding: "utf8" }).filter((n) => /\.mdx?$/u.test(n)).sort();
  for (const name of names) {
    const file = path.join(DOCS, name);
    for (const [, indent, block, body] of fs.readFileSync(file, "utf8").matchAll(DOCS_BLOCK)) {
      check(!blocks.has(block!), `capture=${block} is used once across the docs`);
      if (block! in given) {
        blocks.set(block!, { file, body: `${given[block!]}\n` });
        continue;
      }
      const commands = docsCommands(dedent(body!, indent!));
      if (commands.length === 0) {
        log(`docs: capture=${block} in ${name} has no $ command and no lab output; left as is`);
        continue;
      }
      const exec = demoHome();
      if (!commands[0]!.startsWith("fleetd init")) check(exec(INIT).status === 0, `docs: ${INIT}`);
      const out = commands.map((cmd) => {
        const r = exec(cmd);
        return `$ ${cmd}\n${r.out}${r.status === 0 ? "" : `\n[exit ${r.status}]`}`.replace(/\n$/u, "");
      });
      blocks.set(block!, { file, body: `${out.join("\n")}\n` });
    }
  }
  return blocks;
}

/** Writes the blocks back into the docs' sources and rebuilds site/docs. */
function fillDocs(blocks: ReturnType<typeof docsBlocks>) {
  for (const [name, { body }] of blocks) assertPublishable(`docs capture=${name}`, body);
  const files = new Set([...blocks.values()].map((b) => b.file));
  for (const file of files) {
    const text = fs.readFileSync(file, "utf8").replace(DOCS_BLOCK, (all, indent: string, name: string) => {
      const b = blocks.get(name);
      return b === undefined || b.file !== file ? all : `${indent}\`\`\`console capture=${name}\n${reindent(b.body, indent)}${indent}\`\`\``;
    });
    fs.writeFileSync(file, text);
  }
  execFileSync("cargo", ["run", "-q", "--locked", "-p", "docsgen"], { cwd: REPO, stdio: "inherit" });
  execFileSync("npm", ["ci", "--prefix", "docs/site"], { cwd: REPO, stdio: "inherit" });
  execFileSync("npm", ["run", "build", "--prefix", "docs/site"], { cwd: REPO, stdio: "inherit" });
  log(`docs: recaptured ${blocks.size} block(s) in ${files.size} file(s) and rebuilt site/docs`);
}

interface TrainLine {
  readonly ms: number;
  readonly type: string;
  readonly summary: string;
  /** The Change (X<n>) the line is about, when it is about one. */
  readonly change?: string;
  readonly statusOn?: string;
}

/** The merge train from the newest lab m7 run on this box (any slot), with the `fleetd/train` commit status the
 * train posted on GitHub before each merge. Undefined when no run has merged anything. */
export function trainLines(): { lines: Array<TrainLine>; from: string } | undefined {
  const root = SLOT === 0 ? LAB : path.dirname(LAB);
  const runs = [root, ...fs.readdirSync(root).filter((d) => /^slot-\d$/u.test(d)).map((d) => path.join(root, d))].flatMap((dir) =>
    fs.readdirSync(dir).filter((d) => d.startsWith("e2e-")).map((d) => path.join(dir, d, "hub", "hub.sqlite")),
  );
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "fleetd-site-train-"));
  cleanups.push(() => fs.rmSync(tmp, { recursive: true, force: true }));
  let best: { db: DatabaseSync; at: number; from: string } | undefined;
  for (const [i, file] of runs.filter((f) => fs.existsSync(f)).entries()) {
    // A copy, so a reader never takes a lock in or checkpoints a lab run's own files.
    const copy = path.join(tmp, `${i}.sqlite`);
    for (const ext of ["", "-wal"]) if (fs.existsSync(file + ext)) fs.copyFileSync(file + ext, copy + ext);
    const db = new DatabaseSync(copy);
    const at = Number((db.prepare("SELECT max(created_ms) AS at FROM events WHERE type = 'pr.merged'").get() as { at: number | null }).at ?? 0);
    if (at > (best?.at ?? 0)) best = { db, at, from: file };
  }
  if (best === undefined) return undefined;
  const rows = best.db
    .prepare("SELECT created_ms, type, data FROM events WHERE type LIKE 'change.%' OR type LIKE 'train.%' OR type IN ('review.verdict', 'pr.merged') ORDER BY seq")
    .all() as Array<{ created_ms: number; type: string; data: string }>;
  const lines: Array<TrainLine> = [];
  const changeOfPr = new Map<number, string>();
  for (const row of rows) {
    const event = JSON.parse(row.data) as Body;
    if (row.type === "change.queued") changeOfPr.set(Number(event.data.prNumber), String(event.data.changeId));
    // A verdict names the PR, not the Change.
    const reviewed = row.type === "review.verdict" ? changeOfPr.get(Number(/\/pull\/(\d+)$/u.exec(String(event.data?.pr))?.[1])) : undefined;
    const change = typeof event.data?.changeId === "string" ? (event.data.changeId as string) : reviewed;
    const summary = String(event.summary).replace(/\(log: https?:\/\/[^)]+\)/u, "(log: …)");
    lines.push({ ms: row.created_ms, type: row.type, summary, ...(change === undefined ? {} : { change }) });
    if (row.type !== "pr.merged") continue;
    const { repo, prNumber } = event.data as { repo: string; prNumber: number };
    const gh = (route: string): unknown => JSON.parse(execFileSync("gh", ["api", route], { env: scrubbedEnv(), encoding: "utf8" }));
    const head = String((gh(`repos/${repo}/pulls/${prNumber}`) as Body).head.sha);
    // Newest first: the last status the train set before merging.
    const status = (gh(`repos/${repo}/commits/${head}/statuses`) as Array<Body>).find((s) => s.context === "fleetd/train");
    if (status !== undefined) {
      lines.push({ ms: Date.parse(status.created_at), type: "fleetd/train", summary: String(status.description), change: String(event.data.changeId), statusOn: head.slice(0, 7) });
    }
  }
  return { lines: pickTrain(lines.toSorted((a, b) => a.ms - b.ms)), from: best.from };
}

const LIFECYCLE = ["change.queued", "review.verdict", "change.ready", "fleetd/train", "pr.merged"];
const SETBACKS = ["change.refused", "change.ci_failed", "change.needs_rebase"];

/** What the page shows of a run, in time order: the whole path of the first two Changes that merged, and the first
 * of each way the train turns a change away. At most 16 lines. */
export function pickTrain(lines: ReadonlyArray<TrainLine>) {
  const merged = new Set(lines.filter((l) => l.type === "pr.merged").map((l) => l.change));
  const followed = lines.filter((l) => l.type === "change.queued" && merged.has(l.change)).map((l) => l.change).slice(0, 2);
  const picked = new Set(lines.filter((l) => followed.includes(l.change) && LIFECYCLE.includes(l.type)));
  for (const type of SETBACKS) {
    const first = lines.find((l) => l.type === type);
    if (first !== undefined) picked.add(first);
  }
  const shown = lines.filter((l) => picked.has(l));
  check(shown.length <= 16, `the train rule picked ${shown.length} lines, more than the page's 16`);
  return shown;
}

// ---- The page's capture blocks ----

const esc = (s: string) => s.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
const indentAll = (text: string, by: string) => text.split("\n").map((l) => (l === "" ? l : by + l)).join("\n");
type Blocks = Record<string, (indent: string) => string>;

const transcriptBlocks = ({ cmd, out }: { cmd: string; out: string }) => ({
  html: (indent: string) => `${indent}<pre class="lines"><span class="c">${esc(`$ ${cmd}`)}</span>\n<span class="o">${esc(out)}</span></pre>`,
  txt: () => `$ ${cmd}\n${out}`,
});

const trainBlocks = (lines: ReadonlyArray<TrainLine>) => {
  const time = (ms: number) => new Date(ms).toISOString().slice(11, 19);
  const tone = (type: string) => (["change.refused", "change.ci_failed", "change.needs_rebase"].includes(type) ? ' class="bad"' : type === "pr.merged" ? ' class="ok"' : "");
  const width = Math.max(...lines.map((l) => l.type.length)) + 2;
  return {
    html: (indent: string) =>
      lines
        .map((l) => {
          const status = l.statusOn === undefined ? "" : ` <span class="x">· commit status on ${l.statusOn}</span>`;
          return `${indent}<li${tone(l.type)}><span class="t">${time(l.ms)}</span><span class="e">${esc(l.type)}</span><span class="s">${esc(l.summary)}${status}</span></li>`;
        })
        .join("\n"),
    txt: () => lines.map((l) => `${time(l.ms)}  ${l.type.padEnd(width)}${l.summary}${l.statusOn === undefined ? "" : `   [commit status on ${l.statusOn}]`}`).join("\n"),
  };
};

/** In home.html: replaces what is between `<!-- capture:NAME -->` and `<!-- /capture:NAME -->`; each block gets the
 * opening marker's indentation. */
function fill(file: string, blocks: Blocks) {
  let text = fs.readFileSync(file, "utf8");
  for (const [name, make] of Object.entries(blocks)) {
    const re = new RegExp(`^([ \\t]*)<!-- capture:${name} -->\\n[\\s\\S]*?\\n([ \\t]*<!-- /capture:${name} -->)$`, "mu");
    check(re.test(text), `${path.basename(file)} has a capture:${name} block`);
    text = text.replace(re, (_all, indent: string, close: string) => `${indent}<!-- capture:${name} -->\n${make(indent)}\n${close}`);
  }
  fs.writeFileSync(file, text);
}

/** Where each block sits in fleetd.txt, found by the shape of fleetd's own output, so its readers never see markers. */
const TWIN: Record<string, RegExp> = {
  init: /^\$ fleetd init .*\n(?:.*\n)*?\[exit \d+\]$/gmu,
  "machine-add": /^\$ fleetd machine add .*\n(?:.*\n)*?\[exit \d+\]$/gmu,
  train: /^\d\d:\d\d:\d\d {2}.*(?:\n\d\d:\d\d:\d\d {2}.*)*/gmu,
};

/** Replaces each block in the plain-text twin; each must be found exactly once, before and after. */
export function fillTwin(text: string, blocks: Blocks) {
  const find = (name: string, within: string) => {
    const found = [...within.matchAll(TWIN[name]!)];
    check(found.length === 1, `fleetd.txt has one capture:${name} block, found ${found.length}`);
    const [m] = found;
    return { at: m!.index, length: m![0].replace(/\n+$/u, "").length };
  };
  for (const [name, make] of Object.entries(blocks)) {
    const { at, length } = find(name, text);
    const body = make("");
    text = text.slice(0, at) + body + text.slice(at + length);
    check(find(name, text).length === body.length, `capture:${name} reads back from fleetd.txt as written`);
  }
  return text;
}

/** Nothing on a public page may name this machine, its paths or its network, or carry a key. */
function assertPublishable(name: string, text: string) {
  const host = os.hostname();
  const leaks: Array<[string, RegExp | string]> = [
    ["home directory", os.homedir()],
    ["lab directory", LAB],
    ["a /home path", /\/home\/(?!demo\b)/u],
    ["hostname", new RegExp(`\\b${host.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")}\\b`, "iu")],
    ["fleetd key", /fld_[a-z2-7]{20,}/u],
    ...(GH_USER === undefined ? [] : [["GitHub login", GH_USER] as [string, string]]),
    ["tailnet name", /\.ts\.net\b(?<!hub\.your-tailnet\.ts\.net)/u],
    ["non-loopback IPv4", /\b(?!127\.0\.0\.1\b)\d{1,3}(\.\d{1,3}){3}\b/u],
  ];
  for (const [what, needle] of leaks) {
    check(typeof needle === "string" ? !text.includes(needle) : !needle.test(text), `${name} would publish a ${what}`);
  }
}

// ---- The run ----

async function main() {
  check(fs.existsSync(fleetdCommand([])[0]), `${fleetdCommand([])[0]} is built (cargo build --release --locked -p fleetd)`);
  const { init, add } = setupTranscripts();
  const train = trainLines();
  log(train === undefined ? "train: no lab run has merged a PR; the train blocks stay as they are" : `train: ${train.lines.length} lines from ${train.from}`);
  const htmlBlocks: Blocks = { init: transcriptBlocks(init).html, "machine-add": transcriptBlocks(add).html };
  const txtBlocks: Blocks = { init: transcriptBlocks(init).txt, "machine-add": transcriptBlocks(add).txt };
  if (train !== undefined) {
    htmlBlocks.train = trainBlocks(train.lines).html;
    txtBlocks.train = trainBlocks(train.lines).txt;
  }
  for (const [name, make] of [...Object.entries(htmlBlocks), ...Object.entries(txtBlocks)]) assertPublishable(`capture:${name}`, make(""));

  // Everything checked: now the site changes.
  fill(path.join(SITE, "home.html"), htmlBlocks);
  fs.writeFileSync(path.join(SITE, "fleetd.txt"), fillTwin(fs.readFileSync(path.join(SITE, "fleetd.txt"), "utf8"), txtBlocks));
  log("wrote the capture blocks in site/home.html and site/fleetd.txt");
  fillDocs(docsBlocks(landingTranscripts({ init, add })));
}

/** Docs blocks named `init` and `machine-add` show exactly the landing page's transcripts (the dry-run plan without
 * the shell command under each step). */
const landingTranscripts = ({ init, add }: ReturnType<typeof setupTranscripts>) => ({
  init: `$ ${init.cmd}\n${init.out}`,
  "machine-add": `$ ${add.cmd}\n${add.out}`,
});

async function docsOnly() {
  check(fs.existsSync(fleetdCommand([])[0]), `${fleetdCommand([])[0]} is built (cargo build --release --locked -p fleetd)`);
  fillDocs(docsBlocks(landingTranscripts(setupTranscripts())));
}

if (import.meta.main) (DOCS_ONLY ? docsOnly() : main())
  .catch((error: unknown) => {
    log(`FAIL ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`);
    process.exitCode = 1;
  })
  .finally(async () => {
    for (const undo of cleanups.toReversed()) await Promise.resolve(undo()).catch((e: unknown) => log(`cleanup: ${String(e)}`));
  });
