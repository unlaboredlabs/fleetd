// Cloud machines on boat.dev (crates/fleetd/src/hub/pool/mod.rs, view.rs, life.rs, sweep.rs; D306): the hub keeps a
// small fixed pool of named boat machines (`boat-1`…`boat-N`), each an ordinary fleetd machine once it joins, stopped
// when idle and resumed when work needs it. Each hub uses its owner's own boat key, sealed to the hub's box key.
//
// The fences against a surprise bill, all here: the ledger (every row written before the boat call it stands for),
// the lease (boat's own auto-stop, renewed every 10 minutes, at most 30 minutes), the life loop (idle, budget,
// node-vanished and wake-timeout stops), the sweep (boat's own list against the ledger, at start and every 10 min),
// the start budget (half of boat's included starts, a pre-flight, never an extra start), the kill switch, and the
// keepalive (a slot asleep 12 days is woken so boat keeps its disk).
import { randomBytes } from "node:crypto";
import type { CloudKeyTest, CloudMachine, CloudMachineState, CloudPathTest, CloudSize } from "../../shared/contracts.ts";
import type { Clock } from "../../shared/clock.ts";
import { loadOrCreateBoxKey, openSealed, publicKeyOf, seal } from "../../shared/sealed_box.ts";
import { archiveAfterMs, type Boat, type BoatError, BoatFailure, boatError, boatLine, aboutTheRequest, createBody, createBytes, type File, type Limits, phase, type Sandbox } from "./boat.ts";
import { clamp, LEASE_S, SETUP_S, type Lease, type Ttl, ttlMs } from "./lease.ts";
import { Ledger, MACHINE_TYPES, monthBudget, newSlot, pricePerHour, type Settings, type Slot, type State, wanted, WINDOWS } from "./ledger.ts";
import * as starts from "./starts.ts";
import { hubKey, publicLine, type Tunnels } from "./tunnel.ts";
import type { HubDb } from "../store/db.ts";
import { pause } from "../cloud/every.ts";
import { failure as setupFailure } from "../cloud/setup.ts";

export const LABEL_HUB = "fleetd.hub";
export const LABEL_SLOT = "fleetd.slot";
export const LABEL_ATTEMPT = "fleetd.attempt";

const MINUTE = 60_000;
export const IDLE_GRACE_MS = 15 * MINUTE;
export const KEEPALIVE_GRACE_MS = 5 * MINUTE;
export const HELLO_MS = 2 * MINUTE;
export const BROKEN_AFTER = 2;
export const CREATE_HELLO_MS = 15 * MINUTE;
export const SILENT_MS = 10 * MINUTE;
export const RENEW_MS = 10 * MINUTE;
export const KEEPALIVE_AFTER_MS = 12 * 24 * 60 * MINUTE;
export const CLAIM_MS = 2 * MINUTE;
export const OVERDUE_MS = 2 * MINUTE;
export const SWEEP_MS = 10 * MINUTE;
export const TICK_MS = 30_000;
export const POOL_MAX = 10;
export const BUDGET_MAX = 1000;

/** What the pool reads about the machines it made, from the node link. */
export interface Fleet {
  lastSeen(machine: string): number | undefined;
  /** Whether anything keeps it busy, from its node's latest heartbeat; undefined from a node that doesn't say. */
  busy(machine: string): boolean | undefined;
  /** Whether its node has caught up since it linked (hub/cloud's `ready`). */
  ready(machine: string): boolean;
  /** Whether the hub hears its other machines normally: a stalled hub must not stop cloud machines for it. */
  othersHeard(besides: string[], now: number): boolean;
  /** The machine is awake for work now: placement runs the tasks queue again. */
  woke?(machine: string): void;
}

export type Why = "need" | "keepalive" | "test";

/** What a create sends besides what the pool always does. */
export type CreateSpec = { setupScript?: string; files: File[]; bodyUntil: number };

export type Budget = { daySpent: number; monthSpent: number; dayBudget: number; monthBudget: number; left: number };

export function budgetLine(b: Budget): string | undefined {
  if (b.daySpent >= b.dayBudget) {
    return `cloud paused: today's boat.dev budget ($${b.dayBudget.toFixed(2)}) is spent; work runs on your own machines when there's room`;
  }
  if (b.monthSpent >= b.monthBudget) {
    return `cloud paused: this month's boat.dev budget ($${b.monthBudget.toFixed(2)}) is spent; work runs on your own machines when there's room`;
  }
  return undefined;
}

/** What the kill switch did. */
export type Kill = { stopped: string[]; failed: [string, string][]; unlisted?: string };

type PathTest = { slot: string; since: number; result?: { ok: string } | { err: string } };

/** The machines' sizes with their list prices. */
export const sizes = (): CloudSize[] => MACHINE_TYPES.map(([kind, perHour]) => ({ kind, perHour }));
/** The slots of a pool of `n`: `boat-1`…`boat-n`. */
export const slotNames = (n: number) => Array.from({ length: n }, (_, i) => `boat-${i + 1}`);

/** The hub machine's zone: `TZ`, else UTC (attention `hub_zone`). */
export function hubZone(): string {
  const tz = process.env.TZ?.replace(/^:/, "");
  if (tz) {
    try {
      new Intl.DateTimeFormat("en", { timeZone: tz });
      return tz;
    } catch {}
  }
  return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
}

/** The zone's offset from UTC at `ms`, in ms. */
function offsetAt(ms: number, zone: string): number {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", { timeZone: zone, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" })
      .formatToParts(new Date(ms))
      .map((p) => [p.type, p.value]),
  );
  const local = Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day), Number(parts.hour), Number(parts.minute), Number(parts.second));
  return local - Math.floor(ms / 1000) * 1000;
}

function localDate(ms: number, zone: string): [number, number, number] {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", { timeZone: zone, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date(ms)).map((x) => [x.type, x.value]),
  );
  return [Number(p.year), Number(p.month), Number(p.day)];
}

/** Midnight of `y-m-d` in `zone`, ms (the earliest, across a DST change). */
function midnight(y: number, m: number, d: number, zone: string): number {
  const guess = Date.UTC(y, m - 1, d);
  const first = guess - offsetAt(guess, zone);
  return guess - offsetAt(first, zone);
}

/** Midnight today in `zone`, ms. */
export function dayStart(now: number, zone: string): number {
  try {
    const [y, m, d] = localDate(now, zone);
    return midnight(y, m, d, zone);
  } catch {
    return now - (((now % 86_400_000) + 86_400_000) % 86_400_000);
  }
}

/** The 1st of this month at midnight in `zone`, ms. */
export function monthStart(now: number, zone: string): number {
  try {
    const [y, m] = localDate(now, zone);
    return midnight(y, m, 1, zone);
  } catch {
    return dayStart(now, zone);
  }
}

const cloudState = (s: State): CloudMachineState => s;

/** `/limits` in one line: the plan, its starts, the machines running and whether the pool's size is allowed. */
export function limitsLine(l: Limits, kind: string): string {
  const parts = ["Key works"];
  if (typeof l.sandboxPlanDollars === "number") parts.push(`$${l.sandboxPlanDollars.toFixed(0)} plan`);
  if (l.startLimits) parts.push(`${l.startLimits.perDay} starts a day (${l.startLimits.perMinute} a minute)`);
  parts.push(`${l.activeSandboxes} of ${l.maxActiveSandboxes} machines running`);
  const t = l.machineTypes.find((x) => x.type === kind);
  if (t?.available) parts.push(`${kind} allowed`);
  else if (t) parts.push(`${kind} not allowed on this plan${t.reason ? ` (${t.reason})` : ""}`);
  let line = parts.join(" · ");
  if (!l.canStart) line += `. But boat.dev says: ${l.startBlockedReason ?? "it can't start machines now"}`;
  return line;
}

/** What a refusal of the hub's key means, in plain words. */
export function keyWords(e: BoatError): string {
  if (e.kind === "key_refused") {
    switch (e.code) {
      case "api_key_expired":
        return "boat.dev says the key has expired: make a new one and paste it here";
      case "api_key_action_forbidden":
        return "boat.dev refused an action this key lacks: give it account.read and sandbox.read, and the rest of the actions the setup step lists";
      case "api_key_sandbox_forbidden":
        return "boat.dev says the key can't reach these machines: scope it to the fleetd environment";
      case "unauthorized":
      case "invalid_api_key":
      case "":
        return "boat.dev doesn't know this key: check it was copied whole";
      default:
        return `boat.dev refused the key (${e.code})`;
    }
  }
  if (e.kind === "billing") return `The key works, but boat.dev needs billing attention (${e.code})`;
  return boatLine(e);
}

/** "Today $0.41 of $3.00 · this month $6.10 of $20.00". */
export const spendLine = (day: number, dayBudget: number, month: number, monthBudget: number) =>
  `Today $${day.toFixed(2)} of $${dayBudget.toFixed(2)} · this month $${month.toFixed(2)} of $${monthBudget.toFixed(2)}`;

/** One lock per slot: a wake, a create, the life loop's step for it. */
class Locks {
  private readonly tails = new Map<string, Promise<void>>();
  async with<T>(slot: string, f: () => Promise<T>): Promise<T> {
    const before = this.tails.get(slot) ?? Promise.resolve();
    let release!: () => void;
    const mine = new Promise<void>((r) => (release = r));
    this.tails.set(slot, before.then(() => mine));
    await before;
    try {
      return await f();
    } finally {
      release();
    }
  }
}

const words = (e: unknown) => (e instanceof Error ? e.message : String(e));

export class Pool {
  readonly ledger: Ledger;
  private readonly locks = new Locks();
  /** Placement's claims on awake machines: when each was last claimed. */
  readonly claims = new Map<string, number>();
  private ready_ = false;
  private readonly warned = new Set<string>();
  readonly waking = new Set<string>();
  private keyTest_: CloudKeyTest | undefined;
  private path: PathTest | undefined;
  readonly hydrated_ = new Set<string>();
  /** When this hub process began watching its machines: a hello deadline counts only time since then. */
  private readonly watchingSince: number;

  constructor(
    db: HubDb,
    readonly home: string,
    readonly boat: Boat,
    readonly tunnels: Tunnels,
    readonly fleet: Fleet,
    private readonly clock: Clock,
    readonly zone: string,
  ) {
    this.ledger = new Ledger(db);
    this.watchingSince = clock.now();
  }

  now(): number {
    return this.clock.now();
  }

  ready(): boolean {
    return this.ready_;
  }

  setReady(): void {
    this.ready_ = true;
  }

  private boxKey(): Uint8Array {
    try {
      return loadOrCreateBoxKey(this.home);
    } catch (e) {
      console.error("pool: hub box key:", e);
      throw new Error("the hub can't read its box key: check the hub's home directory");
    }
  }

  /** The public half of the hub's SSH key, made now if it isn't yet: what boat puts on each machine. */
  sshPublicKey(): string {
    return publicLine(hubKey(this.ledger, this.home));
  }

  /** The slot's tunnel: held while its machine should be up, closed otherwise. */
  syncTunnel(row: Slot): void {
    if (row.sandboxId !== undefined && (wanted(row.state) || row.state === "stopping")) this.tunnels.open(row.slot, row.sandboxId);
    else this.tunnels.close(row.slot);
  }

  hydrated(slot: string): boolean {
    return this.hydrated_.has(slot);
  }

  /** Why the slot's tunnel isn't up, when one is held and isn't. */
  tunnelDown(slot: string): string | undefined {
    const t = this.tunnels.status(slot);
    return t && "down" in t ? t.down : undefined;
  }

  waited(at: number, now: number): number {
    return now - Math.max(at, this.watchingSince);
  }

  lock<T>(slot: string, f: () => Promise<T>): Promise<T> {
    return this.locks.with(slot, f);
  }

  /** Keeps the admin's boat key sealed to the hub's box key; the plaintext is never stored or returned. */
  setKey(key: string): void {
    const k = key.trim();
    if (k === "") throw new Error("an empty boat.dev key");
    this.ledger.setSealedKey(seal(publicKeyOf(this.boxKey()), new TextEncoder().encode(k)));
    // A new key is untested, and what boat said to the old one about a create no longer holds.
    this.heard(undefined);
    this.forgetRefusedCreates();
  }

  /** The admin's boat key, opened with the hub's box key. */
  openKey(): string {
    const sealed = this.ledger.sealedKey();
    if (!sealed) throw new BoatFailure({ kind: "no_key", message: "no boat.dev key: Settings › Hub › Machines" });
    let box: Uint8Array;
    try {
      box = loadOrCreateBoxKey(this.home);
    } catch {
      throw new BoatFailure({ kind: "no_key", message: "the hub can't read its box key" });
    }
    const plain = openSealed(box, sealed);
    if (!plain) throw new BoatFailure({ kind: "no_key", message: "the boat.dev key was sealed to another box key: paste it again in Settings › Hub › Machines" });
    try {
      return new TextDecoder("utf-8", { fatal: true }).decode(plain);
    } catch {
      throw new BoatFailure({ kind: "no_key", message: "the boat.dev key isn't text: paste it again" });
    }
  }

  /** Drops the notes of the creates boat refused: once the key or the environment changes, Create asks boat again. */
  forgetRefusedCreates(): void {
    for (const row of this.ledger.slots()) {
      if (row.state === "failed" && row.sandboxId === undefined && row.note !== undefined) {
        delete row.note;
        this.ledger.put(row);
      }
    }
  }

  /** Day and month spend against their budgets, in the hub's time zone. */
  budget(s: Settings, now: number): Budget {
    const daySpent = this.ledger.spent(dayStart(now, this.zone), now);
    const monthSpent = this.ledger.spent(monthStart(now, this.zone), now);
    const mb = monthBudget(s);
    return { daySpent, monthSpent, dayBudget: s.dayBudget, monthBudget: mb, left: Math.min(s.dayBudget - daySpent, mb - monthSpent) };
  }

  private burn(s: Settings, slots: Slot[], extra: number): number {
    return (slots.filter((r) => wanted(r.state)).length + extra) * pricePerHour(s.machineType);
  }

  lease(s: Settings, longestS: number, extra: number): Lease {
    return clamp(longestS, this.budget(s, this.now()).left, this.burn(s, this.ledger.slots(), extra));
  }

  /** Why no start may go now, in one plain line, or undefined. Placement shows it on a waiting task. */
  startHeld(): string | undefined {
    const now = this.now();
    let s: Settings;
    try {
      s = this.ledger.settings();
      const line = starts.held(s, now) ?? budgetLine(this.budget(s, now));
      if (line !== undefined) return line;
      const counts = WINDOWS.map((w) => [w, ...this.ledger.startsIn(w, now)] as [typeof w, number, number | undefined]);
      return starts.budgetLine(s.starts ?? starts.INCLUDED_UNKNOWN, counts, this.zone);
    } catch (e) {
      return `the pool's ledger can't be read: ${words(e)}`;
    }
  }

  /** Placement's claim on an awake machine, before it launches there. */
  claim(slot: string): boolean {
    const awake = this.ledger.slot(slot)?.state === "awake" && this.fleet.ready(slot);
    if (awake) this.claims.set(slot, this.now());
    return awake;
  }

  /** Writes the slot as `to`, then asks boat to stop it. Repeating it is harmless. */
  async stop(slot: string, to: State, why: string): Promise<void> {
    const row = this.ledger.slot(slot);
    if (!row) return;
    row.state = to;
    delete row.idleSince;
    row.note = why;
    this.ledger.put(row);
    this.syncTunnel(row);
    console.info(`pool: stopping ${slot}: ${why}`);
    if (row.sandboxId !== undefined) await this.sendStop(row.sandboxId, slot);
  }

  /** One stop to boat; a machine boat no longer has is written gone. */
  async sendStop(id: string, slot: string | undefined): Promise<void> {
    try {
      await this.boat.stop(id);
    } catch (e) {
      const err = boatError(e);
      if (err.kind === "conflict") return;
      if (err.kind === "not_found") {
        if (slot !== undefined) this.gone(slot, "boat.dev no longer has it");
        return;
      }
      console.warn(`pool: stop of ${id} refused:`, err);
      throw new Error(boatLine(err));
    }
  }

  /** The slot's machine is gone at boat: its meter closes and it needs a new create. */
  gone(slot: string, why: string): void {
    this.ledger.closeSpend(slot, this.now());
    const row = this.ledger.slot(slot);
    if (row) {
      row.state = "gone";
      delete row.sandboxId;
      delete row.createBody;
      row.note = why;
      this.ledger.put(row);
    }
    this.tunnels.close(slot);
    this.hydrated_.delete(slot);
  }

  /** boat saw the machine stopped: asleep, its meter closed, and boat's machines-at-once limit has room again. */
  asleep(row: Slot): void {
    const now = this.now();
    this.ledger.closeSpend(row.slot, now);
    if (wanted(row.state) || row.state === "stopping") row.state = "asleep";
    row.asleepSince = now;
    delete row.awakeSince;
    delete row.leaseUntil;
    delete row.renewedAt;
    delete row.idleSince;
    this.ledger.put(row);
    this.syncTunnel(row);
    this.hydrated_.delete(row.slot);
    this.ledger.setFull(false);
  }

  /** A refusal's backoff, kept in the ledger. */
  backOff(error: BoatError): void {
    const step = (() => {
      try {
        return this.ledger.settings().backoffStep;
      } catch {
        return 0;
      }
    })();
    try {
      const b = starts.backoff(error, step, this.now(), Math.random(), this.zone);
      if ("hold" in b) this.ledger.setHold(b.until, b.reason, b.step);
      else if ("full" in b) this.ledger.setFull(true);
      else {
        console.warn(`pool: bursting paused (${b.pause}): ${b.reason}`);
        this.ledger.setPaused([b.pause, b.reason]);
      }
    } catch (e) {
      console.error("pool: backoff not written:", e);
    }
  }

  /** A start boat took: its backoff ends, and a Test that failed before it is no longer what holds. */
  private started(): void {
    try {
      this.ledger.setHold(undefined, undefined, 0);
    } catch (e) {
      console.error("pool: backoff not cleared:", e);
    }
    this.pathForgetFailure();
  }

  /** The checks before any start. Returns the settings and the lease. */
  private async mayStart(longestS: number): Promise<[Settings, Ttl]> {
    const line = this.startHeld();
    if (line !== undefined) throw new Error(line);
    const s = this.ledger.settings();
    const lease = this.lease(s, longestS, 1);
    if (!("renew" in lease)) throw new Error(budgetLine(this.budget(s, this.now())) ?? "cloud paused: too little budget left to start a machine");
    let limits: Limits;
    try {
      limits = await this.boat.limits();
    } catch (e) {
      const err = boatError(e);
      this.backOff(err);
      throw new Error(boatLine(err));
    }
    try {
      this.ledger.setPlan(limits.startLimits ?? undefined, limits.sandboxPlanDollars ?? undefined);
    } catch (e) {
      console.warn("pool: plan not kept:", e);
    }
    const why = starts.preflight(limits);
    if (why !== undefined) throw new Error(why);
    return [s, lease.renew];
  }

  /** Wakes `slot`: only a machine boat says is stopped is resumed, one wake at a time per slot, after every start check. */
  wake(slot: string, why: Why): Promise<void> {
    return this.lock(slot, async () => {
      const row = this.ledger.slot(slot);
      if (!row) throw new Error(`no cloud machine ${slot}`);
      if (row.state === "awake" || row.state === "waking" || row.state === "creating") return;
      if (row.state === "broken") throw new Error(`${slot} doesn't come back: Reset it in Settings › Hub › Machines`);
      if (row.state === "failed" || row.state === "gone" || row.sandboxId === undefined) throw new Error(`${slot} has no machine: Reset it`);
      const id = row.sandboxId;
      const [s, ttl] = await this.mayStart(LEASE_S);
      // GET first: resume only what boat says is stopped (or stopping, which a resume takes back).
      let seen: Sandbox;
      try {
        seen = await this.boat.get(id);
      } catch (e) {
        const err = boatError(e);
        if (err.kind === "not_found") {
          this.gone(slot, "boat.dev no longer has it");
          throw new Error(`${slot} is gone at boat.dev: Reset it`);
        }
        throw new Error(boatLine(err));
      }
      const now = this.now();
      if (phase(seen) === "dead") {
        this.gone(slot, "boat.dev lost it");
        throw new Error(`${slot} is gone at boat.dev: Reset it`);
      }
      const alreadyUp = phase(seen) === "up";
      const asleepSince = row.asleepSince;
      row.state = "waking";
      row.wakeAt = now;
      row.wakeWhy = why;
      delete row.idleSince;
      delete row.asleepSince;
      delete row.note;
      const price = pricePerHour(s.machineType);
      if (alreadyUp) {
        // Running already: no start, but the lease is renewed now.
        const until = archiveAfterMs(seen);
        if (until !== undefined) row.leaseUntil = until;
        else delete row.leaseUntil;
        delete row.renewedAt;
        this.ledger.put(row);
        if (!this.ledger.hasOpenSpend(slot)) this.ledger.openSpend(slot, id, now, price);
        this.syncTunnel(row);
        return;
      }
      row.leaseUntil = now + ttlMs(ttl);
      row.renewedAt = now;
      this.ledger.put(row);
      const start = this.ledger.countStart(slot, "resume", now);
      const spend = this.ledger.openSpend(slot, id, now, price);
      let sb: Sandbox;
      try {
        sb = await this.boat.resume(id, ttl);
      } catch (e) {
        const err = boatError(e);
        if (err.kind === "no_ready_machine" || err.kind === "rate_limited") this.ledger.uncountStart(start);
        this.backOff(err);
        // Whether a machine runs now: refused outright, none does; no answer, ask boat.
        let up = false;
        if (err.kind === "network" || err.kind === "server") {
          try {
            up = phase(await this.boat.get(id)) === "up";
          } catch {
            up = true;
          }
        }
        if (up) throw new Error(boatLine(err));
        this.ledger.dropSpend(spend);
        row.state = err.kind === "data_expired" ? "gone" : "asleep";
        delete row.leaseUntil;
        delete row.renewedAt;
        if (asleepSince !== undefined) row.asleepSince = asleepSince;
        row.note = boatLine(err);
        if (err.kind === "data_expired") delete row.sandboxId;
        this.ledger.put(row);
        throw new Error(boatLine(err));
      }
      if (sb.alreadyRunning) {
        // It ran already: boat counted no start and kept its old deadline, which only a PATCH moves.
        this.ledger.uncountStart(start);
        this.started();
        try {
          await this.boat.setTtl(id, ttl);
          row.renewedAt = this.now();
        } catch (e) {
          console.warn(`pool: lease of running ${slot} not renewed: ${boatLine(boatError(e))}`);
          const until = archiveAfterMs(sb);
          if (until !== undefined) row.leaseUntil = until;
          else delete row.leaseUntil;
          delete row.renewedAt;
        }
        this.ledger.put(row);
        this.syncTunnel(row);
        return;
      }
      this.started();
      // A resume is a new machine with a new host key: a fresh tunnel, opened before its node needs it.
      this.hydrated_.delete(slot);
      this.tunnels.close(slot);
      this.syncTunnel(row);
    });
  }

  /** Creates `slot`'s machine: the row, the attempt's key and sealed body, the start and the meter are written first. */
  create(slot: string, spec: CreateSpec): Promise<void> {
    return this.lock(slot, async () => {
      const now = this.now();
      const before = this.ledger.slot(slot);
      if (before && (before.sandboxId !== undefined || before.state === "creating")) throw new Error(`${slot} already has a machine`);
      const row = before ?? newSlot(slot, now);
      const [s, ttl] = await this.mayStart(SETUP_S);
      const idemKey = randomBytes(16).toString("hex");
      const body = createBody(s.machineType, `fleetd-${s.hubId.slice(0, 8)}-${slot}`, { [LABEL_HUB]: s.hubId, [LABEL_SLOT]: slot, [LABEL_ATTEMPT]: idemKey }, ttl);
      if (s.environment !== undefined) body.environment = s.environment;
      if (spec.setupScript !== undefined) body.setupScript = spec.setupScript;
      body.files = spec.files;
      const bytes = createBytes(body);
      row.state = "creating";
      row.idemKey = idemKey;
      row.createBody = seal(publicKeyOf(this.boxKey()), bytes);
      row.bodyUntil = spec.bodyUntil;
      row.createdAt = now;
      row.wakeAt = now;
      row.wakeWhy = "need";
      row.leaseUntil = now + ttlMs(ttl);
      row.renewedAt = now;
      row.wakeFailures = 0;
      delete row.note;
      this.ledger.put(row);
      const start = this.ledger.countStart(slot, "create", now);
      const spend = this.ledger.openSpend(slot, undefined, now, pricePerHour(s.machineType));
      let answer: Sandbox | BoatError;
      try {
        answer = await this.boat.create(idemKey, bytes);
      } catch (e) {
        const err = boatError(e);
        answer = err.kind === "unknown_environment" ? { kind: "unknown_environment", name: s.environment ?? "base" } : err;
      }
      this.created(slot, answer, [start, spend]);
    });
  }

  /** Settles a create's answer: the id kept and the body dropped, or the slot failed. */
  created(slot: string, answer: Sandbox | BoatError, rows: [number, number] | undefined): void {
    const row = this.ledger.slot(slot);
    if (!row) throw new Error(`no cloud machine ${slot}`);
    if ("id" in answer) {
      this.started();
      row.sandboxId = answer.id;
      delete row.createBody;
      this.ledger.put(row);
      this.ledger.nameSpend(slot, answer.id);
      // Its setup waits for the tunnel before it joins.
      this.syncTunnel(row);
      return;
    }
    const e = answer;
    // No answer, or boat still at it: leave it creating for the sweep.
    if (e.kind === "network" || e.kind === "server" || e.kind === "idempotency_in_progress") {
      this.backOff(e);
      throw new Error(boatLine(e));
    }
    console.warn(`pool: boat.dev refused the create of ${slot}: ${boatLine(e)}`);
    if (rows) {
      // boat checks the environment before it counts anything.
      if (e.kind === "no_ready_machine" || e.kind === "rate_limited" || e.kind === "unknown_environment") this.ledger.uncountStart(rows[0]);
      this.ledger.dropSpend(rows[1]);
    } else {
      this.ledger.closeSpend(slot, this.now());
    }
    // A refusal of this create's own ask fails only its machine.
    if (!aboutTheRequest(e)) this.backOff(e);
    row.state = "failed";
    delete row.createBody;
    delete row.leaseUntil;
    row.note = boatLine(e);
    this.ledger.put(row);
    throw new Error(boatLine(e));
  }

  /** The kill switch: turns the pool off, then stops every machine labelled with this hub's id, listed from boat. */
  async kill(): Promise<Kill> {
    this.ledger.setEnabled(false);
    const s = this.ledger.settings();
    const kill: Kill = { stopped: [], failed: [] };
    if (!s.hasKey) return kill;
    const rows = this.ledger.slots();
    let targets: [string, string | undefined][];
    try {
      const list = await this.boat.list([[LABEL_HUB, s.hubId]]);
      targets = list
        .filter((sb) => sb.labels[LABEL_HUB] === s.hubId && phase(sb) === "up")
        .map((sb) => [sb.id, rows.find((r) => r.sandboxId === sb.id)?.slot]);
    } catch (e) {
      kill.unlisted = boatLine(boatError(e));
      targets = rows.filter((r) => r.state !== "asleep" && r.state !== "gone" && r.sandboxId !== undefined).map((r) => [r.sandboxId!, r.slot]);
    }
    for (const [id, slot] of targets) {
      const name = slot ?? id;
      try {
        if (slot !== undefined) {
          const st = this.ledger.slot(slot)?.state;
          await this.stop(slot, st === "broken" || st === "failed" ? st : "stopping", "cloud machines are off");
        } else await this.sendStop(id, undefined);
        kill.stopped.push(name);
      } catch (e) {
        kill.failed.push([name, words(e)]);
      }
    }
    return kill;
  }

  /** Lifts a billing or key pause by hand (the admin's Resume). */
  resumeBursting(): void {
    this.ledger.setPaused(undefined);
    this.ledger.setHold(undefined, undefined, 0);
    this.ledger.setFull(false);
  }

  warnOnce(what: string, line: string): void {
    if (this.warned.has(what)) return;
    this.warned.add(what);
    console.warn(`pool: ${line} (${what})`);
  }

  // --- view.rs: the admin's Test, the settings, Reset, the machines ---

  keyTest(): CloudKeyTest | undefined {
    return this.keyTest_;
  }

  heard(test: CloudKeyTest | undefined): void {
    this.keyTest_ = test;
  }

  pathTest(): CloudPathTest | undefined {
    const t = this.path;
    if (!t) return undefined;
    if (t.result && "ok" in t.result) return { machineId: t.slot, ok: true, said: t.result.ok };
    if (t.result) return { machineId: t.slot, ok: false, said: t.result.err };
    return { machineId: t.slot, said: this.pathProgress(t.slot) };
  }

  private pathProgress(slot: string): string {
    const st = this.ledger.slot(slot)?.state;
    const what = st === "creating" ? "being made, its setup takes a few minutes" : st === "waking" ? "waking" : "awake";
    const t = this.tunnels.status(slot);
    const tunnel = !t
      ? "the hub opens its tunnel once boat.dev runs it"
      : "up" in t
        ? "the hub's tunnel to it is up, waiting for its node's hello"
        : t.down === "opening"
          ? "the hub is opening its tunnel to it"
          : `the hub's tunnel to it isn't up yet (${t.down})`;
    return `${slot}: ${what}; ${tunnel}.`;
  }

  pathBegin(slot: string): void {
    this.path = { slot, since: this.now() };
  }

  pathEnd(result: { ok: string } | { err: string }): void {
    if (this.path) this.path.result = result;
  }

  pathClear(): void {
    this.path = undefined;
  }

  pathForgetFailure(): void {
    if (this.path?.result && "err" in this.path.result) this.path = undefined;
  }

  /** The life loop's look at the Test after each step of its slot. */
  pathStep(row: Slot): void {
    const t = this.path;
    if (!t || t.slot !== row.slot || t.result) return;
    const s = this.tunnels.status(row.slot);
    const up = s !== undefined && "up" in s;
    const seen = this.fleet.lastSeen(row.slot);
    const heard = seen !== undefined && seen >= t.since - MINUTE;
    if (row.state === "awake" && up && heard && this.fleet.ready(row.slot)) {
      t.result = { ok: `${row.slot}: boat.dev ran it, the hub's tunnel to it came up and its node said hello through it.` };
    } else if (!wanted(row.state)) {
      t.result = { err: `${row.slot}: ${row.note ?? "it stopped before its node said hello"}` };
    }
  }

  heardLimits(limits: Limits, kind: string): void {
    this.heard({ ok: true, said: limitsLine(limits, kind) });
  }

  heardRefusal(e: BoatError): void {
    if (e.kind === "key_refused" || e.kind === "billing") this.heard({ ok: false, said: keyWords(e) });
  }

  /** The admin's Test: `GET /limits` and the list of this hub's machines. It starts nothing. */
  async test(): Promise<CloudKeyTest> {
    let s: Settings;
    try {
      s = this.ledger.settings();
    } catch (e) {
      return { ok: false, said: `the pool's ledger can't be read: ${words(e)}` };
    }
    if (!s.hasKey) return { ok: false, said: "No boat.dev key yet: paste one first." };
    const fail = (e: BoatError): CloudKeyTest => {
      this.heardRefusal(e);
      return { ok: false, said: keyWords(e) };
    };
    let limits: Limits;
    try {
      limits = await this.boat.limits();
    } catch (e) {
      return fail(boatError(e));
    }
    try {
      this.ledger.setPlan(limits.startLimits ?? undefined, limits.sandboxPlanDollars ?? undefined);
    } catch (e) {
      console.warn("pool: plan not kept:", e);
    }
    try {
      await this.boat.list([[LABEL_HUB, s.hubId]]);
    } catch (e) {
      return fail(boatError(e));
    }
    this.heardLimits(limits, s.machineType);
    return this.keyTest() ?? { ok: true, said: limitsLine(limits, s.machineType) };
  }

  /** The admin's settings, checked. */
  apply(c: { enabled: boolean; poolSize: number; machineType: string; dayBudget: number; monthBudget?: number; projects: { machineId: string; projectId: string }[]; environment?: string }): void {
    if (!Number.isInteger(c.poolSize) || c.poolSize < 1 || c.poolSize > POOL_MAX) throw new Error(`A pool holds 1 to ${POOL_MAX} machines.`);
    if (!MACHINE_TYPES.some(([k]) => k === c.machineType)) {
      throw new Error(`boat.dev has no size ${c.machineType}: pick ${MACHINE_TYPES.map(([k]) => k).join(", ")}.`);
    }
    const budget = (what: string, d: number) => {
      if (!(Number.isFinite(d) && d > 0 && d <= BUDGET_MAX)) throw new Error(`The ${what} budget is dollars above 0, at most $${BUDGET_MAX.toFixed(0)}.`);
    };
    budget("day", c.dayBudget);
    if (c.monthBudget !== undefined) budget("month", c.monthBudget);
    const env = c.environment?.trim() || undefined;
    if (env !== undefined && (env.length > 64 || !/^[A-Za-z0-9_-]+$/.test(env))) throw new Error(`${env} isn't a boat.dev environment name: letters, digits, - and _.`);
    const projects: { machineId: string; projectId: string }[] = [];
    for (const p of c.projects) if (!projects.some((q) => q.machineId === p.machineId && q.projectId === p.projectId)) projects.push(p);
    const moved = this.ledger.settings().environment !== env;
    this.ledger.changeSettings({ enabled: c.enabled, poolSize: c.poolSize, machineType: c.machineType, dayBudget: c.dayBudget, ...(c.monthBudget !== undefined ? { monthBudget: c.monthBudget } : {}), projects, ...(env !== undefined ? { environment: env } : {}) });
    if (moved) this.forgetRefusedCreates();
  }

  /** The slots of the pool's size that need a create. */
  missing(): string[] {
    const s = this.ledger.settings();
    const rows = this.ledger.slots();
    return slotNames(s.poolSize).filter((slot) => {
      const r = rows.find((x) => x.slot === slot);
      return !r || (r.sandboxId === undefined && (r.state === "failed" || r.state === "gone"));
    });
  }

  /** Reset: deletes the slot's machine at boat and forgets it, so the next create makes it anew. */
  retire(slot: string): Promise<void> {
    return this.lock(slot, async () => {
      const row = this.ledger.slot(slot);
      if (!row) throw new Error(`${slot} isn't one of the hub's cloud machines`);
      if (row.state === "creating" && row.sandboxId === undefined) throw new Error(`${slot} is being created: wait until boat.dev answers`);
      if (row.sandboxId !== undefined) {
        try {
          await this.boat.delete(row.sandboxId);
        } catch (e) {
          const err = boatError(e);
          if (err.kind !== "not_found") {
            // Stopped at least, so it costs nothing; Reset again deletes it.
            await this.boat.stop(row.sandboxId).catch(() => {});
            throw new Error(boatLine(err));
          }
        }
      }
      this.ledger.closeSpend(slot, this.now());
      row.state = "gone";
      for (const k of ["sandboxId", "createBody", "idemKey", "leaseUntil", "renewedAt", "awakeSince", "idleSince"] as const) delete row[k];
      row.wakeFailures = 0;
      row.note = "reset: deleted at boat.dev";
      this.tunnels.close(slot);
      this.ledger.put(row);
    });
  }

  /** Each slot with its state, what runs there (from its node's heartbeat) and its spend today. */
  machines(busy: (slot: string) => { threads: number; screens: number } | undefined): CloudMachine[] {
    const now = this.now();
    const meter = this.ledger.meter(dayStart(now, this.zone), now);
    return this.ledger.slots().map((r) => {
      const today = meter.filter(([id]) => id === r.slot || id === r.sandboxId).reduce((a, [, d]) => a + d, 0);
      const b = busy(r.slot) ?? { threads: 0, screens: 0 };
      const running = r.state === "awake" || r.state === "waking";
      const since =
        r.state === "awake" || r.state === "waking"
          ? (r.awakeSince ?? r.wakeAt)
          : r.state === "asleep"
            ? r.asleepSince
            : (r.state === "creating" || r.state === "failed") && r.wakeAt !== undefined
              ? r.createdAt
              : undefined;
      return {
        machineId: r.slot,
        state: cloudState(r.state),
        agents: running ? b.threads : 0,
        screens: running ? b.screens : 0,
        today,
        ...(since !== undefined ? { sinceMs: since } : {}),
        ...(r.note !== undefined ? { note: r.note } : {}),
      };
    });
  }

  // --- life.rs: every 30 s, each slot one step, under its lock ---

  async tick(): Promise<void> {
    let rows: Slot[];
    try {
      rows = this.ledger.slots();
    } catch {
      return console.error("pool: ledger unreadable");
    }
    for (const listed of rows) {
      await this.lock(listed.slot, async () => {
        // Read again under the lock: a wake may have just written it.
        const row = this.ledger.slot(listed.slot);
        if (!row) return;
        this.syncTunnel(row);
        try {
          await this.step(row);
        } catch (e) {
          console.warn(`pool: life step of ${row.slot}: ${words(e)}`);
        }
        const after = this.ledger.slot(listed.slot);
        if (after) this.pathStep(after);
      });
    }
  }

  /** Why a machine never said hello: the timeout, and the tunnel's last error when it never came up. */
  private noHello(slot: string, within: string): string {
    const why = this.tunnelDown(slot);
    return why !== undefined && why !== "opening" ? `no hello within ${within}: the hub's tunnel to it didn't come up (${why})` : `no hello within ${within}`;
  }

  private async step(row: Slot): Promise<void> {
    const now = this.now();
    const s = this.ledger.settings();
    const heard = (since: number | undefined) => {
      const seen = this.fleet.lastSeen(row.slot);
      return seen !== undefined && since !== undefined && seen > since;
    };
    if ((row.state === "creating" || row.state === "waking") && heard(row.wakeAt) && this.fleet.ready(row.slot)) {
      row.state = "awake";
      row.awakeSince = now;
      row.wakeFailures = 0;
      delete row.idleSince;
      delete row.createBody;
      delete row.note;
      this.ledger.put(row);
      this.fleet.woke?.(row.slot);
      return;
    }
    if (row.state === "creating") {
      if (row.wakeAt !== undefined && this.waited(row.wakeAt, now) > CREATE_HELLO_MS) await this.neverJoined(row);
      return;
    }
    if (row.state === "waking") {
      if (row.wakeAt === undefined || this.waited(row.wakeAt, now) <= HELLO_MS) return;
      const failures = row.wakeFailures + 1;
      this.ledger.put({ ...row, wakeFailures: failures });
      if (failures >= BROKEN_AFTER) {
        const t = this.tunnelDown(row.slot);
        return this.stop(row.slot, "broken", t !== undefined ? `${row.slot} doesn't come back: Reset it? (the hub's tunnel to it didn't come up: ${t})` : `${row.slot} doesn't come back: Reset it?`);
      }
      return this.stop(row.slot, "stopping", this.noHello(row.slot, `${HELLO_MS / 60_000} minutes of its wake`));
    }
    if (row.state === "awake") return this.awakeStep(s, row, now);
    if (row.state === "stopping" || row.state === "broken" || row.state === "failed") return this.settle(row);
  }

  private async awakeStep(s: Settings, row: Slot, now: number): Promise<void> {
    const slot = row.slot;
    if (!s.enabled) return this.stop(slot, "stopping", "cloud machines are off");
    // Node vanished: silent 10 minutes, while the hub hears its other machines.
    const seen = this.fleet.lastSeen(slot) ?? row.awakeSince ?? now;
    if (now - seen > SILENT_MS && this.fleet.othersHeard(this.ledger.slots().map((r) => r.slot), now)) {
      return this.stop(slot, "stopping", "its node went silent for 10 minutes");
    }
    // Idle: the node not busy (one that sends no busy flag counts as busy) and no claim.
    const claimedAt = this.claims.get(slot);
    const claimed = claimedAt !== undefined && now - claimedAt < CLAIM_MS;
    const busy = this.fleet.busy(slot) ?? true;
    const grace = row.wakeWhy === "keepalive" || row.wakeWhy === "test" ? KEEPALIVE_GRACE_MS : IDLE_GRACE_MS;
    const before = row.idleSince;
    if (busy || claimed) delete row.idleSince;
    else row.idleSince = before ?? now;
    const idle = row.idleSince !== undefined && now - row.idleSince >= grace;
    if (idle) {
      row.state = "stopping";
      row.note = "idle";
      delete row.idleSince;
    }
    if (idle || row.idleSince !== before) this.ledger.put(row);
    if (idle) return this.stop(slot, "stopping", "idle");
    // Hydration: asked of boat until it says the disk is whole.
    if (!this.hydrated(slot) && row.sandboxId !== undefined) {
      try {
        if ((await this.boat.get(row.sandboxId)).hydrated === true) this.hydrated_.add(slot);
      } catch {}
    }
    return this.renew(s, row, now);
  }

  /** The lease: renewed every 10 minutes, or at once when the clamp now gives an earlier deadline; stopped on its say. */
  private async renew(s: Settings, row: Slot, now: number): Promise<void> {
    const lease = this.lease(s, LEASE_S, 0);
    if (!("renew" in lease)) return this.stop(row.slot, "stopping", budgetLine(this.budget(s, now)) ?? "the budget is nearly spent");
    const ttl = lease.renew;
    const due = row.renewedAt === undefined || now - row.renewedAt >= RENEW_MS;
    const shorter = row.leaseUntil !== undefined && now + ttlMs(ttl) + 30_000 < row.leaseUntil;
    if ((!due && !shorter) || row.sandboxId === undefined) return;
    try {
      await this.boat.setTtl(row.sandboxId, ttl);
    } catch (e) {
      const err = boatError(e);
      if (err.kind === "not_found") return this.gone(row.slot, "boat.dev no longer has it");
      throw new Error(`lease of ${row.slot} not renewed: ${boatLine(err)}`);
    }
    row.leaseUntil = now + ttlMs(ttl);
    row.renewedAt = now;
    this.ledger.put(row);
  }

  /** A machine that is to stop: asked until boat says archived, then asleep with its meter closed. */
  private async settle(row: Slot): Promise<void> {
    const open = this.ledger.hasOpenSpend(row.slot);
    if (row.state !== "stopping" && !open) return;
    if (row.sandboxId === undefined) return this.ledger.closeSpend(row.slot, this.now());
    let sb: Sandbox;
    try {
      sb = await this.boat.get(row.sandboxId);
    } catch (e) {
      const err = boatError(e);
      if (err.kind === "not_found") return this.gone(row.slot, "boat.dev no longer has it");
      throw new Error(boatLine(err));
    }
    const p = phase(sb);
    if (p === "stopped") return this.asleep(row);
    if (p === "dead") return this.gone(row.slot, "boat.dev lost it");
    if (p === "up") return this.sendStop(row.sandboxId, row.slot);
  }

  /** A create whose node never said hello within the enroll token's life: deleted, `failed`, with why. */
  private async neverJoined(row: Slot): Promise<void> {
    let note = this.noHello(row.slot, "15 minutes of its create");
    const id = row.sandboxId;
    if (id !== undefined) {
      try {
        const err = (await this.boat.get(id)).setupError;
        if (err) note = setupFailure(err);
      } catch {}
      try {
        await this.boat.delete(id);
        this.ledger.closeSpend(row.slot, this.now());
        delete row.sandboxId;
      } catch (e) {
        await this.boat.stop(id).catch(() => {});
        note = `${note} (delete refused: ${boatLine(boatError(e))})`;
      }
    }
    console.warn(`pool: ${row.slot}, a created machine, never joined; deleted: ${note}`);
    row.state = "failed";
    delete row.createBody;
    row.note = note;
    this.ledger.put(row);
    this.syncTunnel(row);
  }

  // --- sweep.rs: boat's own list against the ledger ---

  async sweep(): Promise<void> {
    const s = this.ledger.settings();
    if (!s.hasKey) {
      this.ready_ = true;
      return;
    }
    let limits: Limits;
    try {
      limits = await this.boat.limits();
    } catch (e) {
      const err = boatError(e);
      if (err.kind === "key_refused" || err.kind === "no_key") this.backOff(err);
      this.heardRefusal(err);
      throw new Error(boatLine(err));
    }
    this.heardLimits(limits, s.machineType);
    this.ledger.setPlan(limits.startLimits ?? undefined, limits.sandboxPlanDollars ?? undefined);
    // Only a billing or key pause: a refusal of what was asked stays until a person resumes.
    if (limits.canStart && (s.paused?.[0] === "billing" || s.paused?.[0] === "key")) {
      console.info("pool: boat.dev can start again; bursting resumes");
      this.ledger.setPaused(undefined);
    }
    if (s.full && limits.activeSandboxes < limits.maxActiveSandboxes) {
      console.info("pool: boat.dev has room for a machine again");
      this.ledger.setFull(false);
    }
    let list: Sandbox[];
    try {
      list = await this.boat.list([[LABEL_HUB, s.hubId]]);
    } catch (e) {
      throw new Error(boatLine(boatError(e)));
    }
    const now = this.now();
    const seen: string[] = [];
    let up = 0;
    for (const sb of list) {
      // Only this hub's machines, whatever boat's filter did.
      if (sb.labels[LABEL_HUB] !== s.hubId) continue;
      seen.push(sb.id);
      const p = phase(sb);
      if (p === "up") up++;
      const rows = this.ledger.slots();
      let row = rows.find((r) => r.sandboxId === sb.id);
      if (!row) {
        // A create whose answer was lost: its attempt label finds its row.
        const attempt = sb.labels[LABEL_ATTEMPT];
        const r = rows.find((x) => x.sandboxId === undefined && x.state === "creating" && x.idemKey === attempt);
        if (r) {
          console.info(`pool: adopted ${sb.id} for ${r.slot}, a create whose answer was lost`);
          r.sandboxId = sb.id;
          delete r.createBody;
          this.ledger.put(r);
          this.ledger.nameSpend(r.slot, sb.id);
          row = r;
        }
      }
      if (!row) {
        // An orphan: this hub's label, no row. Stop it; once stopped, delete it.
        console.warn(`pool: a machine the ledger doesn't know: ${sb.id} (${sb.state})`);
        try {
          if (p === "up") await this.sendStop(sb.id, undefined);
          else if (p === "stopped" || p === "dead") await this.boat.delete(sb.id);
        } catch (e) {
          console.warn(`pool: orphan ${sb.id} not stopped: ${words(e)}`);
        }
        continue;
      }
      const slot = row.slot;
      await this.lock(slot, async () => {
        const r = this.ledger.slot(slot);
        if (!r || r.sandboxId !== sb.id) return;
        if (p === "up") {
          const until = archiveAfterMs(sb);
          const overdue = until !== undefined && now - until > OVERDUE_MS;
          if (overdue) this.warnOnce(`overdue ${sb.id}`, "boat.dev ran a machine past its deadline; stopped it");
          if (overdue || !s.enabled || !wanted(r.state)) {
            const to = r.state === "broken" || r.state === "failed" ? r.state : "stopping";
            await this.stop(slot, to, s.enabled ? "boat ran it while the hub didn't want it" : "cloud machines are off").catch((e) =>
              console.warn(`pool: stop of ${slot} refused: ${words(e)}`),
            );
          }
        } else if (p === "stopped") {
          // Its setup lease ended before a hello: the life loop's create timeout settles it.
          if (r.state === "creating") return;
          // A wanted machine is asked again: a resume may have gone out since the list was read.
          let stopped = !wanted(r.state);
          if (!stopped) {
            try {
              stopped = phase(await this.boat.get(sb.id)) === "stopped";
            } catch {
              stopped = false;
            }
          }
          if (stopped && (wanted(r.state) || r.state === "stopping" || this.ledger.hasOpenSpend(slot))) this.asleep(r);
        } else if (p === "dead") {
          this.gone(slot, "boat.dev lost it");
        }
      });
    }
    // Rows whose machine boat no longer lists: asked by id first.
    for (const row of this.ledger.slots()) {
      const id = row.sandboxId;
      if (id === undefined || seen.includes(id)) continue;
      await this.lock(row.slot, async () => {
        try {
          await this.boat.get(id);
        } catch (e) {
          if (boatError(e).kind === "not_found") this.gone(row.slot, "boat.dev no longer has it");
        }
      });
    }
    await this.retryCreates(now);
    // boat runs machines this hub doesn't know of: warn once.
    const strangers = limits.activeSandboxes > up;
    if (strangers && !s.strangersWarned) console.warn(`pool: boat.dev runs ${limits.activeSandboxes} machines, ${up} of them this hub's; they share its start limits`);
    if (strangers !== s.strangersWarned) this.ledger.setStrangersWarned(strangers);
    await this.reconcileCost(now);
    this.ledger.prune(now);
    // The sweep got through: placement may use the pool. Then the keepalive.
    this.ready_ = true;
    await this.keepalive(now);
  }

  /** A create with no id and no machine found under its attempt label: its sealed body again, while its token lives. */
  private async retryCreates(now: number): Promise<void> {
    for (const listed of this.ledger.slots()) {
      await this.lock(listed.slot, async () => {
        const row = this.ledger.slot(listed.slot);
        if (!row || row.state !== "creating" || row.sandboxId !== undefined) return;
        let plain: Uint8Array | undefined;
        if (row.createBody && row.idemKey && row.bodyUntil !== undefined && row.bodyUntil > now) {
          try {
            plain = openSealed(this.boxKey(), row.createBody) ?? undefined;
          } catch {
            plain = undefined;
          }
        }
        if (plain && row.idemKey) {
          let answer: Sandbox | BoatError;
          try {
            answer = await this.boat.create(row.idemKey, plain);
          } catch (e) {
            answer = boatError(e);
          }
          try {
            this.created(row.slot, answer, undefined);
          } catch (e) {
            console.warn(`pool: create retry of ${row.slot}: ${words(e)}`);
          }
          return;
        }
        row.state = "failed";
        delete row.createBody;
        row.note = "its create got no answer, and boat.dev has no machine for it";
        this.ledger.put(row);
        this.ledger.closeSpend(row.slot, now);
      });
    }
  }

  /** boat's own cost for each machine that ran today or this month, since the meter's same starts. */
  private async reconcileCost(now: number): Promise<void> {
    for (const since of [dayStart(now, this.zone), monthStart(now, this.zone)]) {
      for (const id of this.ledger.meteredSince(since, now)) {
        try {
          this.ledger.setBoatCost(id, since, await this.boat.usage(id, since));
        } catch (e) {
          console.warn(`pool: boat's cost of ${id} unread:`, boatError(e));
        }
      }
    }
  }

  /** Wakes each slot asleep 12 days, so boat keeps its disk. */
  private async keepalive(now: number): Promise<void> {
    for (const row of this.ledger.slots()) {
      const due = row.state === "asleep" && row.sandboxId !== undefined && row.asleepSince !== undefined && now - row.asleepSince >= KEEPALIVE_AFTER_MS;
      if (due) await this.wake(row.slot, "keepalive").catch((e) => console.warn(`pool: keepalive wake of ${row.slot} held back: ${words(e)}`));
    }
  }

  /** The pool's loops: the sweep at hub start (again every tick until it gets through), then every 10 minutes; the life loop every 30 s. */
  async run(signal: AbortSignal): Promise<void> {
    let nextSweep = 0;
    while (!signal.aborted) {
      let hasKey = false;
      try {
        hasKey = this.ledger.settings().hasKey;
      } catch {}
      if (hasKey) {
        const now = this.now();
        if (now >= nextSweep) {
          try {
            await this.sweep();
            nextSweep = now + SWEEP_MS;
          } catch (e) {
            console.warn(`pool: sweep failed; cloud placement waits: ${words(e)}`);
          }
        }
        await this.tick();
      } else {
        // No key: nothing at boat to reconcile, so the pool has nothing to wait for.
        this.ready_ = true;
      }
      await pause(TICK_MS, signal);
    }
  }
}

export type { Lease };
