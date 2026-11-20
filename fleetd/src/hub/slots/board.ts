// The slot board's rules, without I/O: the service in index.ts persists what
// `takeOps` hands it and feeds it thread events, machine facts and the time.
//
// Where a slot runs is the board's call too, by count alone (D547): a machine's own slots first; once they are full,
// the team's hosted providers in their fixed order (shared/sandbox.ts ORDER), each up to its limit counted across all
// machines, for a task that runs on a Claude account and on a machine whose node can make that provider's boxes; then
// the queue. Each held claim keeps its place, which the start carries to the node. The board follows where the node
// says each live session's claude runs (`places`): a box counts against its provider while it lives, held or idle
// between turns, and a run that comes back goes where its claude still is.
//
// What runs where's Linux machine (`setHosted`'s `linux`) narrows that: `ours_first` is the rule above, `ours_only`
// leaves the providers out, and a provider's id leaves the machines' own slots out and the other providers too.
//
// A bot that picked its agents' computer (`setComputer`: one hosted provider, at an exact size) has its
// agents placed there and nowhere else: while it has no room, or can't be used (its provider disconnected),
// they wait, saying why, rather than run elsewhere or at another size. Its pick is the bot's own, so it holds whatever
// the Linux machine says.
import type { MachineId, ProjectRef, ProviderTrouble, SlotHosted, SlotSandbox, SlotState, SlotStatePerMachine, SlotStatePerProject } from "../../shared/contracts.ts";
import { HEARTBEAT_TIMEOUT_SECS, type NodeLoad, type SandboxTrouble } from "../../shared/node_link.ts";
import { computerLabel, isProvider, type Limit, NAMES, ORDER, NO_ACCOUNT_HOSTED, RUNNER_ID, troubleLine, troubleOf } from "../../shared/sandbox.ts";
import type { Size } from "../../sandbox/providers/common.ts";
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
  /** The hosted providers its node can make boxes in (it holds their keys), as its last heartbeat said. */
  sandboxes?: string[];
  /** Where each of its live sessions runs now (thread → LOCAL or a provider), as its last heartbeat said: a hosted
   * box from its making until it is destroyed, a claude on the machine while it lives. */
  places?: Record<string, string>;
  /** When `places` came (the board's clock). */
  placesAt?: number;
  /** What its node found wrong with a provider, as its last heartbeat said (shared/node_link.ts SandboxTrouble). */
  trouble?: SandboxTrouble[];
};

/** How long a machine's last word on its live sessions counts after it stops reporting (offline, removed): a hosted box
 * lives an hour past its node's last renewal (node/sandbox/remote/boxes.ts LIFETIME_MS), so no box of it is left by
 * then and its provider's room is free again. */
export const PLACES_FRESH_MS = 65 * 60_000;

/** How long a machine's word on a provider's trouble counts once its heartbeats stop: two missed ones. */
export const TROUBLE_FRESH_MS = 2 * HEARTBEAT_TIMEOUT_SECS * 1000;

/** A machine's own slots: a person's number, else what it fits. */
const machineCapOf = (m: Machine) => m.maxAgents ?? m.auto.cap;

/** Where a held slot runs: the machine's own slots, or a hosted provider's box. */
export const LOCAL = "local";

/** A bot's pick of its agents' computer (shared/contracts.ts ComputerPick): a hosted provider, and the exact size
 * every agent of the bot gets there. */
export type ComputerPick = { kind: string; cpu: number; memGb: number };

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
  /** Where it runs or last ran: LOCAL (or undefined) on its machine's own slots, else a hosted provider. */
  place?: string;
  /** It runs on a Claude account, not its machine's own login: a hosted box may take it. */
  hostable?: boolean;
  /** The size its computer was started at, its bot's pick where the board placed it; absent: the default there. Kept
   * while it holds the slot, so a pick changed meanwhile counts it at what it runs. */
  size?: Size;
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
  /** Each connected provider: its boxes live now and what is wrong there. */
  hosted: SlotHosted[];
};

/** What a project's max agents comes from, for its lead's line. */
export type MaxSource =
  | { kind: "project" }
  | { kind: "fleet" }
  | { kind: "machine" }
  /** Its machine's own measure, and the term that sets it. */
  | { kind: "auto"; why: string };

/** The narrowest limit a queued claim waits behind. */
type Wait = "fleet" | "machine" | "project";

/** What holds a task back from a machine, in the order `block` checks. */
type Block = "fleet" | "no_agents" | "machine" | "disk" | "project";

const same = (a: ProjectRef, b: ProjectRef) => a.machineId === b.machineId && a.projectId === b.projectId;

const cloneClaim = (c: Claim): Claim => ({ ...c, projectRef: { ...c.projectRef }, ...(c.size ? { size: { ...c.size } } : {}) });

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
  /** The team's connected hosted providers' limits, in the order agents go to them. */
  private hosted_: Limit[] = [];
  /** What runs where's Linux machine: `ours_first`, `ours_only`, or a provider's id (that provider only). */
  private linux_ = "ours_first";
  /** Each bot's pick of its agents' computer; a bot with none is placed as above. */
  private computers: [ProjectRef, ComputerPick][] = [];

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

  /** The team's hosted providers' limits, in the order agents go to them, and where its Linux machine is (`linux`).
   * Raising a limit, or a pick that opens more room, starts what now fits. */
  setHosted(limits: Limit[], linux = "ours_first"): boolean {
    const before = JSON.stringify([this.hosted_, this.linux_]);
    this.hosted_ = limits.map((l) => ({ ...l }));
    this.linux_ = linux;
    return JSON.stringify([this.hosted_, this.linux_]) !== before;
  }

  /** The providers the Linux machine places agents in, in order: every connected one for `ours_first`, none for
   * `ours_only`, the one it names otherwise. */
  private picked(): Limit[] {
    if (this.linux_ === "ours_first") return this.hosted_;
    return this.hosted_.filter((l) => l.provider === this.linux_);
  }

  /** Whether the Linux machine places agents on the machines' own slots: not when it names a provider only. */
  private oursPicked(): boolean {
    return this.linux_ === "ours_first" || this.linux_ === "ours_only";
  }

  hosted(): readonly Limit[] {
    return this.hosted_;
  }

  /** A bot's pick of its agents' computer, as its settings keep it; undefined: none. True when it changed. */
  setComputer(r: ProjectRef, pick: ComputerPick | undefined): boolean {
    const before = JSON.stringify(this.computerOf(r) ?? null);
    this.computers = this.computers.filter(([x]) => !same(x, r));
    if (pick) this.computers.push([{ ...r }, { kind: pick.kind, cpu: pick.cpu, memGb: pick.memGb }]);
    return JSON.stringify(pick ?? null) !== before;
  }

  computerOf(r: ProjectRef): ComputerPick | undefined {
    return this.computers.find(([x]) => same(x, r))?.[1];
  }

  /** The size a held claim's computer is started at: its bot's pick, where the claim is placed at it; undefined: the
   * default there. */
  sizeOf(holder: string): Size | undefined {
    const c = this.claims_[this.idx(holder)];
    return c && c.state === "held" ? this.sizeAt(c) : undefined;
  }

  /** The size the held claim that follows `threadId` on `m` is started at (`sizeOf`). */
  sizeOfThread(m: MachineId, threadId: string): Size | undefined {
    const c = this.claims_.find((x) => x.threadId === threadId && claimMachine(x) === m);
    return c && c.state === "held" ? this.sizeAt(c) : undefined;
  }

  private sizeAt(c: Claim): Size | undefined {
    return c.size ? { ...c.size } : undefined;
  }

  /** Claim `c`, just placed: the size its computer starts at, its bot's pick where it is placed there. */
  private stamp(c: Claim): void {
    const pick = this.computerOf(c.projectRef);
    if (pick && pick.kind === c.place) c.size = { cpu: pick.cpu, memGb: pick.memGb };
    else delete c.size;
  }

  /** Machine `m`'s name, where its agents run and its CPUs and memory, as its node last said; undefined: not seen. */
  machineFacts(m: MachineId): { name: string; cap: number } | undefined {
    const x = this.machine(m);
    return x && { name: x.name, cap: this.ownCap(m) };
  }

  /** The fleet cap when set, else what the machines fit together and the hosted limits any of them can use. */
  total(): number {
    if (this.cap_ !== undefined) return this.cap_;
    const own = this.oursPicked() ? this.machines.reduce((n, m) => n + this.ownCap(m.machineId), 0) : 0;
    const hosted = this.picked().filter((l) => this.machines.some((m) => this.canHost(m.machineId, l.provider))).reduce((n, l) => n + l.max, 0);
    return own + hosted;
  }

  /** Whether `m` runs agents and its node can make `provider`'s boxes. */
  private canHost(m: MachineId, provider: string): boolean {
    return this.runsAgents(m) && (this.machine(m)?.sandboxes ?? []).includes(provider);
  }

  /** The hosted limits machine `m` can use: those of the providers its node makes boxes in. */
  private hostedCap(m: MachineId): number {
    return this.picked().filter((l) => this.canHost(m, l.provider)).reduce((n, l) => n + l.max, 0);
  }

  /** Where the node says the claim's thread runs now, if its claude or box lives. */
  private liveAt(c: Pick<Claim, "threadId" | "projectRef">): string | undefined {
    return c.threadId === undefined ? undefined : this.places(claimMachine(c as Claim))[c.threadId];
  }

  /** Where machine `m`'s live sessions run, as it last said, while that still holds (PLACES_FRESH_MS). */
  private places(m: MachineId): Record<string, string> {
    const machine = this.machine(m);
    if (!machine?.places || machine.placesAt === undefined || this.nowMs - machine.placesAt > PLACES_FRESH_MS) return {};
    return machine.places;
  }

  /** Held claims on `m`'s own slots: where its node says their claude runs, else where the board placed them. */
  private localClaims(m: MachineId): Claim[] {
    return this.claims_.filter((c) => c.state === "held" && claimMachine(c) === m && (this.liveAt(c) ?? c.place ?? LOCAL) === LOCAL);
  }

  /** How many agents run on `m`'s own slots. */
  private localHeld(m: MachineId): number {
    return this.localClaims(m).length;
  }

  /** Whether another agent fits `m`'s own slots now. */
  private localRoom(m: MachineId): boolean {
    return this.localHeld(m) < this.ownCap(m);
  }

  /** `provider`'s boxes across all machines: every live one a node reports, held or idle between turns, and each held
   * claim placed there whose box no report shows yet. */
  private hostedUse(provider: string): number {
    let n = 0;
    for (const m of this.machines) for (const at of Object.values(this.places(m.machineId))) if (at === provider) n++;
    return n + this.claims_.filter((c) => c.state === "held" && c.place === provider && this.liveAt(c) === undefined).length;
  }

  /** What a machine that makes `provider`'s boxes last said is wrong there, while that still holds: the hub's runner's
   * word first, then the other machines' in their order. */
  trouble(provider: string): ProviderTrouble | undefined {
    if (!isProvider(provider)) return undefined;
    const ms = [...this.machines].sort((a, b) => (a.machineId === RUNNER_ID ? -1 : b.machineId === RUNNER_ID ? 1 : 0));
    for (const m of ms) {
      if (m.placesAt === undefined || this.nowMs - m.placesAt > TROUBLE_FRESH_MS) continue;
      const t = m.trouble?.find((x) => x.provider === provider && (x.what !== "start" || (x.until ?? 0) > this.nowMs));
      if (t) return troubleOf(provider, t);
    }
    return undefined;
  }

  /** Forgets what the machines said is wrong with `provider` (a test of its key just worked, and they were told to try
   * it again): until a heartbeat says it again. */
  clearTrouble(provider: string): void {
    for (const m of this.machines) {
      if (!m.trouble) continue;
      m.trouble = m.trouble.filter((t) => t.provider !== provider);
      if (m.trouble.length === 0) delete m.trouble;
    }
  }

  /** The troubles of the picked providers, each as its line (`troubleLine`). */
  private troubleLines(): string[] {
    return this.picked().flatMap((l) => {
      const t = this.trouble(l.provider);
      return t ? [troubleLine(t)] : [];
    });
  }

  /** Each connected provider, in order: its boxes live now, its limit and its trouble. */
  hostedState(): SlotHosted[] {
    return this.hosted_.map((l) => {
      const t = this.trouble(l.provider);
      return { provider: l.provider, limit: l.max, running: this.hostedUse(l.provider), ...(t ? { trouble: t } : {}) };
    });
  }

  /** Where claim `c` would run on `m` now; undefined when it can't yet. A claude still alive runs where it is: its box
   * already counts against its provider; on the machine, it needs a free slot. Else where it ran last while that has
   * room, then the machine's own slots, then each hosted provider in order. */
  private freePlace(c: Pick<Claim, "place" | "hostable" | "threadId" | "projectRef">, m: MachineId): string | undefined {
    if (!this.runsAgents(m)) return undefined;
    const localFree = this.localRoom(m);
    const live = c.threadId === undefined ? undefined : this.places(m)[c.threadId];
    if (live !== undefined && live !== LOCAL) return live;
    if (live === LOCAL) return localFree ? LOCAL : undefined;
    const hostedFree = (p: string) => c.hostable === true && this.canHost(m, p) && this.hostedUse(p) < (this.hosted_.find((l) => l.provider === p)?.max ?? 0);
    // Its bot's pick: there, or nowhere yet.
    const pick = this.computerOf(c.projectRef);
    if (pick) return hostedFree(pick.kind) ? pick.kind : undefined;
    // Else where the Linux machine says: where it ran last while that has room, the machine's own slots, the providers.
    const picked = this.picked();
    if (c.place && c.place !== LOCAL && picked.some((l) => l.provider === c.place) && hostedFree(c.place)) return c.place;
    if (localFree && this.oursPicked()) return LOCAL;
    return picked.find((l) => hostedFree(l.provider))?.provider;
  }

  /** The claim's place (LOCAL or a provider), or undefined while it holds no slot. */
  placeOf(holder: string): string | undefined {
    const c = this.claims_[this.idx(holder)];
    return c && c.state === "held" ? (c.place ?? LOCAL) : undefined;
  }

  /** The place of the held claim that follows `threadId` on `m`. */
  placeOfThread(m: MachineId, threadId: string): string | undefined {
    const c = this.claims_.find((x) => x.threadId === threadId && claimMachine(x) === m);
    return c && c.state === "held" ? (c.place ?? LOCAL) : undefined;
  }

  private machine(m: MachineId): Machine | undefined {
    return this.machines.find((x) => x.machineId === m);
  }

  /** The machine's cap: its own slots and the hosted limits it can use. */
  machineCap(m: MachineId): number {
    return this.ownCap(m) + this.hostedCap(m);
  }

  /** The machine's own slots: a person's setting, else what it fits; UNMEASURED until its node reports. */
  ownCap(m: MachineId): number {
    // The hub's own runner runs nothing on its machine: every agent of its goes to a hosted provider.
    if (!this.runsAgents(m) || m === RUNNER_ID) return 0;
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
  observeMachine(
    machineId: MachineId,
    name: string,
    auto: Auto,
    diskRoom: number | undefined,
    sandboxes: string[] = [],
    places: Record<string, string> = {},
    trouble: SandboxTrouble[] = [],
  ): boolean {
    const roomBefore = this.diskRoom(machineId) ?? Infinity;
    const capBefore = this.machineCap(machineId);
    const m = this.machine(machineId);
    let freed = false;
    if (!m) {
      const machine: Machine = { machineId, name, auto: { ...auto } };
      if (diskRoom !== undefined) machine.diskRoom = diskRoom;
      if (sandboxes.length) machine.sandboxes = [...sandboxes];
      if (Object.keys(places).length) machine.places = { ...places };
      machine.placesAt = this.nowMs;
      if (trouble.length) machine.trouble = trouble.map((t) => ({ ...t }));
      this.machines.push(machine);
      this.ops.push({ op: "machine", machineId, name, auto: { ...auto } });
    } else {
      if (diskRoom === undefined) delete m.diskRoom;
      else m.diskRoom = diskRoom;
      if (sandboxes.length) m.sandboxes = [...sandboxes];
      else delete m.sandboxes;
      // A box destroyed or a claude ended since frees room, for this machine's queue or any machine's for a provider.
      const was = m.places ?? {};
      freed = Object.entries(was).some(([thread, at]) => places[thread] !== at);
      if (Object.keys(places).length) m.places = { ...places };
      else delete m.places;
      m.placesAt = this.nowMs;
      if (trouble.length) m.trouble = trouble.map((t) => ({ ...t }));
      else delete m.trouble;
      if (m.auto.cap !== auto.cap || m.auto.why !== auto.why || m.name !== name) {
        m.auto = { ...auto };
        m.name = name;
        this.ops.push({ op: "machine", machineId, name, auto: { ...auto } });
      }
    }
    return freed || this.machineCap(machineId) > capBefore || (this.diskRoom(machineId) ?? Infinity) > roomBefore;
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
  private block(r: ProjectRef, m: MachineId, fresh: boolean, c: Pick<Claim, "place" | "hostable" | "threadId"> = {}): Block | undefined {
    const [used, , running] = this.held(r, m);
    if (this.cap_ !== undefined && used >= this.cap_) return "fleet";
    if (!this.runsAgents(m)) return "no_agents";
    if (this.freePlace({ ...c, projectRef: r }, m) === undefined) return "machine";
    if (fresh && this.diskRoom(m) === 0) return "disk";
    if (running >= this.maxOn(r, m)) return "project";
    return undefined;
  }

  /** Why an agent of a bot that picked `pick` can't have that computer on machine `m` now. */
  private pickBlocker(r: ProjectRef, pick: ComputerPick, m: MachineId, hostable: boolean): string {
    const picked = `its bot's computer is ${computerLabel(pick)}`;
    const other = "or pick another on the bot's Computer page";
    const name = this.machine(m)?.name ?? m;
    const at = pick.kind;
    const provider = nameOf(at);
    const limit = this.hosted_.find((l) => l.provider === at);
    if (!limit) return `${picked}, and ${provider} isn't connected: an admin connects it in Settings › Hub › Machines, ${other}`;
    if (!hostable) return `${picked}, but ${NO_ACCOUNT_HOSTED}, ${other}`;
    if (!this.canHost(m, at)) {
      const t = this.trouble(at);
      return t ? `${picked}, but ${troubleLine(t)}` : `${picked}, and ${name} can't make ${provider} boxes yet: it gets the key at its next heartbeat`;
    }
    return `${picked}: ${provider} is full, ${this.hostedUse(at)} of ${limit.max}`;
  }

  /** Why a task of the project cannot take a slot on machine `m` now, or undefined if it can. */
  private blocker(r: ProjectRef, m: MachineId, fresh: boolean, c: Pick<Claim, "place" | "hostable" | "threadId"> = {}): string | undefined {
    const block = this.block(r, m, fresh, c);
    if (block === undefined) return undefined;
    const [used, , running] = this.held(r, m);
    const machine = this.machine(m);
    const name = machine?.name ?? m;
    switch (block) {
      case "fleet":
        return `fleet cap: ${used} of ${this.cap_ ?? 0} running`;
      case "no_agents":
        return `${name} runs no agents: its role is screens only (a hub admin changes it in Settings › Hub › Machines)`;
      case "machine": {
        const pick = this.computerOf(r);
        if (pick && !(c.threadId !== undefined && this.places(m)[c.threadId] !== undefined)) return this.pickBlocker(r, pick, m, c.hostable === true);
        const usable = this.picked().filter((l) => this.canHost(m, l.provider));
        if (m === RUNNER_ID)
          return runnerBlocker(this.picked().length > 0, usable.map((l) => `${nameOf(l.provider)} ${this.hostedUse(l.provider)} of ${l.max}`), c.hostable === true, this.linux_, this.troubleLines());
        if (!this.oursPicked()) {
          const t = this.trouble(this.linux_);
          return providerOnlyBlocker(this.linux_, this.picked()[0], this.picked()[0] ? this.hostedUse(this.linux_) : 0, this.canHost(m, this.linux_), name, c.hostable === true, t ? troubleLine(t) : undefined);
        }
        const why = machine ? machineWhy(machine) : UNMEASURED_WHY;
        const own = `machine cap: ${this.localHeld(m)} of ${this.ownCap(m)} running on ${name} (${why})`;
        if (usable.length === 0) {
          // A provider its node set aside after a failure: what went wrong there, rather than nothing.
          const troubles = c.hostable === true ? this.troubleLines() : [];
          return troubles.length > 0 ? `${own}; ${troubles.join("; ")}` : own;
        }
        if (c.threadId !== undefined && this.places(m)[c.threadId] === LOCAL) return `${own}; its Claude still runs there, so it waits for a slot of its own`;
        if (c.hostable !== true) return `${own}; hosted sandboxes take only agents on a Claude account, not this machine's own login`;
        return `${own}, and hosted sandboxes are full: ${usable.map((l) => `${nameOf(l.provider)} ${this.hostedUse(l.provider)} of ${l.max}`).join(", ")}`;
      }
      case "disk":
        return `disk: no room for another agent on ${name} until the new worktrees settle or space frees`;
      case "project":
        return `Max agents: ${running} of ${this.maxOn(r, m)} running`;
    }
  }

  /** The narrowest limit the project's tasks on machine `m` wait behind now. */
  private limit(r: ProjectRef, m: MachineId): Wait | undefined {
    const [used, , running] = this.held(r, m);
    if (running >= this.maxOn(r, m)) return "project";
    if (this.freePlace({ hostable: true, projectRef: r }, m) === undefined || this.diskRoom(m) === 0) return "machine";
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
      if (this.block(c.projectRef, claimMachine(c), c.threadId === undefined, c) === undefined) this.grant(i);
    }
  }

  /** Holds claim `i`'s slot; a new agent's start counts against its machine's disk room until it settles. */
  private grant(i: number): void {
    const c = this.claims_[i] as Claim;
    c.place = this.freePlace(c, claimMachine(c)) ?? LOCAL;
    c.state = "held";
    this.stamp(c);
    if (c.threadId === undefined) this.starts.push([c.holder, claimMachine(c), this.nowMs]);
    this.save(i);
  }

  /**
   * Asking again for a holder that already has a slot returns granted; for one already queued, its current reason.
   * An idle holder joins the back of the queue.
   */
  acquire(holder: string, projectRef: ProjectRef, priority: SlotPriority, hostable = false): Grant {
    let i = this.idx(holder);
    if (i >= 0) {
      const c = this.claims_[i] as Claim;
      if (c.state === "held") return GRANTED;
      c.projectRef = { ...projectRef };
      c.priority = priority;
      c.hostable = hostable;
      if (c.state === "idle") {
        c.state = "queued";
        c.order = this.nextOrder++;
      }
    } else {
      const c: Claim = { holder, projectRef: { ...projectRef }, priority, state: "queued", order: this.nextOrder++, hostable };
      this.claims_.push(c);
      i = this.claims_.length - 1;
    }
    this.save(i);
    this.evaluate();
    const c = this.claims_[i] as Claim;
    if (c.state === "held") return GRANTED;
    const reason = this.blocker(projectRef, claimMachine(c), c.threadId === undefined, c);
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
      // A thread that ran with no grant (a Monitor of its own woke it) runs where its claude lives, as its node says;
      // else where the board would place it now.
      if (c.state !== "held") {
        c.place = this.liveAt(c) ?? this.freePlace(c, machineId) ?? c.place ?? LOCAL;
        this.stamp(c);
      }
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
      // Its own slots and what runs in them; the hosted limits are the team's, shared by every machine, so they are
      // named beside it, never added to it (the fleet's total counts each once).
      const usable = this.picked().filter((l) => l.max > 0 && this.canHost(m.machineId, l.provider));
      const shared = usable.length ? `; then the team's hosted sandboxes (${usable.map((l) => `${nameOf(l.provider)} ${l.max}`).join(", ")})` : "";
      const row: MachineRow = {
        machineId: m.machineId,
        cap: machineCapOf(m),
        auto: m.auto.cap,
        why: `${m.auto.why}${shared}`,
        running: this.localHeld(m.machineId),
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
      hosted: this.hostedState(),
    };
    if (this.cap_ !== undefined) out.fleetCap = this.cap_;
    return out;
  }
}

/** The longest a machine's `why` goes to the apps: past it, it is cut with an ellipsis, never dropped. */
export const WHY_MAX = 1000;

/** `text`, or its first `max - 1` characters and an ellipsis. */
export function clip(text: string, max: number): string {
  const chars = [...text];
  return chars.length > max ? `${chars.slice(0, Math.max(0, max - 1)).join("")}…` : text;
}

/** fleetd cloud calls this until its W760 pin move. No node of this fleetd says it runs VMs any more, so a cap's
 * reason is its own: nothing of where agents run is added to it. */
export function withSandbox<T extends { why: string }>(auto: T, _sandbox: NodeLoad["sandbox"]): T & { sandbox?: SlotSandbox } {
  return auto;
}

/** A provider's name where a person reads it; one this build doesn't know, by its id. */
const nameOf = (p: string): string => NAMES[p as keyof typeof NAMES] ?? p;

/** Why an agent waits on a machine while the Linux machine is `provider` only: it isn't connected, the machine can't
 * make its boxes yet, the agent has no Claude account, or it is at its limit. */
export function providerOnlyBlocker(provider: string, limit: Limit | undefined, used: number, canHost: boolean, machine: string, hostable: boolean, trouble?: string): string {
  const name = nameOf(provider);
  if (!limit) return `the team's agents run on ${name} only, and ${name} isn't connected: an admin connects it, or picks your machines for Linux machine, in Settings › Hub › Machines`;
  if (!hostable) return `the team's agents run on ${name} only, and ${NO_ACCOUNT_HOSTED}`;
  if (!canHost && trouble) return `the team's agents run on ${name} only, and ${trouble}`;
  if (!canHost) return `the team's agents run on ${name} only, and ${machine} can't make ${name} boxes yet: it gets the key at its next heartbeat`;
  return `the team's agents run on ${name} only, and it is full: ${used} of ${limit.max}`;
}

/** Why an agent of a bot no computer runs (the hub's runner) waits: no provider is connected (`connected`), one the
 * runner set aside after a failure (`trouble`, each its line) or none ready on it yet, it has no Claude account, or
 * every provider is at its limit (`full`, one "boat.dev 3 of 3" each). */
export function runnerBlocker(connected: boolean, full: string[], hostable: boolean, linux = "ours_first", trouble: string[] = []): string {
  if (linux === "ours_only") return "the team's agents run on its own machines only, and no computer of the team's runs this bot: an admin picks a provider for Linux machine in Settings › Hub › Machines, or connects a computer";
  if (!connected) return "no hosted sandbox provider is connected to run it: an admin connects boat.dev in Settings › Hub › Machines";
  if (full.length === 0 && trouble.length > 0) return trouble.join("; ");
  if (full.length === 0) return `${ORDER.map((p) => NAMES[p]).join(" and ")} is starting: the agent starts once it is ready`;
  if (!hostable) return "agents in hosted sandboxes run on a Claude account, and this one has none: connect the hub's API key or your Claude subscription in Settings";
  return `hosted sandboxes are full: ${full.join(", ")}`;
}

/** The board's state as the apps and `cap_set` show it: no count below 0, a machine's `why` cut to WHY_MAX ("auto" only
 * when empty), and where its agents run. */
export function slotState(s: BoardState): SlotState {
  const count = (n: number) => Math.max(n, 0);
  const out: SlotState = { cap: count(s.cap), used: count(s.used), queued: count(s.queued), perProject: [] };
  if (s.fleetCap !== undefined) out.fleetCap = count(s.fleetCap);
  if (s.hosted.length > 0) out.hosted = s.hosted.map((h) => ({ ...h, limit: count(h.limit), running: count(h.running) }));
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
    m.why = row.why ? clip(row.why, WHY_MAX) : "auto";
    m.running = count(row.running);
    if (row.diskRoom !== undefined) m.diskRoom = count(row.diskRoom);
    return m as SlotStatePerMachine;
  });
  return out;
}
