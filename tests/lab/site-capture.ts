// `FLEETD_LAB_SLOT=<n> node tests/lab/site-capture.ts`: re-shoots the fleetd.sh landing page from the real product.
// `node tests/lab/site-capture.ts --docs` only recaptures the docs' ```console capture=NAME blocks (no lab, no claude).
// A lab hub and node, a haiku lead that files three numbered asks, the desktop app (app/desktop, launched by its QA
// harness, so `pnpm install && pnpm qa:build` there first) answering them, and the setup CLI in a throwaway HOME. Writes site/capture-*.png and rewrites the `<!-- capture:NAME -->`
// blocks in site/home.html and the same blocks in site/fleetd.txt. Costs three tiny claude-haiku turns. Every process
// it starts is stopped by the PID captured at spawn; it never touches a hub or node it didn't start.
//
// Everything that knows how the lab lays out a machine is in stageLab(); the rest drives only the fleetd CLI, MCP
// tools and the app.
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import {
  type Body,
  callToolWith,
  claudeLoginEnv,
  check,
  cli,
  fleetdCommand,
  HUB_PORT,
  HUB_URL,
  cleanupMachineHomes,
  LAB,
  log,
  MODEL,
  nodeEnv,
  nodeHome,
  prepareMachineHome,
  REPO,
  SLOT,
  scrubbedEnv,
  takeLabLock,
  until,
  waitEventWith,
  writeFleetdWrapper,
} from "./harness.ts";

const DOCS_ONLY = process.argv.includes("--docs");
if (process.env.FLEETD_LAB_SLOT === undefined && !DOCS_ONLY) throw new Error("set FLEETD_LAB_SLOT (1-9) to the lab slot this run may use");

const SITE = path.join(REPO, "site");
const RUN = path.join(LAB, "site-capture");
const MACHINE = "builder-1";
const TURN_MS = 240_000;
const ENDED = ["thread.completed", "thread.failed", "thread.interrupted"];

/** The app's window (the QA harness's medium size), in logical pixels; the captures are this at the page's scale. */
const APP_WINDOW = { width: 1400, height: 900 };
const REPLY = "1 go 2 nvm 3 b";

/** What the lead is told to run: the asks are arranged, the filing, batching and answering are real. */
const ASK_MESSAGE = `Run these three commands in your shell, one after the other, exactly as written, then stop:
fleetd ask --key site.pricing.headline --class product --text "Pricing page headline: the copy review left two variants in site/pricing.md. Ship A?" --rec "Pay for machines, not seats"
fleetd ask --key deps.moment --class product --text "Drop the moment dependency and format invoice and receipt dates with the built-in Intl API instead?" --rec "drop moment"
fleetd ask --key billing.team.trial --class money --text "Free trial length for the Team plan?" --options "7 days,14 days,30 days" --rec "7 days" --blocks "the Team plan launch"`;

/** The demo project the lead works in. */
const STOREFRONT: Record<string, string> = {
  "README.md": "# storefront\n\nMarketing site and checkout for the Team plan.\n\n- `site/pricing.md`: the pricing page copy\n- `src/dates.js`: date formatting for invoices and receipts\n",
  "site/pricing.md": '# Pricing\n\n<!-- headline: two variants from the copy review, pick one before launch -->\n<!-- A: "Pay for machines, not seats" -->\n<!-- B: "One price per machine. Every agent included." -->\n\n## Team\n\nPer machine, billed monthly. Free trial included.\n',
  "package.json": '{\n  "name": "storefront",\n  "private": true,\n  "type": "module",\n  "dependencies": {\n    "moment": "2.30.1"\n  }\n}\n',
  "src/dates.js": 'import moment from "moment";\n\nexport const invoiceDate = (d) => moment(d).format("D MMM YYYY");\nexport const receiptTime = (d) => moment(d).format("D MMM YYYY, HH:mm");\n',
};

/** Undone last to first in `finally`: processes by their spawn PID, lab state put back. */
const cleanups: Array<() => Promise<void> | void> = [];

const spawnTracked = (name: string, [cmd, args]: [string, Array<string>], env: Record<string, string>) => {
  fs.mkdirSync(path.join(RUN, "logs"), { recursive: true });
  const out = fs.openSync(path.join(RUN, "logs", `${name}.log`), "a");
  const child = spawn(cmd, args, { env, stdio: ["ignore", out, out] });
  log(`started ${name} pid=${child.pid}`);
  cleanups.push(async () => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    const exited = new Promise((r) => child.once("exit", r));
    child.kill("SIGTERM");
    const timer = setTimeout(() => child.kill("SIGKILL"), 10_000);
    await exited;
    clearTimeout(timer);
    log(`stopped ${name} pid=${child.pid}`);
  });
  return child;
};

const pause = (ms: number) => new Promise<undefined>((r) => setTimeout(() => r(undefined), ms));

// ---- The lab: a hub and node builder-1 (its own HOME, so its own ~/.fleetd and Claude config dir). ----

async function stageLab() {
  takeLabLock();

  const workspace = path.join(LAB, "storefront");
  fs.rmSync(workspace, { recursive: true, force: true });
  for (const [file, text] of Object.entries(STOREFRONT)) {
    fs.mkdirSync(path.dirname(path.join(workspace, file)), { recursive: true });
    fs.writeFileSync(path.join(workspace, file), text);
  }
  const gitEnv = { ...scrubbedEnv(), GIT_AUTHOR_NAME: "lab", GIT_AUTHOR_EMAIL: "lab@localhost", GIT_COMMITTER_NAME: "lab", GIT_COMMITTER_EMAIL: "lab@localhost" };
  for (const args of [["init", "-q", "-b", "main"], ["add", "."], ["commit", "-q", "-m", "storefront: pricing page draft and invoice dates"]]) {
    execFileSync("git", args, { cwd: workspace, env: gitEnv, stdio: "ignore" });
  }

  // The lead's shell gets `fleetd` (the build under test) on the node's PATH; the node sets FLEETD_NODE_SOCK itself.
  writeFleetdWrapper();
  prepareMachineHome(MACHINE);
  cleanups.push(() => cleanupMachineHomes());

  const hubHome = path.join(RUN, "hub");
  spawnTracked("hub", fleetdCommand(["hub", "start", "--home", hubHome, "--listen", `127.0.0.1:${HUB_PORT}`]), scrubbedEnv());
  await until("hub /healthz", 30_000, async () => (await fetch(`${HUB_URL}/healthz`).then((r) => r.ok, () => false)) || (await pause(250)));
  const keyOf = (out: string) => {
    const key = /fld_[a-z2-7]{20,}/u.exec(out)?.[0];
    check(key, "hub key create printed a key");
    return key!;
  };
  const operateKey = keyOf(cli("hub", "key", "create", "--home", hubHome, "--name", "site-capture", "--role", "operate", "--machines", "*"));
  const humanKey = keyOf(cli("hub", "key", "create", "--home", hubHome, "--human", "--name", "laptop"));
  const token = /^\S{16,}$/mu.exec(cli("hub", "token", "create", "--home", hubHome, "--machine", MACHINE))?.[0];
  check(token, "hub token create printed a token");
  spawnTracked(
    "node",
    fleetdCommand([
      "node", "join", "--hub", HUB_URL, "--token", token!, "--machine", MACHINE, "--home", nodeHome(MACHINE),
    ]),
    nodeEnv(MACHINE),
  );
  return { operateKey, humanKey, workspace };
}

// ---- The app, through app/desktop's QA harness: the release main bundle on the lab hub with the human key. ----

async function startApp(scale: number, humanKey: string) {
  // The harness reads its scale when it loads.
  process.env.QA_SCALE = String(scale);
  const qa = await import("../../app/desktop/qa/harness.ts");
  const { app, page, close } = await qa.launch(undefined, undefined, { url: HUB_URL, key: humanKey });
  cleanups.push(close);
  await qa.setView(app, page, "medium", "light");
  return {
    page,
    show: (screen: string, route: string) => qa.show(page, screen, route),
    settle: () => qa.settle(page),
    png: (out: string) => page.screenshot({ path: out, animations: "disabled", caret: "hide" }),
  };
}

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

// ---- The docs' capture blocks (docs/site/*.md) ----

const DOCS = path.join(REPO, "docs/site");
const DOCS_BLOCK = /^```console capture=([a-z0-9-]+)\n([\s\S]*?)^```$/gmu;

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

/** Each block's `$ ` commands run in a fresh throwaway HOME where the standard `fleetd init` already ran (unless the
 * block's first command is `fleetd init`), each followed by its output; `[exit N]` only when N isn't 0. Blocks named
 * in `given` (output only the lab run has, like the digest) take that text instead; without it they're left alone. */
export function docsBlocks(given: Record<string, string>) {
  const blocks = new Map<string, { file: string; body: string }>();
  for (const name of fs.readdirSync(DOCS).filter((n) => n.endsWith(".md")).sort()) {
    const file = path.join(DOCS, name);
    for (const [, block, body] of fs.readFileSync(file, "utf8").matchAll(DOCS_BLOCK)) {
      check(!blocks.has(block!), `capture=${block} is used once across docs/site`);
      if (block! in given) {
        blocks.set(block!, { file, body: `${given[block!]}\n` });
        continue;
      }
      const commands = docsCommands(body!);
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

/** Writes the blocks back into docs/site and regenerates site/docs. */
function fillDocs(blocks: ReturnType<typeof docsBlocks>) {
  for (const [name, { body }] of blocks) assertPublishable(`docs capture=${name}`, body);
  const files = new Set([...blocks.values()].map((b) => b.file));
  for (const file of files) {
    const text = fs.readFileSync(file, "utf8").replace(DOCS_BLOCK, (all, name: string) => {
      const b = blocks.get(name);
      return b === undefined || b.file !== file ? all : `\`\`\`console capture=${name}\n${b.body}\`\`\``;
    });
    fs.writeFileSync(file, text);
  }
  execFileSync("cargo", ["run", "-q", "--locked", "-p", "docsgen"], { cwd: REPO, stdio: "inherit" });
  log(`docs: recaptured ${blocks.size} block(s) in ${files.size} file(s) under docs/site and regenerated site/docs`);
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
const SETBACKS = ["change.refused", "train.frozen", "change.ci_failed", "change.needs_rebase"];

/** What the page shows of a run, in time order: the whole path of the first two Changes that merged, and the first
 * of each way the train turns a change away or holds it (a freeze with the resume that ends it). At most 16 lines. */
export function pickTrain(lines: ReadonlyArray<TrainLine>) {
  const merged = new Set(lines.filter((l) => l.type === "pr.merged").map((l) => l.change));
  const followed = lines.filter((l) => l.type === "change.queued" && merged.has(l.change)).map((l) => l.change).slice(0, 2);
  const picked = new Set(lines.filter((l) => followed.includes(l.change) && LIFECYCLE.includes(l.type)));
  for (const type of SETBACKS) {
    const first = lines.find((l) => l.type === type);
    if (first !== undefined) picked.add(first);
  }
  const frozen = lines.find((l) => l.type === "train.frozen");
  const resumed = frozen && lines.find((l) => l.type === "train.resumed" && l.ms >= frozen.ms);
  if (resumed) picked.add(resumed);
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
  digest: /^ {2}fleetd digest · .*(?:\n {2}\S.*)*/gmu,
  // From the first "## " heading through the indented and blank lines after it.
  wake: /^ {2}## .*(?:\n(?: {2}.*)?)*/gmu,
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

/** All string values in a JSON value. */
const strings = (v: unknown): Array<string> =>
  typeof v === "string" ? [v] : Array.isArray(v) ? v.flatMap(strings) : v !== null && typeof v === "object" ? Object.values(v).flatMap(strings) : [];

/** Hand-written callouts that quote the product, and ids on the page, that this run's output no longer contains. */
function staleQuotes(haystack: string) {
  const norm = (s: string) => s.replaceAll("**", "").replaceAll("’", "'").replace(/\s+/gu, " ").trim();
  const hay = norm(haystack);
  const html = fs.readFileSync(path.join(SITE, "home.html"), "utf8");
  const txt = fs.readFileSync(path.join(SITE, "fleetd.txt"), "utf8");
  const quotes = [...html.matchAll(/<code class="q">([\s\S]*?)<\/code>|<q>([\s\S]*?)<\/q>/gu)].map((m) =>
    norm((m[1] ?? m[2] ?? "").replaceAll("&lt;", "<").replaceAll("&gt;", ">").replaceAll("&amp;", "&")),
  );
  const ids = [...new Set([...(html + txt).matchAll(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gu)].map((m) => m[0]))];
  // "blocks: the Team plan launch" is the app's label around the ask's own text.
  return [...quotes, ...ids].filter((q) => !hay.includes(q) && !hay.includes(q.replace(/^[a-z]+: /u, "")));
}

// ---- The run ----

async function main() {
  const html = fs.readFileSync(path.join(SITE, "home.html"), "utf8");
  const size = /<img src="\/capture-inbox\.png" width="(\d+)" height="(\d+)"/u.exec(html);
  check(size, "home.html sizes capture-inbox.png");
  const scale = Number(size![1]) / APP_WINDOW.width;
  check(Number(size![2]) === APP_WINDOW.height * scale, `home.html's capture-inbox.png is the app window at one scale`);
  check(fs.existsSync(fleetdCommand([])[0]), `${fleetdCommand([])[0]} is built (cargo build --release --locked -p fleetd)`);
  fs.rmSync(RUN, { recursive: true, force: true });
  const shots = path.join(RUN, "shots");
  fs.mkdirSync(shots, { recursive: true });

  const { operateKey, humanKey, workspace } = await stageLab();
  const client = new Client({ name: "fleetd-site-capture", version: "0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${HUB_URL}/mcp`), { requestInit: { headers: { authorization: `Bearer ${operateKey}` } } }) as Transport);
  cleanups.push(() => client.close().catch(() => undefined));
  const callTool = callToolWith(() => client);
  const waitEvent = waitEventWith(callTool);
  const cursor = async () => (await callTool("fleetd_status")).body.cursor as number;
  const ok = (r: { isError: boolean; body: Body }, what: string) => {
    check(!r.isError, `${what}: ${JSON.stringify(r.body)}`);
    return r.body;
  };

  await until(`${MACHINE} online`, 120_000, async () => {
    const s = (await callTool("fleetd_status")).body;
    if (s.machines.some((m: Body) => m.machineId === MACHINE && m.status === "online")) return true;
    await callTool("events_wait", { cursor: s.cursor, timeoutSec: 5 });
    return undefined;
  });
  ok(await callTool("project_add", { machineId: MACHINE, path: workspace, title: "storefront" }), "project_add storefront");
  const projectId = await until(`${MACHINE} online with the storefront project`, 120_000, async () => {
    const s = (await callTool("fleetd_status")).body;
    const p = s.projects.find((p: Body) => p.machineId === MACHINE && p.workspaceRoot === workspace);
    const online = s.machines.some((m: Body) => m.machineId === MACHINE && m.status === "online");
    if (online && p && (await callTool("project_get", { machineId: MACHINE, projectId: p.projectId })).body.stale === false) return p.projectId as string;
    await callTool("events_wait", { cursor: s.cursor, timeoutSec: 5 });
    return undefined;
  });
  const turn = async (what: string, from: number, threadId: string) => {
    const { event } = await waitEvent(what, TURN_MS, { cursor: from, machineId: MACHINE, match: (e) => e.threadId === threadId && ENDED.includes(e.type) });
    check(event.type === "thread.completed", `${what}: ${event.type}`);
  };

  // Turn 1: the lead starts. The app comes up meanwhile, with an empty inbox.
  let from = await cursor();
  const lead = ok(await callTool("lead_start", { machineId: MACHINE, projectId, model: MODEL, effort: "low" }), "lead_start").threadId as string;
  const screen = await startApp(scale, humanKey);
  await turn("lead start", from, lead);
  await screen.show("board", "#/board");
  log(`lead ${lead} started; app up`);

  // Turn 2: the lead files the asks from its shell; the hub batches them; the app shows the batch.
  from = await cursor();
  ok(await callTool("thread_send", { machineId: MACHINE, threadId: lead, message: ASK_MESSAGE, clientRequestId: randomUUID() }), "thread_send");
  await turn("the lead filing its asks", from, lead);
  await waitEvent("batch.ready", 120_000, { cursor: from, types: ["batch.ready"] });
  const open = ok(await callTool("asks_list", { state: "open" }), "asks_list");
  check(open.asks.length === 3, `the lead filed 3 asks, found ${open.asks.length}`);
  // The inbox panel holds the whole batch and the reply field; the board's strip shows only the first two asks.
  await screen.show("inbox", "#/board?inbox");
  const panel = screen.page.getByRole("complementary", { name: "Needs you" });
  for (const ask of open.asks as Array<Body>) await panel.getByText(String(ask.text)).first().waitFor({ timeout: 30_000 });
  await screen.settle();
  await screen.png(path.join(shots, "capture-inbox.png"));
  log("captured the inbox");

  // The reply, typed into the inbox panel's reply field; Enter sends it as the human. Turn 3: the hub wakes the lead with the answers.
  from = await cursor();
  const reply = panel.getByRole("textbox", { name: "Reply" });
  await reply.fill(REPLY);
  await reply.press("Enter");
  await screen.settle();
  await screen.png(path.join(shots, "capture-reply.png"));
  log("captured the inbox after the reply");
  const woken = await waitEvent("the lead woken with the answers", 120_000, { cursor: from, types: ["lead.woken"], match: (e) => e.threadId === lead });
  await turn("the lead's wake", woken.cursor, lead);

  const tail = ok(await callTool("thread_tail", { machineId: MACHINE, threadId: lead, n: 50 }), "thread_tail");
  const messages = (tail.items as Array<Body>).filter((i) => i.kind === "message");
  const wake = String(messages.find((m) => m.role === "user")?.text ?? "");
  check(wake.includes("## Why you are woken"), "the newest user message is the wake");
  const digest = String(ok(await callTool("digest_get"), "digest_get").text).trim();
  const answered = ok(await callTool("asks_list", { state: "answered" }), "asks_list answered");

  const { init, add } = setupTranscripts();
  const train = trainLines();
  log(train === undefined ? "train: no lab run has merged a PR; the train blocks stay as they are" : `train: ${train.lines.length} lines from ${train.from}`);

  // The wake without its header (project id, timestamp) and without the sections that say "none".
  const sections = wake.slice(wake.indexOf("## ")).split(/\n(?=## )/u).filter((s) => s.split("\n").slice(1).join("\n").trim() !== "none");
  const wakeText = sections.map((s) => s.trimEnd()).join("\n\n");
  const [digestHead = "", ...digestRest] = digest.split("\n");
  const htmlBlocks: Blocks = {
    init: transcriptBlocks(init).html,
    "machine-add": transcriptBlocks(add).html,
    digest: (indent) => `${indent}<pre class="lines"><span class="c">${esc(digestHead)}</span>${digestRest.length === 0 ? "" : `\n<span class="o">${esc(digestRest.join("\n"))}</span>`}</pre>`,
  };
  const txtBlocks: Blocks = {
    init: transcriptBlocks(init).txt,
    "machine-add": transcriptBlocks(add).txt,
    digest: () => indentAll(digest, "  "),
    wake: () => indentAll(wakeText, "  "),
  };
  if (train !== undefined) {
    htmlBlocks.train = trainBlocks(train.lines).html;
    txtBlocks.train = trainBlocks(train.lines).txt;
  }
  for (const [name, make] of [...Object.entries(htmlBlocks), ...Object.entries(txtBlocks)]) assertPublishable(`capture:${name}`, make(""));

  // Everything checked: now the site changes.
  // Every capture the page shows, and only those.
  const published = fs.readdirSync(shots).filter((shot) => html.includes(`/${shot}`));
  for (const shot of html.matchAll(/\/(capture-[\w-]+\.png)/gu)) check(published.includes(shot[1]!), `the run shot ${shot[1]}, which home.html shows`);
  for (const shot of published) fs.copyFileSync(path.join(shots, shot), path.join(SITE, shot));
  fill(path.join(SITE, "home.html"), htmlBlocks);
  fs.writeFileSync(path.join(SITE, "fleetd.txt"), fillTwin(fs.readFileSync(path.join(SITE, "fleetd.txt"), "utf8"), txtBlocks));
  const stale = staleQuotes([...strings(tail), ...strings(answered), wake, digest, init.out, add.out].join("\n"));
  log(`wrote ${published.map((s) => `site/${s}`).join(", ")} and the capture blocks in site/home.html and site/fleetd.txt`);
  fillDocs(docsBlocks({ ...landingTranscripts({ init, add }), digest }));
  if (stale.length > 0) log(`check by hand: the page says these, this run's output doesn't:\n${stale.map((s) => `  - ${s}`).join("\n")}`);
  log("callouts are placed by hand: if the app's layout moved, re-aim --x/--y in home.html (see the comment above Fig. 1)");
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
    log(`logs: ${path.join(RUN, "logs")}`);
    process.exitCode = 1;
  })
  .finally(async () => {
    for (const undo of cleanups.toReversed()) await Promise.resolve(undo()).catch((e: unknown) => log(`cleanup: ${String(e)}`));
  });
