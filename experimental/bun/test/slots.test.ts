// The slot board (crates/fleetd/src/hub/slots/{board,sizing,mod}.rs tests) and cap_set (hub/tasks/cap.rs).
import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { MIGRATIONS } from "../src/gen/migrations.ts";
import { Hub } from "../src/hub/api/hub.ts";
import { leadWakes, type Trigger } from "../src/hub/api/leads.ts";
import { Board, type Claim, GRANTED, type Machine, type Placed, type SlotPriority, SETTLE_MS } from "../src/hub/slots/board.ts";
import { capSet, machineLine, pausedLine, raisedLine } from "../src/hub/slots/cap.ts";
import { Slots, slots, state } from "../src/hub/slots/index.ts";
import { start } from "../src/hub/slots/loops.ts";
import { autoCap, diskRoom, HARD_TOP, UNMEASURED, UNMEASURED_WHY } from "../src/hub/slots/sizing.ts";
import { HubDb } from "../src/hub/store/db.ts";
import { events } from "../src/hub/store/events.ts";
import { store } from "../src/hub/store/hub_store.ts";
import type { NodeLoad } from "../src/shared/node_link.ts";
import type { MachineId, ProjectRef } from "../src/shared/contracts.ts";
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
    expect(autoCap(machine(8, 8), false)).toEqual(auto(2, "memory 8 GB, about 2 GB an agent"));
    expect(autoCap(machine(12, 18), false)).toEqual(auto(6, "memory 18 GB, about 2 GB an agent"));
    expect(autoCap(machine(16, 32), false)).toEqual(auto(12, "memory 32 GB, about 2 GB an agent"));
    expect(autoCap(machine(32, 128), false)).toEqual(auto(28, "28 of 32 CPUs"));
    expect(autoCap(machine(64, 256), false)).toEqual(auto(56, "56 of 64 CPUs"));
    expect(autoCap(machine(128, 512), false)).toEqual(auto(64, "top of 64"));
    expect(autoCap(machine(2, 4), false)).toEqual(auto(1, "memory 4 GB, about 2 GB an agent"));
  });

  test("the kernel's short count of memory is rounded up; an older node without memory counts four", () => {
    expect(autoCap({ cpus: 16, load1: 0.5, memTotalBytes: 33_520_000_000 }, false)).toEqual(
      auto(12, "memory 32 GB, about 2 GB an agent"),
    );
    expect(autoCap(machine(16), false)).toEqual(auto(4, "memory unknown"));
    expect(autoCap(machine(2), false)).toEqual(auto(1, "1 of 2 CPUs"));
  });

  test("a cloud machine takes 4 GB an agent; an older node's memory per agent replaces two", () => {
    const large: NodeLoad = { cpus: 8, load1: 0.5, memTotalBytes: 15_991 * 2 ** 20 };
    expect(autoCap(large, true)).toEqual(auto(3, "memory 16 GB, about 4 GB an agent"));
    expect(autoCap(large, false).cap).toBe(6);
    expect(autoCap({ ...machine(12, 18), memPerAgentBytes: 2 * GB }, false)).toEqual(
      auto(6, "memory 18 GB, about 2 GB an agent"),
    );
    expect(autoCap({ ...machine(16, 32), memPerAgentBytes: 4 * GB }, false)).toEqual(
      auto(6, "memory 32 GB, about 4 GB an agent"),
    );
    expect(autoCap({ ...machine(16, 32), memPerAgentBytes: 2_500_000_000 }, false)).toEqual(
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
  test("room is what a task of the project could take now", () => {
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

  test("a project follows the default until it has a max of its own", () => {
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

  test("the fleet cap and each project's max agents both hold", () => {
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

  /** devbox fits 2; cloud machines boat-1 and boat-2 fit 3 each. */
  const cloudKit = (cap?: number) => ({
    k: Kit.on(cap, [machine("devbox", 2), machine("boat-1", 3), machine("boat-2", 3)]),
    app: project_("app", "devbox"),
    cloud: ["boat-1", "boat-2"] as MachineId[],
  });
  const place = (k: Kit, holder: string, r: ProjectRef, cloud: MachineId[]) => k.board.place(holder, r, "work", cloud, 0);
  const on = (m?: string): Placed => (m === undefined ? { kind: "granted" } : { kind: "granted", on: m });

  test("a new task bursts only at its machine's agent limit and packs the busiest cloud machine", () => {
    const { k, app, cloud } = cloudKit();
    const placed = Array.from({ length: 9 }, (_, n) => place(k, `T${n + 1}`, app, cloud));
    expect(placed.slice(0, 8)).toEqual([on(), on(), on("boat-1"), on("boat-1"), on("boat-1"), on("boat-2"), on("boat-2"), on("boat-2")]);
    expect(placed[8]).toEqual({ kind: "full", reason: "machine cap: 2 of 2 running on devbox-box (memory 18 GB)" });
    expect(k.board.state().perMachine.map((m) => m.running)).toEqual([2, 3, 3]);
    k.board.release("T9");
    k.board.bind("T3", "boat-1", "t3");
    expect(k.board.observe("boat-1", "t3", false)).toBe(true);
    expect(k.board.room(app)).toBe(0);
    expect(place(k, "T10", app, cloud)).toEqual(on("boat-1"));
    k.release("T1");
    expect(place(k, "T11", app, cloud)).toEqual(on());
  });

  test("the machine's own agent limit decides the burst, not the fleet cap or the project's max", () => {
    // Fleet cap 64 and the project's own max 64, as on a live hub: devbox's limit is what a person set it to.
    const k = Kit.on(64, [machine("devbox", 22), machine("boat-1", 3)]);
    const app = project_("app", "devbox");
    k.board.setCap(64, { projectRef: app, maxAgents: 64 });
    k.board.setMachine("devbox", 20);
    // Below it, nothing goes to a cloud machine, however many run.
    for (let n = 1; n <= 20; n++) expect(place(k, `T${n}`, app, ["boat-1"])).toEqual(on());
    // At it, the next one bursts.
    expect(place(k, "T21", app, ["boat-1"])).toEqual(on("boat-1"));
    // Lowered to 10 with 20 running: every new one bursts while the cloud has room, then waits for devbox.
    k.board.setMachine("devbox", 10);
    expect(place(k, "T22", app, ["boat-1"])).toEqual(on("boat-1"));
    expect(place(k, "T23", app, ["boat-1"])).toEqual(on("boat-1"));
    expect(place(k, "T24", app, ["boat-1"])).toEqual({ kind: "full", reason: "machine cap: 20 of 10 running on devbox-box (set)" });
  });

  test("a hydrated cloud machine goes before one just woken", () => {
    const { k, app } = cloudKit();
    for (let n = 1; n <= 2; n++) expect(place(k, `T${n}`, app, [])).toEqual(on());
    const cloud = ["boat-2", "boat-1"];
    expect(k.board.place("T3", app, "work", ["boat-1"], 0)).toEqual(on("boat-1"));
    const warm = (holder: string) => k.board.place(holder, app, "work", cloud, 1);
    expect(warm("T4")).toEqual(on("boat-2"));
    expect(warm("T5")).toEqual(on("boat-2"));
    expect(warm("T6")).toEqual(on("boat-2"));
    expect(warm("T7")).toEqual(on("boat-1"));
  });

  test("a person-set limit holds bursting too", () => {
    {
      const { k, app, cloud } = cloudKit(4);
      for (let n = 1; n <= 4; n++) expect(place(k, `T${n}`, app, cloud).kind).toBe("granted");
      expect(place(k, "T5", app, cloud)).toEqual({ kind: "queued", reason: "fleet cap: 4 of 4 running" });
    }
    {
      const { k, app, cloud } = cloudKit();
      k.board.setCap(undefined, { projectRef: app, maxAgents: 3 });
      for (let n = 1; n <= 3; n++) expect(place(k, `T${n}`, app, cloud).kind).toBe("granted");
      expect(place(k, "T4", app, cloud)).toEqual({
        kind: "queued",
        reason: "machine cap: 2 of 2 running on devbox-box (memory 18 GB)",
      });
      expect(k.board.agents(app)).toEqual([3, 1]);
    }
    {
      const { k, app, cloud } = cloudKit();
      k.board.setRunsAgents("devbox", false);
      expect(place(k, "T1", app, cloud).kind).toBe("queued");
    }
    {
      const { k, app } = cloudKit();
      for (let n = 1; n <= 2; n++) place(k, `T${n}`, app, []);
      expect(place(k, "T3", app, []).kind).toBe("full");
    }
  });

  test("a follow-up counts on the cloud machine it runs on", () => {
    const { k, app } = cloudKit();
    for (let n = 1; n <= 3; n++) k.board.acquire(`T${n}`, app, "work", "boat-1");
    expect(k.board.acquire("T4", app, "work", "boat-1")).toEqual(
      queued("machine cap: 3 of 3 running on boat-1-box (memory 18 GB)"),
    );
    expect(k.board.room(app)).toBe(2);
    k.release("T1");
    expect(k.board.agents(app)).toEqual([3, 0]);
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

  test("a claim on a cloud machine outlives a restart", () => {
    const { open } = fresh();
    const r = project_("app", "devbox");
    const s = open();
    for (const [m, n] of [["devbox", 1], ["boat-1", 2]] as const) s.setCap({ machine: { machineId: m, maxAgents: n } });
    const req = (holder: string) => ({ holder, projectRef: r, priority: "work" as const });
    expect(s.place(req("T1"), ["boat-1"], 0)).toEqual({ kind: "granted" });
    expect(s.place(req("T2"), ["boat-1"], 0)).toEqual({ kind: "granted", on: "boat-1" });
    const running = (x: Slots) => (x.state().perMachine ?? []).map((m) => [m.machineId, m.running]);
    expect(running(s)).toEqual([
      ["devbox", 1],
      ["boat-1", 1],
    ]);
    expect(running(open())).toEqual(running(s));
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
    s.observeMachine(r.machineId, "builder-1", load, false);
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
    s.observeMachine("lab-a", "builder-1", { cpus: 16, load1: 0.5, memTotalBytes: 32 * GIB }, false);
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

  test("raising a project's max starts queued agents, logs agents.cap and wakes the lead", async () => {
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

  test("the fleet cap needs admin everywhere, and a project max above it is refused", async () => {
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
