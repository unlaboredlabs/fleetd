// `fleetd init` on the hub machine (crates/fleetd/src/cli/setup/wizard.rs `steps` past "This machine"): where the hub
// listens, the logins it needs (claude through T2248's describe(), gh, the commit author), the hub itself, the
// machines that run agents, a first project, the app's pairing, then the hub's setup steps and the doctor.
import { mkdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, setupLine } from "../../node/runner/claude/describe.ts";
import { ClaudeAccountStore } from "../../hub/claude_accounts/index.ts";
import type { HubDb } from "../../hub/store/db.ts";
import { HubStore } from "../../hub/store/hub_store.ts";
import { type GitIdentity, homeDir, isNoreply, type MachineRecord, parseGitIdentity, readSetup, resolveHome } from "../common.ts";
import { mint } from "../pair.ts";
import { terminal } from "../tty.ts";
import { listKeys, openHub } from "../store.ts";
import type { Checklist } from "./checklist.ts";
import {
  findRepos,
  installCommand,
  lanIpv4,
  noreplyIdentity,
  parseGithubRepo,
  parseSshHosts,
  parseTailscaleStatus,
  REPO_ROOTS,
  shortRemote,
  type Tailnet,
} from "./detect.ts";
import { addProject, connect, hubHasTool, run as runDoctor, show as showChecks, stillChecking, tally } from "./doctor.ts";
import { installHub } from "./index.ts";
import { type Added, add as addMachine, candidates, Stop } from "./machine.ts";
import { CLAUDE_INSTALL, claudeVerdict, verdictFix, verdictProblem } from "./machine_plan.ts";
import { capture, currentExe, probeListen, release } from "./shared.ts";
import { runLocal } from "./ssh.ts";
import { isFailure } from "./steps.ts";
import { q } from "./units.ts";
import { failedWithLog, type InitOptions, nodeLine, notes, splitFix, type Ui, walk, workerClaude } from "./wizard.ts";
import { settingsPath } from "../../shared/settings_path.ts";

const PORT = 4790;
/** The installer's line, with the desktop app or without. */
const INSTALLER = ["curl -fsSL https://fleetd.sh", "sh"].join(" | ");

/** `bin` on PATH, without running anything. */
function which(bin: string): string | undefined {
  for (const dir of (process.env.PATH ?? "").split(":")) {
    if (!dir) continue;
    const file = join(dir, bin);
    try {
      const st = statSync(file);
      if (st.isFile() && (st.mode & 0o111) !== 0) return file;
    } catch {}
  }
  return undefined;
}

const isDir = (p: string) => {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
};

/** Runs a command with only the environment the hub service has. */
function hubEnvRun(program: string, args: string[]): { code: number; stdout: string; stderr: string } | undefined {
  const env: Record<string, string> = {};
  for (const k of ["HOME", "PATH", "USER", "LANG"]) if (process.env[k]) env[k] = process.env[k]!;
  try {
    const out = Bun.spawnSync([program, ...args], { env, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
    return { code: out.exitCode ?? 1, stdout: out.stdout.toString(), stderr: out.stderr.toString() };
  } catch {
    return undefined;
  }
}

/** A login flow or a clone with this terminal attached. */
function attached(list: Checklist, program: string, args: string[], env?: Record<string, string>): boolean {
  list.stopSpinner();
  try {
    return Bun.spawnSync([program, ...args], { stdio: [terminal(), "inherit", "inherit"], ...(env ? { env: { ...process.env, ...env } } : {}) }).exitCode === 0;
  } catch {
    return false;
  }
}

function install(tool: string): string {
  let osRelease: string | undefined;
  try {
    osRelease = readFileSync("/etc/os-release", "utf8");
  } catch {}
  return installCommand(tool, process.platform === "darwin" ? "macos" : process.platform, osRelease);
}

async function tailnet(): Promise<Tailnet | undefined> {
  if (which("tailscale") === undefined) return undefined;
  const out = await runLocal("tailscale", ["status", "--json"]);
  return out.code === 0 ? parseTailscaleStatus(out.stdout) : undefined;
}

const tildeOf = (path: string) => {
  const home = homeDir();
  return path.startsWith(`${home}/`) ? `~/${path.slice(home.length + 1)}` : path === home ? "~/" : path;
};

/** A desktop session the app could open in: always on macOS, an X or Wayland display on Linux. */
const hasDisplay = () => process.platform === "darwin" || Boolean(process.env.DISPLAY || process.env.WAYLAND_DISPLAY);

/** Whether the desktop app is installed here, and how to open (or install) it. */
function appHint(): [boolean, string] {
  const home = homeDir();
  if (process.platform === "darwin") {
    for (const app of [join(home, "Applications/fleetd.app"), "/Applications/fleetd.app"]) {
      if (isDir(app)) return [true, `open ${tildeOf(app)}`];
    }
    return [false, INSTALLER];
  }
  const data = process.env.XDG_DATA_HOME || join(home, ".local/share");
  try {
    if (statSync(join(data, "fleetd/app/fleetd-desktop.AppImage")).isFile()) return [true, "open fleetd from your app menu"];
  } catch {}
  return [false, `${INSTALLER} -s -- --app`];
}

/** On a desktop with the fleetd app: "Continue in the desktop app" opens its onboarding (`fleetd://setup`). */
export async function offerApp(ui: Ui, list: Checklist): Promise<number | undefined> {
  const [installed] = appHint();
  if (!ui.interactive || !installed || !hasDisplay()) return undefined;
  const inApp = await ui.select(
    list,
    "Where would you like to set up?",
    [
      [false, "Here in the terminal", ""],
      [true, "Continue in the desktop app", "the fleetd app walks you through it"],
    ],
    false,
  );
  if (!inApp) return undefined;
  let cli = "fleetd";
  try {
    cli = currentExe();
  } catch {}
  const enc = (t: string) =>
    encodeURIComponent(t)
      .replace(/[!'()~]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`)
      .replace(/%20/g, "+");
  const link = `fleetd://setup?v=1&cli=${enc(cli)}&home=${enc(resolveHome())}`;
  const opener = process.platform === "darwin" ? "open" : "xdg-open";
  let opened = false;
  try {
    opened = Bun.spawnSync([opener, link], { stdout: "ignore", stderr: "ignore" }).exitCode === 0;
  } catch {}
  if (opened) {
    list.outro([], "Opened the fleetd app; it takes it from here.");
    return 0;
  }
  list.failed("desktop app", "did not open", `${opener} '${link}'`);
  return undefined;
}

type Summary = { hub?: string; workers: string[]; project?: string; pairing?: string };

async function reachability(
  opts: InitOptions,
  ui: Ui,
  list: Checklist,
  net: Tailnet | undefined,
  lan: string | undefined,
): Promise<[string, string]> {
  if (opts.listen !== undefined) {
    const url = opts.url ?? `http://${opts.listen}`;
    list.done("reachable at", url);
    return [opts.listen, url];
  }
  if (opts.previous) {
    const url = opts.url ?? opts.previous.url;
    list.done("reachable at", url);
    return [opts.previous.listen, url];
  }
  const hosts: [string, string, string, string][] = [];
  if (net?.ipv4) hosts.push([net.ipv4, net.dnsName ?? net.ipv4, "Your tailnet", "your devices reach it, nothing public"]);
  hosts.push(["127.0.0.1", "127.0.0.1", "This machine only", "other machines can't reach it"]);
  if (lan) hosts.push([lan, lan, "Your LAN", "anyone on this network, plain HTTP"]);
  list.start("Looking for a free port");
  const choices: [number, string, string][] = [];
  const addrs: [string, string][] = [];
  for (const [i, [ip, name, label, why]] of hosts.entries()) {
    let port = PORT;
    while (port < PORT + 10 && (await probeListen([ip, port])) !== "free") port++;
    const url = `http://${name}:${port}`;
    choices.push([i, label, `${url} · ${why}${port === PORT ? "" : ` · ${PORT} is taken`}`]);
    addrs.push([`${ip}:${port}`, url]);
  }
  list.stopSpinner();
  const picked = await ui.select(list, "Where should the workspace listen?", choices, 0);
  const [listen, found] = addrs[picked]!;
  const url = opts.url ?? found;
  list.done("reachable at", url);
  return [listen, url];
}

/** How this claude updates itself: Homebrew and npm through their package manager, the native installer again,
 * anything else with `claude update`. */
export function updateCommandFor(path: string): string {
  if (path.includes("/Caskroom/") || path.includes("/Cellar/") || path.startsWith("/opt/homebrew/")) return "brew upgrade claude-code";
  if (path.includes("/node_modules/")) return "npm install -g @anthropic-ai/claude-code@latest";
  if (path.includes("/.local/share/claude/") || path.includes("/.claude/local/")) return CLAUDE_INSTALL;
  return "claude update";
}

/** claude on PATH, else where its installers put it (machine_plan's lookup): one just installed isn't on PATH yet. */
function claudeBinary(): string | undefined {
  const home = homeDir();
  const known = [join(home, ".local/bin/claude"), join(home, ".claude/local/claude"), "/opt/homebrew/bin/claude", "/usr/local/bin/claude"];
  return which("claude") ?? known.find((f) => {
    try {
      return statSync(f).isFile();
    } catch {
      return false;
    }
  });
}

/** What the hub's leads sign in to Claude with when it isn't each machine's own login (claude_accounts `runsOn`: the
 * hub's key, else the owner's subscription): then a machine's claude needs no login. Undefined on a hub not set up
 * yet, or with no account of its own. */
export function hubClaudeAccount(home: string): string | undefined {
  let db: HubDb;
  try {
    db = openHub(home);
  } catch {
    return undefined;
  }
  try {
    const setup = new ClaudeAccountStore(db).setup();
    if (setup.hubApi !== undefined) return "the workspace's API key";
    return setup.owner !== undefined && setup.subscriptions.has(setup.owner) ? "the owner's subscription" : undefined;
  } catch {
    return undefined;
  } finally {
    db.conn.close();
  }
}

/**
 * The user's own claude, as fleetd's sessions run it: installed first (offered here, as the machines that run agents
 * need it), then logged in, or not, when the hub has an account of its own (`account`). Logged out with none, the
 * login is offered; turned down, the Claude step at the end has the other ways. Whether claude is installed now.
 */
async function hubClaude(ui: Ui, list: Checklist, account: string | undefined): Promise<boolean> {
  let binary = claudeBinary();
  if (binary === undefined) {
    const command = install("claude");
    if (await ui.offerToRun(list, `claude isn't installed; fleetd's agents run through it. Install it now? (${command})`)) {
      attached(list, "/bin/sh", ["-c", command]);
      binary = claudeBinary();
    }
    if (binary === undefined) {
      list.failed("claude", "is not installed; fleetd's agents run through it", command);
      return false;
    }
  }
  let real = binary;
  try {
    real = realpathSync(binary);
  } catch {}
  let [logged, updated] = [false, false];
  for (;;) {
    list.start("Checking claude");
    const setup = await describe(binary);
    const printed = setup.version ?? "";
    const verdict = claudeVerdict(printed);
    // The version first, then always the login: an old claude's login still matters.
    if (setup.version !== undefined && verdict !== "ok") {
      const fix = verdict === "older" ? updateCommandFor(real) : verdictFix(verdict) || updateCommandFor(real);
      const why = verdictProblem(verdict, printed).replace(/\.+$/, "").replace(/^claude /, "");
      list.warn("claude version", why, fix);
      if (!updated && verdict !== "newer" && (await ui.offerToRun(list, `Update claude now? (${fix})`))) {
        updated = true;
        attached(list, "/bin/sh", ["-c", fix]);
        continue;
      }
    }
    const detail = setupLine(setup).replace(/^claude /, "");
    if (setup.loginKind === undefined) {
      if (setup.version !== undefined && account !== undefined) {
        list.done("claude", `${detail.split(",")[0]}; agents sign in with ${account}, so it needs no login here`);
        return true;
      }
      if (setup.version !== undefined && !logged && (await ui.offerToRun(list, "claude isn't logged in. Log in now? (No: give the workspace an API key at the end instead)"))) {
        logged = true;
        attached(list, binary, ["auth", "login"]);
        continue;
      }
      if (setup.version === undefined && setup.problem !== undefined) {
        const [why, fix] = splitFix(setup.problem);
        list.failed("claude", why.replace(/^claude /, ""), fix);
      } else {
        // Not a failure of its own: the Claude step at the end is where it's required, with every way to do it.
        list.skipped("claude", `${detail}: log in with claude auth login, or give the workspace an API key in the Claude step at the end`);
      }
      return true;
    }
    if (setup.proxySource === "environment") {
      list.warn(
        "claude",
        `${detail}; that proxy is only in this shell, so fleetd's services won't use it`,
        "put ANTHROPIC_BASE_URL in the env block of ~/.claude/settings.json",
      );
    } else list.done("claude", detail);
    // A protocol break the probe found (the version and login are shown above).
    if (setup.problem !== undefined && !setup.problem.includes("not logged in")) {
      const [why, fix] = splitFix(setup.problem);
      list.failed("claude protocol", why.replace(/^claude /, ""), fix);
    }
    return true;
  }
}

/** gh installed and logged in, as the hub service runs it; offers `gh auth login` right here. */
async function ghCheck(ui: Ui, list: Checklist): Promise<boolean> {
  if (which("gh") === undefined) {
    list.failed("gh", "is not installed; the merge train and PR checks need it", ghInstall(install("gh")));
    return false;
  }
  let offered = false;
  for (;;) {
    list.start("Checking gh");
    const out = hubEnvRun("gh", ["auth", "status"]);
    if (out !== undefined && out.code === 0) {
      const account = /account (\S+)/.exec(`${out.stdout}\n${out.stderr}`)?.[1];
      list.done("gh", account === undefined ? "logged in" : `logged in as ${account}`);
      return true;
    }
    if (!offered && (await ui.offerToRun(list, "gh isn't logged in. Log in now?"))) {
      offered = true;
      attached(list, "gh", ["auth", "login"]);
      continue;
    }
    list.failed(
      "gh",
      "not logged in; the merge train and PR checks need it until the workspace has its GitHub App",
      "gh auth login, or the workspace's GitHub App: fleetd init --step github",
    );
    return false;
  }
}

async function commitIdentity(opts: InitOptions, ui: Ui, list: Checklist, ghOk: boolean): Promise<GitIdentity | undefined> {
  let identity = opts.identity ?? opts.previous?.gitIdentity;
  let asked = false;
  if (identity === undefined) {
    asked = ui.interactive;
    const fromGh = ghOk ? noreplyIdentity((await runLocal("gh", ["api", "user"])).stdout) : undefined;
    // No git on this machine yet is no identity from it.
    const git = async (key: string) => (await runLocal("git", ["config", "--global", key])).stdout.trim();
    const [name, email] = [await git("user.name"), await git("user.email")];
    const fromGit = name && email ? `${name} <${email}>` : undefined;
    const text = await ui.input(list, "Commit author for your agents", fromGh ?? fromGit ?? "", "Name <id+user@users.noreply.github.com>", (s) =>
      parseGitIdentity(s) ? undefined : "like: Name <id+user@users.noreply.github.com>",
    );
    identity = parseGitIdentity(text);
  }
  const fix = 'fleetd init --git-identity "Name <id+user@users.noreply.github.com>"';
  if (identity && isNoreply(identity)) {
    // Just answered above: no second line saying the same.
    if (!asked) list.done("commit author", `${identity.name} <${identity.email}>`);
  } else if (identity) {
    list.warn("commit author", `${identity.name} <${identity.email}> isn't a GitHub noreply address; public repos will show it`, fix);
  } else list.failed("commit author", "none set; agents need one to commit", fix);
  return identity;
}

/** The machines that run agents, each set up with `machine add`: this machine's id when it is one, those whose node
 * runs, and those whose node is left to the user (--no-service). */
async function workers(
  opts: InitOptions,
  ui: Ui,
  list: Checklist,
  net: Tailnet | undefined,
  claudeHere: boolean,
  account: string | undefined,
): Promise<[string | undefined, string[], string[]]> {
  let recorded: Record<string, MachineRecord> = {};
  try {
    recorded = readSetup(opts.home)?.machines ?? {};
  } catch {}
  let hosts: string[] = [];
  try {
    hosts = parseSshHosts(readFileSync(join(homeDir(), ".ssh/config"), "utf8"));
  } catch {}
  const found = candidates(recorded, hosts, net?.peers ?? []);
  const localId = found[0]!.machineId;
  const defaults: string[] = [];
  if (Object.keys(recorded).length === 0 || recorded[localId] !== undefined) defaults.push(localId);
  const items: [string, string, string][] = [];
  for (const c of found) {
    const hint =
      c.found === "here"
        ? "this machine"
        : c.found === "set_up"
          ? `set up · ${c.host}`
          : c.found === "ssh_config"
            ? `~/.ssh/config · ${c.host}`
            : "tailnet";
    if (c.found === "set_up") defaults.push(c.machineId);
    items.push([c.machineId, c.machineId, hint]);
  }
  const chosen = await ui.multi(list, "Which machines should run agents?", items, defaults);
  if (chosen.length === 0) {
    list.skipped("workers", "none yet");
    list.note("Add one later: fleetd machine add <ssh-host>, or fleetd pair --worker <name>");
    return [undefined, [], []];
  }
  let local: string | undefined;
  const [ids, byHand]: [string[], string[]] = [[], []];
  for (const c of found.filter((x) => chosen.includes(x.machineId))) {
    const again = c.host === undefined ? "fleetd machine add --local" : `fleetd machine add ${c.host}`;
    // This machine without claude: its line under Logins says how to install it, and setting it up would only stop.
    if (c.host === undefined && !claudeHere) {
      list.skipped(c.machineId, "runs agents once claude is installed here (see claude above); then run fleetd init again");
      continue;
    }
    list.start(`Setting up ${c.machineId}`);
    capture();
    let added: Added | undefined;
    try {
      added = await addMachine({
        ...(c.host === undefined ? {} : { host: c.host }),
        machineId: c.machineId,
        dryRun: false,
        ...(c.sshConfig === undefined ? {} : { sshConfig: c.sshConfig }),
        home: opts.home,
        enroll: { kind: "hub" },
        noService: !opts.withService,
        ...(opts.claudeConfigDir === undefined ? {} : { claudeConfigDir: opts.claudeConfigDir }),
        mac: false,
      });
    } catch (error) {
      if (!(error instanceof Stop)) {
        release();
        throw error;
      }
      error.print();
    }
    const said = release();
    if (added === undefined) {
      failedWithLog(list, c.machineId, "setup stopped", said, `fix the cause, then run ${again}`);
      continue;
    }
    nodeLine(list, c.machineId, added, "online");
    notes(list, said);
    // This machine's claude was checked under Logins, its login offered there.
    if (c.host !== undefined) await workerClaude(ui, list, added, account);
    (added.runByHand === undefined ? ids : byHand).push(added.machineId);
    if (c.host === undefined) local = added.machineId;
  }
  return [local, ids, byHand];
}

/** A node that just linked is "degraded: checking …" until its first claude check answers, about a second later. */
async function awaitRunnerChecks(opts: InitOptions, list: Checklist, ids: string[]) {
  let db: HubDb;
  try {
    db = openHub(opts.home);
  } catch {
    return;
  }
  try {
    const store = new HubStore(db);
    for (const id of ids) {
      list.start(`Waiting for ${id}'s claude check`);
      const deadline = Date.now() + 30_000;
      let answered = false;
      for (;;) {
        const m = store.machineGet(id) as { degradedReason?: string } | undefined;
        if (!(m?.degradedReason !== undefined && stillChecking(m.degradedReason))) {
          answered = true;
          break;
        }
        if (Date.now() > deadline) break;
        await Bun.sleep(500);
      }
      list.stopSpinner();
      if (!answered) list.skipped(id, "still checking its claude; run fleetd doctor in a minute");
    }
  } finally {
    db.conn.close();
  }
}

/** gh's fix where it isn't installed: the gh line's and a clone's, so the end list says it once. */
const ghInstall = (installGh: string) => `${installGh}, then gh auth login`;

/** A clone that failed, and what to do: without gh logged in, a private repo needs it first (the gh line said how). */
export function cloneFailed(full: string, path: string, ghOk: boolean, installGh: string, ghThere = which("gh") !== undefined): [string, string] {
  if (ghOk) return [`cloning ${full} failed`, `gh repo clone ${full} ${path}, then run fleetd init again`];
  return [`cloning ${full} failed; a private repo needs your GitHub login on this machine`, ghThere ? "gh auth login" : ghInstall(installGh)];
}

async function firstProject(opts: InitOptions, ui: Ui, list: Checklist, local: string | undefined, ghOk: boolean): Promise<string | undefined> {
  const title = "project";
  let existing: { title: string; machineId: string }[] = [];
  try {
    const db = openHub(opts.home);
    try {
      existing = new HubStore(db).projectsList() as never;
    } finally {
      db.conn.close();
    }
  } catch {}
  if (existing.length > 0) {
    const what = `${existing[0]!.title} on ${existing[0]!.machineId}`;
    list.done("projects", existing.length > 1 ? `${what} and ${existing.length - 1} more` : what);
    return what;
  }
  if (local === undefined) {
    list.skipped(title, "none here: this machine runs no agents");
    return undefined;
  }
  if (!(await hubHasTool(opts.home, "project_add"))) {
    list.skipped(title, "this workspace can't add bots yet; after fleetd update, run fleetd init again");
    return undefined;
  }
  if (!ui.interactive) {
    list.skipped(title, "none picked (--yes); run fleetd init in a terminal to pick one");
    return undefined;
  }
  const repos = findRepos(REPO_ROOTS.map((r) => join(homeDir(), r)));
  type Pick = number | "clone" | "later";
  const items: [Pick, string, string][] = repos.slice(0, 30).map((r, i): [Pick, string, string] => [i, tildeOf(r.path), r.remote ? shortRemote(r.remote) : ""]);
  const fallback: Pick = items.length === 0 ? "clone" : 0;
  items.push(["clone", "Clone one from GitHub", "paste its URL"], ["later", "Not now", ""]);
  const picked = await ui.select(list, "Which repo should be your first bot?", items, fallback);
  let path: string;
  if (picked === "later") {
    list.skipped(title, "none yet; run fleetd init again to add one");
    return undefined;
  }
  if (picked === "clone") {
    const text = await ui.input(list, "GitHub repo", "", "https://github.com/owner/repo", (s) =>
      parseGithubRepo(s) ? undefined : "a GitHub URL or owner/repo",
    );
    const repo = parseGithubRepo(text);
    if (!repo) return undefined;
    const parent = ["src", "code", "projects"].map((d) => join(homeDir(), d)).find(isDir) ?? join(homeDir(), "src");
    path = join(parent, repo[1]);
    if (!isDir(join(path, ".git"))) {
      mkdirSync(parent, { recursive: true });
      const full = `${repo[0]}/${repo[1]}`;
      // Without gh, git never asks for a GitHub password, which GitHub refuses anyway: a private repo fails plainly.
      const cloned = ghOk
        ? attached(list, "gh", ["repo", "clone", full, path])
        : attached(list, "git", ["clone", `https://github.com/${full}`, path], { GIT_TERMINAL_PROMPT: "0" });
      if (!cloned) {
        const [why, fix] = cloneFailed(full, tildeOf(path), ghOk, install("gh"));
        list.failed(title, why, fix);
        return undefined;
      }
    }
  } else path = repos[picked]!.path;
  list.start("Adding the bot");
  try {
    await addProject(opts.home, local, path);
    const what = `${tildeOf(path)} on ${local}`;
    list.done(title, what);
    return what;
  } catch (f) {
    if (!isFailure(f)) throw f;
    list.failed(title, f.message, f.fix);
    return undefined;
  }
}

/** Pairs the desktop app with a one-time code; the app on this machine picks it up by itself. True when a device is
 * or can now be paired. */
async function app(opts: InitOptions, ui: Ui, list: Checklist, summary: Summary): Promise<boolean> {
  let devices: string[] = [];
  try {
    const db = openHub(opts.home);
    try {
      devices = listKeys(db)
        .filter((k) => k.kind === "human" && k.revokedAt === undefined)
        .map((k) => k.name);
    } finally {
      db.conn.close();
    }
  } catch {}
  let want: boolean;
  if (devices.length === 0) want = await ui.confirm(list, "Pair the fleetd app with this workspace?", true);
  else {
    list.done("app", `paired: ${devices.join(", ")}`);
    summary.pairing = `paired: ${devices.join(", ")}`;
    want = ui.interactive && (await ui.confirm(list, "Pair another device?", false));
  }
  if (!want) {
    if (devices.length === 0) list.skipped("app", "not paired; fleetd pair prints a code any time");
    return devices.length > 0;
  }
  try {
    const minted = mint(opts.home, undefined, "admin");
    const [installed] = appHint();
    list.done("pairing code", `${minted.code} · one use, 15 min`);
    if (installed && hasDisplay()) list.note("The app on this machine pairs by itself when you open it.");
    else {
      list.note(`In the fleetd app, enter ${minted.urls[0] ?? ""} and the code, or open:`);
      list.note(minted.deepLink);
    }
    summary.pairing = `code ${minted.code}`;
    return true;
  } catch (error) {
    list.failed("pairing code", (error as Error).message, "fleetd pair");
    return devices.length > 0;
  }
}

/** The hub's setup steps (setup_list), each a line, then the doctor's checks no step speaks for. A person at the
 * terminal may open the steps left, one by one. */
async function setupSteps(opts: InitOptions, ui: Ui, list: Checklist, idle: string[]) {
  const steps = await import("./steps.ts");
  list.start("Running the doctor");
  let checks: any[];
  try {
    checks = await runDoctor(opts.home);
  } catch (f) {
    if (!isFailure(f)) throw f;
    list.failed("doctor", f.message, f.fix);
    return;
  }
  let client;
  try {
    client = await connect(opts.home);
  } catch (f) {
    if (!isFailure(f)) throw f;
    list.failed("setup", f.message, f.fix);
    return;
  }
  let all: any[] | undefined;
  try {
    all = await steps.list(client);
  } catch (f) {
    if (!isFailure(f)) throw f;
    list.failed("setup", f.message, f.fix);
    return;
  }
  if (all === undefined) {
    tally(list, showChecks(list, checks, idle), "checks");
    return;
  }
  steps.show(list, all);
  tally(list, showChecks(list, steps.unowned(checks, all), idle), "other checks");
  const left: [string, string, string][] = all.filter((s) => s.status !== "done").map((s) => [s.id, s.title, steps.needWords(s.need)]);
  if (left.length === 0 || !ui.interactive) return;
  const picked = await ui.multi(list, `Set up any of these now? (the app's ${settingsPath()} › Setup has them too)`, left, []);
  for (const step of all.filter((s) => picked.includes(s.id))) {
    // The step's last line says where it stands now: its line above and its tries before that (a key that didn't
    // save) leave the end list. Done, none stays; left untried, its line above does.
    const from = list.items.length;
    const status = await walk(opts, ui, list, client, step);
    const last = list.items.findLastIndex((item, at) => at >= from && item.title === step.title);
    const stands = status === "done" ? undefined : last >= 0 ? last : list.items.findLastIndex((item, at) => at < from && item.title === step.title);
    list.settle((item, at) => (at >= from || item.title === step.title) && at !== stands);
  }
}

/** The line that makes `fleetd` work in this shell, while the installer's ~/.local/bin isn't on its PATH: every fix
 * below it starts with `fleetd`. */
const PATH_LINE = 'export PATH="$HOME/.local/bin:$PATH"';

function finish(list: Checklist, summary: Summary, paired: boolean) {
  const needs = list.needsYou();
  if (needs.length > 0 && which("fleetd") === undefined) needs.unshift(`fleetd isn't on this shell's PATH yet: ${PATH_LINE}`);
  if (list.failures().length > 0) {
    list.outro(needs, "Fix those, then run fleetd init again; it keeps what's done.");
    return;
  }
  if (list.todos.length > 0) {
    list.outro(needs, "Then run fleetd init again; it keeps what's done.");
    return;
  }
  const lines: string[] = [];
  if (summary.hub) lines.push(`workspace ${summary.hub}`);
  if (summary.workers.length > 0) lines.push(`workers   ${summary.workers.join(", ")}`);
  if (summary.project) lines.push(`bot       ${summary.project}`);
  if (summary.pairing) lines.push(`app       ${summary.pairing}`);
  if (which("fleetd") === undefined) lines.push(`PATH      add: ${PATH_LINE}`);
  if (list.rich) list.boxed("fleetd is ready", lines.join("\n"));
  else {
    process.stderr.write("\nfleetd is ready\n");
    for (const l of lines) process.stderr.write(`  ${l}\n`);
  }
  const [installed] = appHint();
  const next = installed
    ? paired
      ? "Next: open the fleetd app; it connects by itself, then send your first order."
      : "Next: run fleetd pair, then open the fleetd app."
    : `Next: get the fleetd app (${INSTALLER}) and enter the code.`;
  list.outro([], next);
}

/** The hub machine's setup, from where it listens to the summary. */
export async function hubSteps(opts: InitOptions, ui: Ui, list: Checklist): Promise<number> {
  const net = await tailnet();
  const [listen, url] = await reachability(opts, ui, list, net, await lanIpv4());
  const summary: Summary = { hub: url, workers: [] };
  list.sectionHeader("Logins");
  // A hub set up before may hold a Claude account of its own: then no machine needs claude logged in.
  const account = opts.previous === undefined ? undefined : hubClaudeAccount(opts.home);
  const claudeHere = await hubClaude(ui, list, account);
  const ghOk = await ghCheck(ui, list);
  const identity = await commitIdentity(opts, ui, list, ghOk);
  list.sectionHeader("Workspace");
  list.start("Starting the workspace");
  let hubUp = false;
  try {
    const how = await installHub(
      { home: opts.home, listen, url, ...(identity ? { identity } : {}), withService: opts.withService, restart: false },
      () => {},
    );
    if (how.startsWith("not started")) {
      list.todo(
        "workspace",
        "not started (--no-service)",
        "start the workspace, then run fleetd init again",
        `fleetd workspace start --home ${q(opts.home)} --listen ${listen}`,
      );
    } else {
      list.done("workspace", how.replace(" and answers at ", " · "));
      hubUp = true;
    }
  } catch (f) {
    if (!isFailure(f)) throw f;
    list.failed("workspace", f.message, f.fix);
  }
  let added: string[] = [];
  let idle: string[] = [];
  list.sectionHeader("Workers");
  if (hubUp) {
    const [local, ids, byHand] = await workers(opts, ui, list, net, claudeHere, account);
    summary.workers = [...ids, ...byHand];
    [added, idle] = [ids, byHand];
    list.sectionHeader("Bot");
    const project = await firstProject(opts, ui, list, local, ghOk);
    if (project !== undefined) summary.project = project;
  } else {
    list.skipped("workers", "need the workspace running");
    list.sectionHeader("Bot");
    list.skipped("project", "needs the workspace running");
  }
  list.sectionHeader("App & setup");
  const paired = await app(opts, ui, list, summary);
  if (hubUp) {
    await awaitRunnerChecks(opts, list, added);
    await setupSteps(opts, ui, list, idle);
  }
  finish(list, summary, paired);
  return list.failures().length > 0 ? 1 : 0;
}
