// `fleetd init`'s guided setup: a checklist of steps, each a question at a
// terminal or its default without one (or with --yes). Ported: a worker joining a hub (`--join … --code …`, the line
// `fleetd pair --worker` prints) and a joined worker run again, which keeps its enrolment and repairs what it runs.
// The hub's own setup (where it listens, its logins, workers, a first project, the app) is listed in PORT_MAP.md.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { NotImplemented } from "../../shared/errors.ts";
import { fleetdDir } from "../../shared/home.ts";
import { type GitIdentity, isMachineId, parseGitIdentity, type SetupState } from "../common.ts";
import { localHostName, machineIdFromHost } from "../project.ts";
import * as tty from "../tty.ts";
import { Checklist } from "./checklist.ts";
import { type Added, Stop, join as joinHubAs, localArgs } from "./machine.ts";
import { loginCommand, loginStatusCommand } from "./machine_plan.ts";
import { capture, localDirs, release } from "./shared.ts";
import { runAttached, runSsh } from "./ssh.ts";
import { q } from "./units.ts";

const AGAIN = "Run fleetd init to continue; it keeps what's done.";
/** A join that stopped before it enrolled: a plain `fleetd init` would ask what this machine is, as on a new one. */
const JOIN_AGAIN = "Then run the join command its fix names: a plain fleetd init doesn't keep the hub or the code.";

export type InitOptions = {
  home: string;
  previous?: SetupState;
  listen?: string;
  url?: string;
  identity?: GitIdentity;
  withService: boolean;
  yes: boolean;
  join?: [string, string];
  machineId?: string;
  rejoin: boolean;
  mac: boolean;
  claudeConfigDir?: string;
  step?: string;
};

/** The person pressed Esc or Ctrl-C at a prompt. */
export class Stopped extends Error {}

/** Prompts, one at a time. Without a terminal (or with --yes) each answers its default. */
export class Ui {
  constructor(readonly interactive: boolean) {}
  async confirm(list: Checklist, prompt: string, fallback: boolean): Promise<boolean> {
    if (!this.interactive) return fallback;
    list.stopSpinner();
    try {
      return await tty.confirm(prompt, fallback);
    } catch {
      throw new Stopped();
    } finally {
      list.prompted();
    }
  }
  /** Whether to run something interactive now (a login): only when a person is at the terminal and says yes. */
  offerToRun(list: Checklist, prompt: string): Promise<boolean> {
    return this.interactive ? this.confirm(list, prompt, true) : Promise.resolve(false);
  }
  async input(list: Checklist, prompt: string, fallback: string, placeholder: string, check: (s: string) => string | undefined): Promise<string> {
    if (!this.interactive) return fallback;
    list.stopSpinner();
    try {
      const answer = await tty.input(prompt, {
        ...(fallback !== "" ? { initial: fallback } : placeholder !== "" ? { placeholder } : {}),
        validate: (s) => check(s.trim()),
      });
      return answer.trim();
    } catch {
      throw new Stopped();
    } finally {
      list.prompted();
    }
  }
  async multi<T>(list: Checklist, prompt: string, items: [T, string, string][], fallback: T[]): Promise<T[]> {
    if (!this.interactive) return fallback;
    list.stopSpinner();
    try {
      return await tty.multiselect(prompt, items.map(([value, label, hint]) => ({ value, label, hint })), fallback);
    } catch {
      throw new Stopped();
    } finally {
      list.prompted();
    }
  }
  async select<T>(list: Checklist, prompt: string, items: [T, string, string][], fallback: T): Promise<T> {
    if (!this.interactive) return fallback;
    list.stopSpinner();
    try {
      const initial = Math.max(0, items.findIndex(([v]) => v === fallback));
      return await tty.select(prompt, items.map(([value, label, hint]) => ({ value, label, hint })), initial);
    } catch {
      throw new Stopped();
    } finally {
      list.prompted();
    }
  }
}

/** `why. Fix: what` split; a problem without a fix is its own fix. */
export function splitFix(problem: string): [string, string] {
  const at = problem.indexOf(" Fix: ");
  if (at >= 0) return [problem.slice(0, at).trim().replace(/\.+$/, ""), problem.slice(at + 6).trim().replace(/\.+$/, "")];
  return [problem.trim().replace(/\.+$/, ""), problem.trim()];
}

// ---- what this machine is ----

export type InitRole = "hub" | "ask" | "join" | "repair_worker";

/** `joined`: (hub URL, machine id) of an enrolled node here; `join`: what --join/--machine-id name. */
export function initRole(hubSetup: boolean, joined: [string, string] | undefined, join: [string, string | undefined] | undefined, rejoin: boolean): InitRole {
  const same = (a: string, b: string) => a.replace(/\/+$/, "") === b.replace(/\/+$/, "");
  if (join && joined && !rejoin && same(join[0], joined[0]) && (join[1] === undefined || join[1] === joined[1])) return "repair_worker";
  if (join) return "join";
  if (hubSetup) return "hub";
  return joined ? "repair_worker" : "ask";
}

export type Joined = { hub: string; machineId: string; identity?: GitIdentity };

/** The commit identity in a node unit `machine add` wrote (systemd or launchd); undefined for any other file. */
export function nodeUnitFacts(fileName: string, text: string): { identity?: GitIdentity } | undefined {
  if (fileName !== "fleetd-node.service" && fileName !== "sh.fleetd.node.plist") return undefined;
  const value = (key: string): string | undefined => {
    for (const line of text.split("\n")) {
      if (!line.startsWith("Environment=")) continue;
      const body = line.slice(12).replace(/^"+|"+$/g, "");
      if (body.startsWith(`${key}=`)) return body.slice(key.length + 1).replaceAll('\\"', '"').replaceAll("%%", "%");
    }
    const lines = text.split("\n");
    const at = lines.findIndex((l) => l.trim() === `<key>${key}</key>`);
    const next = at < 0 ? undefined : lines[at + 1]?.trim();
    if (next?.startsWith("<string>") && next.endsWith("</string>")) {
      return next.slice(8, -9).replaceAll("&lt;", "<").replaceAll("&gt;", ">").replaceAll("&amp;", "&");
    }
    return undefined;
  };
  const [name, email] = [value("GIT_AUTHOR_NAME"), value("GIT_AUTHOR_EMAIL")];
  return name !== undefined && email !== undefined ? { identity: { name, email } } : {};
}

/** The node `fleetd init --join` set up here, if it is enrolled: from its node.json and its unit. */
export function joinedHere(): Joined | undefined {
  let node: any;
  try {
    node = JSON.parse(readFileSync(join(fleetdDir(), "node", "node.json"), "utf8"));
  } catch {
    return undefined;
  }
  if (node?.enrolled !== true || typeof node.hub !== "string" || typeof node.machineId !== "string") return undefined;
  const dirs = localDirs();
  let identity: GitIdentity | undefined;
  for (const dir of [`${dirs.configHome.replace(/\/+$/, "")}/systemd/user`, `${dirs.home.replace(/\/+$/, "")}/Library/LaunchAgents`]) {
    let names: string[] = [];
    try {
      names = readdirSync(dir);
    } catch {}
    for (const name of names) {
      let text: string;
      try {
        text = readFileSync(join(dir, name), "utf8");
      } catch {
        continue;
      }
      const facts = nodeUnitFacts(name, text);
      if (facts !== undefined) {
        identity = facts.identity;
        break;
      }
    }
    if (identity !== undefined) break;
  }
  return { hub: node.hub, machineId: node.machineId, ...(identity ? { identity } : {}) };
}

// ---- the run ----

export async function run(opts: InitOptions, interactive: boolean): Promise<number> {
  const ui = new Ui(interactive);
  const list = new Checklist();
  if (list.rich) tty.intro("fleetd init");
  try {
    return await steps(opts, ui, list);
  } catch (error) {
    if (!(error instanceof Stopped)) throw error;
    list.stopSpinner();
    process.stderr.write(`${list.rich ? "   " : ""}${AGAIN}\n`);
    return 130;
  }
}

async function steps(opts: InitOptions, ui: Ui, list: Checklist): Promise<number> {
  const joined = joinedHere();
  const role = initRole(
    opts.previous !== undefined,
    joined ? [joined.hub, joined.machineId] : undefined,
    opts.join ? [opts.join[0], opts.machineId] : undefined,
    opts.rejoin,
  );
  if (role === "repair_worker" && joined) {
    list.setSections(1);
    return repairWorker(opts, ui, list, joined);
  }
  if (role === "join") {
    list.setSections(2);
    return joinHub(opts, ui, list);
  }
  list.setSections(6);
  list.sectionHeader("This machine");
  if (role === "ask") {
    const handed = await (await import("./hub_wizard.ts")).offerApp(ui, list);
    if (handed !== undefined) return handed;
    const hub = await ui.select(
      list,
      "What is this machine?",
      [
        [true, "The hub", "always on; your fleet and the app connect to it"],
        [false, "A worker for a hub I already have", "joins it with a one-time code"],
      ],
      true,
    );
    if (!hub) {
      list.setSections(3);
      return joinHub(opts, ui, list);
    }
  }
  return (await import("./hub_wizard.ts")).hubSteps(opts, ui, list);
}

type PastedJoin = { hub: string; code: string; machineId?: string; identity?: GitIdentity };

/** The words of a pasted shell line: single and double quotes, backslash escapes. */
export function shellWords(line: string): string[] | undefined {
  const out: string[] = [];
  let word: string | undefined;
  let quote: "'" | '"' | undefined;
  for (let i = 0; i < line.length; i++) {
    const c = line[i]!;
    if (quote === "'") {
      if (c === "'") quote = undefined;
      else word += c;
    } else if (quote === '"') {
      if (c === '"') quote = undefined;
      else if (c === "\\") {
        if (i + 1 >= line.length) return undefined;
        word = (word ?? "") + line[++i]!;
      } else word += c;
    } else if (c === "'" || c === '"') {
      quote = c;
      word ??= "";
    } else if (c === "\\") {
      if (i + 1 >= line.length) return undefined;
      word = (word ?? "") + line[++i];
    } else if (/\s/.test(c)) {
      if (word !== undefined) out.push(word);
      word = undefined;
    } else word = (word ?? "") + c;
  }
  if (quote !== undefined) return undefined;
  if (word !== undefined) out.push(word);
  return out;
}

/** What the line `fleetd pair --worker` prints carries: the hub, the code, the machine's name and the identity. */
export function pastedJoin(line: string): PastedJoin | undefined {
  const words = shellWords(line.trim());
  if (!words) return undefined;
  const after = (flag: string) => {
    const at = words.indexOf(flag);
    return at < 0 ? undefined : words[at + 1];
  };
  const [hub, code] = [after("--join"), after("--code")];
  if (hub === undefined || !URL.canParse(hub) || code === undefined) return undefined;
  const machineId = after("--machine-id");
  const idText = after("--git-identity");
  const identity = idText === undefined ? undefined : parseGitIdentity(idText);
  return { hub, code, ...(machineId !== undefined ? { machineId } : {}), ...(identity ? { identity } : {}) };
}

const needed = (s: string) => (s === "" ? "needed" : undefined);

async function joinHub(opts: InitOptions, ui: Ui, list: Checklist): Promise<number> {
  list.sectionHeader("Join a hub");
  let pasted: PastedJoin | undefined;
  let hub: string;
  let code: string;
  if (opts.join) [hub, code] = opts.join;
  else {
    list.note("On the hub, run: fleetd pair --worker <name for this machine>, and paste the line it prints here");
    hub = await ui.input(
      list,
      "The line it printed, or the hub's address",
      "",
      "curl -fsSL https://fleetd.sh | sh -s -- --join … or http://devbox.tailnet.ts.net:4790",
      (s) => (pastedJoin(s) || URL.canParse(s) ? undefined : "the line fleetd pair --worker printed, or the hub's URL"),
    );
    pasted = pastedJoin(hub);
    if (pasted) [hub, code] = [pasted.hub, pasted.code];
    else code = await ui.input(list, "One-time code", "", "", needed);
  }
  const identity = opts.identity ?? pasted?.identity;
  let machineId = opts.machineId ?? pasted?.machineId;
  if (machineId === undefined) {
    const fallback = machineIdFromHost(localHostName());
    machineId =
      opts.join || !ui.interactive
        ? fallback
        : await ui.input(list, "This machine's name on the hub", fallback, "", (s) =>
            isMachineId(s) ? undefined : "lowercase letters, digits and dashes",
          );
  }
  if (hub.trim() === "" || code.trim() === "") {
    list.failed("join", "needs the hub's address and a one-time code", "on the hub, run fleetd pair --worker <name>, then the command it prints here");
    list.outro(list.needsYou(), AGAIN);
    return 1;
  }
  list.sectionHeader("Worker");
  list.start(`Joining ${hub.trim()}`);
  capture();
  let added: Added | undefined;
  try {
    added = await joinHubAs(hub.trim(), { kind: "token", token: code.trim() }, {
      ...localArgs(machineId, opts.withService),
      ...(identity ? { gitIdentity: identity } : {}),
      ...(opts.claudeConfigDir === undefined ? {} : { claudeConfigDir: opts.claudeConfigDir }),
      mac: opts.mac,
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
    failedWithLog(list, machineId, "could not join", said, `a used or expired code: on the hub, fleetd pair --worker ${machineId} prints a new command`);
    return workerEnd(list, "", false);
  }
  nodeLine(list, added.machineId, added, `joined ${hub.trim()}`);
  notes(list, said);
  if (opts.mac) {
    // At a terminal too, until the grants' own prompts (src/node/agents_mac) are here to walk through: the same note.
    list.note(
      "This is the agents' Mac now. Last, at this Mac: run fleetd node grants --ask accessibility, then fleetd node grants --ask screen_recording, and turn on fleetd in each pane they open; the node restarts itself to take up each. Settings › Hub › Setup › A Mac for agents in the app shows each check.",
    );
    return workerEnd(list, "This Mac is the agents' Mac now.", true);
  }
  await workerClaude(ui, list, added);
  return workerEnd(list, "This machine is a worker now.", true);
}

/** A worker that joined by itself, run again: keeps its enrolment and only checks and repairs what it runs. */
async function repairWorker(opts: InitOptions, ui: Ui, list: Checklist, joined: Joined): Promise<number> {
  list.sectionHeader("Worker");
  if (opts.join) list.note("Already enrolled with that hub, so the code is not used (--rejoin enrols again).");
  const title = joined.machineId;
  list.start(`Checking ${title}`);
  capture();
  let added: Added | undefined;
  try {
    const identity = opts.identity ?? joined.identity;
    added = await joinHubAs(joined.hub, { kind: "keep" }, {
      ...localArgs(joined.machineId, opts.withService),
      ...(identity ? { gitIdentity: identity } : {}),
      ...(opts.claudeConfigDir === undefined ? {} : { claudeConfigDir: opts.claudeConfigDir }),
    });
  } catch (error) {
    if (!(error instanceof Stop)) {
      release();
      throw error;
    }
    error.print();
  }
  const said = release();
  if (added === undefined) failedWithLog(list, title, "check stopped", said, "fix the cause above, then run fleetd init again");
  else {
    nodeLine(list, title, added, `enrolled with ${joined.hub}`);
    notes(list, said);
    await workerClaude(ui, list, added);
  }
  return workerEnd(list, "This machine is a worker.", true);
}

/** The tail of what a captured step printed, as its ✗ line with its own fix where it gave one. */
export function failedWithLog(list: Checklist, title: string, what: string, said: string[], fix: string) {
  const last = [...said].reverse().find((l) => l.startsWith("fleetd: "));
  if (last === undefined) {
    list.failed(title, what, fix);
    return;
  }
  const [why, ownFix] = splitFix(last.slice(8));
  list.failed(title, `${what}: ${why.split("\n")[0]}`, why === ownFix ? fix : ownFix);
}

/** `machine add`'s notes (linger, an untested claude, …) as ! lines; the login note is the claude line's. */
export function notes(list: Checklist, said: string[]) {
  for (const line of said) {
    if (!line.startsWith("note: ")) continue;
    const note = line.slice(6);
    if (note.includes("not logged in")) continue;
    const [why, fix] = splitFix(note);
    list.warn("note", why, why !== fix ? fix : undefined);
  }
}

/** A worker's line: done when its node runs as a service; with --no-service, left to the user with its command. */
export function nodeLine(list: Checklist, title: string, added: Added, done: string) {
  if (added.runByHand === undefined) list.done(title, done);
  else {
    list.todo(
      title,
      "enrolled; its node isn't started (--no-service)",
      `start ${added.machineId}'s node`,
      added.target.local ? added.runByHand : `ssh ${added.target.host} ${q(added.runByHand)}`,
    );
  }
}

function workerEnd(list: Checklist, ok: string, enrolled: boolean): number {
  const failed = list.failures().length > 0;
  const next = !enrolled
    ? JOIN_AGAIN
    : failed
      ? AGAIN
      : list.todos.length > 0
        ? "Then run fleetd init again."
        : `${ok} Its agents start from orders you send in the fleetd app.`;
  list.outro(list.needsYou(), next);
  return failed ? 1 : 0;
}

/** The worker's claude login: done, or offered at a terminal, else failed with how to log in. */
export async function workerClaude(ui: Ui, list: Checklist, added: Added) {
  const title = `claude on ${added.machineId}`;
  const login = loginCommand(added.claude, added.claudeConfigDir);
  const fix = added.target.local ? login : `ssh -t ${added.target.host} ${q(login)}`;
  let loggedIn = added.loggedIn;
  let offered = false;
  for (;;) {
    if (loggedIn) {
      list.done(title, "logged in");
      return;
    }
    if (offered || !(await ui.offerToRun(list, `claude on ${added.machineId} isn't logged in. Log in now?`))) {
      list.failed(title, "not logged in", fix);
      return;
    }
    offered = true;
    list.stopSpinner();
    runAttached(added.target, login);
    const out = await runSsh(added.target, loginStatusCommand(added.layout, added.claude, added.claudeConfigDir));
    try {
      loggedIn = JSON.parse(out.stdout.trim())?.loggedIn === true;
    } catch {
      loggedIn = false;
    }
  }
}

// ---- the hub's setup steps (`fleetd init --step <id>`) ----

/** setup_test, said as the step's line. */
async function tested(list: Checklist, client: import("../mcp_client.ts").McpClient, id: string): Promise<string> {
  const steps = await import("./steps.ts");
  list.start("Testing");
  try {
    const step = await steps.test(client, id);
    const [state, detail, fix] = steps.line(step);
    list.finish(step.title, state, detail, fix);
    return step.status;
  } catch (f) {
    if (!steps.isFailure(f)) throw f;
    list.failed("test", f.message, f.fix);
    return "look";
  }
}

/** `fleetd invite --name <name>` from the People step: the link and code are shown this once. */
async function inviteStep(opts: InitOptions, ui: Ui, list: Checklist) {
  const name = await ui.input(list, "Their name", "", "alice", needed);
  const { inviteCommand } = await import("../people.ts");
  const out = inviteCommand(["--name", name], opts.home);
  if (out.code === 0) {
    list.done(`invite ${name}`, "send them this:");
    list.note(out.stdout.replace(/\s+$/, ""));
  } else {
    list.failed(`invite ${name}`, out.stderr.trim().replace(/^fleetd: /, ""), "fleetd invite --name <name>");
  }
}

/** One step, open: its guide, then Test until it passes or the person goes on. */
export async function walk(opts: InitOptions, ui: Ui, list: Checklist, client: import("../mcp_client.ts").McpClient, step: any): Promise<string> {
  const steps = await import("./steps.ts");
  list.heading(`${step.title} · ${steps.needWords(step.need)}`);
  list.note(steps.guide(step));
  if (!ui.interactive) return tested(list, client, step.id);
  for (;;) {
    const actions: [string, string, string][] = [];
    if (step.id === "people") actions.push(["invite", "Invite someone now", "a link and a code, for 7 days"]);
    if (step.test !== undefined || (step.ways ?? []).length > 0) actions.push(["test", "Test it", "run its checks now"]);
    actions.push(["next", "Go on", ""]);
    const picked = await ui.select(list, `${step.title}:`, actions, actions[0]![0]);
    if (picked === "invite") {
      await inviteStep(opts, ui, list);
      if ((await tested(list, client, step.id)) === "done") return "done";
    } else if (picked === "test") {
      if ((await tested(list, client, step.id)) === "done") return "done";
    } else return step.status;
  }
}

/** `fleetd init --step <id>`: that one step against the hub this machine runs, then the next action. */
export async function openStep(opts: InitOptions, id: string, interactive: boolean): Promise<number> {
  const ui = new Ui(interactive);
  const list = new Checklist();
  const { connect } = await import("./doctor.ts");
  const steps = await import("./steps.ts");
  let client;
  try {
    client = await connect(opts.home);
  } catch (f) {
    if (!steps.isFailure(f)) throw f;
    list.failed("setup", f.message, f.fix);
    return 4;
  }
  let found;
  try {
    const all = await steps.list(client);
    if (all === undefined) {
      list.failed("setup", "this hub has no setup steps yet", "fleetd update, then fleetd init --step again");
      return 1;
    }
    found = all.find((s) => s.id === id);
  } catch (f) {
    if (!steps.isFailure(f)) throw f;
    list.failed("setup", f.message, f.fix);
    return 4;
  }
  if (found === undefined) {
    list.failed("setup", `this hub has no step ${id}`, "fleetd init");
    return 1;
  }
  try {
    const status = await walk(opts, ui, list, client, found);
    if (status === "done") {
      list.outro([], "Next: fleetd init lists what's left; the app's Settings › Hub › Setup has the same steps.");
      return 0;
    }
    list.outro([], `Run fleetd init --step ${id} again when you've done it; it keeps what's done.`);
    return found.need?.kind === "required" ? 1 : 0;
  } catch (error) {
    if (!(error instanceof Stopped)) throw error;
    list.stopSpinner();
    process.stderr.write(`${list.rich ? "   " : ""}${AGAIN}\n`);
    return 130;
  }
}
