// `fleetd project add|list|stop|remove|set|profiles|repo` and `fleetd machine set`:
// the hub's add-a-project service (project_discover and project_add) from a terminal, a project's or the fleet's
// settings, and a project's repos.
import { readFileSync } from "node:fs";
import { normalize, resolve as resolvePath } from "node:path";
import { ArgError, parse, type Parsed } from "./args.ts";
import { clientRequestId, homeDir, isTty, ioMessage, println, readSetup, resolveHome, s, tilde } from "./common.ts";
import type { McpClient } from "./mcp_client.ts";
import { call, Out, Stop } from "./out.ts";
import { connectTo, connectWith } from "./setup/doctor.ts";
import { isFailure } from "./setup/steps.ts";
import { humanKeyRequired } from "./steer.ts";
import * as tty from "./tty.ts";
import { PROJECT_USAGE, MACHINE_SET_USAGE } from "./usages.ts";
export { PROJECT_USAGE, MACHINE_SET_USAGE };


const SPEC = {
  options: {
    machine: "str",
    title: "str",
    dest: "str",
    "use-existing": "bool",
    yes: "bool",
    hub: "str",
    "max-agents": "str",
    "pause-extras": "bool",
    "fleet-cap": "str",
    "key-file": "str",
    profiles: "str",
    model: "str",
    effort: "str",
    fast: "str",
    note: "str",
    rename: "str",
    default: "bool",
    lead: "bool",
    delete: "bool",
    name: "str",
    new: "str",
    "git-init": "bool",
    archived: "bool",
  },
  positionals: true,
} as const;

/** A clone reports each phase and every 5 percent; this long without a word, it is not coming. */
const QUIET_LIMIT_MS = 20 * 60_000;
const FOLDER_NEEDS =
  "a plain folder with no git: its lead chats, remembers and uses screens here; agents that change code need a git repo";

function usage(message: string): number {
  process.stderr.write(`fleetd: ${message}\n\nusage:\n${PROJECT_USAGE}`);
  return 2;
}

// ---- what a person gives ----

function shortRemote(raw: string): string {
  let url = raw.trim().replace(/\/+$/, "");
  if (url.endsWith(".git")) url = url.slice(0, -4);
  if (url.startsWith("git@")) {
    const rest = url.slice(4);
    const colon = rest.indexOf(":");
    if (colon >= 0) return `${rest.slice(0, colon)}/${rest.slice(colon + 1)}`;
  }
  for (const scheme of ["https://", "http://", "ssh://git@", "ssh://", "git://"]) {
    if (url.startsWith(scheme)) {
      const rest = url.slice(scheme.length);
      const at = rest.lastIndexOf("@");
      return at < 0 ? rest : rest.slice(at + 1);
    }
  }
  return url;
}

/** The GitHub repository in what a person pastes: a URL, `github.com/o/r`, `git@github.com:o/r.git` or `o/r`. */
export function githubRepo(raw: string): string | undefined {
  const text = raw.trim();
  const short = shortRemote(text);
  let path: string | undefined;
  for (const prefix of ["github.com/", "www.github.com/"]) {
    if (short.startsWith(prefix)) {
      path = short.slice(prefix.length).split("/").slice(0, 2).join("/");
      break;
    }
  }
  if (path === undefined && !text.includes(":") && !text.includes(".") && !text.startsWith("/")) path = short;
  if (path === undefined) return undefined;
  if (path.endsWith(".git")) path = path.slice(0, -4);
  const m = /^([A-Za-z0-9][A-Za-z0-9-]{0,38})\/([A-Za-z0-9._-]{1,100})$/.exec(path);
  return m && m[2] !== "." && m[2] !== ".." ? path : undefined;
}

export type AddSource = { path: string } | { github: string };

/** A path when it looks like one (`/`, `~`, `.`), else a GitHub repository, else neither. */
export function addSource(raw: string): AddSource | undefined {
  const text = raw.trim();
  if (text === "") return undefined;
  if (/^[/~.]/.test(text)) return { path: text };
  const repo = githubRepo(text);
  return repo === undefined ? undefined : { github: repo };
}

/** `~/x` against `home`, `x` and `./x` against `cwd`; `/x` as given. No trailing `/`. */
export function resolveUserPath(text: string, cwd: string, home: string): string {
  const path = text === "~" ? home : text.startsWith("~/") ? `${home}/${text.slice(2)}` : resolvePath(cwd, text);
  const out = normalize(path);
  return out.length > 1 ? out.replace(/\/+$/, "") : out;
}

/** This machine's host name: /etc/hostname, else `hostname -s`. */
export function localHostName(): string {
  try {
    const name = readFileSync("/etc/hostname", "utf8").trim();
    if (name) return name;
  } catch {}
  const out = Bun.spawnSync(["hostname", "-s"], { stderr: "ignore" }).stdout.toString().trim();
  return out || "this-machine";
}

/** A machine id from a host name: its first label, lowercased, other characters as single `-`. */
export function machineIdFromHost(host: string): string {
  const h = host.split("@").pop() ?? host;
  const label = (h.split(".")[0] ?? h).toLowerCase();
  let id = "";
  let replacing = false;
  for (const c of label) {
    if (/[a-z0-9-]/.test(c)) {
      id += c;
      replacing = false;
    } else if (!replacing) {
      id += "-";
      replacing = true;
    }
  }
  return [...id.replace(/^-+|-+$/g, "")].slice(0, 32).join("");
}

/** This machine's id: the one `fleetd init` set up here, else the one its host name gives. */
function localMachine(home: string): string {
  try {
    const setup = readSetup(home);
    const local = setup && Object.entries(setup.machines).find(([, m]) => m.local);
    if (local) return local[0];
  } catch {}
  return machineIdFromHost(localHostName());
}

/** The inspect, as a few lines for a person. */
function describe(inspect: any): string {
  const list = (key: string[]) => {
    let at = inspect;
    for (const k of key) at = at?.[k];
    if (!Array.isArray(at)) return undefined;
    const names = at.filter((n) => typeof n === "string") as string[];
    const shown = names.slice(0, 6).join(", ");
    const text = names.length > 6 ? `${shown} and ${names.length - 6} more` : shown;
    return text === "" ? undefined : text;
  };
  const lines = [`Lead needs: ${s(inspect, "/leadNeeds")}`];
  if (s(inspect, "/leadNeeds") === FOLDER_NEEDS) return lines.join("\n");
  if (typeof inspect?.defaultBranch === "string") lines.push(`Default branch: ${inspect.defaultBranch}`);
  lines.push(
    `CI: ${list(["ci", "workflows"]) ?? "none"}; required checks: ${list(["ci", "requiredChecks"]) ?? "none"}`,
  );
  const squashAllowed = inspect?.merge?.squashAllowed;
  const squash = squashAllowed === true ? "squash allowed" : squashAllowed === false ? "squash OFF" : "squash unknown";
  const protectedWord = inspect?.merge?.protected === true ? "protected" : "unprotected";
  const rulesets = list(["merge", "rulesets"]);
  lines.push(`Merge: ${protectedWord}, ${squash}${rulesets === undefined ? "" : `, rulesets: ${rulesets}`}`);
  for (const note of Array.isArray(inspect?.notes) ? inspect.notes : []) {
    lines.push(`Note: ${typeof note === "string" ? note : ""}`);
  }
  return lines.join("\n");
}

const VERBS = ["add", "list", "remove", "archive", "unarchive", "stop", "set", "profiles", "profile", "repo"];

export async function projectCommand(argv: string[]): Promise<number> {
  const verb = argv[0];
  if (verb === undefined) return usage("missing project command");
  if (!VERBS.includes(verb)) return usage(`unknown project command '${verb}'`);
  const v = parse(argv.slice(1), SPEC);
  if (v instanceof ArgError) return usage(v.message);
  const home = resolveHome();
  const out = new Out(isTty() && !v.flag("yes"));
  const keyFile = v.str("key-file") || undefined;
  let client: McpClient;
  try {
    if (verb === "stop" && keyFile === undefined) return usage(humanKeyRequired("a stop"));
    if (verb === "profile" && keyFile === undefined) return usage(humanKeyRequired("a profile change"));
    if (verb === "stop" || verb === "profile") {
      let key: string;
      try {
        key = readFileSync(keyFile!, "utf8").trim();
      } catch (error) {
        return out.fail(new Stop(3, `cannot read --key-file: ${ioMessage(error)}`));
      }
      client = await connectWith(home, v.str("hub"), "fleetd-project", key);
    } else if (keyFile !== undefined) {
      return usage("--key-file is for project stop and project profile");
    } else {
      client = await connectTo(home, v.str("hub"), "fleetd-project");
    }
  } catch (f) {
    if (isFailure(f)) return out.fail(new Stop(4, f.message, f.fix));
    throw f;
  }
  try {
    switch (verb) {
      case "add":
        await add(client, out, v, home);
        break;
      case "list":
        await list(client, v);
        break;
      case "remove":
        await remove(client, out, v);
        break;
      case "archive":
      case "unarchive":
        await archive(client, out, v, verb === "archive");
        break;
      case "stop":
        await stop(client, out, v);
        break;
      case "set":
        await set(client, out, v);
        break;
      case "profiles":
        await profiles(client, v);
        break;
      case "profile":
        await profile(client, out, v);
        break;
      default:
        await repo(client, out, v);
    }
    return 0;
  } catch (error) {
    if (error instanceof tty.Cancelled) return out.fail(new Stop(1, "stopped"));
    if (!(error instanceof Stop)) throw error;
    return error.code === 2 ? usage(error.message) : out.fail(error);
  }
}

async function list(client: McpClient, v: Parsed) {
  const body = await call(client, "project_get", { machineId: v.str("machine") ?? null });
  const projects: any[] = Array.isArray(body?.projects) ? body.projects : [];
  const archived = v.flag("archived");
  const shown = projects.filter((p) => archived || p.archivedAt === undefined);
  if (projects.length === 0) println("No projects yet: fleetd project add <path|github-url>");
  else if (shown.length === 0) println("Every project is archived: fleetd project list --archived shows them");
  for (const p of shown) {
    const arch = p.archivedAt !== undefined ? "  (archived)" : "";
    println(
      `${s(p, "/machineId")}/${s(p, "/projectId")}  ${s(p, "/title")}  ${tilde(s(p, "/workspaceRoot"))}${arch}`,
    );
  }
}

async function archive(client: McpClient, out: Out, v: Parsed, archived: boolean) {
  const [machine, project] = await find(client, v);
  await call(client, "project_archive", { machineId: machine, projectId: s(project, "/projectId"), archived });
  const title = s(project, "/title");
  out.success(
    archived
      ? `${title} is archived; its chat, memory and folder stay`
      : `${title} is back; its lead starts with your next message`,
  );
}

async function stop(client: McpClient, out: Out, v: Parsed) {
  const [machine, project] = await find(client, v);
  const title = s(project, "/title");
  if (out.tty) {
    const sure = await tty
      .confirm(`Stop everything in ${title} on ${machine}? The lead's turn and its agents stop; the lead stays.`, false)
      .catch(() => false);
    if (!sure) return;
  }
  const body = await call(client, "chat_stop", {
    projectRef: { machineId: machine, projectId: s(project, "/projectId") },
    clientRequestId: clientRequestId(),
  });
  out.success(`${title}: ${s(body, "/message/text")}`);
}

const find = (client: McpClient, v: Parsed) => findTarget(client, v.positionals[0]);

/** The project a `<machine>/<project id or title>` argument names. */
async function findTarget(client: McpClient, target: string | undefined): Promise<[string, any]> {
  if (target === undefined) throw new Stop(2, "give the project as <machine>/<project id or title>");
  const slash = target.indexOf("/");
  if (slash < 0) throw new Stop(2, `'${target}' is not <machine>/<project>`);
  const [machine, which] = [target.slice(0, slash), target.slice(slash + 1)];
  const body = await call(client, "project_get", { machineId: machine });
  const projects: any[] = Array.isArray(body?.projects) ? body.projects : [];
  const byTitle = projects.filter((p) => s(p, "/title") === which);
  const found = projects.find((p) => s(p, "/projectId") === which) ?? (byTitle.length === 1 ? byTitle[0] : undefined);
  if (found === undefined) {
    throw new Stop(3, `no single project '${which}' on ${machine}`, `fleetd project list --machine ${machine} shows their ids`);
  }
  return [machine, found];
}

async function remove(client: McpClient, out: Out, v: Parsed) {
  const [machine, project] = await find(client, v);
  const title = s(project, "/title");
  if (out.tty) {
    const sure = await tty
      .confirm(
        `Remove ${title} on ${machine}? Its agents stop and its chat, memory, skills and orders are erased; its files stay.`,
        false,
      )
      .catch(() => false);
    if (!sure) return;
  }
  await call(client, "project_remove", { machineId: machine, projectId: s(project, "/projectId") });
  out.success(`${title} removed from ${machine} and erased; its files, branches and worktrees stay`);
}

const NEITHER = (text: string) =>
  `'${text}' is neither a path (/…, ~/…, ./…) nor a GitHub repo (https://github.com/owner/repo)`;

async function repo(client: McpClient, out: Out, v: Parsed) {
  const sub = v.positionals[0];
  if (sub !== "add" && sub !== "list" && sub !== "remove") throw new Stop(2, "give project repo add, list or remove");
  const [machine, project] = await findTarget(client, v.positionals[1]);
  const title = s(project, "/title");
  const at = { machineId: machine, projectId: s(project, "/projectId") };
  const arg = v.positionals[2];
  if (sub === "list") {
    const body = await call(client, "project_repo_list", at);
    const repos: any[] = Array.isArray(body?.repos) ? body.repos : [];
    if (repos.length === 0) {
      println(`${title} holds no repo, a plain folder: fleetd project repo add ${machine}/${title} <path|github-url>`);
    }
    for (const r of repos) {
      const [key, base] = [s(r, "/repoKey"), s(r, "/base")];
      const lands = key === "" ? "no remote" : base === "" ? key : `${key} on ${base}`;
      println(`${s(r, "/name")}  ${tilde(s(r, "/path"))}  ${lands}`);
    }
    return;
  }
  if (sub === "add") {
    if (arg === undefined) throw new Stop(2, "give the repo as a path or a GitHub URL");
    const input: Record<string, unknown> = { ...at, name: v.str("name") ?? null };
    const source = addSource(arg);
    if (source === undefined) throw new Stop(2, NEITHER(arg));
    if ("path" in source) input.path = resolveUserPath(source.path, process.cwd(), homeDir());
    else {
      input.url = arg;
      input.dest = v.str("dest") ?? null;
      if (v.flag("use-existing")) input.useExisting = true;
    }
    const head = await call(client, "events_wait", { timeoutSec: 0 });
    const cursor = head?.cursor ?? 0;
    const added = await call(client, "project_repo_add", input);
    if (typeof added?.addId === "string") {
      await followClone(client, out, machine, s(added, "/path"), added.addId, cursor);
      out.success(`added to ${title}`);
      return;
    }
    out.success(`${s(added, "/repo/name")} added to ${title}`);
    if (added?.archived !== undefined) out.info(s(added, "/next"));
    return;
  }
  if (arg === undefined) throw new Stop(2, "give the repo's name (fleetd project repo list shows them)");
  if (out.tty) {
    const sure = await tty.confirm(`Remove ${arg} from ${title}? Its agents stop; its files stay.`, false).catch(() => false);
    if (!sure) return;
  }
  const body = await call(client, "project_repo_remove", { ...at, name: arg });
  out.success(`${arg} removed from ${title}`);
  out.info(s(body, "/next"));
}

function countOf(v: Parsed, name: string): number | undefined {
  const n = v.str(name);
  if (n === undefined) return undefined;
  const parsed = /^\+?[0-9]+$/.test(n) ? Number(n) : NaN;
  if (!(parsed >= 1 && parsed <= 1000)) {
    throw new Stop(2, `--${name} takes a number from 1 to 1000${name === "max-agents" ? " or default" : ""}`);
  }
  return parsed;
}

/** The hub's profiles for a person, a line each, and with a project's allowed list, which it allows. */
export function profilesLines(view: any): string[] {
  const allowed: string[] | undefined = Array.isArray(view?.allowed)
    ? view.allowed.filter((a: unknown) => typeof a === "string")
    : undefined;
  const lines: string[] = [];
  for (const p of Array.isArray(view?.profiles) ? view.profiles : []) {
    const name = s(p, "/name");
    const marks: string[] = [];
    if (p.default === true) marks.push("default");
    if (p.lead === true) marks.push("lead");
    if (p.fast === true) marks.push("fast");
    if (allowed) marks.push(allowed.includes(name) ? "allowed" : "not allowed");
    const m = marks.length === 0 ? "" : ` (${marks.join(", ")})`;
    lines.push(`${padEnd(name, 10)} ${s(p, "/model")} at ${s(p, "/effort")}${m}`);
    const note = s(p, "/note");
    if (note !== "") lines.push(`           ${note}`);
    if (typeof p.refused === "string") lines.push(`           ! ${p.refused}`);
  }
  return lines;
}

/** `format!("{x:<w$}")`: pads by characters. */
export const padEnd = (text: string, width: number) => text + " ".repeat(Math.max(0, width - [...text].length));
export const padStart = (text: string, width: number) => " ".repeat(Math.max(0, width - [...text].length)) + text;

async function profiles(client: McpClient, v: Parsed) {
  const input: Record<string, unknown> = {};
  if (v.positionals.length > 0) {
    const [machine, project] = await find(client, v);
    input.projectRef = { machineId: machine, projectId: s(project, "/projectId") };
  }
  for (const line of profilesLines(await call(client, "profiles_list", input))) println(line);
}

/** profile_create's or profile_update's input from the flags: `id` updates that profile, none creates `name`. */
export function profileInput(
  name: string,
  id: number | undefined,
  flags: [string, string][],
  isDefault: boolean,
  lead: boolean,
): Record<string, unknown> {
  const input: Record<string, unknown> = id === undefined ? { name } : { id };
  for (const [flag, value] of flags) {
    if (flag === "model" || flag === "note") input[flag] = value;
    else if (flag === "rename") input.name = value;
    else if (flag === "effort") {
      if (!["low", "medium", "high", "xhigh", "max"].includes(value)) {
        throw new ArgError(`--effort takes low, medium, high, xhigh or max, got '${value}'`);
      }
      input.effort = value;
    } else if (flag === "fast") {
      if (value !== "on" && value !== "off") throw new ArgError(`--fast takes on or off, got '${value}'`);
      input.fast = value === "on";
    }
  }
  if (isDefault) input.default = true;
  if (lead) input.lead = true;
  if (id === undefined) {
    if (input.model === undefined || input.effort === undefined) {
      throw new ArgError(`a new profile ${name} needs --model and --effort`);
    }
    if (input.note === undefined) input.note = "";
  }
  return input;
}

async function profile(client: McpClient, out: Out, v: Parsed) {
  const name = v.positionals[0];
  if (name === undefined) throw new Stop(2, "give the profile's name");
  const view = await call(client, "profiles_list", {});
  const found = (Array.isArray(view?.profiles) ? view.profiles : []).find((p: any) => p?.name === name);
  const id = typeof found?.id === "number" ? (found.id as number) : undefined;
  let body;
  if (v.flag("delete")) {
    if (id === undefined) throw new Stop(2, `no profile is named ${name}`);
    body = await call(client, "profile_delete", { id });
  } else {
    const flags = (["model", "effort", "fast", "note", "rename"] as const)
      .map((f) => [f, v.str(f)] as [string, string | undefined])
      .filter((f): f is [string, string] => f[1] !== undefined);
    let input;
    try {
      input = profileInput(name, id, flags, v.flag("default"), v.flag("lead"));
    } catch (error) {
      throw new Stop(2, (error as Error).message);
    }
    body = await call(client, id === undefined ? "profile_create" : "profile_update", input);
  }
  out.success(typeof body?.next === "string" ? body.next : "Done.");
}

async function set(client: McpClient, out: Out, v: Parsed) {
  const profilesFlag = v.str("profiles");
  const allowed =
    profilesFlag === undefined
      ? undefined
      : profilesFlag
          .split(",")
          .map((p) => p.trim())
          .filter((p) => p !== "" && p !== "none");
  // null: back to its machine's cap within the fleet cap.
  const maxAgents: number | null | undefined = v.str("max-agents") === "default" ? null : countOf(v, "max-agents");
  const fleetCap = countOf(v, "fleet-cap");
  if (allowed !== undefined) {
    const [machine, project] = await find(client, v);
    const body = await call(client, "project_set", {
      machineId: machine,
      projectId: s(project, "/projectId"),
      profiles: allowed,
    });
    out.success(typeof body?.next === "string" ? body.next : "Set.");
    if (maxAgents === undefined && fleetCap === undefined) return;
  }
  const input: Record<string, any> = {};
  if (fleetCap !== undefined) input.cap = fleetCap;
  const target = v.positionals[0];
  if (target !== undefined && maxAgents !== undefined) {
    const [machine, project] = await find(client, v);
    input.project = {
      projectRef: { machineId: machine, projectId: s(project, "/projectId") },
      pauseExtras: v.flag("pause-extras"),
    };
    if (maxAgents === null) input.project.followDefault = true;
    else input.project.maxAgents = maxAgents;
  } else if (target !== undefined) {
    if (allowed === undefined) throw new Stop(2, "give --max-agents <n> or --profiles <names> for the project");
  } else if (maxAgents !== undefined) {
    throw new Stop(2, "--max-agents needs the project as <machine>/<project>");
  } else if (fleetCap === undefined) {
    throw new Stop(2, "give --max-agents <n> or --profiles <names> with a project, or --fleet-cap <n>");
  }
  const body = await call(client, "cap_set", input);
  out.success(typeof body?.next === "string" ? body.next : "Set.");
}

// ---- machine set ----


function machineUsage(message: string): number {
  process.stderr.write(`fleetd: ${message}\n\nusage:\n${MACHINE_SET_USAGE}`);
  return 2;
}

/** `machine_roles_set`'s input from `--roles` and `--max-sessions`; undefined when neither is given. */
export function rolesInput(machine: string, roles?: string, maxSessions?: string): Record<string, unknown> | undefined {
  if (roles === undefined && maxSessions === undefined) return undefined;
  const input: Record<string, unknown> = { machineId: machine };
  if (roles !== undefined) {
    const list: string[] = [];
    for (const role of roles.split(",").map((r) => r.trim()).filter(Boolean)) {
      if (role !== "agents" && role !== "sessions") {
        throw new ArgError(`--roles takes agents, sessions or both (agents,sessions), not ${role}`);
      }
      if (!list.includes(role)) list.push(role);
    }
    if (list.length === 0) throw new ArgError("--roles takes agents, sessions or both (agents,sessions)");
    input.roles = list;
  }
  if (maxSessions === "auto") input.autoSessions = true;
  else if (maxSessions !== undefined) {
    const n = /^[+-]?[0-9]+$/.test(maxSessions) ? Number(maxSessions) : NaN;
    if (!(n >= 1 && n <= 64)) throw new ArgError("--max-sessions takes a number from 1 to 64 or auto");
    input.maxSessions = n;
  }
  return input;
}

function rolesLine(machine: any): string {
  const roles = (Array.isArray(machine?.roles) ? machine.roles : [])
    .filter((r: unknown) => typeof r === "string")
    .map((r: string) => (r === "sessions" ? "screens" : r));
  const n = (k: string) => (typeof machine?.[k] === "number" ? machine[k] : 0);
  return `${s(machine, "/machineId")}: ${roles.join(" and ")}, ${n("sessionsLive")} of ${n("maxSessions")} screens (${s(machine, "/maxSessionsWhy")}).`;
}

export async function machineSetCommand(argv: string[]): Promise<number> {
  const v = parse(argv, {
    options: { "max-agents": "str", roles: "str", "max-sessions": "str", hub: "str" },
    positionals: true,
  });
  if (v instanceof ArgError) return machineUsage(v.message);
  if (v.positionals.length !== 1) {
    return machineUsage(
      "give the machine's id: fleetd machine set <id> --max-agents <n>|auto or --roles agents,sessions",
    );
  }
  const machine = v.positionals[0]!;
  let roles;
  try {
    roles = rolesInput(machine, v.str("roles"), v.str("max-sessions"));
  } catch (error) {
    return machineUsage((error as Error).message);
  }
  let input: Record<string, any> | undefined = { machine: { machineId: machine } };
  const max = v.str("max-agents");
  if (max === undefined) {
    if (roles === undefined) return machineUsage("give --max-agents <n>|auto, --roles or --max-sessions");
    input = undefined;
  } else if (max === "auto") input.machine.auto = true;
  else {
    try {
      input.machine.maxAgents = countOf(v, "max-agents");
    } catch {
      return machineUsage("--max-agents takes a number from 1 to 1000 or auto");
    }
  }
  const home = resolveHome();
  const out = new Out(isTty());
  let client;
  try {
    client = await connectTo(home, v.str("hub"), "fleetd-machine");
  } catch (f) {
    if (isFailure(f)) return out.fail(new Stop(4, f.message, f.fix));
    throw f;
  }
  try {
    if (input !== undefined) {
      const body = await call(client, "cap_set", input);
      out.success(typeof body?.next === "string" ? body.next : "Set.");
    }
    if (roles !== undefined) {
      const body = await call(client, "machine_roles_set", roles);
      const line = body?.machine !== undefined ? rolesLine(body.machine) : "";
      out.success(typeof body?.next === "string" ? `${line} ${body.next}` : line);
    }
  } catch (error) {
    if (error instanceof Stop) return out.fail(error);
    throw error;
  }
  return 0;
}

// ---- add ----

type Pick = { path: string; machine: string } | { url: string };

async function pick(client: McpClient, out: Out, machine: string | undefined): Promise<Pick> {
  const spinner = tty.spinner();
  spinner.start("Looking for repos on your machines and GitHub…");
  let found;
  try {
    found = await call(client, "project_discover", { machineId: machine ?? null });
  } finally {
    spinner.stop("Found");
  }
  const items: tty.Item<Pick | "paste">[] = [];
  for (const m of Array.isArray(found?.machines) ? found.machines : []) {
    const id = s(m, "/machineId");
    for (const r of Array.isArray(m.repos) ? m.repos : []) {
      if (r.projectId !== undefined) continue;
      items.push({
        value: { machine: id, path: s(r, "/path") },
        label: s(r, "/name"),
        hint: `${id} · ${tilde(s(r, "/path"))} · ${s(r, "/remote")}`,
      });
    }
    if (m.problem !== undefined) out.info(`${id}: ${s(m.problem, "/message")}`);
  }
  const github = found?.github ?? {};
  for (const r of Array.isArray(github.repos) ? github.repos : []) {
    if (Array.isArray(r.checkouts) && r.checkouts.length > 0) continue;
    const priv = r.private === true ? "private · " : "";
    items.push({ value: { url: s(r, "/url") }, label: s(r, "/repo"), hint: `clone · ${priv}gh on ${s(github, "/ghOn")}` });
  }
  if (github.problem !== undefined) out.info(`${s(github.problem, "/message")} (${s(github.problem, "/fix")})`);
  items.push({ value: "paste", label: "Paste a GitHub URL", hint: "or owner/repo" });
  const choice = await tty.select("Which repo?", items);
  if (choice !== "paste") return choice;
  const url = await tty.input("GitHub repo", {
    placeholder: "https://github.com/owner/repo",
    validate: (t) => {
      const src = addSource(t);
      return src && "github" in src ? undefined : "a GitHub URL or owner/repo";
    },
  });
  return { url };
}

async function add(client: McpClient, out: Out, v: Parsed, home: string) {
  if (out.tty) tty.intro("Add a project");
  const givenMachine = v.str("machine");
  const newName = v.str("new");
  if (newName !== undefined) return addNew(client, out, v, newName, givenMachine);
  const text = v.positionals[0];
  let picked: Pick;
  if (text !== undefined) {
    const source = addSource(text);
    if (source === undefined) throw new Stop(2, NEITHER(text));
    picked =
      "path" in source
        ? { machine: givenMachine ?? localMachine(home), path: resolveUserPath(source.path, process.cwd(), homeDir()) }
        : { url: text };
  } else if (out.tty) {
    picked = await pick(client, out, givenMachine);
  } else {
    throw new Stop(2, "give a path or a GitHub URL (or run it in a terminal to pick one)");
  }
  const input: Record<string, unknown> = { title: v.str("title") ?? null };
  if ("path" in picked) {
    input.machineId = picked.machine;
    input.path = picked.path;
  } else {
    input.url = picked.url;
    input.dest = v.str("dest") ?? null;
    if (givenMachine !== undefined) input.machineId = givenMachine;
    const preview = await call(client, "project_add", { ...input, dryRun: true });
    const target = preview?.clone ?? {};
    const [machine, dest] = [s(target, "/machineId"), s(target, "/path")];
    if (machine !== "") input.machineId = machine;
    if (out.tty) out.info(describe(preview?.inspect ?? null));
    const same = target.sameRemote === true;
    if (v.flag("use-existing")) input.useExisting = true;
    else if (same && v.str("dest") === undefined) {
      if (!out.tty) {
        throw new Stop(
          3,
          `${machine} already has it at ${dest}`,
          "Pass --use-existing to add that checkout, or --dest <dir> to clone elsewhere",
        );
      }
      const useIt = await tty.confirm(`${machine} already has it at ${tilde(dest)}. Add that checkout?`, true).catch(() => false);
      if (!useIt) throw new Stop(1, "not added", "Clone somewhere else with --dest <dir>");
      input.useExisting = true;
    } else if (out.tty && dest !== "") {
      const go = await tty.confirm(`Clone into ${tilde(dest)} on ${machine}?`, true).catch(() => false);
      if (!go) return;
    }
  }
  const head = await call(client, "events_wait", { timeoutSec: 0 });
  const cursor = head?.cursor ?? 0;
  const added = await call(client, "project_add", input);
  const machine = s(added, "/machineId");
  const path = s(added, "/path");
  if (typeof added?.addId !== "string") {
    out.success(`${tilde(path)} on ${machine} ${added?.created === true ? "added" : "is already a project"}`);
    out.info(describe(added?.inspect ?? null));
    return finish(out);
  }
  const event = await followClone(client, out, machine, path, added.addId, cursor);
  out.info(describe(event?.data?.inspect ?? null));
  finish(out);
}

async function addNew(client: McpClient, out: Out, v: Parsed, name: string, machine: string | undefined) {
  const input: Record<string, unknown> = { create: true, title: name };
  if (machine !== undefined) input.machineId = machine;
  const dest = v.str("dest");
  if (dest !== undefined) {
    if (!dest.startsWith("/")) {
      throw new Stop(
        2,
        `--dest ${dest} is not a full path on the machine`,
        "Give it starting with /, or leave it out for ~/fleetd/projects/<name>",
      );
    }
    input.path = dest;
  }
  if (v.flag("git-init")) input.gitInit = true;
  const added = await call(client, "project_add", input);
  out.success(`${name} made at ${tilde(s(added, "/path"))} on ${s(added, "/machineId")}`);
  out.info(describe(added?.inspect ?? null));
  finish(out);
}

/** Follows a clone's events to its `project.added`; its `project.add_failed` stops. */
async function followClone(
  client: McpClient,
  out: Out,
  machine: string,
  path: string,
  addId: string,
  cursor: unknown,
): Promise<any> {
  const bar = out.tty ? tty.progressBar(100) : undefined;
  bar?.start(`Cloning into ${tilde(path)} on ${machine}`);
  if (!out.tty) println(`cloning into ${path} on ${machine}`);
  let lastPhase = "";
  let heard = Date.now();
  for (;;) {
    if (Date.now() - heard > QUIET_LIMIT_MS) {
      bar?.error("no word from the clone");
      throw new Stop(
        1,
        `no progress from the clone on ${machine} for ${QUIET_LIMIT_MS / 60_000} minutes`,
        `fleetd project list --machine ${machine} shows whether it was added; else add it again`,
      );
    }
    const page = await call(client, "events_wait", {
      cursor,
      timeoutSec: 50,
      machineId: machine,
      types: ["project.clone_progress", "project.added", "project.add_failed"],
    });
    cursor = page?.cursor ?? cursor;
    for (const e of Array.isArray(page?.events) ? page.events : []) {
      if (s(e, "/data/addId") !== addId) continue;
      heard = Date.now();
      const type = s(e, "/type");
      if (type === "project.clone_progress") {
        const phase = s(e, "/data/phase").replaceAll("_", " ");
        const pct = typeof e.data?.percent === "number" ? e.data.percent : undefined;
        if (bar) {
          bar.setPosition(pct ?? 0);
          bar.setMessage(`${phase} ${s(e, "/data/detail")}`);
        } else if (phase !== lastPhase) println(`  ${phase}`);
        lastPhase = phase;
      } else if (type === "project.added") {
        const done = `${tilde(path)} cloned and added on ${machine}`;
        if (bar) bar.stop(done);
        else println(`✓ ${done}`);
        return e;
      } else {
        bar?.error("clone failed");
        throw new Stop(1, s(e, "/data/message"), typeof e.data?.fix === "string" ? e.data.fix : undefined);
      }
    }
  }
}

function finish(out: Out) {
  const next =
    "Write to its lead in the app's chat, or from any agent with chat_send; the lead starts with the first message.";
  if (out.tty) tty.outro(next);
  else println(next);
}
