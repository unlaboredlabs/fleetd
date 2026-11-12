// The slot board's rules, without I/O: the service in index.ts persists what
// `takeOps` hands it and feeds it thread events, machine facts and the time.
import type { MachineId, ProjectRef, SlotState, SlotStatePerMachine, SlotStatePerProject } from "../../shared/contracts.ts";
import { type Auto, UNMEASURED, UNMEASURED_WHY } from "./sizing.ts";

/** An agent started this recently still counts against its machine's disk room: its worktree hasn't grown yet. */
export const SETTLE_MS = 10 * 60 * 1000;

/** Queue order: reviews, then write and read tasks, oldest first within each. A review gates a merge. */
export type SlotPriority = "review" | "work";

const rank = (p: SlotPriority) => (p === "review" ? 0 : 1);

export const parsePriority = (s: string): SlotPriority => (s === "review" ? "review" : "work");

/** One machine as the board sizes it. */
export type Machine = {
  machineId: MachineId;
  /** Its name, for the reasons people read. */
  name: string;
  /** What it fits, as last measured; kept while it is offline. */
  auto: Auto;
  /** A person's setting; undefined: auto. */
  maxAgents?: number;
  /** New agents its free disk took at the last heartbeat; undefined while its node reports no disk. */
  diskRoom?: number;
};

const machineCapOf = (m: Machine) => m.maxAgents ?? m.auto.cap;
/** Why it fits that many, or "set" for a person's setting. */
const machineWhy = (m: Machine) => (m.maxAgents !== undefined ? "set" : m.auto.why);

/** What the slot board answers: granted, or queued with a reason that fits `Task.queuedReason`. */
export type Grant = { granted: true } | { granted: false; reason: string };

export const GRANTED: Grant = { granted: true };
const queuedGrant = (reason: string): Grant => ({ granted: false, reason });

export type ClaimState = "queued" | "held" | "idle";

export const parseClaimState = (s: string): ClaimState => (s === "held" ? "held" : s === "idle" ? "idle" : "queued");

export type Claim = {
  holder: string;
  projectRef: ProjectRef;
  priority: SlotPriority;
  threadId?: string;
  state: ClaimState;
  order: number;
};

/** The machine whose cap a claim counts against: where it runs. */
export const claimMachine = (c: Claim): MachineId => c.projectRef.machineId;

/** A write the service persists, in order. */
export type Op =
  | { op: "save"; claim: Claim }
  | { op: "remove"; holder: string }
  | { op: "cap"; cap: number }
  /** A project's own max; undefined: it follows the default again. */
  | { op: "max_agents"; projectRef: ProjectRef; maxAgents?: number }
  /** A machine's measure, not a person's setting. */
  | { op: "machine"; machineId: MachineId; name: string; auto: Auto }
  /** A person's setting for the machine, with its measure for a machine not seen yet. */
  | { op: "machine_max"; machine: Machine };

export type ProjectRow = { projectRef: ProjectRef; maxAgents: number; own: boolean; running: number; queued: number };

export type MachineRow = {
  machineId: MachineId;
  cap: number;
  maxAgents?: number;
  auto: number;
  why: string;
  running: number;
  diskRoom?: number;
};

export type BoardState = {
  /** The fleet cap when set, else the machines' caps added up. */
  cap: number;
  fleetCap?: number;
  used: number;
  queued: number;
  perProject: ProjectRow[];
  perMachine: MachineRow[];
};

/** What a project's max agents comes from, for its lead's line. */
export type MaxSource =
  | { kind: "project" }
  | { kind: "fleet" }
  | { kind: "machine" }
  /** Its machine's own measure, and the term that sets it. */
  | { kind: "auto"; why: string };

/** The narrowest limit a queued claim waits behind. */
type Limit = "fleet" | "machine" | "project";

/** What holds a task back from a machine, in the order `block` checks. */
type Block = "fleet" | "no_agents" | "machine" | "disk" | "project";

const same = (a: ProjectRef, b: ProjectRef) => a.machineId === b.machineId && a.projectId === b.projectId;

const cloneClaim = (c: Claim): Claim => ({ ...c, projectRef: { ...c.projectRef } });

/** Every claim is a task's: a lead is not an agent and holds no slot. Claims and max agents keep insertion order. */
export class Board {
  private cap_: number | undefined;
  private readonly maxAgents: [ProjectRef, number][];
  private readonly machines: Machine[];
  private claims_: Claim[];
  /** New agents granted in the last SETTLE_MS: holder, machine, when. In memory only. */
  private starts: [string, MachineId, number][] = [];
  /** When each project's held slots last changed. In memory only. */
  private moved: [ProjectRef, number][] = [];
  private firstTickMs: number | undefined;
  private nowMs = 0;
  private nextOrder: number;
  private ops: Op[] = [];
  /** Machines whose role is sessions only: they run no agents. */
  private sessionsOnly: MachineId[] = [];

  constructor(cap: number | undefined, maxAgents: [ProjectRef, number][], machines: Machine[], claims: Claim[]) {
    this.cap_ = cap;
    this.maxAgents = maxAgents;
    this.machines = machines;
    this.claims_ = claims;
    this.nextOrder = Math.max(claims.reduce((n, c) => Math.max(n, c.order), 0), 0) + 1;
  }

  /** Whether the machine runs agents: false takes its cap to 0, so its projects' agents wait. */
  setRunsAgents(m: MachineId, on: boolean): void {
    this.sessionsOnly = this.sessionsOnly.filter((x) => x !== m);
    if (!on) this.sessionsOnly.push(m);
  }

  private runsAgents(m: MachineId): boolean {
    return !this.sessionsOnly.includes(m);
  }

  /** The time, before each change; starts older than SETTLE_MS stop counting. True when one did. */
  tick(nowMs: number): boolean {
    this.nowMs = nowMs;
    this.firstTickMs ??= nowMs;
    const before = this.starts.length;
    this.starts = this.starts.filter(([, , at]) => nowMs - at < SETTLE_MS);
    return this.starts.length < before;
  }

  /** Each project's held slots, to tell which projects a change moved (`noteMoves`). */
  heldCounts(): [ProjectRef, number][] {
    const counts: [ProjectRef, number][] = [];
    for (const c of this.claims_) {
      if (c.state !== "held") continue;
      const found = counts.find(([r]) => same(r, c.projectRef));
      if (found) found[1] += 1;
      else counts.push([{ ...c.projectRef }, 1]);
    }
    return counts;
  }

  /** Every project whose held slots differ from `before` had a slot taken or freed now. */
  noteMoves(before: [ProjectRef, number][]): void {
    const after = this.heldCounts();
    const count = (list: [ProjectRef, number][], r: ProjectRef) => list.find(([x]) => same(x, r))?.[1] ?? 0;
    const moved = [...before, ...after].map(([r]) => r).filter((r) => count(before, r) !== count(after, r));
    for (const r of moved) {
      const found = this.moved.find(([x]) => same(x, r));
      if (found) found[1] = this.nowMs;
      else this.moved.push([r, this.nowMs]);
    }
  }

  /** When the project last had a slot taken or freed; the hub's start when it hasn't since. */
  movedAt(r: ProjectRef): number {
    return this.moved.find(([x]) => same(x, r))?.[1] ?? this.firstTickMs ?? this.nowMs;
  }

  /** The writes made since the last call. */
  takeOps(): Op[] {
    const ops = this.ops;
    this.ops = [];
    return ops;
  }

  cap(): number | undefined {
    return this.cap_;
  }

  /** The fleet cap when set, else what the machines fit together. */
  total(): number {
    return this.cap_ ?? this.machines.reduce((n, m) => n + this.machineCap(m.machineId), 0);
  }

  private machine(m: MachineId): Machine | undefined {
    return this.machines.find((x) => x.machineId === m);
  }

  /** The machine's cap: a person's setting, else what it fits; UNMEASURED until its node reports. */
  machineCap(m: MachineId): number {
    if (!this.runsAgents(m)) return 0;
    const machine = this.machine(m);
    return machine ? machineCapOf(machine) : UNMEASURED;
  }

  /** A person's setting for the machine; undefined: auto. */
  machineSetting(m: MachineId): number | undefined {
    return this.machine(m)?.maxAgents;
  }

  /** New agents the machine's disk takes now; undefined: no limit known. */
  private diskRoom(m: MachineId): number | undefined {
    const room = this.machine(m)?.diskRoom;
    if (room === undefined) return undefined;
    const recent = this.starts.filter(([, x]) => x === m).length;
    return Math.max(room - recent, 0);
  }

  /** A heartbeat's facts. True when the machine now takes more than before. */
  observeMachine(machineId: MachineId, name: string, auto: Auto, diskRoom: number | undefined): boolean {
    const roomBefore = this.diskRoom(machineId) ?? Infinity;
    const capBefore = this.machineCap(machineId);
    const m = this.machine(machineId);
    if (!m) {
      const machine: Machine = { machineId, name, auto: { ...auto } };
      if (diskRoom !== undefined) machine.diskRoom = diskRoom;
      this.machines.push(machine);
      this.ops.push({ op: "machine", machineId, name, auto: { ...auto } });
    } else {
      if (diskRoom === undefined) delete m.diskRoom;
      else m.diskRoom = diskRoom;
      if (m.auto.cap !== auto.cap || m.auto.why !== auto.why || m.name !== name) {
        m.auto = { ...auto };
        m.name = name;
        this.ops.push({ op: "machine", machineId, name, auto: { ...auto } });
      }
    }
    return this.machineCap(machineId) > capBefore || (this.diskRoom(machineId) ?? Infinity) > roomBefore;
  }

  claims(): readonly Claim[] {
    return this.claims_;
  }

  private idx(holder: string): number {
    return this.claims_.findIndex((c) => c.holder === holder);
  }

  private save(i: number): void {
    this.ops.push({ op: "save", claim: cloneClaim(this.claims_[i] as Claim) });
  }

  /** The project's max agents: its own once a person sets it, else the default. */
  maxAgentsOf(r: ProjectRef): number {
    return this.ownMax(r) ?? this.defaultMax(r.machineId);
  }

  private ownMax(r: ProjectRef): number | undefined {
    return this.maxAgents.find(([s]) => same(s, r))?.[1];
  }

  /** A project's max until a person sets one: its machine's cap, within the fleet cap. */
  private defaultMax(m: MachineId): number {
    const machine = this.machineCap(m);
    return this.cap_ === undefined ? machine : Math.min(this.cap_, machine);
  }

  maxSource(r: ProjectRef): MaxSource {
    if (this.ownMax(r) !== undefined) return { kind: "project" };
    if (this.cap_ !== undefined && this.cap_ < this.machineCap(r.machineId)) return { kind: "fleet" };
    const m = this.machine(r.machineId);
    if (m && m.maxAgents !== undefined) return { kind: "machine" };
    if (m) return { kind: "auto", why: m.auto.why };
    return { kind: "auto", why: UNMEASURED_WHY };
  }

  /** Slots held fleet-wide, on machine `m`, and by the project's agents toward its max agents there. */
  private held(r: ProjectRef, m: MachineId): [number, number, number] {
    let used = 0;
    let machine = 0;
    let mine = 0;
    for (const c of this.claims_) {
      if (c.state !== "held") continue;
      used += 1;
      if (claimMachine(c) === m) machine += 1;
      if (this.counted(r, m, c)) mine += 1;
    }
    return [used, machine, mine];
  }

  /**
   * Whether claim `c` counts toward the project's max agents for a slot on machine `m`: a max a person set counts its
   * agents on every machine; the default only those on the machine the slot is on.
   */
  private counted(r: ProjectRef, m: MachineId, c: Claim): boolean {
    return same(c.projectRef, r) && (this.ownMax(r) !== undefined || claimMachine(c) === m);
  }

  /** The project's max agents for a slot on machine `m`. */
  private maxOn(r: ProjectRef, m: MachineId): number {
    const own = this.ownMax(r);
    if (own !== undefined) return own;
    return m === r.machineId ? this.defaultMax(m) : this.machineCap(m);
  }

  /** What holds a task of the project back from a slot on machine `m` now. `fresh`: it would start a new agent. */
  private block(r: ProjectRef, m: MachineId, fresh: boolean): Block | undefined {
    const [used, onMachine, running] = this.held(r, m);
    if (this.cap_ !== undefined && used >= this.cap_) return "fleet";
    if (!this.runsAgents(m)) return "no_agents";
    if (onMachine >= this.machineCap(m)) return "machine";
    if (fresh && this.diskRoom(m) === 0) return "disk";
    if (running >= this.maxOn(r, m)) return "project";
    return undefined;
  }

  /** Why a task of the project cannot take a slot on machine `m` now, or undefined if it can. */
  private blocker(r: ProjectRef, m: MachineId, fresh: boolean): string | undefined {
    const block = this.block(r, m, fresh);
    if (block === undefined) return undefined;
    const [used, onMachine, running] = this.held(r, m);
    const machine = this.machine(m);
    const name = machine?.name ?? m;
    switch (block) {
      case "fleet":
        return `fleet cap: ${used} of ${this.cap_ ?? 0} running`;
      case "no_agents":
        return `${name} runs no agents: its role is screens only (a hub admin changes it in Settings › Hub › Machines)`;
      case "machine": {
        const why = machine ? machineWhy(machine) : UNMEASURED_WHY;
        return `machine cap: ${onMachine} of ${this.machineCap(m)} running on ${name} (${why})`;
      }
      case "disk":
        return `disk: no room for another agent on ${name} until the new worktrees settle or space frees`;
      case "project":
        return `Max agents: ${running} of ${this.maxOn(r, m)} running`;
    }
  }

  /** The narrowest limit the project's tasks on machine `m` wait behind now. */
  private limit(r: ProjectRef, m: MachineId): Limit | undefined {
    const [used, onMachine, running] = this.held(r, m);
    if (running >= this.maxOn(r, m)) return "project";
    if (onMachine >= this.machineCap(m) || this.diskRoom(m) === 0) return "machine";
    if (this.cap_ !== undefined && used >= this.cap_) return "fleet";
    return undefined;
  }

  /** How many more of the project's tasks could start now on its own machine. */
  room(r: ProjectRef): number {
    const m = r.machineId;
    const [used, onMachine, running] = this.held(r, m);
    const fleet = this.cap_ === undefined ? Infinity : this.cap_ - used;
    const disk = this.diskRoom(m) ?? Infinity;
    return Math.max(Math.min(fleet, this.machineCap(m) - onMachine, disk, this.maxOn(r, m) - running), 0);
  }

  /** The queued holder's place in line, from 1, among the claims it shares its narrowest limit with. */
  position(holder: string): number | undefined {
    const c = this.claims_[this.idx(holder)];
    if (!c || c.state !== "queued") return undefined;
    const limit = this.limit(c.projectRef, claimMachine(c));
    const before = (x: Claim) => rank(x.priority) < rank(c.priority) || (x.priority === c.priority && x.order < c.order);
    const ahead = this.claims_.filter((x) => {
      if (x.state !== "queued" || !before(x)) return false;
      if (limit === "project") return same(x.projectRef, c.projectRef);
      if (limit === "machine") return claimMachine(x) === claimMachine(c);
      return true;
    }).length;
    return ahead + 1;
  }

  /** The project's agents holding a slot and waiting for one. */
  agents(r: ProjectRef): [number, number] {
    let running = 0;
    let queued = 0;
    for (const c of this.claims_) {
      if (!same(c.projectRef, r)) continue;
      if (c.state === "held") running += 1;
      else if (c.state === "queued") queued += 1;
    }
    return [running, queued];
  }

  /** Grants every queued claim that fits, reviews first, then oldest first. */
  evaluate(): void {
    const queue = this.claims_
      .map((c, i) => [c, i] as const)
      .filter(([c]) => c.state === "queued")
      .sort(([a], [b]) => rank(a.priority) - rank(b.priority) || a.order - b.order);
    for (const [c, i] of queue) {
      if (this.block(c.projectRef, claimMachine(c), c.threadId === undefined) === undefined) this.grant(i);
    }
  }

  /** Holds claim `i`'s slot; a new agent's start counts against its machine's disk room until it settles. */
  private grant(i: number): void {
    const c = this.claims_[i] as Claim;
    c.state = "held";
    if (c.threadId === undefined) this.starts.push([c.holder, claimMachine(c), this.nowMs]);
    this.save(i);
  }

  /**
   * Asking again for a holder that already has a slot returns granted; for one already queued, its current reason.
   * An idle holder joins the back of the queue.
   */
  acquire(holder: string, projectRef: ProjectRef, priority: SlotPriority): Grant {
    let i = this.idx(holder);
    if (i >= 0) {
      const c = this.claims_[i] as Claim;
      if (c.state === "held") return GRANTED;
      c.projectRef = { ...projectRef };
      c.priority = priority;
      if (c.state === "idle") {
        c.state = "queued";
        c.order = this.nextOrder++;
      }
    } else {
      const c: Claim = { holder, projectRef: { ...projectRef }, priority, state: "queued", order: this.nextOrder++ };
      this.claims_.push(c);
      i = this.claims_.length - 1;
    }
    this.save(i);
    this.evaluate();
    const c = this.claims_[i] as Claim;
    if (c.state === "held") return GRANTED;
    const reason = this.blocker(projectRef, claimMachine(c), c.threadId === undefined);
    return reason === undefined ? GRANTED : queuedGrant(reason);
  }

  /** The holder's slot follows the thread from now on. */
  bind(holder: string, machineId: MachineId, threadId: string): void {
    const i = this.idx(holder);
    const c = this.claims_[i];
    if (c && claimMachine(c) === machineId) {
      c.threadId = threadId;
      this.save(i);
    }
  }

  /** Drops the holder's claim; true when that freed a held slot. */
  release(holder: string): boolean {
    const i = this.idx(holder);
    if (i < 0) return false;
    const [c] = this.claims_.splice(i, 1) as [Claim];
    // Granted but never launched (the node went offline, or the launch failed): it made no worktree.
    const unlaunched = c.threadId === undefined && this.starts.some(([h]) => h === c.holder);
    this.starts = this.starts.filter(([h]) => h !== c.holder);
    this.ops.push({ op: "remove", holder: c.holder });
    return c.state === "held" || unlaunched;
  }

  /** The project is gone: its claims are dropped, held or queued, and so is its own max agents. */
  forgetProject(r: ProjectRef): boolean {
    const holders = this.claims_.filter((c) => same(c.projectRef, r)).map((c) => c.holder);
    let freed = false;
    for (const holder of holders) freed = this.release(holder) || freed;
    if (this.maxAgents.some(([s]) => same(s, r))) this.setCap(undefined, { projectRef: r, maxAgents: undefined });
    this.moved = this.moved.filter(([s]) => !same(s, r));
    return freed;
  }

  /** Applies a bound thread's running/stopped status; a thread no claim follows is not counted. True when freed. */
  observe(machineId: string, threadId: string, running: boolean): boolean {
    const i = this.claims_.findIndex((c) => c.threadId === threadId && claimMachine(c) === machineId);
    const c = this.claims_[i];
    if (!c) return false;
    if (running) {
      c.state = "held";
      this.save(i);
      return false;
    }
    if (c.state !== "held") return false;
    c.state = "idle";
    this.save(i);
    return true;
  }

  /** Startup: a claim bound to a thread follows that thread's last known status. */
  restore(holder: string, running: boolean): void {
    const i = this.idx(holder);
    const c = this.claims_[i];
    if (!c) return;
    c.state = running ? "held" : "idle";
    this.save(i);
  }

  /** `cap_set`: a machine's max agents in place of what it fits; undefined: auto again. */
  setMachine(m: MachineId, maxAgents: number | undefined): void {
    let machine = this.machine(m);
    if (!machine) {
      machine = { machineId: m, name: m, auto: { cap: UNMEASURED, why: UNMEASURED_WHY } };
      this.machines.push(machine);
    }
    if (maxAgents === undefined) delete machine.maxAgents;
    else machine.maxAgents = maxAgents;
    this.ops.push({ op: "machine_max", machine: { ...machine, auto: { ...machine.auto } } });
  }

  /** `cap_set`: the fleet cap, and a project's own max (undefined: back to the default). Lowering revokes nothing. */
  setCap(cap: number | undefined, maxAgents?: { projectRef: ProjectRef; maxAgents: number | undefined }): void {
    if (cap !== undefined) {
      this.cap_ = cap;
      this.ops.push({ op: "cap", cap });
    }
    if (maxAgents) {
      const { projectRef: r, maxAgents: n } = maxAgents;
      const at = this.maxAgents.findIndex(([s]) => same(s, r));
      if (at >= 0 && n !== undefined) (this.maxAgents[at] as [ProjectRef, number])[1] = n;
      else if (at < 0 && n !== undefined) this.maxAgents.push([{ ...r }, n]);
      else if (at >= 0) this.maxAgents.splice(at, 1);
      this.ops.push(n === undefined ? { op: "max_agents", projectRef: r } : { op: "max_agents", projectRef: r, maxAgents: n });
    }
  }

  /** The project's agents running beyond its max agents, newest first, writers and readers only. */
  extras(r: ProjectRef): string[] {
    const home = r.machineId;
    const counted = this.claims_.filter((c) => c.state === "held" && this.counted(r, home, c));
    const over = Math.max(counted.length - this.maxAgentsOf(r), 0);
    return counted
      .filter((c) => c.priority === "work")
      .sort((a, b) => b.order - a.order)
      .slice(0, over)
      .map((c) => c.holder);
  }

  state(): BoardState {
    const rows: ProjectRow[] = this.maxAgents.map(([r, n]) => ({
      projectRef: { ...r },
      maxAgents: n,
      own: true,
      running: 0,
      queued: 0,
    }));
    for (const c of this.claims_) {
      if (c.state === "idle") continue;
      let row = rows.find((x) => same(x.projectRef, c.projectRef));
      if (!row) {
        row = {
          projectRef: { ...c.projectRef },
          maxAgents: this.maxAgentsOf(c.projectRef),
          own: false,
          running: 0,
          queued: 0,
        };
        rows.push(row);
      }
      if (c.state === "held") row.running += 1;
      else row.queued += 1;
    }
    rows.sort((a, b) => b.running - a.running);
    const count = (s: ClaimState) => this.claims_.filter((c) => c.state === s).length;
    const perMachine = this.machines.slice(0, 50).map((m) => {
      const row: MachineRow = {
        machineId: m.machineId,
        cap: machineCapOf(m),
        auto: m.auto.cap,
        why: m.auto.why,
        running: this.claims_.filter((c) => c.state === "held" && claimMachine(c) === m.machineId).length,
      };
      if (m.maxAgents !== undefined) row.maxAgents = m.maxAgents;
      const disk = this.diskRoom(m.machineId);
      if (disk !== undefined) row.diskRoom = disk;
      return row;
    });
    const out: BoardState = {
      cap: this.total(),
      used: count("held"),
      queued: count("queued"),
      perProject: rows.slice(0, 50),
      perMachine,
    };
    if (this.cap_ !== undefined) out.fleetCap = this.cap_;
    return out;
  }
}

/** The board's state as the apps and `cap_set` show it: no count below 0, and a machine's `why` of 1 to 200 characters, else "auto". */
export function slotState(s: BoardState): SlotState {
  const count = (n: number) => Math.max(n, 0);
  const out: SlotState = { cap: count(s.cap), used: count(s.used), queued: count(s.queued), perProject: [] };
  if (s.fleetCap !== undefined) out.fleetCap = count(s.fleetCap);
  out.perProject = s.perProject.map(
    (row): SlotStatePerProject => ({
      projectRef: row.projectRef,
      maxAgents: count(row.maxAgents),
      own: row.own,
      running: count(row.running),
      queued: count(row.queued),
    }),
  );
  out.perMachine = s.perMachine.map((row) => {
    // Keys in the Rust struct's order.
    const m: Record<string, unknown> = { machineId: row.machineId, cap: count(row.cap) };
    if (row.maxAgents !== undefined) m.maxAgents = count(row.maxAgents);
    m.auto = count(row.auto);
    m.why = row.why.length >= 1 && row.why.length <= 200 ? row.why : "auto";
    m.running = count(row.running);
    if (row.diskRoom !== undefined) m.diskRoom = count(row.diskRoom);
    return m as SlotStatePerMachine;
  });
  return out;
}
