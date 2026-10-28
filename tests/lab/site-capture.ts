// `node tests/lab/site-capture.ts`: rewrites the docs' setup transcripts from the product, checked first for anything
// that names this machine. `node tests/lab/site-capture.ts --docs` recaptures the docs' ```console capture=NAME blocks
// without that check. The setup CLI in a throwaway HOME (`fleetd init` and `fleetd machine add --dry-run`, with your
// claude and gh logins copied in, sanitized) fills the docs' `init` and `machine-add` blocks. No hub, node or claude
// turn. The landing page's clips come from app/desktop's fixtures instead (app/desktop/qa/showcase.spec.ts).
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { type Body, claudeLoginEnv, check, fleetdCommand, LAB, log, REPO, scrubbedEnv } from "./harness.ts";

const DOCS_ONLY = process.argv.includes("--docs");

/** Undone last to first in `finally`. */
const cleanups: Array<() => Promise<void> | void> = [];

// ---- Setup transcripts ----

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
  const transcripts = setupBlocks(setupTranscripts());
  for (const [name, text] of Object.entries(transcripts)) assertPublishable(`capture:${name}`, text);
  // Everything checked: now the docs change.
  fillDocs(docsBlocks(transcripts));
}

/** Docs blocks named `init` and `machine-add` show exactly these transcripts (the dry-run plan without the shell
 * command under each step). */
const setupBlocks = ({ init, add }: ReturnType<typeof setupTranscripts>) => ({
  init: `$ ${init.cmd}\n${init.out}`,
  "machine-add": `$ ${add.cmd}\n${add.out}`,
});

async function docsOnly() {
  check(fs.existsSync(fleetdCommand([])[0]), `${fleetdCommand([])[0]} is built (cargo build --release --locked -p fleetd)`);
  fillDocs(docsBlocks(setupBlocks(setupTranscripts())));
}

if (import.meta.main) (DOCS_ONLY ? docsOnly() : main())
  .catch((error: unknown) => {
    log(`FAIL ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`);
    process.exitCode = 1;
  })
  .finally(async () => {
    for (const undo of cleanups.toReversed()) await Promise.resolve(undo()).catch((e: unknown) => log(`cleanup: ${String(e)}`));
  });
