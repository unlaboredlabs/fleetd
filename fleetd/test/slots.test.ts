// The slot board (crates/fleetd/src/hub/slots/{board,sizing,mod}.rs tests) and cap_set (hub/tasks/cap.rs).
import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { MIGRATIONS } from "../src/gen/migrations.ts";
import { Hub } from "../src/hub/api/hub.ts";
import { leadWakes, type Trigger } from "../src/hub/api/leads.ts";
import { Board, type Claim, GRANTED, LOCAL, type Machine, PLACES_FRESH_MS, SANDBOX_WHY_MAX, type SlotPriority, SETTLE_MS, slotState, WHY_MAX } from "../src/hub/slots/board.ts";
import { capSet, machineLine, pausedLine, raisedLine } from "../src/hub/slots/cap.ts";
import { Slots, slots, state, withSandbox } from "../src/hub/slots/index.ts";
import { start } from "../src/hub/slots/loops.ts";
import { autoCap, diskRoom, HARD_TOP, UNMEASURED, UNMEASURED_WHY } from "../src/hub/slots/sizing.ts";
import { HubDb } from "../src/hub/store/db.ts";
import { events } from "../src/hub/store/events.ts";
import { store } from "../src/hub/store/hub_store.ts";
import type { NodeLoad } from "../src/shared/node_link.ts";
import type { MachineId, ProjectRef } from "../src/shared/contracts.ts";
import { NO_ACCOUNT_HOSTED, RUNNER_ID } from "../src/shared/sandbox.ts";
import { key, kit, project } from "./work-kit.ts";

const GIB = 2 ** 30;
const GB = 1_000_000_000;

describe("sizing", () => {
  const machine = (cpus: number, memGib?: number): NodeLoad => ({
    cpus,
    load1: 0.5,
    ...(memGib !== undefined ? { memTotalBytes: memGib * GIB } : {}),
  });
  const withDisk = (load: NodeLoad, freeGb: number, minFreeGb: number): NodeLoad => ({
    ...load,
    disk: { freeBytes: freeGb * GB, totalBytes: 2000 * GB, minFreeBytes: minFreeGb * GB },
  });
  const auto = (cap: number, why: string) => ({ cap, why });

  test("the example machines", () => {
    expect(autoCap(machine(8, 8))).toEqual(auto(2, "memory 8 GB, about 2 GB an agent"));
    expect(autoCap(machine(12, 18))).toEqual(auto(6, "memory 18 GB, about 2 GB an agent"));
    expect(autoCap(machine(16, 32))).toEqual(auto(12, "memory 32 GB, about 2 GB an agent"));
    expect(autoCap(machine(32, 128))).toEqual(auto(28, "28 of 32 CPUs"));
    expect(autoCap(machine(64, 256))).toEqual(auto(56, "56 of 64 CPUs"));
    expect(autoCap(machine(128, 512))).toEqual(auto(64, "top of 64"));
    expect(autoCap(machine(2, 4))).toEqual(auto(1, "memory 4 GB, about 2 GB an agent"));
  });

  test("the kernel's short count of memory is rounded up; an older node without memory counts four", () => {
    expect(autoCap({ cpus: 16, load1: 0.5, memTotalBytes: 33_520_000_000 })).toEqual(
      auto(12, "memory 32 GB, about 2 GB an agent"),
    );
    expect(autoCap(machine(16))).toEqual(auto(4, "memory unknown"));
    expect(autoCap(machine(2))).toEqual(auto(1, "1 of 2 CPUs"));
  });

  test("an older node's memory per agent replaces two", () => {
    const large: NodeLoad = { cpus: 8, load1: 0.5, memTotalBytes: 15_991 * 2 ** 20 };
    expect(autoCap(large).cap).toBe(6);
    expect(autoCap({ ...machine(12, 18), memPerAgentBytes: 2 * GB })).toEqual(
      auto(6, "memory 18 GB, about 2 GB an agent"),
    );
    expect(autoCap({ ...machine(16, 32), memPerAgentBytes: 4 * GB })).toEqual(
      auto(6, "memory 32 GB, about 4 GB an agent"),
    );
    expect(autoCap({ ...machine(16, 32), memPerAgentBytes: 2_500_000_000 })).toEqual(
      auto(9, "memory 32 GB, about 2.5 GB an agent"),
    );
  });

  test("disk room counts 5 GB agents above the floor", () => {
    expect(diskRoom(withDisk(machine(8, 8), 60, 26))).toBe(6);
    expect(diskRoom(withDisk(machine(2, 4), 25, 20))).toBe(1);
    expect(diskRoom(withDisk(machine(2, 4), 10, 20))).toBe(0);
    expect(diskRoom(machine(2, 4))).toBeUndefined();
    expect(diskRoom({ ...withDisk(machine(64, 256), 1500, 200), diskPerAgentBytes: 2 * GB })).toBe(650);
  });
});

const project_ = (p: string, m = "lab-a"): ProjectRef => ({ machineId: m, projectId: p });

/** A machine that fits `cap`, with room on its disk for `diskRoom` new agents if known. */
function machine(m: string, cap: number, disk?: number): Machine {
  return { machineId: m, name: `${m}-box`, auto: { cap, why: "memory 18 GB" }, ...(disk !== undefined ? { diskRoom: disk } : {}) };
}

const queued = (reason: string) => ({ granted: false, reason });

/** The board plus what the tasks area's release listener would see: holders granted other than by their own acquire. */
class Kit {
  seen: string[] = [];
  grants: string[] = [];
  constructor(public board: Board) {}
  static fleet(cap: number) {
    return Kit.on(cap, [machine("lab-a", HARD_TOP)]);
  }
  static on(cap: number | undefined, machines: Machine[]) {
    return new Kit(new Board(cap, [], machines, []));
  }
  held(): string[] {
    return this.board
      .claims()
      .filter((c) => c.state === "held")
      .sort((a, b) => a.order - b.order)
      .map((c) => c.holder);
  }
  freed() {
    this.board.evaluate();
    for (const h of this.held()) {
      if (!this.seen.includes(h)) {
        this.grants.push(h);
        this.seen.push(h);
      }
    }
  }
  acquire(holder: string, r: ProjectRef, p: SlotPriority = "work") {
    const g = this.board.acquire(holder, r, p);
    if (g.granted && !this.seen.includes(holder)) this.seen.push(holder);
    return g;
  }
  work(holder: string) {
    return this.acquire(holder, project_("pa"));
  }
  release(holder: string) {
    if (this.board.release(holder)) this.freed();
  }
  thread(t: string, running: boolean) {
    if (this.board.observe("lab-a", t, running)) this.freed();
  }
  setCap(cap: number | undefined, max?: [ProjectRef, number]) {
    this.board.setCap(cap, max && { projectRef: max[0], maxAgents: max[1] });
    this.freed();
    return this.board.state();
  }
}

describe("board", () => {
  test("room is what a task of the bot could take now", () => {
    const [a, b] = [project_("pa"), project_("pb")];
    const k = Kit.fleet(10);
    expect(k.board.room(a)).toBe(10);
    k.work("T1");
    k.acquire("T2", b);
    expect([k.board.room(a), k.board.room(b)]).toEqual([8, 8]);
    k.setCap(undefined, [a, 1]);
    expect([k.board.room(a), k.board.room(b)]).toEqual([0, 8]);
    k.release("T1");
    expect(k.board.room(a)).toBe(1);
  });

  test("a bot follows the default until it has a max of its own", () => {
    const a = project_("pa");
    const k = Kit.fleet(10);
    expect([k.board.maxAgentsOf(a), k.board.maxSource(a)]).toEqual([10, { kind: "fleet" }]);
    k.setCap(4);
    expect(k.board.maxAgentsOf(a)).toBe(4);
    k.setCap(undefined, [a, 3]);
    k.setCap(8);
    expect([k.board.maxAgentsOf(a), k.board.maxSource(a)]).toEqual([3, { kind: "project" }]);
    k.board.setCap(undefined, { projectRef: a, maxAgents: undefined });
    expect([k.board.maxAgentsOf(a), k.board.maxSource(a)]).toEqual([8, { kind: "fleet" }]);
    expect(k.board.takeOps().at(-1)).toEqual({ op: "max_agents", projectRef: a });
    expect(k.board.state().perProject).toEqual([]);
  });

  test("queues past the cap and grants the next on release", () => {
    const k = Kit.fleet(2);
    expect(k.work("T1")).toEqual(GRANTED);
    expect(k.work("T2")).toEqual(GRANTED);
    expect(k.work("T3")).toEqual(queued("fleet cap: 2 of 2 running"));
    expect(k.work("T1")).toEqual(GRANTED);
    const s = k.board.state();
    expect([s.cap, s.fleetCap, s.used, s.queued]).toEqual([2, 2, 2, 1]);
    k.release("T1");
    expect(k.grants).toEqual(["T3"]);
    k.work("T4");
    expect(k.board.release("T4")).toBe(false);
    k.release("T2");
    expect(k.grants).toEqual(["T3"]);
    const s2 = k.board.state();
    expect([s2.used, s2.queued]).toEqual([1, 0]);
  });

  test("the fleet cap and each bot's max agents both hold", () => {
    const [a, b] = [project_("pa"), project_("pb")];
    const k = Kit.fleet(3);
    k.setCap(undefined, [a, 1]);
    expect(k.acquire("T1", a)).toEqual(GRANTED);
    expect(k.acquire("T2", a)).toEqual(queued("Max agents: 1 of 1 running"));
    expect(k.acquire("T3", b)).toEqual(GRANTED);
    expect(k.acquire("T4", b)).toEqual(GRANTED);
    expect(k.acquire("T5", b)).toEqual(queued("fleet cap: 3 of 3 running"));
    expect(k.board.state().perProject).toEqual([
      { projectRef: b, maxAgents: 3, own: false, running: 2, queued: 1 },
      { projectRef: a, maxAgents: 1, own: true, running: 1, queued: 1 },
    ]);
    k.release("T1");
    expect(k.grants).toEqual(["T2"]);
    k.release("T3");
    expect(k.grants).toEqual(["T2", "T5"]);
    expect([k.board.agents(a), k.board.agents(b)]).toEqual([
      [1, 0],
      [2, 0],
    ]);
  });

  test("serves reviews, then work, FIFO within each", () => {
    const a = project_("pa");
    const k = Kit.fleet(1);
    k.work("T1");
    k.work("T2");
    k.work("T3");
    k.acquire("R1", a, "review");
    k.acquire("R2", a, "review");
    expect(k.board.position("R1")).toBe(1);
    expect(k.board.position("T2")).toBe(3);
    for (const h of ["T1", "R1", "R2", "T2"]) k.release(h);
    expect(k.grants).toEqual(["R1", "R2", "T2", "T3"]);
  });

  test("at max agents one, a gating review runs before queued writers", () => {
    const a = project_("pa");
    const k = Kit.fleet(40);
    k.setCap(undefined, [a, 1]);
    k.work("T1");
    k.board.bind("T1", a.machineId, "t1");
    k.thread("t1", true);
    k.work("T2");
    k.work("T3");
    expect(k.acquire("R1", a, "review")).toEqual(queued("Max agents: 1 of 1 running"));
    expect(k.board.position("R1")).toBe(1);
    k.thread("t1", false);
    expect(k.grants).toEqual(["R1"]);
    k.release("R1");
    k.release("T1");
    expect(k.grants).toEqual(["R1", "T2"]);
    k.release("T2");
    expect(k.grants).toEqual(["R1", "T2", "T3"]);
  });

  test("the extras are the newest writers, never a review", () => {
    const a = project_("pa");
    const k = Kit.fleet(40);
    for (let n = 1; n <= 4; n++) k.work(`T${n}`);
    k.acquire("R1", a, "review");
    k.setCap(undefined, [a, 3]);
    expect(k.board.agents(a)).toEqual([5, 0]);
    expect(k.board.extras(a)).toEqual(["T4", "T3"]);
  });

  test("applies cap changes and keeps them across a restart", () => {
    const k = Kit.fleet(1);
    k.work("T1");
    k.work("T2");
    k.work("T3");
    const raised = k.setCap(2);
    expect(k.grants).toEqual(["T2"]);
    expect([raised.cap, raised.used, raised.queued]).toEqual([2, 2, 1]);
    const lowered = k.setCap(1);
    expect([lowered.cap, lowered.used, lowered.queued]).toEqual([1, 2, 1]);
    k.release("T1");
    expect(k.grants).toEqual(["T2"]);
    expect(k.board.takeOps().some((op) => op.op === "cap" && op.cap === 1)).toBe(true);
    const claims = k.board.claims().map((c): Claim => ({ ...c }));
    const second = new Kit(new Board(1, [], [machine("lab-a", HARD_TOP)], claims));
    second.seen = second.held();
    const s = second.board.state();
    expect([s.cap, s.used, s.queued]).toEqual([1, 1, 1]);
    second.release("T2");
    expect(second.grants).toEqual(["T3"]);
  });

  test("holds a slot only while the bound thread runs; a lead's thread takes none", () => {
    const a = project_("pa");
    const k = Kit.fleet(1);
    k.thread("lead1", true);
    expect(k.board.state().used).toBe(0);
    k.work("T1");
    k.board.bind("T1", a.machineId, "t1");
    k.work("T2");
    k.thread("t1", true);
    expect([k.board.state().used, k.board.state().queued]).toEqual([1, 1]);
    k.thread("t1", false);
    expect(k.grants).toEqual(["T2"]);
    k.thread("t1", true);
    expect([k.board.state().cap, k.board.state().used]).toEqual([1, 2]);
    expect(k.work("T1")).toEqual(GRANTED);
    k.thread("t1", false);
    expect(k.board.state().used).toBe(1);
    k.work("T3");
    expect(k.work("T1")).toEqual(queued("fleet cap: 1 of 1 running"));
    k.release("T2");
    expect(k.grants).toEqual(["T2", "T3"]);
  });

  test("each machine runs what it fits with no fleet cap", () => {
    const [air, big] = [project_("pa", "air"), project_("pb", "big")];
    const k = Kit.on(undefined, [machine("air", 2), machine("big", 56)]);
    expect(k.board.maxAgentsOf(air)).toBe(2);
    expect(k.board.maxSource(air)).toEqual({ kind: "auto", why: "memory 18 GB" });
    k.acquire("T1", air);
    k.acquire("T2", air);
    expect(k.acquire("T3", air)).toEqual(queued("machine cap: 2 of 2 running on air-box (memory 18 GB)"));
    expect(k.acquire("T4", project_("pc", "air"))).toEqual(queued("machine cap: 2 of 2 running on air-box (memory 18 GB)"));
    expect(k.board.position("T4")).toBe(2);
    for (let n = 5; n <= 60; n++) k.acquire(`T${n}`, big);
    const s = k.board.state();
    expect([s.cap, s.fleetCap, s.used]).toEqual([58, undefined, 58]);
    expect(s.perMachine.map((m) => [m.cap, m.running])).toEqual([
      [2, 2],
      [56, 56],
    ]);
    expect(k.board.room(air)).toBe(0);
    k.release("T1");
    expect(k.grants).toEqual(["T3"]);
  });

  test("hosted: own slots first, then each provider in order up to its limit across machines, then the queue", () => {
    const [air, big] = [project_("pa", "air"), project_("pb", "big")];
    const k = Kit.on(undefined, [{ ...machine("air", 2), sandboxes: ["boat", "acme"] }, { ...machine("big", 1), sandboxes: ["boat"] }]);
    k.board.setHosted([{ provider: "boat", max: 2 }, { provider: "acme" as never, max: 1 }]);
    const acquire = (h: string, r: ProjectRef, hostable = true) => k.board.acquire(h, r, "work", hostable);
    expect(acquire("T1", air)).toEqual(GRANTED);
    expect(acquire("T2", air)).toEqual(GRANTED);
    // Its own slots full: boat.dev, then the next.
    expect(acquire("T3", air)).toEqual(GRANTED);
    expect(acquire("T4", big)).toEqual(GRANTED);
    expect(acquire("T5", big)).toEqual(GRANTED);
    expect(acquire("T6", air)).toEqual(GRANTED);
    expect(["T1", "T2", "T3", "T4", "T5", "T6"].map((h) => k.board.placeOf(h))).toEqual([LOCAL, LOCAL, "boat", LOCAL, "boat", "acme"]);
    // boat.dev's limit is the team's: big, which makes only boat.dev's boxes, waits; so does air.
    expect(acquire("T7", big)).toEqual(queued("machine cap: 1 of 1 running on big-box (memory 18 GB), and hosted sandboxes are full: boat.dev 2 of 2"));
    expect(acquire("T8", air)).toEqual(queued("machine cap: 2 of 2 running on air-box (memory 18 GB), and hosted sandboxes are full: boat.dev 2 of 2, acme 1 of 1"));
    // A boat.dev box freed goes to the first in line that can use it.
    k.release("T3");
    expect(k.board.placeOf("T7")).toBe("boat");
    expect(k.board.placeOf("T8")).toBeUndefined();
    // A machine shows its own slots and what runs in them; the hosted limits are the team's, named, never added to
    // each machine's cap. The total counts each once.
    expect(k.board.state().perMachine.map((m) => [m.cap, m.running, m.why])).toEqual([
      [2, 2, "memory 18 GB; then the team's hosted sandboxes (boat.dev 2, acme 1)"],
      [1, 1, "memory 18 GB; then the team's hosted sandboxes (boat.dev 2)"],
    ]);
    expect(k.board.total()).toBe(6);
    // A person's number for a machine counts its own slots.
    k.board.setMachine("air", 1);
    expect(k.board.state().perMachine[0]!.cap).toBe(1);
  });

  test("the Linux machine: your machines only, or a provider only, and back to machines first", () => {
    const air = project_("pa", "air");
    const k = Kit.on(undefined, [{ ...machine("air", 1), sandboxes: ["boat"] }]);
    const acquire = (h: string, hostable = true) => k.board.acquire(h, air, "work", hostable);
    // Your machines only: a full machine never spills into boat.dev.
    k.board.setHosted([{ provider: "boat", max: 2 }], "ours_only");
    expect(acquire("T1")).toEqual(GRANTED);
    expect(acquire("T2")).toEqual(queued("machine cap: 1 of 1 running on air-box (memory 18 GB)"));
    expect(k.board.total()).toBe(1);
    k.release("T1");
    expect(k.board.placeOf("T2")).toBe(LOCAL);
    k.release("T2");
    // boat.dev only: the machine's free slot stays empty, and boat's limit is the room.
    k.board.setHosted([{ provider: "boat", max: 1 }], "boat");
    expect(acquire("T3")).toEqual(GRANTED);
    expect(k.board.placeOf("T3")).toBe("boat");
    expect(acquire("T4")).toEqual(queued("the team's agents run on boat.dev only, and it is full: 1 of 1"));
    expect(k.board.total()).toBe(1);
    // One with no Claude account can't go there, and says so.
    expect(acquire("T5", false)).toEqual(queued(`the team's agents run on boat.dev only, and ${NO_ACCOUNT_HOSTED}`));
    // Machines first again (today's rule): what waits starts on the machine.
    expect(k.board.setHosted([{ provider: "boat", max: 1 }], "ours_first")).toBe(true);
    k.board.evaluate();
    expect(k.board.placeOf("T4")).toBe(LOCAL);
  });

  test("a bot's picked computer: its agents go there and nowhere else, at its size; while it can't be had, they wait and say why", () => {
    const [vm, hosted_, free] = [project_("pv", "air"), project_("pe", "air"), project_("pf", "air")];
    const vms = { kind: "microvm" as const };
    const k = Kit.on(undefined, [{ ...machine("air", 1), sandboxes: ["boat"], auto: { cap: 1, why: "memory 18 GB", sandbox: vms, host: { cpus: 16, memGb: 32 } } }]);
    k.board.setHosted([{ provider: "boat", max: 1 }]);
    k.board.setComputer(vm, { kind: "vm", cpu: 8, memGb: 16 });
    k.board.setComputer(hosted_, { kind: "boat", cpu: 4, memGb: 8 });
    const acquire = (h: string, r: ProjectRef, hostable = true) => k.board.acquire(h, r, "work", hostable);
    // The boat.dev bot's agent goes to boat.dev though the machine has a free slot, at its picked size.
    expect(acquire("T1", hosted_)).toEqual(GRANTED);
    expect([k.board.placeOf("T1"), k.board.sizeOf("T1")]).toEqual(["boat", { cpu: 4, memGb: 8 }]);
    // The Local VM bot's agent takes the machine's slot in a VM of its size.
    expect(acquire("T2", vm)).toEqual(GRANTED);
    expect([k.board.placeOf("T2"), k.board.sizeOf("T2")]).toEqual([LOCAL, { cpu: 8, memGb: 16 }]);
    // Full: each waits for its own computer, never another's, nor another size.
    expect(acquire("T3", hosted_)).toEqual(queued("its bot's computer is boat.dev · 4 vCPU / 8 GB: boat.dev is full, 1 of 1"));
    expect(acquire("T4", vm)).toEqual(queued("its bot's computer is Local VM · 8 vCPU / 16 GB: 1 of 1 in use on air-box (memory 18 GB)"));
    // A bot with no pick is placed as before, with the default size.
    k.release("T2");
    expect(k.board.placeOf("T4")).toBe(LOCAL);
    k.release("T4");
    expect(acquire("T5", free)).toEqual(GRANTED);
    expect([k.board.placeOf("T5"), k.board.sizeOf("T5")]).toEqual([LOCAL, undefined]);
    k.release("T5");
    // A stale pick: boat.dev disconnected. Its agent waits and says so; it never runs on the machine or another provider.
    k.release("T1");
    k.board.setHosted([]);
    expect(acquire("T6", hosted_)).toEqual(
      queued("its bot's computer is boat.dev · 4 vCPU / 8 GB, and boat.dev isn't connected: an admin connects it in Settings › Hub › Machines, or pick another on the bot's Computer page"),
    );
    expect(k.board.placeOf("T6")).toBeUndefined();
    // Its machine's VMs off, or too small for the pick: the Local VM bot's agent waits, and says which.
    k.board.observeMachine("air", "air-box", { cap: 1, why: "memory 18 GB", sandbox: { kind: "process", why: "no /dev/kvm" }, host: { cpus: 16, memGb: 32 } }, undefined, []);
    expect(acquire("T7", vm)).toEqual(queued("its bot's computer is Local VM · 8 vCPU / 16 GB, and air-box runs no VMs now: no /dev/kvm; or pick another on the bot's Computer page"));
    k.board.observeMachine("air", "air-box", { cap: 1, why: "memory 18 GB", sandbox: vms, host: { cpus: 4, memGb: 16 } }, undefined, []);
    expect(k.board.placeOf("T7")).toBeUndefined();
    expect(k.board.state()).toBeDefined();
    k.release("T7");
    expect(acquire("T8", vm)).toEqual(queued("its bot's computer is Local VM · 8 vCPU / 16 GB, and air-box hasn't the CPUs or memory for it; or pick another on the bot's Computer page"));
    // Dropping the pick: placed as before again.
    expect(k.board.setComputer(vm, undefined)).toBe(true);
    k.board.evaluate();
    expect([k.board.placeOf("T8"), k.board.sizeOf("T8")]).toEqual([LOCAL, undefined]);
  });

  test("a Local VM counts its memory's worth of its machine's slots, so a big pick never over-commits it", () => {
    const [big, small, free] = [project_("pb", "air"), project_("ps", "air"), project_("pf", "air")];
    // 10 slots of 4 GiB VMs (4.1 GiB each with their overhead).
    const host = { cpus: 32, memGb: 64, vmGb: 4.1 };
    const k = Kit.on(undefined, [{ ...machine("air", 10), auto: { cap: 10, why: "memory 64 GB", sandbox: { kind: "microvm" }, host } }]);
    k.board.setComputer(big, { kind: "vm", cpu: 8, memGb: 16 });
    k.board.setComputer(small, { kind: "vm", cpu: 4, memGb: 4 });
    const acquire = (h: string, r: ProjectRef) => k.board.acquire(h, r, "work", true);
    // 16 GB takes 4 slots, 4 GB one, an unpicked agent one: 4 + 4 + 1 + 1 = 10.
    expect(acquire("T1", big)).toEqual(GRANTED);
    expect(acquire("T2", big)).toEqual(GRANTED);
    expect(acquire("T3", small)).toEqual(GRANTED);
    expect(acquire("T4", free)).toEqual(GRANTED);
    // Full: a third 16 GB VM waits, and so does any agent, though only 4 agents run.
    expect(acquire("T5", big)).toEqual(queued("its bot's computer is Local VM · 8 vCPU / 16 GB, which takes 4 of air-box's slots: 10 of 10 in use on air-box (memory 64 GB)"));
    expect(acquire("T6", free)).toEqual(
      queued("machine cap: 10 of 10 slots in use on air-box (memory 64 GB), by 4 agents, a bot's bigger VMs taking more than one"),
    );
    // A 16 GB VM ends: its 4 slots go to the first in line, the next 16 GB VM.
    k.release("T1");
    expect([k.board.placeOf("T5"), k.board.placeOf("T6")]).toEqual([LOCAL, undefined]);
    k.release("T3");
    expect(k.board.placeOf("T6")).toBe(LOCAL);
  });

  test("a Local VM needing more slots than its machine's limit waits saying so; a running agent counts at the size it started", () => {
    const vm = project_("pv", "air");
    const host = { cpus: 32, memGb: 64, vmGb: 4.1 };
    const k = Kit.on(undefined, [{ ...machine("air", 10), maxAgents: 2, auto: { cap: 10, why: "memory 64 GB", sandbox: { kind: "microvm" }, host } }]);
    k.board.setComputer(vm, { kind: "vm", cpu: 8, memGb: 16 });
    // 4 slots, a limit of 2: never "full", but never placed either, saying why and how to fix it.
    expect(k.board.acquire("T1", vm, "work", true)).toEqual(
      queued(
        "its bot's computer is Local VM · 8 vCPU / 16 GB, but air-box runs at most 2 agents at once, and a VM of 8 vCPU / 16 GB takes 4 of them (its memory's worth): raise air-box's max agents in Settings › Hub › Machines, or pick a smaller one",
      ),
    );
    k.board.setMachine("air", 10);
    k.board.evaluate();
    expect([k.board.placeOf("T1"), k.board.sizeOf("T1")]).toEqual([LOCAL, { cpu: 8, memGb: 16 }]);
    // The pick changes while it runs: it keeps its 16 GB and its 4 slots until it ends; a new agent gets the new size.
    k.board.setComputer(vm, { kind: "vm", cpu: 4, memGb: 4 });
    expect(k.board.sizeOf("T1")).toEqual({ cpu: 8, memGb: 16 });
    for (const h of ["T2", "T3", "T4", "T5", "T6", "T7"]) expect(k.board.acquire(h, vm, "work", true)).toEqual(GRANTED);
    expect(k.board.sizeOf("T2")).toEqual({ cpu: 4, memGb: 4 });
    // 4 + 6 = 10: full.
    expect(k.board.acquire("T8", vm, "work", true)).toEqual(queued("its bot's computer is Local VM · 4 vCPU / 4 GB: 10 of 10 in use on air-box (set)"));
    k.release("T1");
    expect(k.board.placeOf("T8")).toBe(LOCAL);
  });

  test("a machine whose VMs take only agents on a Claude account: a Local VM pick's agents on its own login wait, saying why", () => {
    const vm = project_("pv", "air");
    const sandbox = { kind: "microvm" as const, why: "this machine signs in to Claude with its own login", accountsOnly: true };
    const k = Kit.on(undefined, [{ ...machine("air", 2), auto: { cap: 2, why: "memory 18 GB", sandbox, host: { cpus: 16, memGb: 32 } } }]);
    k.board.setComputer(vm, { kind: "vm", cpu: 2, memGb: 4 });
    // Never placed on the machine, where the node would refuse it: it waits and says so.
    expect(k.board.acquire("T1", vm, "work", false)).toEqual(
      queued(
        "its bot's computer is Local VM · 2 vCPU / 4 GB, but air-box's VMs take only agents on a Claude account, and this bot's run on its own login: connect one in Settings › Your accounts › Claude, or pick another on the bot's Computer page",
      ),
    );
    expect(k.board.placeOf("T1")).toBeUndefined();
    // On a Claude account it goes into a VM.
    expect(k.board.acquire("T2", vm, "work", true)).toEqual(GRANTED);
    expect([k.board.placeOf("T2"), k.board.sizeOf("T2")]).toEqual([LOCAL, { cpu: 2, memGb: 4 }]);
  });

  test("the hub's runner beside a computer: the computer's bots run as before, the runner's only in hosted boxes", () => {
    const [mine, hosted] = [project_("pa", "air"), project_("ph", RUNNER_ID)];
    // The runner's node may report its machine's size: it still has no slots of its own.
    const k = Kit.on(undefined, [{ ...machine("air", 1), sandboxes: ["boat"] }, { ...machine(RUNNER_ID, 8), sandboxes: ["boat"] }]);
    k.board.setHosted([{ provider: "boat", max: 2 }]);
    const acquire = (h: string, r: ProjectRef, hostable = true) => k.board.acquire(h, r, "work", hostable);
    expect(acquire("T1", mine)).toEqual(GRANTED);
    expect(acquire("T2", hosted)).toEqual(GRANTED);
    expect(acquire("T3", mine)).toEqual(GRANTED);
    expect(["T1", "T2", "T3"].map((h) => k.board.placeOf(h))).toEqual([LOCAL, "boat", "boat"]);
    expect(acquire("T4", hosted)).toEqual(queued("hosted sandboxes are full: boat.dev 2 of 2"));
    expect(acquire("T5", hosted, false)).toEqual(
      queued("agents in hosted sandboxes run on a Claude account, and this one has none: connect the hub's API key or your Claude subscription in Settings"),
    );
    expect(k.board.ownCap(RUNNER_ID)).toBe(0);
    k.board.setHosted([]);
    expect(acquire("T6", hosted)).toEqual(queued(expect.stringContaining("no hosted sandbox provider is connected") as never));
  });

  test("hosted: a provider its node set aside says why, on the board and in a queued agent's reason, until it is back", () => {
    const [mine, hosted] = [project_("pa", "air"), project_("ph", RUNNER_ID)];
    const k = Kit.on(undefined, [{ ...machine("air", 1), sandboxes: ["boat"] }, { ...machine(RUNNER_ID, 0), sandboxes: ["boat"] }]);
    k.board.setHosted([{ provider: "boat", max: 20 }]);
    const now = Date.parse("2026-11-19T12:35:00.000Z");
    k.board.tick(now);
    const runner = { cap: 0, why: "hosted sandboxes only" };
    k.board.observeMachine(RUNNER_ID, "Hosted sandboxes", runner, undefined, ["boat"], { th1: "boat", th2: "boat", th3: "boat" });
    expect(k.board.state().hosted).toEqual([{ provider: "boat", limit: 20, running: 3 }]);
    // boat.dev refused a box for billing: the runner offers it no more until 12:45, and says why.
    const refused = { provider: "boat", what: "start" as const, reason: "billing", why: "boat won't run sandboxes on this account until its billing is sorted out (402 Payment Required).", until: now + 10 * 60_000 };
    k.board.observeMachine(RUNNER_ID, "Hosted sandboxes", runner, undefined, [], { th1: "boat" }, [refused]);
    const trouble = { what: "start", reason: "billing", message: "boat.dev refused: billing isn't set up on the account", fix: "set up billing in boat.dev's dashboard", until: "2026-11-19T12:45:00.000Z" };
    expect(k.board.state().hosted).toEqual([{ provider: "boat", limit: 20, running: 1, trouble }]);
    const why = "boat.dev refused: billing isn't set up on the account (set up billing in boat.dev's dashboard); trying again at 12:45";
    expect(k.board.acquire("T1", hosted, "work", true)).toEqual(queued(why));
    // A computer's bot whose own slots are full says it too, rather than nothing about boat.dev.
    expect(k.board.acquire("T2", mine, "work", true)).toEqual(GRANTED);
    k.board.observeMachine("air", "air-box", { cap: 1, why: "memory 18 GB" }, undefined, [], {}, [refused]);
    expect(k.board.acquire("T3", mine, "work", true)).toEqual(queued(`machine cap: 1 of 1 running on air-box (memory 18 GB); ${why}`));
    // The runner offers boat.dev again: the trouble is gone and the queued agent goes there.
    k.board.observeMachine(RUNNER_ID, "Hosted sandboxes", runner, undefined, ["boat"], { th1: "boat" });
    k.board.evaluate();
    expect(k.board.placeOf("T1")).toBe("boat");
    expect(k.board.state().hosted[0]?.trouble).toEqual(trouble);
    // air's word is the last one of it; once its heartbeats stop, it no longer counts.
    k.board.tick(now + 2 * 45_000 + 1);
    expect(k.board.state().hosted[0]?.trouble).toBeUndefined();
  });

  test("hosted: an agent on the machine's own login stays on its slots, and says why", () => {
    const air = project_("pa", "air");
    const k = Kit.on(undefined, [{ ...machine("air", 1), sandboxes: ["boat"] }]);
    k.board.setHosted([{ provider: "boat", max: 5 }]);
    expect(k.board.acquire("T1", air, "work", false)).toEqual(GRANTED);
    expect(k.board.acquire("T2", air, "work", false)).toEqual(
      queued("machine cap: 1 of 1 running on air-box (memory 18 GB); hosted sandboxes take only agents on a Claude account, not this machine's own login"),
    );
    expect(k.board.acquire("T3", air, "work", true)).toEqual(GRANTED);
    expect(k.board.placeOf("T3")).toBe("boat");
  });

  test("hosted: a machine whose node holds no key, or no limit set, adds nothing; a run that comes back keeps its box", () => {
    const air = project_("pa", "air");
    const k = Kit.on(undefined, [machine("air", 1)]);
    k.board.setHosted([{ provider: "boat", max: 5 }]);
    expect(k.board.acquire("T1", air, "work", true)).toEqual(GRANTED);
    expect(k.board.acquire("T2", air, "work", true)).toEqual(queued("machine cap: 1 of 1 running on air-box (memory 18 GB)"));
    // Its node now holds boat.dev's key.
    k.board.observeMachine("air", "air-box", { cap: 1, why: "memory 18 GB" }, undefined, ["boat"]);
    k.freed();
    expect(k.board.placeOf("T2")).toBe("boat");
    // T2's run ends and comes back while T1's slot freed: it goes back where its box is.
    k.board.bind("T2", "air", "th2");
    k.board.observe("air", "th2", false);
    k.release("T1");
    expect(k.board.acquire("T2", air, "work", true)).toEqual(GRANTED);
    expect(k.board.placeOf("T2")).toBe("boat");
    expect(k.board.placeOfThread("air", "th2")).toBe("boat");
  });

  test("hosted: a box counts against its provider while it lives, held or idle, until its node says it is gone", () => {
    const air = project_("pa", "air");
    const k = Kit.on(undefined, [{ ...machine("air", 1), sandboxes: ["boat"] }]);
    k.board.setHosted([{ provider: "boat", max: 1 }]);
    const auto = { cap: 1, why: "memory 18 GB" };
    expect(k.board.acquire("T1", air, "work", true)).toEqual(GRANTED);
    expect(k.board.acquire("T2", air, "work", true)).toEqual(GRANTED);
    expect(k.board.placeOf("T2")).toBe("boat");
    k.board.bind("T2", "air", "th2");
    k.board.observeMachine("air", "air-box", auto, undefined, ["boat"], { th2: "boat" });
    // T2's turn ends; its box stays until its claude idles out, and still counts.
    k.board.observe("air", "th2", false);
    expect(k.board.acquire("T3", air, "work", true)).toEqual(queued("machine cap: 1 of 1 running on air-box (memory 18 GB), and hosted sandboxes are full: boat.dev 1 of 1"));
    // T2's next turn goes back to its box, whatever else is free.
    k.release("T1");
    expect(k.board.acquire("T2", air, "work", true)).toEqual(GRANTED);
    expect(k.board.placeOf("T2")).toBe("boat");
    expect(k.board.placeOf("T3")).toBe(LOCAL);
    // Once the node says the box is gone, its room is free again.
    k.board.observe("air", "th2", false);
    expect(k.board.acquire("T4", air, "work", true)).toEqual(queued("machine cap: 1 of 1 running on air-box (memory 18 GB), and hosted sandboxes are full: boat.dev 1 of 1"));
    expect(k.board.observeMachine("air", "air-box", auto, undefined, ["boat"], {})).toBe(true);
    k.board.evaluate();
    expect(k.board.placeOf("T4")).toBe("boat");
  });

  test("hosted: a machine that stops reporting stops holding its boxes' room once they can't be alive", () => {
    const big = project_("pb", "big");
    const k = Kit.on(undefined, [{ ...machine("air", 0), sandboxes: ["boat"] }, { ...machine("big", 0), sandboxes: ["boat"] }]);
    k.board.setHosted([{ provider: "boat", max: 1 }]);
    k.board.tick(1_000);
    // air reports a live boat.dev box, then goes offline.
    k.board.observeMachine("air", "air-box", { cap: 0, why: "memory 18 GB" }, undefined, ["boat"], { th9: "boat" });
    expect(k.board.acquire("T1", big, "work", true)).toEqual(queued("machine cap: 0 of 0 running on big-box (memory 18 GB), and hosted sandboxes are full: boat.dev 1 of 1"));
    // Within the box's last hour it still counts; past it, its room is free.
    k.board.tick(1_000 + PLACES_FRESH_MS);
    expect(k.board.acquire("T1", big, "work", true)).toEqual(queued("machine cap: 0 of 0 running on big-box (memory 18 GB), and hosted sandboxes are full: boat.dev 1 of 1"));
    k.board.tick(1_000 + PLACES_FRESH_MS + 1);
    k.board.evaluate();
    expect(k.board.placeOf("T1")).toBe("boat");
  });

  test("hosted: a run whose claude still lives on its machine stays there, and waits for a slot of its own", () => {
    const air = project_("pa", "air");
    const k = Kit.on(undefined, [{ ...machine("air", 1), sandboxes: ["boat"] }]);
    k.board.setHosted([{ provider: "boat", max: 5 }]);
    const auto = { cap: 1, why: "memory 18 GB" };
    expect(k.board.acquire("T1", air, "work", true)).toEqual(GRANTED);
    k.board.bind("T1", "air", "th1");
    k.board.observe("air", "th1", false);
    k.board.observeMachine("air", "air-box", auto, undefined, ["boat"], { th1: LOCAL });
    expect(k.board.acquire("T2", air, "work", true)).toEqual(GRANTED);
    expect(k.board.placeOf("T2")).toBe(LOCAL);
    // T1's claude is still alive here: it doesn't go to boat.dev behind its node's back, it waits for its own slot.
    expect(k.board.acquire("T1", air, "work", true)).toEqual(queued("machine cap: 1 of 1 running on air-box (memory 18 GB); its Claude still runs there, so it waits for a slot of its own"));
    // A Monitor of its own wakes it: it runs where its claude is.
    k.board.observe("air", "th1", true);
    expect(k.board.placeOf("T1")).toBe(LOCAL);
  });

  test("a saved fleet cap holds under the machines' total", () => {
    const [a, b] = [project_("pa", "m1"), project_("pb", "m2")];
    const k = Kit.on(3, [machine("m1", 6), machine("m2", 6)]);
    for (const [h, r] of [["T1", a], ["T2", a], ["T3", b]] as const) expect(k.acquire(h, r)).toEqual(GRANTED);
    expect(k.acquire("T4", b)).toEqual(queued("fleet cap: 3 of 3 running"));
    expect(k.board.total()).toBe(3);
  });

  test("disk room counts agents started until they settle", () => {
    const a = project_("pa", "air");
    const k = Kit.on(undefined, [machine("air", 8, 2)]);
    k.board.tick(1_000);
    k.acquire("T1", a);
    k.acquire("T2", a);
    expect(k.acquire("T3", a)).toEqual(
      queued("disk: no room for another agent on air-box until the new worktrees settle or space frees"),
    );
    expect(k.board.room(a)).toBe(0);
    expect(k.board.state().perMachine[0]?.diskRoom).toBe(0);
    expect(k.board.observeMachine("air", "air-box", machine("air", 8).auto, 2)).toBe(false);
    expect(k.board.tick(1_000 + SETTLE_MS - 1)).toBe(false);
    expect(k.board.tick(1_000 + SETTLE_MS)).toBe(true);
    k.freed();
    expect(k.grants).toEqual(["T3"]);
    k.board.bind("T1", a.machineId, "t1");
    k.board.observe("air", "t1", false);
    expect(k.board.observeMachine("air", "air-box", machine("air", 8).auto, 0)).toBe(false);
    expect(k.acquire("T1", a)).toEqual(GRANTED);
  });

  test("an unlaunched grant gives its disk room back", () => {
    const a = project_("pa", "air");
    const k = Kit.on(undefined, [machine("air", 8, 1)]);
    k.acquire("T1", a);
    k.acquire("T2", a);
    k.release("T1");
    expect(k.grants).toEqual(["T2"]);
  });

  test("a machine measured bigger frees capacity; an unmeasured one takes four", () => {
    const a = project_("pa", "new");
    const k = Kit.on(undefined, []);
    expect(k.board.machineCap("new")).toBe(UNMEASURED);
    for (let n = 1; n <= 5; n++) k.acquire(`T${n}`, a);
    expect(k.board.agents(a)).toEqual([4, 1]);
    expect(k.board.maxSource(a)).toEqual({ kind: "auto", why: UNMEASURED_WHY });
    const auto = { cap: 12, why: "memory 32 GB" };
    expect(k.board.observeMachine("new", "new-box", auto, undefined)).toBe(true);
    expect(k.board.takeOps().at(-1)).toEqual({ op: "machine", machineId: "new", name: "new-box", auto });
    k.freed();
    expect(k.board.agents(a)).toEqual([5, 0]);
    k.board.takeOps();
    expect(k.board.observeMachine("new", "new-box", auto, undefined)).toBe(false);
    expect(k.board.takeOps()).toEqual([]);
  });

  test("a new task at every machine's agent limit queues, and starts once a slot frees", () => {
    const k = Kit.on(undefined, [machine("devbox", 2), machine("builder", 2)]);
    const app = project_("app", "devbox");
    for (let n = 1; n <= 2; n++) expect(k.board.acquire(`T${n}`, app, "work")).toEqual(GRANTED);
    expect(k.board.acquire("T3", app, "work")).toEqual(queued("machine cap: 2 of 2 running on devbox-box (memory 18 GB)"));
    k.release("T1");
    expect(k.board.agents(app)).toEqual([2, 0]);
  });
});

describe("the service", () => {
  const fresh = () => {
    const clock = { now: () => 1_792_000_000_000 };
    const db = HubDb.memory();
    const hub = new Hub({ home: "", listen: { host: "127.0.0.1", port: 0 } }, db, clock);
    const open = () => new Slots(db, clock, store(hub), events(hub));
    return { hub, db, open };
  };

  test("a hub from when leads held slots: their claims go, a task's stays", () => {
    const conn = new Database(":memory:");
    // Found by content, not as the last migration, so later migrations don't break this test.
    const at = MIGRATIONS.findIndex((m) => m.sql.includes("DELETE FROM slot_claims WHERE priority = 'lead'"));
    for (const m of MIGRATIONS.slice(0, at)) conn.run(m.sql);
    conn.run(`INSERT INTO slot_claims VALUES ('lead:lab-a/p1', 'lab-a', 'p1', 'lead', 'l1', 'held', 1),
      ('T1', 'lab-a', 'p1', 'work', 't1', 'held', 2);`);
    conn.run((MIGRATIONS[at] as { sql: string }).sql);
    expect(conn.query<{ holder: string }, []>("SELECT holder FROM slot_claims").all().map((r) => r.holder)).toEqual(["T1"]);
  });

  test("spawns never overshoot max agents", () => {
    const { open } = fresh();
    const s = open();
    const r = project_("p1");
    s.setCap({ maxAgents: { projectRef: r, maxAgents: 2 } });
    const granted = Array.from({ length: 24 }, (_, i) => s.acquire({ holder: `T${i + 1}`, projectRef: r, priority: "work" }));
    expect(granted.filter((g) => g.granted).length).toBe(2);
    expect({ ...s.agents(r), movedMs: 0 }).toEqual({
      running: 2,
      maxAgents: 2,
      queued: 22,
      source: { kind: "project" },
      movedMs: 0,
    });
  });

  test("going back to the default outlives a restart", () => {
    const { open } = fresh();
    const r = project_("p1");
    const set = (x: Slots, n: number | undefined) => x.setCap({ cap: 6, maxAgents: { projectRef: r, maxAgents: n } });
    set(open(), 2);
    expect(open().agents(r).source).toEqual({ kind: "project" });
    set(open(), undefined);
    const s = open();
    expect(s.agents(r).source).not.toEqual({ kind: "project" });
    expect(s.state().perProject).toEqual([]);
  });

  test("max agents starts every agent whatever memory each is estimated to take", () => {
    const { open } = fresh();
    const s = open();
    const r = project_("p1");
    const load = { cpus: 32, load1: 0.5, memTotalBytes: 60 * GIB, memPerAgentBytes: 2_000_000_000 } as NodeLoad;
    s.observeMachine(r.machineId, "builder-1", load);
    s.setCap({ maxAgents: { projectRef: r, maxAgents: 20 } });
    for (let i = 1; i <= 20; i++) expect(s.acquire({ holder: `T${i}`, projectRef: r, priority: "work" })).toEqual(GRANTED);
    expect(s.acquire({ holder: "T21", projectRef: r, priority: "work" })).toEqual(queued("Max agents: 20 of 20 running"));
  });

  test("a bound thread's events hold and free its slot; a restart follows the stored thread", async () => {
    const { hub, open } = fresh();
    const r = project_("p1");
    const s = slots(hub);
    s.setCap({ cap: 1 });
    let notified = 0;
    s.onRelease(() => notified++);
    s.acquire({ holder: "T1", projectRef: r, priority: "work" });
    s.bind("T1", { machineId: "lab-a", threadId: "t1" });
    expect(s.acquire({ holder: "T2", projectRef: r, priority: "work" }).granted).toBe(false);
    const stop = new AbortController();
    const running = s.run(events(hub), stop.signal);
    const log = events(hub);
    log.append({ at: "2026-10-17T10:00:00.000Z", type: "thread.started", machineId: "lab-a", threadId: "t1", summary: "run" });
    log.append({ at: "2026-10-17T10:01:00.000Z", type: "thread.completed", machineId: "lab-a", threadId: "t1", summary: "done" });
    await Bun.sleep(10);
    expect(s.state().used).toBe(1);
    expect(s.position("T2")).toBeUndefined();
    expect(notified).toBeGreaterThan(1);
    stop.abort();
    await running;
    // T1's thread is stored idle: after a restart its claim is idle, T2's still held.
    expect(open().agents(r).running).toBe(1);
  });

  test("a heartbeat sizes its machine, and the agents' Mac's role goes off for good", () => {
    const { hub, open } = fresh();
    store(hub).machineUpsert({ machineId: "lab-a", name: "builder-1", status: "online" } as never);
    start(hub);
    hub.shutdown.abort();
    const s = slots(hub);
    s.observeMachine("lab-a", "builder-1", { cpus: 16, load1: 0.5, memTotalBytes: 32 * GIB });
    expect(s.state().perMachine).toEqual([
      { machineId: "lab-a", cap: 12, auto: 12, why: "memory 32 GB, about 2 GB an agent", running: 0 },
    ]);
    s.keepToolOnly("mac1");
    expect(s.machineCap("mac1")).toBe(0);
    expect(open().machineCap("mac1")).toBe(0);
    expect(state(hub).cap).toBe(12);
  });
});

describe("cap_set", () => {
  test("the lines", () => {
    expect(pausedLine(4, 2, 2, 2)).toBe("Max agents 4 → 2: 2 agents push their work and wait; 2 keep running.");
    expect(pausedLine(2, 2, 1, 1)).toBe("Max agents 2: 1 agent pushes its work and waits; 1 keeps running.");
    expect(raisedLine(2, 4, 0, 2)).toBe("Max agents 2 → 4.");
    expect(raisedLine(2, 4, 1, 1)).toBe("Max agents 2 → 4: 1 queued agent starts now, 1 slot free.");
    expect(machineLine("devbox", 12, 6, false, true)).toBe(
      "Max agents on devbox set to 6 (auto was 12): running agents finish; new ones wait.",
    );
    expect(machineLine("devbox", 6, 12, true, false)).toBe(
      "Max agents on devbox back to auto: 12, was 6: queued agents start as slots allow.",
    );
  });

  test("raising a bot's max starts queued agents, logs agents.cap and wakes the lead", async () => {
    const { hub } = kit();
    const r = project_("p1");
    project(hub, r);
    const wakes: Trigger[] = [];
    leadWakes(hub).trigger = (_r, t) => void wakes.push(t);
    const s = slots(hub);
    s.setCap({ maxAgents: { projectRef: r, maxAgents: 1 } });
    s.acquire({ holder: "T1", projectRef: r, priority: "work" });
    s.acquire({ holder: "T2", projectRef: r, priority: "work" });
    const out = await capSet(hub, key("operate"), { project: { projectRef: r, maxAgents: 3 } });
    expect(out.next).toBe("Max agents 1 → 3: 1 queued agent starts now, 1 slot free.");
    expect(out.slots.perProject[0]).toEqual({ projectRef: r, maxAgents: 3, own: true, running: 2, queued: 0 });
    const cap = events(hub).page(0).events.filter((e) => e.type === "agents.cap");
    expect(cap.map((e) => [e.machineId, e.projectId, e.data])).toEqual([
      ["lab-a", "p1", { projectRef: r, from: 1, to: 3, running: 2, queued: 0 }],
    ]);
    expect(wakes).toEqual([
      { kind: "line", line: "cap_raised", text: "- cap raised to 3: 1 slot free; queued agents already started" },
    ]);
  });

  test("the fleet cap needs admin everywhere, and a bot max above it is refused", async () => {
    const { hub, tools, ok, refused } = kit();
    // The tasks area wires it; until then the test does.
    tools.add("cap_set", capSet);
    const r = project_("p1");
    project(hub, r);
    expect(await refused(key("operate"), "cap_set", { cap: 4 })).toBe("forbidden");
    const out = await ok(key("admin"), "cap_set", { cap: 4 });
    expect(out.next).toStartWith("Fleet cap set to 4 (the machines fit ");
    expect(await refused(key("operate"), "cap_set", { project: { projectRef: r, maxAgents: 5 } })).toBe("invalid");
    expect(await refused(key("admin"), "cap_set", { machine: { machineId: "nope", maxAgents: 2 } })).toBe("not_found");
    expect(await refused(key("admin"), "cap_set", {})).toBe("invalid");
  });
});

describe("where a machine's agents run, on its cap line", () => {
  // The longest real reason: a VM that started but couldn't reach Claude (T4071's), with a long error, and AppArmor's
  // with its fix.
  const unreachable =
    "the last VM didn't start: the VM can't reach Claude at claude-gateway.tail1234ab.ts.net:8317: curl: (28) Failed to connect to claude-gateway.tail1234ab.ts.net port 8317 after 10002 ms: Timeout was reached; the node tries VMs again after 21:40 UTC";
  const apparmor = {
    why: "AppArmor keeps this user from making the user namespace virtiofsd shares files from. The command lets unprivileged users make them again, now and after a reboot.",
    fix: "echo kernel.apparmor_restrict_unprivileged_userns=0 | sudo tee /etc/sysctl.d/60-fleetd-userns.conf && sudo sysctl --system",
  };
  const load = (sandbox: NodeLoad["sandbox"]): NodeLoad => ({ cpus: 32, memTotalBytes: 60e9, sandbox }) as unknown as NodeLoad;

  test("a long VM refusal reaches the apps whole, on the line and as its own field with its fix, never as 'auto'", () => {
    const k = Kit.on(undefined, []);
    for (const [id, sandbox] of [
      ["devbox", { kind: "process", why: unreachable }],
      ["lab-b", { kind: "process", why: apparmor.why, fix: apparmor.fix }],
    ] as const) {
      k.board.observeMachine(id, id, withSandbox(autoCap(load(sandbox)), sandbox), undefined);
    }
    const rows = slotState(k.board.state()).perMachine!;
    const devbox = rows.find((r) => r.machineId === "devbox")!;
    expect(devbox.why).toContain(`; agents run as plain processes: ${unreachable}`);
    expect(devbox.sandbox).toEqual({ kind: "process", why: unreachable });
    const lab = rows.find((r) => r.machineId === "lab-b")!;
    expect(lab.why.endsWith(`${apparmor.why} Fix: ${apparmor.fix}`)).toBe(true);
    expect(lab.sandbox).toEqual({ kind: "process", ...apparmor });
  });

  test("a reason past every limit is cut with an ellipsis, not dropped; in VMs and off by choice say so too", () => {
    const k = Kit.on(undefined, []);
    const huge = `${unreachable} ${"x".repeat(2_000)}`;
    k.board.observeMachine("devbox", "devbox", withSandbox(autoCap(load({ kind: "process", why: huge })), { kind: "process", why: huge }), undefined);
    const off = { kind: "process", why: `turned off on this machine (node.json "sandbox": "process")`, expected: true } as const;
    k.board.observeMachine("lab-b", "lab-b", withSandbox(autoCap(load(off)), off), undefined);
    k.board.observeMachine("lab-c", "lab-c", withSandbox(autoCap(load({ kind: "microvm" })), { kind: "microvm" }), undefined);
    const rows = slotState(k.board.state()).perMachine!;
    const devbox = rows.find((r) => r.machineId === "devbox")!;
    expect([...devbox.why].length).toBeLessThanOrEqual(WHY_MAX);
    expect(devbox.why.endsWith("…")).toBe(true);
    expect(devbox.why).toContain(unreachable);
    expect([...devbox.sandbox!.why!].length).toBe(SANDBOX_WHY_MAX);
    expect(devbox.sandbox!.why!.startsWith(unreachable)).toBe(true);
    expect(rows.find((r) => r.machineId === "lab-b")!.sandbox).toEqual(off);
    expect(rows.find((r) => r.machineId === "lab-c")!.sandbox).toEqual({ kind: "microvm" });
    // The next heartbeat's word replaces the last; a node that stops saying drops it.
    k.board.observeMachine("lab-c", "lab-c", autoCap(load(undefined)), undefined);
    expect(slotState(k.board.state()).perMachine!.find((r) => r.machineId === "lab-c")!.sandbox).toBeUndefined();
  });
});
