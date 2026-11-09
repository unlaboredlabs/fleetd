// The pool's tables (migration `cloud_pool`): its settings, one row per slot,
// the starts it counted and its spend meter. Every row is written before the boat call it stands for; nothing about
// the pool is held only in memory.
import type { SQLQueryBindings } from "bun:sqlite";
import type { ProjectRef } from "../../shared/contracts.ts";
import type { HubDb } from "../store/db.ts";
import type { StartLimits } from "./boat.ts";

export type Settings = {
  hubId: string;
  enabled: boolean;
  poolSize: number;
  machineType: string;
  dayBudget: number;
  /** Undefined: the plan's included dollars. */
  monthBudget?: number;
  projects: ProjectRef[];
  environment?: string;
  hasKey: boolean;
  /** `billing`, `key` or `refused`, with its line. */
  paused?: [string, string];
  holdUntil?: number;
  holdReason?: string;
  backoffStep: number;
  full: boolean;
  starts?: StartLimits;
  planDollars?: number;
  strangersWarned: boolean;
};

/** The included dollars of boat's $20 plan, the month budget before /limits was ever read. */
export const PLAN_DOLLARS_UNKNOWN = 20;

export const monthBudget = (s: Settings) => s.monthBudget ?? s.planDollars ?? PLAN_DOLLARS_UNKNOWN;

export type SettingsChange = {
  enabled: boolean;
  poolSize: number;
  machineType: string;
  dayBudget: number;
  monthBudget?: number;
  projects: ProjectRef[];
  environment?: string;
};

/** boat's machine sizes, each with its list price an hour. */
export const MACHINE_TYPES: [string, number][] = [
  ["small", 0.018],
  ["default", 0.036],
  ["large", 0.072],
  ["xlarge", 0.2],
];

/** Dollars an hour for `kind`; an unknown size counts as the dearest. */
export const pricePerHour = (kind: string) => MACHINE_TYPES.find(([k]) => k === kind)?.[1] ?? MACHINE_TYPES[3]![1];

export type State = "creating" | "waking" | "awake" | "stopping" | "asleep" | "broken" | "failed" | "gone";
const STATES: State[] = ["creating", "waking", "awake", "stopping", "asleep", "broken", "failed", "gone"];
const parseState = (s: string): State => (STATES.includes(s as State) ? (s as State) : "gone");

/** Whether the hub wants the machine running. */
export const wanted = (s: State) => s === "creating" || s === "waking" || s === "awake";

/** One slot's row. */
export type Slot = {
  /** Also its machine id: `boat-1`. */
  slot: string;
  sandboxId?: string;
  state: State;
  idemKey?: string;
  /** The attempt's body, sealed to the hub's box key, while boat hasn't answered it. */
  createBody?: Uint8Array;
  bodyUntil?: number;
  createdAt: number;
  awakeSince?: number;
  wakeAt?: number;
  wakeWhy?: string;
  asleepSince?: number;
  leaseUntil?: number;
  renewedAt?: number;
  idleSince?: number;
  wakeFailures: number;
  note?: string;
};

export const newSlot = (slot: string, now: number): Slot => ({ slot, state: "failed", createdAt: now, wakeFailures: 0 });

const SLOT_COLUMNS =
  "slot, sandbox_id, state, idem_key, create_body, body_until, created_at, awake_since, wake_at, wake_why, asleep_since, lease_until, renewed_at, idle_since, wake_failures, note";

type SlotRow = {
  slot: string;
  sandbox_id: string | null;
  state: string;
  idem_key: string | null;
  create_body: Uint8Array | null;
  body_until: number | null;
  created_at: number;
  awake_since: number | null;
  wake_at: number | null;
  wake_why: string | null;
  asleep_since: number | null;
  lease_until: number | null;
  renewed_at: number | null;
  idle_since: number | null;
  wake_failures: number;
  note: string | null;
};

const opt = <T>(v: T | null): T | undefined => (v === null ? undefined : v);

function slotOf(r: SlotRow): Slot {
  const s: Slot = { slot: r.slot, state: parseState(r.state), createdAt: r.created_at, wakeFailures: r.wake_failures };
  const set = <K extends keyof Slot>(k: K, v: Slot[K] | undefined) => {
    if (v !== undefined) s[k] = v;
  };
  set("sandboxId", opt(r.sandbox_id));
  set("idemKey", opt(r.idem_key));
  set("createBody", r.create_body ? new Uint8Array(r.create_body) : undefined);
  set("bodyUntil", opt(r.body_until));
  set("awakeSince", opt(r.awake_since));
  set("wakeAt", opt(r.wake_at));
  set("wakeWhy", opt(r.wake_why));
  set("asleepSince", opt(r.asleep_since));
  set("leaseUntil", opt(r.lease_until));
  set("renewedAt", opt(r.renewed_at));
  set("idleSince", opt(r.idle_since));
  set("note", opt(r.note));
  return s;
}

/** One window of the start budget. */
export type Window = "minute" | "hour" | "day";
export const WINDOWS: Window[] = ["minute", "hour", "day"];
export const windowMs = (w: Window) => (w === "minute" ? 60_000 : w === "hour" ? 3_600_000 : 86_400_000);

type SettingsRow = {
  hub_id: string;
  enabled: number;
  pool_size: number;
  machine_type: string;
  day_budget: number;
  month_budget: number | null;
  projects: string;
  environment: string | null;
  has_key: number;
  paused_kind: string | null;
  paused_reason: string | null;
  hold_until: number | null;
  hold_reason: string | null;
  backoff_step: number;
  full: number;
  starts_minute: number | null;
  starts_hour: number | null;
  starts_day: number | null;
  plan_dollars: number | null;
  strangers_warned: number;
};

export class Ledger {
  constructor(private readonly db: HubDb) {}

  private exec(sql: string, ...params: SQLQueryBindings[]): void {
    this.db.conn.query(sql).run(...params);
  }

  settings(): Settings {
    const r = this.db.conn
      .query<SettingsRow, []>(
        `SELECT hub_id, enabled, pool_size, machine_type, day_budget, month_budget, projects, environment,
                sealed_key IS NOT NULL AS has_key, paused_kind, paused_reason, hold_until, hold_reason, backoff_step, full,
                starts_minute, starts_hour, starts_day, plan_dollars, strangers_warned
           FROM pool_settings WHERE id = 1`,
      )
      .get();
    if (!r) throw new Error("the pool's settings row is missing (migration cloud_pool)");
    let projects: ProjectRef[] = [];
    try {
      projects = JSON.parse(r.projects) as ProjectRef[];
    } catch {
      projects = [];
    }
    const s: Settings = {
      hubId: r.hub_id,
      enabled: Boolean(r.enabled),
      poolSize: r.pool_size,
      machineType: r.machine_type,
      dayBudget: r.day_budget,
      projects,
      hasKey: Boolean(r.has_key),
      backoffStep: r.backoff_step,
      full: Boolean(r.full),
      strangersWarned: Boolean(r.strangers_warned),
    };
    if (r.month_budget !== null) s.monthBudget = r.month_budget;
    if (r.environment !== null) s.environment = r.environment;
    if (r.paused_kind !== null) s.paused = [r.paused_kind, r.paused_reason ?? ""];
    if (r.hold_until !== null) s.holdUntil = r.hold_until;
    if (r.hold_reason !== null) s.holdReason = r.hold_reason;
    if (r.starts_minute !== null && r.starts_hour !== null && r.starts_day !== null) {
      s.starts = { perMinute: r.starts_minute, perHour: r.starts_hour, perDay: r.starts_day };
    }
    if (r.plan_dollars !== null) s.planDollars = r.plan_dollars;
    return s;
  }

  changeSettings(s: SettingsChange): void {
    this.exec(
      `UPDATE pool_settings SET enabled = ?1, pool_size = ?2, machine_type = ?3, day_budget = ?4,
         month_budget = ?5, projects = ?6, environment = ?7 WHERE id = 1`,
      s.enabled ? 1 : 0,
      s.poolSize,
      s.machineType,
      s.dayBudget,
      s.monthBudget ?? null,
      JSON.stringify(s.projects.map((p) => ({ machineId: p.machineId, projectId: p.projectId }))),
      s.environment ?? null,
    );
  }

  setEnabled(enabled: boolean): void {
    this.exec("UPDATE pool_settings SET enabled = ?1 WHERE id = 1", enabled ? 1 : 0);
  }

  /** The boat key, sealed to the hub's box key; undefined forgets it. */
  setSealedKey(sealed: Uint8Array | undefined): void {
    this.exec("UPDATE pool_settings SET sealed_key = ?1, paused_kind = NULL, paused_reason = NULL WHERE id = 1", sealed ?? null);
  }

  sealedKey(): Uint8Array | undefined {
    const r = this.db.conn.query<{ sealed_key: Uint8Array | null }, []>("SELECT sealed_key FROM pool_settings WHERE id = 1").get();
    return r?.sealed_key ? new Uint8Array(r.sealed_key) : undefined;
  }

  /** The hub's SSH key, sealed: `sealed` is kept only if none is yet, and the one kept is returned. */
  sshKeyOr(sealed: Uint8Array): Uint8Array {
    this.exec("UPDATE pool_settings SET ssh_key = ?1 WHERE id = 1 AND ssh_key IS NULL", sealed);
    return this.sealedSshKey()!;
  }

  sealedSshKey(): Uint8Array | undefined {
    const r = this.db.conn.query<{ ssh_key: Uint8Array | null }, []>("SELECT ssh_key FROM pool_settings WHERE id = 1").get();
    return r?.ssh_key ? new Uint8Array(r.ssh_key) : undefined;
  }

  setPaused(paused: [string, string] | undefined): void {
    this.exec("UPDATE pool_settings SET paused_kind = ?1, paused_reason = ?2 WHERE id = 1", paused?.[0] ?? null, paused?.[1] ?? null);
  }

  setHold(until: number | undefined, reason: string | undefined, step: number): void {
    this.exec("UPDATE pool_settings SET hold_until = ?1, hold_reason = ?2, backoff_step = ?3 WHERE id = 1", until ?? null, reason ?? null, step);
  }

  setFull(full: boolean): void {
    this.exec("UPDATE pool_settings SET full = ?1 WHERE id = 1", full ? 1 : 0);
  }

  setPlan(starts: StartLimits | undefined, planDollars: number | undefined): void {
    this.exec(
      `UPDATE pool_settings SET starts_minute = ?1, starts_hour = ?2, starts_day = ?3,
         plan_dollars = coalesce(?4, plan_dollars) WHERE id = 1`,
      starts?.perMinute ?? null,
      starts?.perHour ?? null,
      starts?.perDay ?? null,
      planDollars ?? null,
    );
  }

  setStrangersWarned(warned: boolean): void {
    this.exec("UPDATE pool_settings SET strangers_warned = ?1 WHERE id = 1", warned ? 1 : 0);
  }

  slots(): Slot[] {
    return this.db.conn.query<SlotRow, []>(`SELECT ${SLOT_COLUMNS} FROM pool_machines ORDER BY slot`).all().map(slotOf);
  }

  slot(slot: string): Slot | undefined {
    const r = this.db.conn.query<SlotRow, [string]>(`SELECT ${SLOT_COLUMNS} FROM pool_machines WHERE slot = ?1`).get(slot);
    return r ? slotOf(r) : undefined;
  }

  put(s: Slot): void {
    this.exec(
      `INSERT OR REPLACE INTO pool_machines (${SLOT_COLUMNS})
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16)`,
      s.slot,
      s.sandboxId ?? null,
      s.state,
      s.idemKey ?? null,
      s.createBody ?? null,
      s.bodyUntil ?? null,
      s.createdAt,
      s.awakeSince ?? null,
      s.wakeAt ?? null,
      s.wakeWhy ?? null,
      s.asleepSince ?? null,
      s.leaseUntil ?? null,
      s.renewedAt ?? null,
      s.idleSince ?? null,
      s.wakeFailures,
      s.note ?? null,
    );
  }

  countStart(slot: string, what: string, at: number): number {
    return Number(this.db.conn.query("INSERT INTO pool_starts (at, slot, what) VALUES (?1, ?2, ?3)").run(at, slot, what).lastInsertRowid);
  }

  uncountStart(row: number): void {
    this.exec("UPDATE pool_starts SET refused = 1 WHERE rowid = ?1", row);
  }

  startsIn(window: Window, now: number): [number, number | undefined] {
    const r = this.db.conn
      .query<{ n: number; oldest: number | null }, [number]>("SELECT count(*) AS n, min(at) AS oldest FROM pool_starts WHERE refused = 0 AND at > ?1")
      .get(now - windowMs(window));
    return [r?.n ?? 0, opt(r?.oldest ?? null)];
  }

  openSpend(slot: string, sandboxId: string | undefined, from: number, perHour: number): number {
    return Number(
      this.db.conn.query("INSERT INTO pool_spend (slot, sandbox_id, from_ms, per_hour) VALUES (?1, ?2, ?3, ?4)").run(slot, sandboxId ?? null, from, perHour).lastInsertRowid,
    );
  }

  dropSpend(id: number): void {
    this.exec("DELETE FROM pool_spend WHERE id = ?1", id);
  }

  hasOpenSpend(slot: string): boolean {
    return this.db.conn.query("SELECT 1 FROM pool_spend WHERE slot = ?1 AND until_ms IS NULL").get(slot) !== null;
  }

  closeSpend(slot: string, at: number): void {
    this.exec("UPDATE pool_spend SET until_ms = max(from_ms, ?2) WHERE slot = ?1 AND until_ms IS NULL", slot, at);
  }

  nameSpend(slot: string, sandboxId: string): void {
    this.exec("UPDATE pool_spend SET sandbox_id = ?2 WHERE slot = ?1 AND sandbox_id IS NULL", slot, sandboxId);
  }

  /** The hub's own meter since `since`: dollars by sandbox (or slot, for a create boat hasn't answered). */
  meter(since: number, now: number): [string, number][] {
    const rows = this.db.conn
      .query<{ id: string; from_ms: number; until_ms: number; per_hour: number }, [number, number]>(
        `SELECT coalesce(sandbox_id, slot) AS id, from_ms, coalesce(until_ms, ?2) AS until_ms, per_hour FROM pool_spend
          WHERE coalesce(until_ms, ?2) > ?1`,
      )
      .all(since, now);
    const out: [string, number][] = [];
    for (const r of rows) {
      const ms = Math.max(0, Math.min(r.until_ms, now) - Math.max(r.from_ms, since));
      const dollars = (r.per_hour * ms) / 3_600_000;
      const at = out.find(([k]) => k === r.id);
      if (at) at[1] += dollars;
      else out.push([r.id, dollars]);
    }
    return out;
  }

  setBoatCost(sandboxId: string, since: number, dollars: number): void {
    this.exec("INSERT OR REPLACE INTO pool_boat_cost (sandbox_id, since_ms, dollars) VALUES (?1, ?2, ?3)", sandboxId, since, dollars);
  }

  /** Spent since `since`: each machine's larger of the hub's meter and boat's own cost. */
  spent(since: number, now: number): number {
    const meter = this.meter(since, now);
    const boat = this.db.conn
      .query<{ sandbox_id: string; dollars: number }, [number]>("SELECT sandbox_id, dollars FROM pool_boat_cost WHERE since_ms = ?1")
      .all(since);
    let total = meter.map(([id, ours]) => Math.max(ours, boat.find((b) => b.sandbox_id === id)?.dollars ?? 0)).reduce((a, b) => a + b, 0);
    total += boat.filter((b) => !meter.some(([m]) => m === b.sandbox_id)).reduce((a, b) => a + b.dollars, 0);
    return total;
  }

  meteredSince(since: number, now: number): string[] {
    return this.meter(since, now)
      .map(([id]) => id)
      .filter((id) => id.startsWith("bx_"));
  }

  prune(now: number): void {
    const old = now - 40 * 86_400_000;
    this.exec("DELETE FROM pool_starts WHERE at <= ?1", now - windowMs("day"));
    this.exec("DELETE FROM pool_spend WHERE until_ms IS NOT NULL AND until_ms < ?1", old);
    this.exec("DELETE FROM pool_boat_cost WHERE since_ms < ?1", old);
  }
}
