// A project's own settings (Settings › Projects in the app):
// `project_settings_get`, `project_settings_set` and `project_env_set`, and what the hub keeps of them:
// `project_settings.memory_refresh` (on by default), `project_settings.setup` (each new worktree's commands) and the
// `project_env` rows. A repo of the project can have its own `setup` (`repos.setup`).
//
// A variable is set on the project's node first, which keeps the value; only then does the hub record it. The hub's
// row holds a plain variable's value and a secret's fingerprint: a secret reaches the hub sealed to the node's box
// key, is relayed in the same call and is never stored, logged or returned.
import type { Database } from "bun:sqlite";
import type {
  EnvVarName,
  EnvVarSet,
  MachineId,
  ProjectEnvVar,
  ProjectRef,
  ProjectRepo,
  ProjectSettings,
  ProjectSummary,
  ProjectWorktrees,
  RepoId,
  RepoName,
  WorktreeSetup,
} from "../../shared/contracts.ts";
import { ToolError } from "../../shared/errors.ts";
import { CAP_PROJECT_SETTINGS, CAP_WORKTREE_SETUP } from "../../shared/node_link.ts";
import { isHuman, requireRole } from "../api/grants.ts";
import type { Hub } from "../api/hub.ts";
import { offline, unknownMachine, unknownProject } from "../api/refusals.ts";
import type { Caller, Registry } from "../api/registry.ts";
import { allows } from "../auth/index.ts";
import { executors } from "../executor/index.ts";
import { projectEnv, projectUpsert, projectWorktrees } from "../executor/projects.ts";
import { fromExecutor } from "../executor/tools.ts";
import { link } from "../link/server.ts";
import { who } from "../navi/owner.ts";
import { setOnlyMe as storeOnlyMe } from "../navi/store.ts";
import * as repos from "../repos/store.ts";
import { events } from "../store/events.ts";
import { store } from "../store/hub_store.ts";
import { isoMs } from "../store/time.ts";
import { adoptSoon, envIntoVault } from "../vault/aliases.ts";

export const PROJECT_ENV_MAX = 100;
/** Largest value of one variable, plain or secret: 64 KiB. */
export const ENV_VALUE_MAX_BYTES = 64 * 1024;
/** All of one project's values together: every one goes into every session's environment. */
export const ENV_TOTAL_MAX_BYTES = 512 * 1024;
const SEAL_OVERHEAD = 48;
const SETUP_TIMEOUT_DEFAULT_SEC = 600;

/** The refusal when a change would take a project's values past ENV_TOTAL_MAX_BYTES, naming the total. */
export const envTotalOver = (total: number) =>
  `A project's variables take at most 512 KiB together; these would take ${Math.ceil(total / 1024)} KiB.`;

/** The bytes standard base64 decodes to; undefined for text that isn't (secrets.rs `base64_bytes`). */
function base64Bytes(text: string): number | undefined {
  const body = text.replace(/==?$/, "");
  if (!/^[A-Za-z0-9+/]*$/.test(body) || body.length % 4 === 1 || text.length % 4 !== 0) return undefined;
  return Math.floor((body.length * 6) / 8);
}

/** A change's value size: a plain value's own, a secret's from its sealed box less the seal's overhead. */
const setBytes = (v: EnvVarSet) =>
  v.kind === "plain" ? Buffer.byteLength(v.value) : Math.max(0, (base64Bytes(v.sealed) ?? 0) - SEAL_OVERHEAD);

/** A setup as Rust's `WorktreeSetup` reads it, its defaults filled. */
const setupOf = (s: Partial<WorktreeSetup> | undefined): WorktreeSetup => ({
  commands: s?.commands ?? [],
  timeoutSec: s?.timeoutSec ?? SETUP_TIMEOUT_DEFAULT_SEC,
  runAnyway: s?.runAnyway ?? false,
  inputs: s?.inputs ?? [],
});
const isEmptySetup = (s: WorktreeSetup) => (s.commands ?? []).length === 0;

/** `project.settings` about `r`, with what changed in `data`: every open app reads that project's settings again. */
export function announce(hub: Hub, r: ProjectRef, summary: string, data: unknown): void {
  events(hub).append({ at: isoMs(hub.clock.now()), type: "project.settings", machineId: r.machineId, projectId: r.projectId, summary, data });
}

/** One row to write: a plain variable's value, or a secret's fingerprint. */
export type EnvRow = { name: EnvVarName; value?: string; fingerprint?: string; bytes: number };

export class ProjectSettingsStore {
  constructor(private readonly db: Database) {}

  private column<T>(r: ProjectRef, column: "memory_refresh" | "setup"): T | null | undefined {
    const row = this.db
      .query<Record<string, T | null>, [string, string]>(`SELECT ${column} FROM project_settings WHERE machine_id = ? AND project_id = ?`)
      .get(r.machineId, r.projectId);
    return row ? row[column] : undefined;
  }

  /** Whether the project's memory is refreshed each night: on until a person turns it off. */
  memoryRefresh(r: ProjectRef): boolean {
    const saved = this.column<number>(r, "memory_refresh");
    return saved === undefined || saved === null ? true : Boolean(saved);
  }

  setMemoryRefresh(r: ProjectRef, on: boolean): void {
    this.db
      .query(
        `INSERT INTO project_settings (machine_id, project_id, memory_refresh) VALUES (?, ?, ?)
                 ON CONFLICT (machine_id, project_id) DO UPDATE SET memory_refresh = excluded.memory_refresh`,
      )
      .run(r.machineId, r.projectId, on ? 1 : 0);
  }

  /** The project's setup commands; undefined when it has none. */
  setup(r: ProjectRef): WorktreeSetup | undefined {
    return parseSetup(this.column<string>(r, "setup"));
  }

  /** Replaces the project's setup commands; none turns setup off. */
  setSetup(r: ProjectRef, setup: WorktreeSetup): void {
    const json = isEmptySetup(setup) ? null : JSON.stringify(setupOf(setup));
    this.db
      .query(
        `INSERT INTO project_settings (machine_id, project_id, setup) VALUES (?, ?, ?)
                 ON CONFLICT (machine_id, project_id) DO UPDATE SET setup = excluded.setup`,
      )
      .run(r.machineId, r.projectId, json);
  }

  /** The setup commands a new worktree of `repo` runs: the repo's own, else the project's. */
  setupIn(r: ProjectRef, repo: RepoId | undefined): WorktreeSetup | undefined {
    if (repo !== undefined) {
      const own = parseSetup(this.repoJson(repo));
      if (own) return own;
    }
    return this.setup(r);
  }

  /** Replaces `repo`'s setup commands; none gives it the project's. `repo` undefined: the project's. */
  setSetupIn(r: ProjectRef, repo: RepoId | undefined, setup: WorktreeSetup): void {
    if (repo === undefined) return this.setSetup(r, setup);
    const n = repos.number(repo);
    if (n === undefined) return;
    this.db.query("UPDATE repos SET setup = ? WHERE n = ?").run(isEmptySetup(setup) ? null : JSON.stringify(setupOf(setup)), n);
  }

  private repoJson(repo: RepoId): string | null | undefined {
    const n = repos.number(repo);
    if (n === undefined) return undefined;
    return this.db.query<{ setup: string | null }, [number]>("SELECT setup FROM repos WHERE n = ?").get(n)?.setup;
  }

  /** The project's variables, by name. */
  env(r: ProjectRef): ProjectEnvVar[] {
    return this.db
      .query<
        { name: string; kind: string; value: string | null; fingerprint: string | null; bytes: number; updated_at: string },
        [string, string]
      >(
        `SELECT name, kind, value, fingerprint, bytes, updated_at FROM project_env
                 WHERE machine_id = ? AND project_id = ? ORDER BY name`,
      )
      .all(r.machineId, r.projectId)
      .map((row) => ({
        name: row.name,
        kind: row.kind === "secret" ? "secret" : "plain",
        ...(row.value !== null ? { value: row.value } : {}),
        ...(row.fingerprint !== null ? { fingerprint: row.fingerprint } : {}),
        bytes: row.bytes,
        updatedAt: row.updated_at,
      }));
  }

  /** Writes `set` and deletes `remove` in one transaction. */
  envApply(r: ProjectRef, set: EnvRow[], remove: EnvVarName[], at: string): void {
    this.db.transaction(() => {
      for (const name of remove) {
        this.db.query("DELETE FROM project_env WHERE machine_id = ? AND project_id = ? AND name = ?").run(r.machineId, r.projectId, name);
      }
      for (const row of set) {
        this.db
          .query(
            `INSERT INTO project_env (machine_id, project_id, name, kind, value, fingerprint, bytes, updated_at)
                     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                     ON CONFLICT (machine_id, project_id, name) DO UPDATE SET kind = excluded.kind,
                       value = excluded.value, fingerprint = excluded.fingerprint, bytes = excluded.bytes,
                       updated_at = excluded.updated_at`,
          )
          .run(
            r.machineId,
            r.projectId,
            row.name,
            row.fingerprint !== undefined ? "secret" : "plain",
            row.value ?? null,
            row.fingerprint ?? null,
            row.bytes,
            at,
          );
      }
    })();
  }
}

function parseSetup(json: string | null | undefined): WorktreeSetup | undefined {
  if (!json) return undefined;
  try {
    const setup = setupOf(JSON.parse(json) as Partial<WorktreeSetup>);
    return isEmptySetup(setup) ? undefined : setup;
  } catch {
    return undefined;
  }
}

export const projectSettings = (hub: Hub) => new ProjectSettingsStore(hub.db.conn);

/** The setup commands a new worktree of the project's task in `repo` runs: the repo's, else the project's. */
export const taskSetup = (hub: Hub, r: ProjectRef, repo: RepoId | undefined) => projectSettings(hub).setupIn(r, repo);

export const tooOld = (m: MachineId) =>
  new ToolError("invalid", `${m}'s node is too old to take project settings.`, `Update fleetd on ${m} and restart its node.`);

/** The node can take the call: it is online and new enough. */
function nodeReady(hub: Hub, m: MachineId): void {
  if (!store(hub).machineGet(m)) throw unknownMachine(m);
  if (!executors(hub).isConnected(m)) throw offline(m);
  if (!link(hub).can(m, CAP_PROJECT_SETTINGS)) throw tooOld(m);
}

/** The checkouts of the project's other repos on its own machine (projects/repos.rs `other_checkouts`). */
export function otherCheckouts(hub: Hub, r: ProjectRef): ProjectRef[] {
  return repos
    .of(hub.db.conn, r)
    .map((repo) => repo.checkout)
    .filter((c) => !(c.machineId === r.machineId && c.projectId === r.projectId) && c.machineId === r.machineId);
}

/** The repo named in a call, undefined when none is; an unknown one is refused, with the project's repos to pick from. */
export function repoNamed(hub: Hub, r: ProjectRef, name: RepoName | undefined): ProjectRepo | undefined {
  if (name === undefined) return undefined;
  const repo = repos.byName(hub.db.conn, r, name);
  if (repo) return repo;
  const names = repos.of(hub.db.conn, r).map((x) => x.name);
  const fix =
    names.length === 0
      ? "It has no repos: leave repo out for the project's own settings."
      : `Name one of its repos (${names.join(", ")}), or leave repo out for the project's own settings.`;
  throw new ToolError("not_found", `Project ${r.projectId} on ${r.machineId} has no repo ${name}.`, fix);
}

/** The project's settings, with `setup` that of `repo` when one is given. */
async function settingsOf(hub: Hub, r: ProjectRef, repo: ProjectRepo | undefined): Promise<ProjectSettings> {
  const project = store(hub).projectGet(r);
  if (!project) throw unknownProject(r);
  const s = projectSettings(hub);
  const m = r.machineId;
  let worktrees: (ProjectWorktrees & { signinsKept?: boolean }) | undefined;
  let worktreesUnknown: string | undefined;
  if (!store(hub).machineGet(m)) worktreesUnknown = `${m} was removed from this hub.`;
  else if (!executors(hub).isConnected(m)) worktreesUnknown = `${m} is offline.`;
  else if (!link(hub).can(m, CAP_PROJECT_SETTINGS)) worktreesUnknown = `${m}'s node is too old to say: update fleetd there.`;
  else {
    try {
      worktrees = await projectWorktrees(hub, m, r.projectId);
    } catch (error) {
      worktreesUnknown = fromExecutor(error).message;
    }
  }
  // The node says it with the worktrees; the settings say it of the project.
  const signinsKept = worktrees?.signinsKept;
  if (worktrees) delete worktrees.signinsKept;
  return {
    machineId: r.machineId,
    projectId: r.projectId,
    title: project.title,
    workspaceRoot: project.workspaceRoot,
    ...(repo ? { repo: repo.name } : {}),
    memoryRefresh: s.memoryRefresh(r),
    env: s.env(r),
    setup: s.setupIn(r, repo?.repoId) ?? setupOf(undefined),
    ...(worktrees ? { worktrees } : {}),
    ...(worktreesUnknown !== undefined ? { worktreesUnknown } : {}),
    ...(signinsKept !== undefined ? { signinsKept } : {}),
  } as ProjectSettings;
}

/**
 * Only me (D310), from a person's own device: its owner or an admin changes it, and only an admin turns it on for a
 * project nobody owns, which then becomes theirs; off, everyone on the hub sees and uses it.
 */
export function setOnlyMe(hub: Hub, caller: Caller, project: ProjectSummary, on: boolean): void {
  const r = { machineId: project.machineId, projectId: project.projectId };
  // As it is already: nothing to change, nothing to refuse.
  if (on === (project.onlyMe ?? false)) return;
  if (!isHuman(caller)) {
    throw new ToolError("forbidden", "Only a person turns Only me on or off, from one of their own devices.", "Change it in the app: the project's settings.");
  }
  const me = who(hub.db.conn, caller);
  const owns = project.owner !== undefined && project.owner === me;
  if (!owns && !allows(caller, "admin", r.machineId)) {
    const why =
      project.owner !== undefined
        ? "Only this project's owner, or an admin, turns Only me on or off."
        : "Nobody owns this project yet: only an admin turns Only me on for it, and it becomes theirs.";
    throw new ToolError("forbidden", why, "Ask the person whose project it is, or an admin.");
  }
  storeOnlyMe(hub.db.conn, r, on, me);
  announce(hub, r, `${project.title}: Only me ${on ? "on" : "off"}`, { onlyMe: on });
}

export function register(tools: Registry): void {
  tools.add("project_settings_get", async (hub, caller, input) => {
    requireRole(caller, "read", input.machineId);
    const r = { machineId: input.machineId, projectId: input.projectId };
    if (!store(hub).projectGet(r)) throw unknownProject(r);
    const repo = repoNamed(hub, r, input.repo);
    return { settings: await settingsOf(hub, r, repo) };
  });

  tools.add("project_settings_set", async (hub, caller, input) => {
    const m = input.machineId;
    requireRole(caller, "operate", m);
    const r = { machineId: m, projectId: input.projectId };
    const project = store(hub).projectGet(r);
    if (!project) throw unknownProject(r);
    const repo = repoNamed(hub, r, input.repo);
    // The name lives on the node, which renames it in place. The hub's cache takes it at once, and project.settings
    // tells every open app to read its projects again.
    if (input.title !== undefined && input.title !== project.title) {
      if (!executors(hub).isConnected(m)) throw offline(m);
      try {
        await projectUpsert(hub, m, r.projectId, input.title, project.workspaceRoot);
      } catch (error) {
        throw fromExecutor(error);
      }
      store(hub).projectsUpsertMany(m, [{ ...project, title: input.title }]);
      announce(hub, r, `${project.title} renamed ${input.title}`, { title: input.title });
    }
    if (input.onlyMe !== undefined) setOnlyMe(hub, caller, project, input.onlyMe);
    if (input.memoryRefresh !== undefined) projectSettings(hub).setMemoryRefresh(r, input.memoryRefresh);
    if (input.setup !== undefined) projectSettings(hub).setSetupIn(r, repo?.repoId, input.setup);
    const settings = await settingsOf(hub, r, repo);
    let next = "New tasks of the project use these settings.";
    if (input.memoryRefresh !== undefined && input.setup === undefined) {
      next = input.memoryRefresh
        ? "The lead refreshes this project's memory from tonight."
        : "The nightly memory refresh is off for this project; memory stays as the lead and you write it.";
    } else if (input.setup !== undefined && !isEmptySetup(input.setup) && !link(hub).can(m, CAP_WORKTREE_SETUP)) {
      next = `New tasks of the project use these settings. ${m}'s node is too old to run setup commands: update fleetd there.`;
    }
    return { settings, next };
  });

  tools.add("project_env_set", async (hub, caller, input) => {
    const m = input.machineId;
    requireRole(caller, "operate", m);
    if (!isHuman(caller)) {
      throw new ToolError("forbidden", "Only a person sets a project's environment.", "Set it in the desktop app: Settings › Projects.");
    }
    const r = { machineId: m, projectId: input.projectId };
    if (!store(hub).projectGet(r)) throw unknownProject(r);
    const s = projectSettings(hub);
    const set = input.set ?? [];
    const remove = input.remove ?? [];
    // Each variable after the change, by name, with its value's size.
    const sizes = new Map(s.env(r).map((v) => [v.name, v.bytes]));
    for (const name of remove) sizes.delete(name);
    for (const v of set) sizes.set(v.name, setBytes(v));
    if (sizes.size > PROJECT_ENV_MAX) {
      throw new ToolError("invalid", `A project takes at most ${PROJECT_ENV_MAX} variables; this would make ${sizes.size}.`, "Remove some first.");
    }
    const big = set.find((v) => setBytes(v) > ENV_VALUE_MAX_BYTES);
    if (big) {
      throw new ToolError("invalid", `${big.name}'s value is over 64 KiB.`, "Shorten it, or put a file on the machine and set its path instead.");
    }
    const total = [...sizes.values()].reduce((a, b) => a + b, 0);
    if (total > ENV_TOTAL_MAX_BYTES) {
      throw new ToolError("invalid", envTotalOver(total), "Remove or shorten some, or put large values in files on the machine.");
    }
    // The vault keeps them now (W549): a plain value, or a secret sealed to the hub's key, goes straight in. An older
    // app seals a secret to the node's key: it is forwarded as before and moves into the vault from the node.
    const { forNode, missed } = await envIntoVault(hub, caller, r, set, remove);
    if (forNode.set.length > 0 || forNode.remove.length > 0) {
      nodeReady(hub, m);
      let saved;
      try {
        saved = await projectEnv(hub, m, r.projectId, forNode.set, forNode.remove);
      } catch (error) {
        throw fromExecutor(error);
      }
      // Every checkout of the project's repos gets them too, sealed to the same machine (W79).
      for (const checkout of otherCheckouts(hub, r)) {
        try {
          await projectEnv(hub, m, checkout.projectId, forNode.set, forNode.remove);
        } catch (error) {
          missed.push(`${checkout.projectId} (${(error as Error).message})`);
        }
      }
      const rows: EnvRow[] = forNode.set.map((v) => {
        if (v.kind === "plain") return { name: v.name, value: v.value, bytes: Buffer.byteLength(v.value) };
        const fingerprint = saved.find((x) => x.name === v.name)?.fingerprint;
        if (fingerprint === undefined) {
          throw new ToolError("failed", `${m}'s node saved ${v.name} but sent no fingerprint for it.`, `Update fleetd on ${m}, then set ${v.name} again.`);
        }
        return { name: v.name, fingerprint, bytes: setBytes(v) };
      });
      s.envApply(r, rows, forNode.remove, isoMs(hub.clock.now()));
      adoptSoon(hub, m);
    }
    return {
      env: s.env(r),
      next:
        missed.length === 0
          ? "Every claude the node starts for the project from now on gets them; running sessions get them at their next start."
          : `The project has them, but these didn't take: ${missed.join(", ")}. Set them again to retry.`,
    };
  });
}
