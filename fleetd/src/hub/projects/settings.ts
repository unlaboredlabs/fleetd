// A project's own settings (Settings › Projects in the app):
// `project_settings_get`, `project_settings_set` and `project_env_set`, and what the hub keeps of them:
// `project_settings.setup` (each new worktree's commands, in the project's own directory) and the `project_env` rows.
// Each of the project's other repos has its own `setup` (`repos.setup`); none falls back to another's.
// A bot's agents run on its machine, so it has no computer to pick and no computer image: the settings carry neither.
//
// A variable is set on the project's node first, which keeps the value; only then does the hub record it. The hub's
// row holds a plain variable's value and a secret's fingerprint: a secret reaches the hub sealed to the node's box
// key, is relayed in the same call and is never stored, logged or returned.
import type { Database } from "bun:sqlite";
import type {
  BotColor,
  EnvVarName,
  KnownBotColor,
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
import { BOT_COLORS, BOT_COLORS_WERE, BOT_SHAPES, type BotShape } from "../../shared/contracts.ts";
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
import { issueOrders } from "../issues/index.ts";
import { chatTagsOn, issueOrdersOn, setAvatarColor, setAvatarShape, setChatTags, setIssueOrders } from "../project_lead/store.ts";
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
/** A bot's color (the contracts' BOT_COLORS, which app/desktop/src/shared/bot.ts BOT_PAINT paints) when it has none. */
export const BOT_COLOR_DEFAULT: KnownBotColor = "grey";
/** A bot's body (the contracts' BOT_SHAPES, app/desktop/src/shared/bot.ts BOT_BODIES) when it has none. */
export const BOT_SHAPE_DEFAULT = "pebble";

/** The palette's color `color` is: its own, the one an earlier name became (an older app still sends those), or
 * undefined for one that isn't a bot's color. */
export const botColorOf = (color: BotColor): KnownBotColor | undefined =>
  (BOT_COLORS as readonly string[]).includes(color) ? (color as KnownBotColor) : BOT_COLORS_WERE[color];

/** The refusal when a change would take a project's values past ENV_TOTAL_MAX_BYTES, naming the total. */
export const envTotalOver = (total: number) =>
  `A bot's variables take at most 512 KiB together; these would take ${Math.ceil(total / 1024)} KiB.`;

/** The bytes standard base64 decodes to; undefined for text that isn't (secrets.rs `base64_bytes`). */
function base64Bytes(text: string): number | undefined {
  const body = text.replace(/==?$/, "");
  if (!/^[A-Za-z0-9+/]*$/.test(body) || body.length % 4 === 1 || text.length % 4 !== 0) return undefined;
  return Math.floor((body.length * 6) / 8);
}

/** A change's value size: a plain value's own, a secret's from its sealed box less the seal's overhead. */
const setBytes = (v: EnvVarSet) =>
  v.kind === "plain" ? Buffer.byteLength(v.value) : Math.max(0, (base64Bytes(v.sealed) ?? 0) - SEAL_OVERHEAD);

/** A setup with its defaults filled; an older app's or row's time limit and "start anyway" are dropped. */
const setupOf = (s: Partial<WorktreeSetup> | undefined): WorktreeSetup => ({
  commands: s?.commands ?? [],
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

  /** The setup commands of the project's own directory; undefined when it has none. */
  setup(r: ProjectRef): WorktreeSetup | undefined {
    const row = this.db
      .query<{ setup: string | null }, [string, string]>("SELECT setup FROM project_settings WHERE machine_id = ? AND project_id = ?")
      .get(r.machineId, r.projectId);
    return parseSetup(row?.setup);
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

  /** One of the project's other repos, by its row; undefined for its own directory (or none named). */
  private otherRepo(r: ProjectRef, repo: RepoId | undefined): number | undefined {
    const n = repo === undefined ? undefined : repos.number(repo);
    if (n === undefined) return undefined;
    const row = this.db
      .query<{ machine_id: string; project_id: string }, [number]>("SELECT checkout_machine_id AS machine_id, checkout_project_id AS project_id FROM repos WHERE n = ?")
      .get(n);
    return row && !(row.machine_id === r.machineId && row.project_id === r.projectId) ? n : undefined;
  }

  /** The setup commands a new worktree of `repo` runs: its own directory's, or that repo's own; none falls back. */
  setupIn(r: ProjectRef, repo: RepoId | undefined): WorktreeSetup | undefined {
    const n = this.otherRepo(r, repo);
    if (n === undefined) return this.setup(r);
    return parseSetup(this.db.query<{ setup: string | null }, [number]>("SELECT setup FROM repos WHERE n = ?").get(n)?.setup);
  }

  /** Replaces `repo`'s setup commands, none turning its setup off. Its own directory's are the project's. */
  setSetupIn(r: ProjectRef, repo: RepoId | undefined, setup: WorktreeSetup): void {
    const n = this.otherRepo(r, repo);
    if (n === undefined) return this.setSetup(r, setup);
    this.db.query("UPDATE repos SET setup = ? WHERE n = ?").run(isEmptySetup(setup) ? null : JSON.stringify(setupOf(setup)), n);
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

/** The setup commands a new worktree of the project's task in `repo` runs. */
export const taskSetup = (hub: Hub, r: ProjectRef, repo: RepoId | undefined) => projectSettings(hub).setupIn(r, repo);

export const tooOld = (m: MachineId) =>
  new ToolError("invalid", `${m}'s node is too old to take bot settings.`, `Update fleetd on ${m} and restart its node.`);

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
      ? "It has no repos: leave repo out for the bot's own settings."
      : `Name one of its repos (${names.join(", ")}), or leave repo out for the bot's own settings.`;
  throw new ToolError("not_found", `Bot ${r.projectId} on ${r.machineId} has no repo ${name}.`, fix);
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
  const setup = s.setupIn(r, repo?.repoId) ?? setupOf(undefined);
  return {
    machineId: r.machineId,
    projectId: r.projectId,
    title: project.title,
    workspaceRoot: project.workspaceRoot,
    ...(repo ? { repo: repo.name } : {}),
    env: s.env(r),
    setup,
    ...(worktrees ? { worktrees } : {}),
    ...(worktreesUnknown !== undefined ? { worktreesUnknown } : {}),
    ...(signinsKept !== undefined ? { signinsKept } : {}),
  } as ProjectSettings;
}

/**
 * Renames the project. The name lives on the node, which renames it in place; the hub's cache takes it at once, and
 * project.settings tells every open app to read its projects again.
 */
export async function rename(hub: Hub, project: ProjectSummary, title: string): Promise<void> {
  const m = project.machineId;
  const r = { machineId: m, projectId: project.projectId };
  if (!executors(hub).isConnected(m)) throw offline(m);
  try {
    await projectUpsert(hub, m, r.projectId, title, project.workspaceRoot);
  } catch (error) {
    throw fromExecutor(error);
  }
  store(hub).projectsUpsertMany(m, [{ ...project, title }]);
  announce(hub, r, `${project.title} renamed ${title}`, { title });
}

/** Gives the project's bot a color of the palette, and tells every app that shows it. An earlier name (an older app's)
 * is kept as it came, so that app still shows its pick; a newer app wears the color it became. */
export function setColor(hub: Hub, project: ProjectSummary, color: BotColor): void {
  const now = botColorOf(color);
  if (now === undefined) throw new ToolError("invalid", `${color} isn't one of the bot's colors.`, `Pick one of ${BOT_COLORS.join(", ")}.`);
  const r = { machineId: project.machineId, projectId: project.projectId };
  if ((botColorOf(project.avatarColor ?? BOT_COLOR_DEFAULT) ?? BOT_COLOR_DEFAULT) === now) return;
  setAvatarColor(hub.db.conn, r, color, now === BOT_COLOR_DEFAULT);
  announce(hub, r, `${project.title}'s bot is ${now} now`, { avatarColor: color });
}

/** Gives the project's bot a body of the shapes, and tells every app that shows it. */
export function setShape(hub: Hub, project: ProjectSummary, shape: BotShape): void {
  if (!(BOT_SHAPES as readonly string[]).includes(shape)) {
    throw new ToolError("invalid", `${shape} isn't one of the bot's shapes.`, `Pick one of ${BOT_SHAPES.join(", ")}.`);
  }
  const r = { machineId: project.machineId, projectId: project.projectId };
  if ((project.avatarShape ?? BOT_SHAPE_DEFAULT) === shape) return;
  setAvatarShape(hub.db.conn, r, shape);
  announce(hub, r, `${project.title}'s bot is a ${shape} now`, { avatarShape: shape });
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
    if (input.title !== undefined && input.title !== project.title) await rename(hub, project, input.title);
    // An older app's onlyMe is dropped as the call is decoded: every project is everyone's on the hub (D491).
    if (input.avatarColor !== undefined) setColor(hub, project, input.avatarColor);
    if (input.avatarShape !== undefined) setShape(hub, store(hub).projectGet(r) ?? project, input.avatarShape);
    if (input.chatTags !== undefined && input.chatTags !== chatTagsOn(hub.db.conn, r)) {
      setChatTags(hub.db.conn, r, input.chatTags);
      announce(hub, r, `${project.title}'s chat tags are ${input.chatTags ? "on" : "off"}`, { chatTags: input.chatTags });
    }
    if (input.issueOrders !== undefined && input.issueOrders !== issueOrdersOn(hub.db.conn, r)) {
      // Only a person flips it: an order's text (an issue's, among others) never reaches a bot's settings.
      if (!isHuman(caller)) throw new ToolError("forbidden", "Only a person turns issues as orders on or off.", "Ask the person to flip it in Settings › Bots.");
      setIssueOrders(hub.db.conn, r, input.issueOrders);
      // Labels its repos got while it was off stay as they are: only a labelling from now on opens an order.
      if (input.issueOrders) issueOrders(hub).rewatch(r);
      announce(hub, r, `${project.title}'s GitHub issues labelled fleetd ${input.issueOrders ? "open orders" : "no longer open orders"}`, { issueOrders: input.issueOrders });
    }
    if (input.setup !== undefined) projectSettings(hub).setSetupIn(r, repo?.repoId, input.setup);
    // A self-hosted hub's bots run on their machine: there is no computer to pick (an app made for fleetd's cloud may
    // still send one).
    if (input.computer !== undefined)
      throw new ToolError("invalid", "This hub's bots run on their own machine: there is no computer to pick.", "Leave the computer out.");
    const settings = await settingsOf(hub, r, repo);
    let next = "New tasks of the bot use these settings.";
    if ((input.avatarColor !== undefined || input.avatarShape !== undefined) && input.setup === undefined && input.title === undefined) {
      const look = [input.avatarShape !== undefined ? `a ${input.avatarShape}` : undefined, input.avatarColor !== undefined ? (botColorOf(input.avatarColor) ?? input.avatarColor) : undefined];
      next = `Its bot is ${look.filter((w) => w !== undefined).join(" in ")} on every device now.`;
    } else if (input.setup !== undefined && !isEmptySetup(input.setup) && !link(hub).can(m, CAP_WORKTREE_SETUP)) {
      next = `New tasks of the bot use these settings. ${m}'s node is too old to run setup commands: update fleetd there.`;
    }
    return { settings, next };
  });

  tools.add("project_env_set", async (hub, caller, input) => {
    const m = input.machineId;
    requireRole(caller, "operate", m);
    if (!isHuman(caller)) {
      throw new ToolError("forbidden", "Only a person sets a bot's environment.", "Set it in the desktop app: Settings › Bots.");
    }
    const r = { machineId: m, projectId: input.projectId };
    if (!store(hub).projectGet(r)) throw unknownProject(r);
    const { env, missed } = await setEnv(hub, caller, r, input.set ?? [], input.remove ?? []);
    return {
      env,
      next:
        missed.length === 0
          ? "Every claude the node starts for the bot from now on gets them; running sessions get them at their next start."
          : `The bot has them, but these didn't take: ${missed.join(", ")}. Set them again to retry.`,
    };
  });
}

/**
 * `project_env_set` once its caller may: the variables set and removed, as `caller` in the vault. Returns the
 * project's variables after it, and what didn't take.
 */
export async function setEnv(
  hub: Hub,
  caller: Caller,
  r: ProjectRef,
  set: EnvVarSet[],
  remove: EnvVarName[],
): Promise<{ env: ProjectEnvVar[]; missed: string[] }> {
  const m = r.machineId;
  const s = projectSettings(hub);
  // Each variable after the change, by name, with its value's size.
  const sizes = new Map(s.env(r).map((v) => [v.name, v.bytes]));
  for (const name of remove) sizes.delete(name);
  for (const v of set) sizes.set(v.name, setBytes(v));
  if (sizes.size > PROJECT_ENV_MAX) {
    throw new ToolError("invalid", `A bot takes at most ${PROJECT_ENV_MAX} variables; this would make ${sizes.size}.`, "Remove some first.");
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
  return { env: s.env(r), missed };
}
