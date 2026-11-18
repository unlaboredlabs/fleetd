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
// A bot that picked its agents' computer (`setComputer`: a Local VM or one hosted provider, at an exact size) has its
// agents placed there and nowhere else: while it has no room, or can't be used (VMs off, the provider disconnected),
// they wait, saying why, rather than run elsewhere or at another size.
import type { MachineId, ProjectRef, SlotSandbox, SlotState, SlotStatePerMachine, SlotStatePerProject } from "../../shared/contracts.ts";
import type { NodeLoad } from "../../shared/node_link.ts";
import { computerLabel, type Limit, NAMES, RUNNER_ID, vmFits } from "../../shared/sandbox.ts";
import type { Size } from "../../sandbox/providers/common.ts";
import { type Auto, type Host, UNMEASURED, UNMEASURED_WHY } from "./sizing.ts";

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
};

/** How long a machine's last word on its live sessions counts after it stops reporting (offline, removed): a hosted box
 * lives an hour past its node's last renewal (node/sandbox/remote/boxes.ts LIFETIME_MS), so no box of it is left by
 * then and its provider's room is free again. */
export const PLACES_FRESH_MS = 65 * 60_000;

/** A machine's own slots: a person's number, else what it fits. */
const machineCapOf = (m: Machine) => m.maxAgents ?? m.auto.cap;

/** Where a held slot runs: the machine's own slots, or a hosted provider's box. */
export const LOCAL = "local";

/** A bot's pick of its agents' computer (shared/contracts.ts ComputerPick): `vm`, its machine's own VM, or a hosted
 * provider, and the exact size every agent of the bot gets there. */
export type ComputerPick = { kind: string; cpu: number; memGb: number };

/** Where a pick's agents are placed: LOCAL for a Local VM, else its provider. */
export const pickPlace = (p: Pick<ComputerPick, "kind">): string => (p.kind === "vm" ? LOCAL : p.kind);
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
  sandbox?: SlotSandbox;
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
type Wait = "fleet" | "machine" | "project";

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
  /** The team's connected hosted providers' limits, in the order agents go to them. */
  private hosted_: Limit[] = [];
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

  /** The team's hosted providers' limits, in the order agents go to them. Raising one starts what now fits. */
  setHosted(limits: Limit[]): boolean {
    const before = JSON.stringify(this.hosted_);
    this.hosted_ = limits.map((l) => ({ ...l }));
    return JSON.stringify(this.hosted_) !== before;
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
    const pick = this.computerOf(c.projectRef);
    return pick && pickPlace(pick) === (c.place ?? LOCAL) ? { cpu: pick.cpu, memGb: pick.memGb } : undefined;
  }

  /** Machine `m`'s name, where its agents run and its CPUs and memory, as its node last said; undefined: not seen. */
  machineFacts(m: MachineId): { name: string; sandbox?: SlotSandbox; host?: Host } | undefined {
    const x = this.machine(m);
    return x && { name: x.name, ...(x.auto.sandbox ? { sandbox: { ...x.auto.sandbox } } : {}), ...(x.auto.host ? { host: { ...x.auto.host } } : {}) };
  }

  /** Whether machine `m`'s node runs agents in VMs now, as its last heartbeat said. */
  private runsVms(m: MachineId): boolean {
    return this.machine(m)?.auto.sandbox?.kind === "microvm";
  }

  /** The fleet cap when set, else what the machines fit together and the hosted limits any of them can use. */
  total(): number {
    if (this.cap_ !== undefined) return this.cap_;
    const own = this.machines.reduce((n, m) => n + this.ownCap(m.machineId), 0);
    const hosted = this.hosted_.filter((l) => this.machines.some((m) => this.canHost(m.machineId, l.provider))).reduce((n, l) => n + l.max, 0);
    return own + hosted;
  }

  /** Whether `m` runs agents and its node can make `provider`'s boxes. */
  private canHost(m: MachineId, provider: string): boolean {
    return this.runsAgents(m) && (this.machine(m)?.sandboxes ?? []).includes(provider);
  }

  /** The hosted limits machine `m` can use: those of the providers its node makes boxes in. */
  private hostedCap(m: MachineId): number {
    return this.hosted_.filter((l) => this.canHost(m, l.provider)).reduce((n, l) => n + l.max, 0);
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
  private localHeld(m: MachineId): number {
    return this.claims_.filter((c) => c.state === "held" && claimMachine(c) === m && (this.liveAt(c) ?? c.place ?? LOCAL) === LOCAL).length;
  }

  /** `provider`'s boxes across all machines: every live one a node reports, held or idle between turns, and each held
   * claim placed there whose box no report shows yet. */
  private hostedUse(provider: string): number {
    let n = 0;
    for (const m of this.machines) for (const at of Object.values(this.places(m.machineId))) if (at === provider) n++;
    return n + this.claims_.filter((c) => c.state === "held" && c.place === provider && this.liveAt(c) === undefined).length;
  }

  /** Where claim `c` would run on `m` now; undefined when it can't yet. A claude still alive runs where it is: its box
   * already counts against its provider; on the machine, it needs a free slot. Else where it ran last while that has
   * room, then the machine's own slots, then each hosted provider in order. */
  private freePlace(c: Pick<Claim, "place" | "hostable" | "threadId" | "projectRef">, m: MachineId): string | undefined {
    if (!this.runsAgents(m)) return undefined;
    const localFree = this.localHeld(m) < this.ownCap(m);
    const live = c.threadId === undefined ? undefined : this.places(m)[c.threadId];
    if (live !== undefined && live !== LOCAL) return live;
    if (live === LOCAL) return localFree ? LOCAL : undefined;
    const hostedFree = (p: string) => c.hostable === true && this.canHost(m, p) && this.hostedUse(p) < (this.hosted_.find((l) => l.provider === p)?.max ?? 0);
    // Its bot's pick: there, or nowhere yet.
    const pick = this.computerOf(c.projectRef);
    if (pick) {
      const at = pickPlace(pick);
      if (at === LOCAL) return localFree && m !== RUNNER_ID && this.runsVms(m) && vmFits(pick, this.machine(m)?.auto.host) ? LOCAL : undefined;
      return hostedFree(at) ? at : undefined;
    }
    if (c.place && c.place !== LOCAL && hostedFree(c.place)) return c.place;
    if (localFree) return LOCAL;
    return this.hosted_.find((l) => hostedFree(l.provider))?.provider;
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
  observeMachine(machineId: MachineId, name: string, auto: Auto, diskRoom: number | undefined, sandboxes: string[] = [], places: Record<string, string> = {}): boolean {
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
      // Where its agents run comes with every heartbeat and isn't stored: kept as it was said last.
      if (auto.sandbox) m.auto.sandbox = { ...auto.sandbox };
      else delete m.auto.sandbox;
      if (auto.host) m.auto.host = { ...auto.host };
      else delete m.auto.host;
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
  private pickBlocker(pick: ComputerPick, m: MachineId, hostable: boolean): string {
    const picked = `its bot's computer is ${computerLabel(pick)}`;
    const other = "or pick another on the bot's Computer page";
    const machine = this.machine(m);
    const name = machine?.name ?? m;
    const at = pickPlace(pick);
    if (at === LOCAL) {
      if (m === RUNNER_ID) return `${picked}, and no computer of the team's runs this bot: connect one, ${other}`;
      if (!this.runsVms(m)) return `${picked}, and ${name} runs no VMs now${machine?.auto.sandbox?.why ? `: ${machine.auto.sandbox.why}` : ""}; ${other}`;
      if (!vmFits(pick, machine?.auto.host)) return `${picked}, and ${name} hasn't the CPUs or memory for it; ${other}`;
      return `${picked}: ${this.localHeld(m)} of ${this.ownCap(m)} running on ${name} (${machine ? machineWhy(machine) : UNMEASURED_WHY})`;
    }
    const provider = NAMES[at as keyof typeof NAMES] ?? at;
    const limit = this.hosted_.find((l) => l.provider === at);
    if (!limit) return `${picked}, and ${provider} isn't connected: an admin connects it in Settings › Hub › Machines, ${other}`;
    if (!hostable) return `${picked}, and hosted sandboxes take only agents on a Claude account, not ${name}'s own login: give the bot a Claude account, ${other}`;
    if (!this.canHost(m, at)) return `${picked}, and ${name} can't make ${provider} boxes yet: it gets the key at its next heartbeat`;
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
        if (pick && !(c.threadId !== undefined && this.places(m)[c.threadId] !== undefined)) return this.pickBlocker(pick, m, c.hostable === true);
        const usable = this.hosted_.filter((l) => this.canHost(m, l.provider));
        if (m === RUNNER_ID) return runnerBlocker(this.hosted_.length > 0, usable.map((l) => `${NAMES[l.provider]} ${this.hostedUse(l.provider)} of ${l.max}`), c.hostable === true);
        const why = machine ? machineWhy(machine) : UNMEASURED_WHY;
        const own = `machine cap: ${this.localHeld(m)} of ${this.ownCap(m)} running on ${name} (${why})`;
        if (usable.length === 0) return own;
        if (c.threadId !== undefined && this.places(m)[c.threadId] === LOCAL) return `${own}; its Claude still runs there, so it waits for a slot of its own`;
        if (c.hostable !== true) return `${own}; hosted sandboxes take only agents on a Claude account, not this machine's own login`;
        return `${own}, and hosted sandboxes are full: ${usable.map((l) => `${NAMES[l.provider]} ${this.hostedUse(l.provider)} of ${l.max}`).join(", ")}`;
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
      if (c.state !== "held") c.place = this.liveAt(c) ?? this.freePlace(c, machineId) ?? c.place ?? LOCAL;
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
      const usable = this.hosted_.filter((l) => l.max > 0 && this.canHost(m.machineId, l.provider));
      const shared = usable.length ? `; then the team's hosted sandboxes (${usable.map((l) => `${NAMES[l.provider]} ${l.max}`).join(", ")})` : "";
      const row: MachineRow = {
        machineId: m.machineId,
        cap: machineCapOf(m),
        auto: m.auto.cap,
        why: `${m.auto.why}${shared}`,
        running: this.localHeld(m.machineId),
      };
      if (m.auto.sandbox) row.sandbox = { ...m.auto.sandbox };
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

/** The longest a machine's `why` goes to the apps, and its sandbox reason and fix: past them, each is cut with an
 * ellipsis, never dropped (a VM refusal's reason with its fix runs to about 450 characters). */
export const WHY_MAX = 1000;
export const SANDBOX_WHY_MAX = 600;
export const SANDBOX_FIX_MAX = 300;

/** `text`, or its first `max - 1` characters and an ellipsis. */
export function clip(text: string, max: number): string {
  const chars = [...text];
  return chars.length > max ? `${chars.slice(0, Math.max(0, max - 1)).join("")}…` : text;
}

/** A cap's reason with where the machine's agents run: in a VM each, or as plain processes and why (a person reads
 * it beside the machine's cap). Here, beside `clip`, so fleetd cloud sizes its machines with it too. */
export function withSandbox<T extends { why: string }>(auto: T, sandbox: NodeLoad["sandbox"]): T & { sandbox?: SlotSandbox } {
  if (!sandbox) return auto;
  if (sandbox.kind === "microvm") {
    // In VMs, but some agents not (a machine signed in with `claude login`): which, why and the fix, in the same line.
    if (!sandbox.why) return { ...auto, why: `${auto.why}; each agent in a VM of its own`, sandbox: { kind: "microvm" } };
    const note = clip(String(sandbox.why), SANDBOX_WHY_MAX);
    const fix = typeof sandbox.fix === "string" && sandbox.fix ? clip(sandbox.fix, SANDBOX_FIX_MAX) : undefined;
    return { ...auto, why: `${auto.why}; each agent in a VM of its own, but ${fix ? `${note} Fix: ${fix}` : note}`, sandbox: { kind: "microvm", why: note, ...(fix ? { fix } : {}) } };
  }
  // Whole, or cut with an ellipsis: a reason is never dropped from the line people read.
  const reason = clip(String(sandbox.why ?? "") || "no reason given", SANDBOX_WHY_MAX);
  const fix = typeof sandbox.fix === "string" && sandbox.fix ? clip(sandbox.fix, SANDBOX_FIX_MAX) : undefined;
  const out: SlotSandbox = { kind: "process", why: reason, ...(fix ? { fix } : {}), ...(sandbox.expected ? { expected: true } : {}) };
  return { ...auto, why: `${auto.why}; agents run as plain processes: ${fix ? `${reason} Fix: ${fix}` : reason}`, sandbox: out };
}

/** Why an agent of a bot no computer runs (the hub's runner) waits: no provider is connected (`connected`) or ready
 * on the runner yet, it has no Claude account, or every provider is at its limit (`full`, one "E2B 3 of 3" each). */
export function runnerBlocker(connected: boolean, full: string[], hostable: boolean): string {
  if (!connected) return "no hosted sandbox provider is connected to run it: an admin connects E2B, boat.dev or Daytona in Settings › Hub › Machines";
  if (full.length === 0) return "the hosted sandbox providers aren't ready on the hub yet: it starts once they are";
  if (!hostable) return "agents in hosted sandboxes run on a Claude account, and this one has none: connect the hub's API key or your Claude subscription in Settings";
  return `hosted sandboxes are full: ${full.join(", ")}`;
}

/** The board's state as the apps and `cap_set` show it: no count below 0, a machine's `why` cut to WHY_MAX ("auto" only
 * when empty), and where its agents run. */
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
    m.why = row.why ? clip(row.why, WHY_MAX) : "auto";
    m.running = count(row.running);
    if (row.sandbox) {
      const sb: SlotSandbox = { kind: row.sandbox.kind };
      if (row.sandbox.why) sb.why = clip(row.sandbox.why, SANDBOX_WHY_MAX);
      if (row.sandbox.fix) sb.fix = clip(row.sandbox.fix, SANDBOX_FIX_MAX);
      if (row.sandbox.expected) sb.expected = true;
      m.sandbox = sb;
    }
    if (row.diskRoom !== undefined) m.diskRoom = count(row.diskRoom);
    return m as SlotStatePerMachine;
  });
  return out;
}
