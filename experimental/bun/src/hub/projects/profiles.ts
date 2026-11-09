// The hub's task profiles (Settings › Hub › Every project › Profiles; crates/fleetd/src/hub/projects/profiles.rs):
// `profiles_list`, `profile_create`, `profile_update`, `profile_delete`, and the `profiles` rows they keep, one per
// profile, exactly one of them the default. Each project allows the default and the profiles in its `project_profiles`
// rows. Leads start on the profile marked `is_lead`, the default when none is: the mark is never on the default.
import type { Database } from "bun:sqlite";
import type { Effort, Profile, ProfileModel, ProjectRef } from "../../shared/contracts.ts";
import { ToolError } from "../../shared/errors.ts";
import type { ApiModel } from "../../shared/sessions.ts";
import { CAP_CLAUDE_MODELS } from "../../shared/node_link.ts";
import { isHuman, requireRole } from "../api/grants.ts";
import type { Hub } from "../api/hub.ts";
import { allowsEverywhere, unknownProject } from "../api/refusals.ts";
import type { Caller, Registry } from "../api/registry.ts";
import { executors, READ_TIMEOUT_MS } from "../executor/index.ts";
import { link } from "../link/server.ts";
import { store } from "../store/hub_store.ts";
import { isoMs } from "../store/time.ts";

export const PROFILES_MAX = 50;
const EFFORTS: Effort[] = ["low", "medium", "high", "xhigh", "max"];

/** fleetd's own list of current Claude models, for a hub without an API key or whose endpoint lists none. */
export const BUILTIN_MODELS: [string, string][] = [
  ["claude-opus-5-5", "Claude Opus 5.5"],
  ["claude-fable-5-1", "Claude Fable 5.1"],
  ["claude-sonnet-5-5", "Claude Sonnet 5.5"],
  ["claude-haiku-5-5", "Claude Haiku 5.5"],
  ["claude-fable-5", "Claude Fable 5"],
  ["claude-opus-5", "Claude Opus 5"],
  ["claude-sonnet-5", "Claude Sonnet 5"],
  ["claude-opus-4-8", "Claude Opus 4.8"],
];

/** The models Claude Code offers fast mode on. */
export const FAST_MODELS = ["claude-opus-5-5", "claude-opus-5", "claude-opus-4-8"];
export const hasFast = (model: string) => FAST_MODELS.includes(model);

/** A profile's model unless claude refused it. */
export const usableModel = (p: Profile) => (p.refused === undefined ? p.model : undefined);

/** What a launch on one profile sends the node. */
export type Chosen = { profile: string; model?: string; effort: Effort; fast: boolean; helperModel?: string };

/** A new profile, or what an update changes. */
export type ProfileEdit = {
  name?: string;
  note?: string;
  model?: string;
  effort?: Effort;
  fast?: boolean;
  default: boolean;
  /** true makes it the lead's (on the default: leads follow the default). */
  lead?: boolean;
};

/** A change the profiles refuse, in a person's words. */
const refused = (why: string) => new ToolError("invalid", `${why}.`, "Pick another and try again.");

const COLUMNS = "id, name, note, model, effort, fast, is_default, refused, set_at, is_lead";

type Row = {
  id: number;
  name: string;
  note: string;
  model: string;
  effort: string;
  fast: number;
  is_default: number;
  refused: string | null;
  set_at: string;
  is_lead: number;
};

function rowOf(r: Row): Profile {
  const effort = (EFFORTS as string[]).includes(r.effort) ? (r.effort as Effort) : "high";
  const p: Profile = {
    id: r.id,
    name: r.name,
    note: r.note,
    model: r.model,
    effort,
    fast: Boolean(r.fast),
    default: Boolean(r.is_default),
    lead: Boolean(r.is_lead),
    updatedAt: r.set_at,
  } as Profile;
  if (r.refused !== null) p.refused = r.refused;
  return p;
}

/** The `profiles` rows (`HubDb::profiles()`). */
export class ProfileStore {
  constructor(private readonly db: Database) {}

  private one(where: string, ...args: (string | number)[]): Profile | undefined {
    const row = this.db.query<Row, (string | number)[]>(`SELECT ${COLUMNS} FROM profiles WHERE ${where}`).get(...args);
    return row ? rowOf(row) : undefined;
  }

  /** Every profile, the default first, then by name. */
  list(): Profile[] {
    return this.db.query<Row, []>(`SELECT ${COLUMNS} FROM profiles ORDER BY is_default DESC, name`).all().map(rowOf);
  }

  get(id: number): Profile | undefined {
    return this.one("id = ?", id);
  }

  byName(name: string): Profile | undefined {
    return this.one("name = ?", name);
  }

  /** The hub's default; a hub keeps one from its migration on. */
  defaultProfile(): Profile {
    const found = this.one("is_default = 1");
    if (!found) throw refused("the hub has no default profile");
    return found;
  }

  /** The profile leads start on: the one marked, else the default. */
  leadProfile(): Profile {
    return this.one("is_lead = 1") ?? this.defaultProfile();
  }

  /** The profiles a project allows, by name: the default first, then the ones it picked, by name. */
  allowed(r: ProjectRef): string[] {
    return this.db
      .query<{ name: string }, [string, string]>(
        `SELECT p.name FROM profiles p WHERE p.is_default = 1 OR EXISTS (
                   SELECT 1 FROM project_profiles a
                   WHERE a.machine_id = ? AND a.project_id = ? AND a.profile_id = p.id)
                 ORDER BY p.is_default DESC, p.name`,
      )
      .all(r.machineId, r.projectId)
      .map((row) => row.name);
  }

  /** Replaces what the project allows besides the default. A name no profile has is refused, naming it. */
  setAllowed(r: ProjectRef, names: string[]): void {
    const ids: number[] = [];
    for (const name of names) {
      const profile = this.byName(name);
      if (!profile) throw refused(`no profile is named ${name}`);
      if (!profile.default) ids.push(profile.id);
    }
    this.db.transaction(() => {
      this.db.query("DELETE FROM project_profiles WHERE machine_id = ? AND project_id = ?").run(r.machineId, r.projectId);
      for (const id of ids) {
        this.db
          .query("INSERT OR IGNORE INTO project_profiles (machine_id, project_id, profile_id) VALUES (?, ?, ?)")
          .run(r.machineId, r.projectId, id);
      }
    })();
  }

  /** Adds a profile; `edit` has every field but `fast`. A name taken is refused. */
  create(edit: ProfileEdit, at: string): Profile {
    const { name, model, effort } = edit;
    if (name === undefined || model === undefined || effort === undefined) throw refused("a profile needs a name, a model and an effort");
    if (this.byName(name)) throw refused(`a profile is already named ${name}`);
    const id = this.db.transaction(() => {
      if (edit.default) this.db.run("UPDATE profiles SET is_default = 0 WHERE is_default = 1");
      if (edit.lead === true) this.db.run("UPDATE profiles SET is_lead = 0 WHERE is_lead = 1");
      return Number(
        this.db
          .query(
            `INSERT INTO profiles (name, note, model, effort, fast, is_default, set_at, is_lead)
                   VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(name, edit.note ?? "", model, effort, edit.fast ? 1 : 0, edit.default ? 1 : 0, at, edit.lead === true && !edit.default ? 1 : 0)
          .lastInsertRowid,
      );
    })();
    const created = this.get(id);
    if (!created) throw refused("the new profile was not read back");
    return created;
  }

  /**
   * Changes the fields `edit` sets. A new model clears a refusal; `default` makes it the default. A name another
   * profile has is refused; a rename moves the tasks not yet ended to the new name, ended ones keep the old.
   */
  update(id: number, edit: ProfileEdit, at: string): Profile {
    const old = this.get(id);
    if (!old) throw refused(`no profile has id ${id}`);
    if (edit.name !== undefined && (this.byName(edit.name)?.id ?? id) !== id) throw refused(`a profile is already named ${edit.name}`);
    const model = edit.model ?? old.model;
    const keptRefusal = model === old.model ? (old.refused ?? null) : null;
    this.db.transaction(() => {
      if (edit.default) this.db.query("UPDATE profiles SET is_default = 0 WHERE is_default = 1 AND id != ?").run(id);
      // Picking it for the lead moves the mark here, or off every profile when this is the default.
      if (edit.lead === true) this.db.query("UPDATE profiles SET is_lead = 0 WHERE is_lead = 1 AND id != ?").run(id);
      const isDefault = edit.default || old.default;
      const lead = (edit.lead ?? old.lead) && !isDefault;
      this.db
        .query(
          `UPDATE profiles SET name = ?, note = ?, model = ?, effort = ?, fast = ?, is_default = ?, refused = ?,
                   set_at = ?, is_lead = ? WHERE id = ?`,
        )
        .run(
          edit.name ?? old.name,
          edit.note ?? old.note,
          model,
          edit.effort ?? old.effort,
          (edit.fast ?? old.fast) ? 1 : 0,
          isDefault ? 1 : 0,
          keptRefusal,
          at,
          lead ? 1 : 0,
          id,
        );
      // A rename carries the tasks not yet ended with it: they start again on it, and delete sees them.
      if (edit.name !== undefined && edit.name !== old.name) {
        this.db
          .query(
            `UPDATE tasks SET data = json_set(data, '$.profile', ?) WHERE state IN ('queued', 'running', 'idle')
                       AND json_extract(data, '$.profile') = ?`,
          )
          .run(edit.name, old.name);
      }
    })();
    const updated = this.get(id);
    if (!updated) throw refused(`no profile has id ${id}`);
    return updated;
  }

  /** Removes a profile and every project's choice of it. The caller refuses the default and one in use. */
  delete(id: number): void {
    this.db.transaction(() => {
      this.db.query("DELETE FROM project_profiles WHERE profile_id = ?").run(id);
      this.db.query("DELETE FROM profiles WHERE id = ? AND is_default = 0").run(id);
    })();
  }

  /** The tasks not yet ended that run on `name`, as ids. */
  inUse(name: string): string[] {
    return this.db
      .query<{ id: string }, [string]>(
        `SELECT 'T' || n AS id FROM tasks WHERE state IN ('queued', 'running', 'idle')
                   AND json_extract(data, '$.profile') = ? ORDER BY n`,
      )
      .all(name)
      .map((r) => r.id);
  }

  /** claude refused `model` for a session launched at `launchedAt`: every profile on it set before then is marked refused. */
  refuse(model: string, launchedAt: string, why: string): boolean {
    return (
      this.db.query("UPDATE profiles SET refused = ? WHERE model = ? AND refused IS NULL AND set_at <= ?").run(why, model, launchedAt).changes > 0
    );
  }

  /** What a new agent of `name` is launched with; a name no profile has any more runs on the default. */
  chosen(name: string): Chosen {
    const fallback = this.defaultProfile();
    const profile = this.byName(name) ?? fallback;
    const model = usableModel(profile);
    const helper = usableModel(fallback);
    return {
      profile: profile.name,
      ...(model !== undefined ? { model } : {}),
      effort: profile.effort,
      fast: profile.fast && hasFast(profile.model),
      ...(helper !== undefined ? { helperModel: helper } : {}),
    };
  }
}

export const profiles = (hub: Hub) => new ProfileStore(hub.db.conn);

/** The hub's API key as kept (which machines hold it), and the one of them online that can list its models. */
function apiMachine(hub: Hub): { key: string; machine?: string } | undefined {
  const row = hub.db.conn.query<{ data: string }, []>("SELECT data FROM claude_accounts WHERE account = 'hub'").get();
  if (!row) return undefined;
  const api = JSON.parse(row.data) as { sealedOn?: { machineId: string }[] };
  const machine = api.sealedOn?.map((s) => s.machineId).find((m) => executors(hub).isConnected(m) && link(hub).can(m, CAP_CLAUDE_MODELS));
  return { key: row.data, ...(machine !== undefined ? { machine } : {}) };
}

/** How long a list the Models API gave is reused. */
export const MODELS_FRESH_MS = 10 * 60_000;
/** How long fleetd's own list stands in after the API couldn't list, before it is asked again. */
export const MODELS_RETRY_MS = 60_000;
/** How long a read waits on the API before it answers with the last list (else fleetd's own) and lets the ask finish. */
export const MODELS_WAIT_MS = 1_000;

type Listed = [ProfileModel[], "api" | "builtin"];
/** The last list asked for the key kept as `key`, and the ask still running. */
type ModelCache = { key: string; at?: number; listed?: Listed; asking?: Promise<Listed> };
const modelCaches = new WeakMap<Hub, ModelCache>();

const builtinModels = (): Listed => [BUILTIN_MODELS.map(([id, name]) => ({ id, displayName: name, fast: hasFast(id) }) as ProfileModel), "builtin"];

/**
 * The models a profile may pick: what the Models API lists on the hub's API key, else fleetd's own list. The API is
 * asked through a machine holding the key at most once per MODELS_FRESH_MS (MODELS_RETRY_MS after it couldn't list),
 * again at once when the key changes, and never waited on past MODELS_WAIT_MS: an endpoint that didn't answer kept
 * every profiles_list waiting 10 s.
 */
export async function models(hub: Hub): Promise<Listed> {
  const api = apiMachine(hub);
  if (api?.machine === undefined) return builtinModels();
  const machine = api.machine;
  let c = modelCaches.get(hub);
  if (c?.key !== api.key) modelCaches.set(hub, (c = { key: api.key }));
  const cache = c;
  const age = hub.clock.now() - (cache.at ?? Number.NaN);
  if (cache.listed && age >= 0 && age < (cache.listed[1] === "api" ? MODELS_FRESH_MS : MODELS_RETRY_MS)) return cache.listed;
  cache.asking ??= askModels(hub, machine).then((listed) => {
    cache.at = hub.clock.now();
    cache.listed = listed;
    cache.asking = undefined;
    return listed;
  });
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<undefined>((resolve) => (timer = setTimeout(() => resolve(undefined), MODELS_WAIT_MS)));
  const answered = await Promise.race([cache.asking, late]);
  clearTimeout(timer);
  return answered ?? cache.listed ?? builtinModels();
}

async function askModels(hub: Hub, machine: string): Promise<Listed> {
  let fromApi: ApiModel[] = [];
  try {
    const out = await executors(hub).call(machine, "read", { op: "claude_models" }, READ_TIMEOUT_MS);
    if (out.kind === "claude_models" && out.error === undefined) fromApi = out.models;
  } catch {}
  const listed = fromApi
    .filter((m) => m.id !== "")
    .map((m): ProfileModel => ({ id: m.id, ...(m.displayName !== undefined ? { displayName: m.displayName } : {}), fast: hasFast(m.id) }) as ProfileModel);
  if (listed.length > 0) return [listed, "api"];
  return builtinModels();
}

const now = (hub: Hub) => isoMs(hub.clock.now());

/** A person's key whose person is an owner or admin, with admin on every machine (hub/people/tools.rs `administrator`). */
export function administrator(hub: Hub, caller: Caller): boolean {
  if (!isHuman(caller) || !caller.person) return false;
  const row = hub.db.conn
    .query<{ role: string }, [string]>("SELECT role FROM people WHERE person_id = ? AND removed_ms IS NULL")
    .get(caller.person.personId);
  return (row?.role === "owner" || row?.role === "admin") && allowsEverywhere(caller, "admin");
}

function requireAdministrator(hub: Hub, caller: Caller): void {
  if (administrator(hub, caller)) return;
  throw new ToolError(
    "forbidden",
    "Only the hub's owners and admins change task profiles.",
    "Ask an owner or admin; they change them on Settings › Hub › Every project › Profiles in the app.",
  );
}

/** What a change of the lead's profile says: where leads start now, and when. */
const leadLine = (lead: Profile) =>
  ` Leads start on ${lead.name} (${lead.model} at ${lead.effort}${lead.fast ? ", fast" : ""}) from each lead's next start.`;

const unknown = (id: number) => new ToolError("not_found", `No profile has id ${id}.`, "List them with profiles_list.");

/** `model` is one the list offers, or the one the profile already runs on; fast mode only where the model has it. */
async function checkModel(hub: Hub, model: string | undefined, kept: string | undefined, fast: boolean): Promise<void> {
  if (model !== undefined && model !== kept) {
    const [offered] = await models(hub);
    if (!offered.some((m) => m.id === model)) {
      throw new ToolError("invalid", `${model} is not among the models this hub offers.`, `Pick one of: ${offered.map((m) => m.id).join(", ")}.`);
    }
  }
  const effective = model ?? kept;
  if (effective !== undefined && fast && !hasFast(effective)) {
    throw new ToolError("invalid", `${effective} has no fast mode.`, `Turn fast off, or pick one of: ${FAST_MODELS.join(", ")}.`);
  }
}

export function register(tools: Registry): void {
  tools.add("profiles_list", async (hub, caller, input) => {
    const r = input.projectRef;
    requireRole(caller, "read", r?.machineId);
    if (r && !store(hub).projectGet(r)) throw unknownProject(r);
    const s = profiles(hub);
    const [offered, modelsFrom] = await models(hub);
    return {
      profiles: s.list().slice(0, PROFILES_MAX),
      ...(r ? { allowed: s.allowed(r) } : {}),
      models: offered.slice(0, 200),
      modelsFrom,
      efforts: EFFORTS,
    };
  });

  tools.add("profile_create", async (hub, caller, input) => {
    requireAdministrator(hub, caller);
    const s = profiles(hub);
    if (s.list().length >= PROFILES_MAX) {
      throw new ToolError("invalid", `The hub already keeps ${PROFILES_MAX} profiles.`, "Delete one it no longer needs first.");
    }
    const fast = input.fast ?? false;
    await checkModel(hub, input.model, undefined, fast);
    const profile = s.create(
      {
        name: input.name,
        note: input.note ?? "",
        model: input.model,
        effort: input.effort,
        fast,
        default: input.default ?? false,
        ...(input.lead !== undefined ? { lead: input.lead } : {}),
      },
      now(hub),
    );
    const lead = input.lead === true ? leadLine(profile) : "";
    return {
      profile,
      next: `Projects allow ${profile.name} once they pick it on their Agents page (project_set); new agents on it run ${profile.model} at ${profile.effort}.${lead}`,
    };
  });

  tools.add("profile_update", async (hub, caller, input) => {
    requireAdministrator(hub, caller);
    const s = profiles(hub);
    const old = s.get(input.id);
    if (!old) throw unknown(input.id);
    if (input.default === false && old.default) {
      throw new ToolError("invalid", `${old.name} is the default.`, "Make another profile the default instead.");
    }
    const model = input.model ?? old.model;
    // A model without fast mode turns it off unless the update asks for it.
    const fast = (input.fast ?? old.fast) && (input.fast === true || hasFast(model));
    await checkModel(hub, model, old.model, fast);
    const profile = s.update(
      input.id,
      {
        ...(input.name !== undefined ? { name: input.name } : {}),
        ...(input.note !== undefined ? { note: input.note } : {}),
        ...(input.model !== undefined ? { model: input.model } : {}),
        ...(input.effort !== undefined ? { effort: input.effort } : {}),
        fast,
        default: input.default === true,
        ...(input.lead !== undefined ? { lead: input.lead } : {}),
      },
      now(hub),
    );
    const lead = input.lead !== undefined ? leadLine(s.leadProfile()) : "";
    const renamed =
      profile.name !== old.name ? ` Ended tasks keep ${old.name} in their history; the ones not yet ended are on ${profile.name} now.` : "";
    return {
      profile,
      next: `New agents on ${profile.name} run ${profile.model} at ${profile.effort}${profile.fast ? ", fast" : ""} from their next start; running ones keep theirs.${renamed}${lead}`,
    };
  });

  tools.add("profile_delete", (hub, caller, input) => {
    requireAdministrator(hub, caller);
    const s = profiles(hub);
    const profile = s.get(input.id);
    if (!profile) throw unknown(input.id);
    if (profile.default) {
      throw new ToolError(
        "invalid",
        `${profile.name} is the default: every review and helper call runs on it.`,
        "Make another profile the default first.",
      );
    }
    const running = s.inUse(profile.name);
    if (running.length > 0) {
      throw new ToolError("invalid", `${profile.name} is in use by ${running.join(", ")}.`, "Delete it once those tasks have ended, or stop them first.");
    }
    s.delete(input.id);
    // The lead's mark goes with its row: leads fall back to the default.
    const lead = profile.lead
      ? ` Leads ran on it, so they start on the default, ${s.defaultProfile().name}, again from their next start.`
      : "";
    return { ok: true, next: `${profile.name} is gone, and no project allows it any more.${lead}` };
  });
}
