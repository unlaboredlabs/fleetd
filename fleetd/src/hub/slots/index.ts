// The slot board: one queue under each machine's cap (what it fits, sizing.ts),
// its disk room, each project's max agents, and the fleet cap if a person set one; reviews go first, then the oldest.
// A slot is held while a task's thread is running, read from the executor's thread events, and from a grant until
// that thread first runs. A lead is not an agent and holds none.
//
// The seam: `slots(hub)` is `hub.area("slots")`. The tasks area acquires, places, binds and releases; the node link's
// heartbeats size machines (loops.ts); `cap_set` is `setCaps` in cap.ts.
import type { Database } from "bun:sqlite";
import type { Clock } from "../../shared/clock.ts";
import type { HubEventType, MachineId, ProjectRef, SlotState, TaskKind, ThreadRef } from "../../shared/contracts.ts";
import type { NodeLoad } from "../../shared/node_link.ts";
import type { Hub } from "../api/hub.ts";
import type { HubDb } from "../store/db.ts";
import { type EventLog, events } from "../store/events.ts";
import { type HubStore, store } from "../store/hub_store.ts";
import {
  Board,
  type Claim,
  type Grant,
  type Machine,
  type MaxSource,
  type Op,
  parseClaimState,
  parsePriority,
  type SlotPriority,
  slotState,
} from "./board.ts";
import { autoCap, diskRoom } from "./sizing.ts";

export { GRANTED, type Grant, type MaxSource, type SlotPriority } from "./board.ts";

const RUNNING: HubEventType[] = ["thread.started"];
const STOPPED: HubEventType[] = [
  "thread.completed",
  "thread.failed",
  "thread.interrupted",
  "thread.waiting",
  "thread.usage_limited",
];

export const priorityOf = (kind: TaskKind): SlotPriority => (kind === "review" ? "review" : "work");

/**
 * Called after a slot frees (a release, or a task's thread stopping) or a cap changes, once the queue has been
 * re-evaluated. It must not block: the tasks area starts its queue retry from it.
 */
export type ReleaseListener = () => void;

export type CapInput = {
  /** 1..1000. */
  cap?: number;
  /** A machine's max agents, 1 up to the cap; maxAgents undefined: auto again. */
  machine?: { machineId: MachineId; maxAgents: number | undefined };
  /** A project's own max agents, 1 up to the cap; maxAgents undefined: back to the default. */
  maxAgents?: { projectRef: ProjectRef; maxAgents: number | undefined };
};

/** A project's agents as its lead is told them: "agents: 7 running of 12 (auto: memory 32 GB), 2 queued, 0 free". */
export type Agents = {
  running: number;
  maxAgents: number;
  queued: number;
  source: MaxSource;
  /** When one of its slots was last taken or freed (`Board.movedAt`). */
  movedMs: number;
};

export type SlotRequest = {
  /** The TaskId. */
  holder: string;
  projectRef: ProjectRef;
  priority: SlotPriority;
};

const SAVE_CLAIM = `INSERT INTO slot_claims (holder, machine_id, project_id, priority, thread_id, state, order_n)
  VALUES (?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT (holder) DO UPDATE SET machine_id = excluded.machine_id, project_id = excluded.project_id,
    priority = excluded.priority, thread_id = excluded.thread_id,
    state = excluded.state, order_n = excluded.order_n`;

function applyOp(conn: Database, op: Op): void {
  switch (op.op) {
    case "save": {
      const c = op.claim;
      conn
        .query(SAVE_CLAIM)
        .run(
          c.holder,
          c.projectRef.machineId,
          c.projectRef.projectId,
          c.priority,
          c.threadId ?? null,
          c.state,
          c.order,
        );
      return;
    }
    case "remove":
      conn.query("DELETE FROM slot_claims WHERE holder = ?").run(op.holder);
      return;
    case "cap":
      conn
        .query(
          "INSERT INTO slot_settings (key, value) VALUES ('cap', ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value",
        )
        .run(op.cap);
      return;
    // The table keeps its name from when this was a project's share, so an older hub's database opens.
    case "max_agents":
      if (op.maxAgents !== undefined) {
        conn
          .query(
            `INSERT INTO slot_shares (machine_id, project_id, share) VALUES (?, ?, ?)
             ON CONFLICT (machine_id, project_id) DO UPDATE SET share = excluded.share`,
          )
          .run(op.projectRef.machineId, op.projectRef.projectId, op.maxAgents);
      } else {
        conn
          .query("DELETE FROM slot_shares WHERE machine_id = ? AND project_id = ?")
          .run(op.projectRef.machineId, op.projectRef.projectId);
      }
      return;
    case "machine":
      conn
        .query(
          `INSERT INTO slot_machine_caps (machine_id, name, auto, why) VALUES (?, ?, ?, ?)
           ON CONFLICT (machine_id) DO UPDATE SET name = excluded.name, auto = excluded.auto, why = excluded.why`,
        )
        .run(op.machineId, op.name, op.auto.cap, op.auto.why);
      return;
    case "machine_max": {
      const m = op.machine;
      conn
        .query(
          `INSERT INTO slot_machine_caps (machine_id, name, auto, why, max_agents) VALUES (?, ?, ?, ?, ?)
           ON CONFLICT (machine_id) DO UPDATE SET max_agents = excluded.max_agents`,
        )
        .run(m.machineId, m.name, m.auto.cap, m.auto.why, m.maxAgents ?? null);
      return;
    }
  }
}

function persist(db: HubDb, ops: Op[]): void {
  if (ops.length === 0) return;
  db.transaction((conn) => {
    for (const op of ops) applyOp(conn, op);
  });
}

type ClaimRow = {
  holder: string;
  machine_id: string;
  project_id: string;
  priority: string;
  thread_id: string | null;
  state: string;
  order_n: number;
};

/** The persisted board: caps, max agents, machines and claims as the last hub left them. */
function load(db: HubDb): Board {
  const cap = db.all<{ value: number }>("SELECT value FROM slot_settings WHERE key = 'cap'")[0]?.value;
  const shares = db
    .all<{ machine_id: string; project_id: string; share: number }>(
      "SELECT machine_id, project_id, share FROM slot_shares",
    )
    .map((r): [ProjectRef, number] => [{ machineId: r.machine_id, projectId: r.project_id }, r.share]);
  const machines = db
    .all<{ machine_id: string; name: string; auto: number; why: string; max_agents: number | null }>(
      "SELECT machine_id, name, auto, why, max_agents FROM slot_machine_caps ORDER BY rowid",
    )
    .map((r): Machine => {
      // Disk room is unknown until its next heartbeat.
      const m: Machine = { machineId: r.machine_id, name: r.name, auto: { cap: r.auto, why: r.why } };
      if (r.max_agents !== null) m.maxAgents = r.max_agents;
      return m;
    });
  const claims = db
    .all<ClaimRow>(
      "SELECT holder, machine_id, project_id, priority, thread_id, state, order_n FROM slot_claims",
    )
    .map((r): Claim => {
      const c: Claim = {
        holder: r.holder,
        projectRef: { machineId: r.machine_id, projectId: r.project_id },
        priority: parsePriority(r.priority),
        state: parseClaimState(r.state),
        order: r.order_n,
      };
      if (r.thread_id !== null) c.threadId = r.thread_id;
      return c;
    });
  const sessionsOnly = db.all<{ machine_id: string }>("SELECT machine_id FROM machine_roles WHERE agents = 0");
  const board = new Board(cap, shares, machines, claims);
  for (const { machine_id } of sessionsOnly) board.setRunsAgents(machine_id, false);
  return board;
}


export class Slots {
  private readonly listeners: ReleaseListener[] = [];
  /** The event log's head when the board was loaded; `run` follows from here. */
  private readonly cursor: number;

  /**
   * Loads the board and rebuilds held claims from each bound thread's stored status; `run` then follows thread events
   * from the log's head as of now. The queue is re-evaluated when the first listener registers.
   */
  constructor(
    private readonly db: HubDb,
    private readonly clock: Clock,
    hubStore: HubStore,
    log: EventLog,
    private readonly board: Board = load(db),
  ) {
    board.tick(clock.now());
    this.cursor = log.head();
    const bound = board
      .claims()
      .filter((c) => c.state !== "queued" && c.threadId !== undefined)
      .map((c) => ({ holder: c.holder, thread: { machineId: c.projectRef.machineId, threadId: c.threadId } }));
    for (const { holder, thread } of bound) {
      const running = hubStore.threadGet(thread as ThreadRef)?.thread.status === "running";
      board.restore(holder, running);
    }
    persist(db, board.takeOps());
  }

  /** Follows thread events until `signal` aborts: a task's thread running holds its slot, stopping frees it. */
  async run(log: EventLog, signal: AbortSignal): Promise<void> {
    const types = [...RUNNING, ...STOPPED];
    let cursor = this.cursor;
    while (!signal.aborted) {
      let page: Awaited<ReturnType<EventLog["wait"]>>;
      try {
        page = await log.wait({ cursor, types, timeoutSec: 3600 }, signal);
      } catch (error) {
        console.warn("slots: event wait failed:", error);
        await Bun.sleep(1000);
        continue;
      }
      if (signal.aborted) return;
      cursor = page.cursor;
      for (const event of page.events) {
        if (event.machineId === undefined || event.threadId === undefined) continue;
        try {
          this.observe(event.machineId, event.threadId, RUNNING.includes(event.type));
        } catch (error) {
          console.warn("slots: thread event not applied:", error);
        }
      }
    }
  }

  /**
   * Runs `body` on the board at the clock's time; when that or the time freed capacity, re-evaluates the queue,
   * persists, then runs the listeners.
   */
  private locked<R>(body: (b: Board) => [R, boolean]): R {
    const board = this.board;
    const settled = board.tick(this.clock.now());
    const held = board.heldCounts();
    const [result, freedByBody] = body(board);
    const freed = freedByBody || settled;
    if (freed) board.evaluate();
    board.noteMoves(held);
    persist(this.db, board.takeOps());
    if (freed) this.notify();
    return result;
  }

  private notify(): void {
    for (const listener of [...this.listeners]) {
      try {
        listener();
      } catch (error) {
        console.error("slots: release listener failed:", error);
      }
    }
  }

  /** Applies a thread's running/stopped status. */
  observe(machineId: MachineId, threadId: string, running: boolean): void {
    this.locked((b) => [undefined, b.observe(machineId, threadId, running)]);
  }

  /**
   * A heartbeat's facts about the machine (`name` for the reasons people read): what it fits and its disk room. When
   * it takes more than before, starts the queued agents that now fit.
   */
  observeMachine(machineId: MachineId, name: string, load: NodeLoad): void {
    const auto = autoCap(load);
    const room = diskRoom(load);
    this.locked((b) => [undefined, b.observeMachine(machineId, name, auto, room)]);
  }

  /** Takes a slot now, or queues the request (reviews first, then the oldest) and says why. */
  acquire(request: SlotRequest): Grant {
    return this.locked((b) => [b.acquire(request.holder, request.projectRef, request.priority), false]);
  }

  /** The holder's slot follows `thread` from now on, taken again whenever it runs, even past the cap. */
  bind(holder: string, thread: ThreadRef): void {
    this.locked((b) => {
      b.bind(holder, thread.machineId, thread.threadId);
      return [undefined, false];
    });
  }

  /** The holder is done: drops its slot or its queued request, then re-evaluates the queue. */
  release(holder: string): void {
    this.locked((b) => [undefined, b.release(holder)]);
  }

  /** The project is gone (`project_lead::erase`): its slots, queued claims and own max agents go. */
  forgetProject(r: ProjectRef): void {
    this.locked((b) => [undefined, b.forgetProject(r)]);
  }

  /** Registers `listener` and runs it once now, after re-evaluating the queue. Returns the unsubscribe. */
  onRelease(listener: ReleaseListener): () => void {
    this.listeners.push(listener);
    const held = this.board.heldCounts();
    this.board.evaluate();
    this.board.noteMoves(held);
    persist(this.db, this.board.takeOps());
    listener();
    return () => {
      const i = this.listeners.indexOf(listener);
      if (i >= 0) this.listeners.splice(i, 1);
    };
  }

  /** The fleet cap, a machine's max agents, a project's, or any of them. Persisted; applies at once. */
  setCap(input: CapInput): SlotState {
    this.locked((b) => {
      if (input.machine) b.setMachine(input.machine.machineId, input.machine.maxAgents);
      b.setCap(input.cap, input.maxAgents);
      return [undefined, true];
    });
    return this.state();
  }

  /** The agents' Mac's hello (D298): its agents role goes off for good, so it runs no agent even after a restart. */
  keepToolOnly(m: MachineId): SlotState {
    this.db.transaction((conn) => {
      const row = conn
        .query<{ agents: number; sessions: number; max_sessions: number | null }, [string]>(
          "SELECT agents, sessions, max_sessions FROM machine_roles WHERE machine_id = ?",
        )
        .get(m);
      if (row && row.agents === 0) return;
      conn
        .query(
          `INSERT INTO machine_roles (machine_id, agents, sessions, max_sessions) VALUES (?, ?, ?, ?)
           ON CONFLICT (machine_id) DO UPDATE SET agents = excluded.agents, sessions = excluded.sessions,
             max_sessions = excluded.max_sessions`,
        )
        .run(m, 0, row ? row.sessions : 1, row ? row.max_sessions : null);
    });
    return this.setRunsAgents(m, false);
  }

  /** A machine's agents role: off, it runs no agents and its projects' agents wait; on again, queued ones start. */
  setRunsAgents(m: MachineId, on: boolean): SlotState {
    this.locked((b) => {
      b.setRunsAgents(m, on);
      return [undefined, true];
    });
    return this.state();
  }

  agents(r: ProjectRef): Agents {
    const [running, queued] = this.board.agents(r);
    return {
      running,
      maxAgents: this.board.maxAgentsOf(r),
      queued,
      source: this.board.maxSource(r),
      movedMs: this.board.movedAt(r),
    };
  }

  /** The queued holder's place in line, from 1. */
  position(holder: string): number | undefined {
    return this.board.position(holder);
  }

  /** The project's running writers and readers above its max agents, newest first. */
  extras(r: ProjectRef): string[] {
    return this.board.extras(r);
  }

  /** The fleet cap a person set; undefined: the machines' caps alone. */
  cap(): number | undefined {
    return this.board.cap();
  }

  /** The fleet cap when set, else what the machines fit together. */
  total(): number {
    return this.board.total();
  }

  /** The machine's cap: a person's setting, else what it fits. */
  machineCap(m: MachineId): number {
    return this.board.machineCap(m);
  }

  /** A person's setting for the machine; undefined: auto. */
  machineSetting(m: MachineId): number | undefined {
    return this.board.machineSetting(m);
  }

  /** Slots the project's tasks could take now. */
  room(r: ProjectRef): number {
    return this.board.room(r);
  }

  state(): SlotState {
    return slotState(this.board.state());
  }
}

/** The hub's slot board: `slots(hub).acquire(…)`. Made at hub start by loops.ts, so `run` follows from that head. */
export const slots = (hub: Hub): Slots =>
  hub.area("slots", (h) => new Slots(h.db, h.clock, store(h), events(h)));

/** The slot board as `SlotState` (Rust `Slots::state`): what the app's `live` frames and `cap_set` show. */
export const state = (hub: Hub): SlotState => slots(hub).state();
