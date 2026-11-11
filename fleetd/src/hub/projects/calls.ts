// A lead's setup calls for its own project (W614): `repo_add`, `repo_remove` and `project_setup`, and a person's
// `project_setup_undo`. They are a lead's alone, pinned to its own project by its session (lead_calls), and do what a
// person does in the project's settings: add and remove repos, and set the title, icon, picture and color, the
// project's Instructions, its setup commands, plain variables and archive. What guards people has no field here and
// is refused in one place (people_only.ts).
//
// Every change posts one system line in the project's chat, in every approval mode, and keeps what was there before
// (`project_setup_changes`): a person's Undo on the line, from their own device, puts it back. A clone runs on after
// `repo_add` returns; its end, or its failure with the fix, wakes the lead.
import { mkdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import type {
  BotColor,
  ChatMessageId,
  EnvVarSet,
  ProjectIcon,
  ProjectProblem,
  ProjectRef,
  ProjectRepo,
  ProjectSummary,
  RepoName,
  SetupChangeKind,
  WorktreeSetup,
} from "../../shared/contracts.ts";
import { ToolError } from "../../shared/errors.ts";
import { requireRole } from "../api/grants.ts";
import type { Hub } from "../api/hub.ts";
import type { Caller, Registry } from "../api/registry.ts";
import { chat } from "../chat/index.ts";
import { projectRemove } from "../executor/projects.ts";
import { dir as attachmentsDir } from "../intake/attachments.ts";
import { readInto, sessionOf } from "../intake/chat_image.ts";
import { type LeadCall, type LeadCaller, leadCalls, leadWakes, requireHuman, unknownProject } from "../leads/seams.ts";
import * as navis from "../navi/store.ts";
import { INSTRUCTIONS } from "../prompts/entry.ts";
import { entryOr, PromptError, prompts } from "../prompts/store.ts";
import { changed as promptChanged } from "../prompts/tools.ts";
import { redact } from "../redact.ts";
import * as repos from "../repos/store.ts";
import { store } from "../store/hub_store.ts";
import { checkEnvName } from "../vault/fields.ts";
import * as avatar from "./avatar.ts";
import { projectAt } from "./discover.ts";
import * as icon from "./icon.ts";
import { peopleOnly } from "./people_only.ts";
import { type AddHooks, addTo, removeFrom } from "./repos.ts";
import { announce, projectSettings, rename, repoNamed, setColor, setEnv } from "./settings.ts";

export const OPS = ["repo_add", "repo_remove", "project_setup"] as const;

/** What was there before a change, by its kind: what Undo puts back. */
type Before =
  | { kind: "repo_added"; repo: RepoName; created: boolean }
  | { kind: "repo_removed"; repo: RepoName; path?: string; setup?: WorktreeSetup }
  | { kind: "title"; title: string }
  | { kind: "look"; icon?: ProjectIcon; color: BotColor }
  | { kind: "instructions"; text?: string; base?: string }
  | { kind: "setup"; repo?: RepoName; setup?: WorktreeSetup }
  | { kind: "env"; set: { name: string; value: string }[]; remove: string[] }
  | { kind: "archived" };

type SetupCall = {
  archive?: boolean;
  color?: BotColor;
  env?: { set?: { name: string; value: string }[]; remove?: string[] };
  icon?: ProjectIcon;
  instructions?: string;
  picture?: string;
  setup?: { commands: string[]; repo?: RepoName };
  title?: string;
};

const invalid = (why: string, fix?: string) => new ToolError("invalid", why, fix);

/** A lead's call from its own session, and nobody else's. */
function onlyLead(caller: LeadCaller, op: string): void {
  if (caller.agent.kind === "lead") return;
  throw new ToolError("forbidden", `${op} is a project's lead's call, from its own session.`, "A person changes the same in the project's settings in the app.");
}

function projectOf(hub: Hub, r: ProjectRef): ProjectSummary {
  const project = store(hub).projectGet(r);
  if (!project) throw unknownProject(r);
  return project;
}

// ---- The chat line, and what it keeps for Undo.

/** One system line that says what changed, with what was there before kept under its message. */
function post(hub: Hub, r: ProjectRef, text: string, before: Before, names?: string[], picture?: Uint8Array): void {
  const kind: SetupChangeKind = before.kind;
  const { message } = chat(hub).add(r, { author: "system", text, setupChanged: { kind, ...(names ? { names } : {}) } });
  hub.db.conn
    .query("INSERT OR REPLACE INTO project_setup_changes (message_id, machine_id, project_id, before, picture, at_ms) VALUES (?, ?, ?, ?, ?, ?)")
    .run(message.messageId, r.machineId, r.projectId, JSON.stringify(before), picture ?? null, hub.clock.now());
}

function kept(hub: Hub, id: ChatMessageId): { before: Before; picture?: Uint8Array } | undefined {
  const row = hub.db.conn
    .query<{ before: string; picture: Uint8Array | null }, [string]>("SELECT before, picture FROM project_setup_changes WHERE message_id = ?")
    .get(id);
  if (!row) return undefined;
  return { before: JSON.parse(row.before) as Before, ...(row.picture ? { picture: row.picture } : {}) };
}

/** Wakes the project's lead with one line. Never throws: the change it tells of is already made. */
function tell(hub: Hub, r: ProjectRef, line: "request" | "quiet", text: string): void {
  try {
    leadWakes(hub).trigger(r, { kind: "line", line, text });
  } catch (error) {
    console.warn("a lead was not told of its project's setup:", error);
  }
}

// ---- Repos.

type CloneRow = { add_id: string; machine_id: string; project_id: string; repo: string; path: string };

const cloneDone = (hub: Hub, addId: string) => hub.db.conn.query("DELETE FROM project_setup_clones WHERE add_id = ?").run(addId);

/** The line of a repo that is in the project now. `created`: its checkout was no project of the machine before. */
function added(hub: Hub, r: ProjectRef, repo: ProjectRepo, created: boolean): void {
  post(hub, r, `Added the repo ${repo.name}`, { kind: "repo_added", repo: repo.name, created }, [repo.name]);
}

async function repoAdd(hub: Hub, caller: LeadCaller, call: LeadCall): Promise<Record<string, unknown>> {
  onlyLead(caller, "repo_add");
  const r = caller.projectRef;
  const m = r.machineId;
  const { url, path, name } = call as { url?: string; path?: string; name?: RepoName };
  if ((url === undefined) === (path === undefined)) {
    throw invalid("Give url (a GitHub URL or owner/repo, cloned onto the project's machine) or path (a checkout already there), one of them.");
  }
  let created = true;
  // A clone can end before this call does: its row is written only while it still runs.
  let ended = false;
  let addId: string | undefined;
  const hooks: AddHooks = {
    existing: (at) => {
      const other = projectAt(hub, m, at);
      created = other === undefined;
      if (other === undefined || repos.holders(hub.db.conn, { machineId: m, projectId: other }).length > 0) return;
      const title = store(hub).projectGet({ machineId: m, projectId: other })?.title ?? other;
      throw peopleOnly("project_folder", `${at} is the project ${title}.`);
    },
    cloned: (repo) => {
      ended = true;
      if (addId !== undefined) cloneDone(hub, addId);
      added(hub, r, repo, true);
      tell(hub, r, "request", `repo_add: ${repo.name} is cloned and is a repo of the project now, at ${repo.path ?? "its checkout"} on ${m}. spawn_agent takes it with repo.`);
    },
    cloneFailed: (problem: ProjectProblem) => {
      ended = true;
      if (addId !== undefined) cloneDone(hub, addId);
      tell(hub, r, "request", `repo_add: ${url} was not added. ${problem.message}${problem.fix ? ` ${problem.fix}.` : ""}`);
    },
  };
  const out = await addTo(
    hub,
    { machineId: m, projectId: r.projectId, ...(name !== undefined ? { name } : {}), ...(path !== undefined ? { path } : { url: url as string, useExisting: true }) },
    hooks,
  );
  if (out.repo) {
    added(hub, r, out.repo, created);
    return {
      repo: out.repo.name,
      path: out.path,
      next: `${out.repo.name} is a repo of the project now, at ${out.path} on ${m}: spawn_agent takes it with repo. The chat says so in one line the person can undo.`,
    };
  }
  addId = out.addId;
  if (!ended && addId !== undefined) {
    hub.db.conn
      .query("INSERT OR REPLACE INTO project_setup_clones (add_id, machine_id, project_id, repo, path) VALUES (?, ?, ?, ?, ?)")
      .run(addId, m, r.projectId, url as string, out.path);
  }
  return {
    cloning: true,
    path: out.path,
    next: `Cloning ${url} into ${out.path} on ${m}. You are woken when it ends, or when it fails, with the fix: carry on with other work or end your turn, and spawn nothing in it before then.`,
  };
}

async function repoRemove(hub: Hub, caller: LeadCaller, call: LeadCall): Promise<Record<string, unknown>> {
  onlyLead(caller, "repo_remove");
  const r = caller.projectRef;
  const repo = repoNamed(hub, r, (call as { repo?: RepoName }).repo) as ProjectRepo;
  const path = repo.path ?? store(hub).projectGet(repo.checkout)?.workspaceRoot;
  const setup = projectSettings(hub).setupIn(r, repo.repoId);
  const out = await removeFrom(hub, r, repo.name);
  post(hub, r, `Removed the repo ${repo.name}`, { kind: "repo_removed", repo: repo.name, ...(path !== undefined ? { path } : {}), ...(setup ? { setup } : {}) }, [repo.name]);
  const stopped = out.cancelled.length > 0 ? ` Its tasks were stopped: ${out.cancelled.join(", ")}.` : "";
  return {
    removed: repo.name,
    cancelled: out.cancelled,
    next: `${repo.name} is out of the project; its checkout stays on disk${path !== undefined ? ` at ${path}` : ""}.${stopped} The chat says so in one line; the person's Undo on it brings the repo back.`,
  };
}

/**
 * The clones a lead's `repo_add` started under a hub process that is gone: each lead is told, so none waits for a
 * wake that never comes. Run at the hub's start, once the wakes are wired.
 */
function tellInterrupted(hub: Hub): void {
  let rows: CloneRow[];
  try {
    rows = hub.db.conn.query<CloneRow, []>("SELECT add_id, machine_id, project_id, repo, path FROM project_setup_clones").all();
  } catch (error) {
    console.warn("the clones leads wait for were not read:", error);
    return;
  }
  for (const row of rows) {
    cloneDone(hub, row.add_id);
    tell(
      hub,
      { machineId: row.machine_id, projectId: row.project_id },
      "request",
      `repo_add: the hub restarted while cloning ${row.repo} into ${row.path}, so it was not added. Call repo_add with the same url again: a clone that finished on the machine is added as it is.`,
    );
  }
}

// ---- project_setup.

/** Names that usually hold a credential: the ones a pasted .env starts as a secret in the apps (projectModel.ts). */
const SECRETISH = /KEY|TOKEN|SECRET|PASSWORD|PASSWD|PASS|PRIVATE|CREDENTIAL|AUTH|DSN|COOKIE|SESSION/u;
/** A payment provider's secret and restricted keys, which the redaction's shapes leave out. */
const PAID_KEY = /\b[sr]k_(?:live|test)_[A-Za-z0-9]{10,}/u;
/** One unbroken run of eight characters or more with a digit in it, as a key is and a word or a short number isn't. */
const OPAQUE = /^(?=\S*[0-9])\S{8,}$/u;
const NUMBER = /^-?[0-9]+(?:\.[0-9]+)?$/u;
/** A host as people write one: lowercase dotted names, `localhost` or an IPv4 address, with a port or without. */
const HOST = /^(?:localhost|(?:[0-9]{1,3}\.){3}[0-9]{1,3}|(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,24})(?::[0-9]{1,5})?$/u;
/** A path from a root, the home or here, in short segments: a base64 key that starts with a slash is one long run. */
const PATH = /^(?:~|\.{1,2})?(?:\/[A-Za-z0-9._~-]{1,32})+\/?$/u;

/** The URL a value is, with a host: `redis://localhost:6379`, never `user:word`. */
function urlOf(value: string): URL | undefined {
  if (!/^[a-z][a-z0-9+.-]*:\/\/[^/]/iu.test(value)) return undefined;
  try {
    return new URL(value);
  } catch {
    return undefined;
  }
}

/** A URL that carries a password, which is a credential under any name. */
const hasPassword = (value: string) => (urlOf(value.trim())?.password ?? "") !== "";

/**
 * What a dev variable holds under a name like `NEXTAUTH_URL`, `SESSION_STORE` or `COOKIE_DOMAIN` and no key is: a
 * number, a host, a path, a URL with nobody's login in it, or a list of them.
 */
function address(value: string): boolean {
  return value.split(",").every((part) => {
    if (NUMBER.test(part) || HOST.test(part) || PATH.test(part)) return true;
    const url = urlOf(part);
    return url !== undefined && url.username === "" && url.password === "";
  });
}

/**
 * A value fleetd's own redaction would hide (a key by its shape, or by the name it is set under), a URL with a
 * password in it, or an opaque value under a name that usually holds a credential (`STRIPE_KEY`, `SESSION_COOKIE`).
 */
function looksLikeKey(name: string, raw: string): boolean {
  const value = raw.trim();
  if (redact(raw) !== raw || redact(`${name}=${raw}`) !== `${name}=${raw}` || PAID_KEY.test(raw) || hasPassword(value)) return true;
  return SECRETISH.test(name.toUpperCase()) && OPAQUE.test(value) && !address(value);
}

const plain = (v: { name: string; value: string }): EnvVarSet => ({ kind: "plain", name: v.name, value: v.value });

/**
 * The key a lead's plain variables go into the vault under: operate on its project's machine and nothing more, as the
 * project's owner where it has one (an Only me project's variables are its owner's to write).
 */
function leadKey(caller: LeadCaller, project: ProjectSummary): Caller {
  return {
    keyId: "lead-setup",
    name: caller.by,
    prefix: "",
    kind: "agent",
    grants: [{ role: "operate", machines: [project.machineId] }],
    createdAt: new Date(0).toISOString(),
    ...(project.owner !== undefined ? { person: { personId: project.owner, name: caller.by } } : {}),
  } as unknown as Caller;
}

/** The image at `path` in the lead's working directory, rendered as a project's picture. */
async function pictureAt(hub: Hub, caller: LeadCaller, path: string): Promise<Uint8Array> {
  const thread = sessionOf(hub, caller);
  const root = join(attachmentsDir(hub), "uploads");
  const tmp = join(root, `read-${crypto.randomUUID()}`);
  try {
    mkdirSync(root, { recursive: true });
    await readInto(hub, thread, path, false, tmp);
    return await avatar.render(new Uint8Array(readFileSync(tmp)), undefined);
  } finally {
    rmSync(tmp, { force: true });
  }
}

const sameBytes = (a: Uint8Array, b: Uint8Array) => a.length === b.length && Buffer.compare(a, b) === 0;

function fromPrompts(error: unknown): unknown {
  if (!(error instanceof PromptError)) return error;
  return new ToolError(error.kind === "invalid" ? "invalid" : "failed", error.message);
}

async function setup(hub: Hub, caller: LeadCaller, call: LeadCall): Promise<Record<string, unknown>> {
  onlyLead(caller, "project_setup");
  const r = caller.projectRef;
  const c = call as SetupCall;
  const db = hub.db.conn;
  const s = projectSettings(hub);
  const project = projectOf(hub, r);

  // Everything is checked before anything changes.
  if (Object.keys(c).every((k) => k === "op" || (c as Record<string, unknown>)[k] === undefined)) {
    throw invalid("project_setup changes nothing as sent.", "Give any of title, icon, picture, color, instructions, setup, env or archive");
  }
  if (c.icon !== undefined && c.picture !== undefined) throw invalid("Give icon or picture, not both: an icon replaces a picture.");
  if (c.archive === false) throw invalid("archive takes true only: a person brings an archived project back, from the app.");
  const title = c.title?.trim();
  if (title !== undefined && title === "") throw invalid("A project's title has at least one letter.");
  const env = { set: c.env?.set ?? [], remove: c.env?.remove ?? [] };
  const was = new Map(s.env(r).map((v) => [v.name, v]));
  for (const v of env.set) {
    checkEnvName(v.name);
    if (env.remove.includes(v.name)) throw invalid(`${v.name} is both set and removed.`);
    if (looksLikeKey(v.name, v.value)) {
      throw new ToolError(
        "forbidden",
        `${v.name}'s value looks like a key or a password, and project_setup sets plain variables only.`,
        `Call request_secret for ${v.name}: the person enters it on their own device, and it never passes through you`,
      );
    }
  }
  for (const name of [...env.set.map((v) => v.name), ...env.remove]) {
    if (was.get(name)?.kind === "secret") throw peopleOnly("vault", `${name} is a secret a person set.`);
  }
  const setupRepo = c.setup === undefined ? undefined : repoNamed(hub, r, c.setup.repo);
  const picture = c.picture === undefined ? undefined : await pictureAt(hub, caller, c.picture);

  const said: string[] = [];
  /** One thing changed and its line posted, or nothing to change; a failure names what changed before it. */
  const step = async (change: () => Promise<string | undefined> | string | undefined): Promise<void> => {
    try {
      const line = await change();
      if (line !== undefined) said.push(line);
    } catch (error) {
      const e = fromPrompts(error);
      if (!(e instanceof ToolError) || said.length === 0) throw e;
      throw new ToolError(e.code, `${e.message} Changed before that, each with its line in the chat: ${said.join("; ")}.`, e.fix, e.reason);
    }
  };

  if (title !== undefined) {
    await step(async () => {
      if (title === project.title) return undefined;
      await rename(hub, project, title);
      const line = `Renamed the project to ${title}`;
      post(hub, r, line, { kind: "title", title: project.title });
      return line;
    });
  }

  if (c.icon !== undefined || picture !== undefined || c.color !== undefined) {
    await step(() => {
      const before: Before = { kind: "look", color: project.avatarColor ?? "slate" };
      const pick = icon.picked(db, r);
      if (pick) before.icon = pick;
      const jpeg = avatar.jpegOf(db, r);
      const parts: string[] = [];
      if (c.icon !== undefined && (jpeg !== undefined || pick?.face !== c.icon.face || pick.color !== c.icon.color)) {
        icon.set(hub, r, c.icon);
        parts.push("icon");
      }
      if (picture !== undefined && (jpeg === undefined || !sameBytes(jpeg, picture))) {
        announce(hub, r, `${projectOf(hub, r).title} has a new picture`, { avatar: avatar.keep(hub, r, picture) ?? null });
        parts.push("picture");
      }
      if (c.color !== undefined && c.color !== before.color) {
        setColor(hub, projectOf(hub, r), c.color);
        parts.push("color");
      }
      if (parts.length === 0) return undefined;
      const line = `Changed the project's ${parts.join(" and ")}`;
      post(hub, r, line, before, undefined, jpeg);
      return line;
    });
  }

  if (c.instructions !== undefined) {
    const text = c.instructions;
    await step(() => {
      const entry = entryOr(INSTRUCTIONS);
      const p = prompts(hub.db);
      const had = p.overrideOf(entry, r);
      const clear = text.trim() === "";
      if (clear ? had === undefined : had?.text === text) return undefined;
      if (clear) {
        p.reset(entry, "project", r);
        promptChanged(hub, entry.id, "project", r, {});
      } else {
        const saved = p.set(entry, "project", r, text);
        promptChanged(hub, entry.id, "project", r, { ref: saved.ref, warnings: saved.warnings.map((w) => w.code) });
      }
      const line = clear ? "Cleared the project's instructions" : "Wrote the project's instructions";
      post(hub, r, line, { kind: "instructions", ...(had ? { text: had.text, ...(had.base !== undefined ? { base: had.base } : {}) } : {}) });
      return line;
    });
  }

  if (c.setup !== undefined) {
    const commands = c.setup.commands;
    await step(() => {
      const had = s.setupIn(r, setupRepo?.repoId);
      if (JSON.stringify(had?.commands ?? []) === JSON.stringify(commands)) return undefined;
      s.setSetupIn(r, setupRepo?.repoId, { commands, inputs: had?.inputs ?? [] });
      announce(hub, r, `${projectOf(hub, r).title}'s setup commands changed`, { setup: true });
      const of = setupRepo ? ` of ${setupRepo.name}` : "";
      const line = commands.length === 0 ? `Turned off the setup commands${of}` : `Set the setup commands${of}`;
      post(hub, r, line, { kind: "setup", ...(setupRepo ? { repo: setupRepo.name } : {}), ...(had ? { setup: had } : {}) });
      return line;
    });
  }

  if (env.set.length > 0 || env.remove.length > 0) {
    await step(async () => {
      const set = env.set.filter((v) => was.get(v.name)?.value !== v.value);
      const remove = env.remove.filter((name) => was.has(name));
      if (set.length === 0 && remove.length === 0) return undefined;
      const { missed } = await setEnv(hub, leadKey(caller, project), r, set.map(plain), remove);
      // What took, by what the project holds now.
      const is = new Map(s.env(r).map((v) => [v.name, v]));
      const took = [...set.map((v) => v.name), ...remove].filter((name) => was.get(name)?.value !== is.get(name)?.value);
      let line: string | undefined;
      if (took.length > 0) {
        const sets = took.filter((name) => is.has(name)).length;
        const one = took.length === 1 ? took[0] : undefined;
        if (one !== undefined) line = sets === 1 ? `Set the variable ${one}` : `Removed the variable ${one}`;
        else line = sets === took.length ? `Set ${sets} variables` : sets === 0 ? `Removed ${took.length} variables` : `Changed ${took.length} variables`;
        const before: Before = {
          kind: "env",
          set: took.flatMap((name) => (was.has(name) ? [{ name, value: was.get(name)?.value ?? "" }] : [])),
          remove: took.filter((name) => !was.has(name)),
        };
        post(hub, r, line, before, took);
        said.push(line);
      }
      if (missed.length > 0) throw new ToolError("failed", `These variables didn't take: ${missed.join(", ")}.`, "Call project_setup with them again");
      return undefined;
    });
  }

  if (c.archive === true) {
    await step(() => {
      if (projectOf(hub, r).archivedAt !== undefined) return undefined;
      navis.setArchived(db, r, hub.clock.now());
      const p = projectOf(hub, r);
      announce(hub, r, `${p.title} archived`, { kind: p.kind ?? null, title: p.title, archivedAt: p.archivedAt ?? null });
      const line = "Archived the project";
      post(hub, r, line, { kind: "archived" });
      return line;
    });
  }

  if (said.length === 0) return { changed: [], next: "Nothing changed: the project already has all of it." };
  const archived = c.archive === true ? " The project is archived: say so in one line and end your turn; nothing wakes you until a person brings it back." : "";
  return {
    changed: said,
    next: `${said.join(". ")}. Each is one line in the chat, which the person can undo.${archived}`,
  };
}

// ---- A person's Undo.

/** Puts back what was there before the change. Returns what to tell the person, if anything. */
async function restore(hub: Hub, caller: Caller, r: ProjectRef, before: Before, picture: Uint8Array | undefined): Promise<string | undefined> {
  const db = hub.db.conn;
  const s = projectSettings(hub);
  const project = projectOf(hub, r);
  switch (before.kind) {
    case "repo_added": {
      const repo = repos.byName(db, r, before.repo);
      if (!repo) return "It was already out of the project.";
      await removeFrom(hub, r, repo.name);
      // A checkout the add made a project of the machine is forgotten again; its files stay.
      if (before.created && repos.holders(db, repo.checkout).length === 0) {
        await projectRemove(hub, repo.checkout.machineId, repo.checkout.projectId, false, false, false).catch((error) =>
          console.warn("an undone repo's checkout was not forgotten:", error),
        );
      }
      return `Its checkout stays on disk${repo.path !== undefined ? ` at ${repo.path}` : ""}.`;
    }
    case "repo_removed": {
      if (before.path === undefined) {
        throw new ToolError("failed", `fleetd doesn't know where ${before.repo}'s checkout was.`, "Add it again in the project's settings.");
      }
      const out = await addTo(hub, { machineId: r.machineId, projectId: r.projectId, name: before.repo, path: before.path }, {});
      if (before.setup && out.repo) s.setSetupIn(r, out.repo.repoId, before.setup);
      return undefined;
    }
    case "title":
      if (project.title !== before.title) await rename(hub, project, before.title);
      return undefined;
    case "look": {
      icon.restore(db, r, before.icon, hub.clock.now());
      const avatarId = avatar.keep(hub, r, picture);
      announce(hub, r, `${project.title}'s look is back`, { icon: icon.of(db, r), avatar: avatarId ?? null });
      setColor(hub, projectOf(hub, r), before.color);
      return undefined;
    }
    case "instructions": {
      const entry = entryOr(INSTRUCTIONS);
      try {
        if (before.text === undefined) {
          prompts(hub.db).reset(entry, "project", r);
          promptChanged(hub, entry.id, "project", r, {});
        } else {
          const saved = prompts(hub.db).set(entry, "project", r, before.text, before.base);
          promptChanged(hub, entry.id, "project", r, { ref: saved.ref, warnings: saved.warnings.map((w) => w.code) });
        }
      } catch (error) {
        throw fromPrompts(error);
      }
      return undefined;
    }
    case "setup": {
      const repo = before.repo === undefined ? undefined : repos.byName(db, r, before.repo);
      if (before.repo !== undefined && !repo) {
        throw new ToolError("not_found", `${before.repo} is no longer a repo of the project.`, "Its setup commands went with it.");
      }
      s.setSetupIn(r, repo?.repoId, before.setup ?? { commands: [], inputs: [] });
      announce(hub, r, `${project.title}'s setup commands changed`, { setup: true });
      return undefined;
    }
    case "env": {
      // A variable a person has made a secret since stays theirs.
      const secret = new Set(s.env(r).flatMap((v) => (v.kind === "secret" ? [v.name] : [])));
      const { missed } = await setEnv(
        hub,
        caller,
        r,
        before.set.filter((v) => !secret.has(v.name)).map(plain),
        before.remove.filter((name) => !secret.has(name)),
      );
      if (missed.length > 0) throw new ToolError("failed", `These variables didn't go back: ${missed.join(", ")}.`, "Try again.");
      return undefined;
    }
    case "archived": {
      navis.setArchived(db, r, undefined);
      const p = projectOf(hub, r);
      announce(hub, r, `${p.title} back`, { kind: p.kind ?? null, title: p.title, archivedAt: p.archivedAt ?? null });
      return "Its lead starts with the next chat message.";
    }
  }
}

/** The lines being undone now, so a second tap doesn't undo one twice. */
const undoing = new WeakMap<Hub, Set<string>>();

export function register(tools: Registry): void {
  tools.add("project_setup_undo", async (hub, caller, input) => {
    requireHuman(caller, "project_setup_undo");
    const r = input.projectRef;
    requireRole(caller, "operate", r.machineId);
    const message = chat(hub).byId(input.messageId);
    const item = message?.setupChanged;
    if (!message || !item || message.projectRef.machineId !== r.machineId || message.projectRef.projectId !== r.projectId) {
      throw new ToolError("not_found", `No setup line ${input.messageId} in this chat.`);
    }
    if (item.undone === true) return { ok: true, next: "Already undone." };
    const was = kept(hub, message.messageId);
    if (!was) {
      throw new ToolError("not_found", "fleetd no longer holds what was there before this change.", "Change it back in the project's settings.");
    }
    const running = undoing.get(hub) ?? new Set<string>();
    undoing.set(hub, running);
    if (running.has(message.messageId)) return { ok: true, next: "Already being undone." };
    running.add(message.messageId);
    try {
      const next = await restore(hub, caller, r, was.before, was.picture);
      chat(hub).setSetupChanged(message, { ...item, undone: true });
      hub.db.conn.query("DELETE FROM project_setup_changes WHERE message_id = ?").run(message.messageId);
      tell(hub, r, "quiet", `${caller.person?.name ?? caller.name} undid a setup change of yours: "${message.text ?? item.kind}". It is as it was before; make it again only if they ask.`);
      return { ok: true, ...(next !== undefined ? { next } : {}) };
    } finally {
      running.delete(message.messageId);
    }
  });
}

/** The lead's calls, and the wake owed to each lead whose clone a hub restart cut off. */
export function registerLeadCalls(hub: Hub): void {
  leadCalls(hub).register("repo_add", (caller, call) => repoAdd(hub, caller, call));
  leadCalls(hub).register("repo_remove", (caller, call) => repoRemove(hub, caller, call));
  leadCalls(hub).register("project_setup", (caller, call) => setup(hub, caller, call));
  tellInterrupted(hub);
}
