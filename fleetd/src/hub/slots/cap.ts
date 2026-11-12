// A project's max agents, a machine's and the fleet cap, as a person sets them (`cap_set`, `fleetd project set`,
// `fleetd machine set`; crates/fleetd/src/hub/tasks/cap.rs and the tool in tasks/tools.rs). The slot board enforces
// them at every start; this is the change itself: lowering stops nothing unless the extras are paused, raising starts
// queued agents at once and wakes the lead, and every change is one `agents.cap` event whose summary is the chat's
// quiet line. The tasks area wires the tool (`tools.add("cap_set", capSet)`) and sets `capHooks(hub).pauseExtras`.
import type {
  AgentsCapData,
  CapSetInput,
  CapSetOutput,
  MachineId,
  ProjectRef,
  SlotState,
  TaskId,
} from "../../shared/contracts.ts";
import { capRaisedText, fleetLine, machineLine, projectLine } from "../../shared/cap_lines.ts";
import { ToolError } from "../../shared/errors.ts";
import type { Hub } from "../api/hub.ts";
import { leadWakes } from "../api/leads.ts";
import { requireRole, refused } from "../api/grants.ts";
import type { Caller } from "../api/registry.ts";
import { allowsEverywhere, unknownMachine, unknownProject } from "../api/refusals.ts";
import { events } from "../store/events.ts";
import { store } from "../store/hub_store.ts";
import { isoMs } from "../store/time.ts";
import { slots } from "./index.ts";

export { machineLine, pausedLine, pausedReason, raisedLine } from "../../shared/cap_lines.ts";

export type CapChange = {
  cap?: number;
  machine?: { machineId: MachineId; /** undefined: auto again. */ maxAgents: number | undefined };
  project?: {
    projectRef: ProjectRef;
    /** Its own max; undefined: back to the default. */
    maxAgents: number | undefined;
    /** Lowering: pause the agents above the new max now instead of letting them finish. */
    pauseExtras: boolean;
  };
};

export type CapOutcome = { slots: SlotState; paused: TaskId[]; next: string };

export type CapHooks = {
  /**
   * Tells each running writer or reader above `maxAgents` (`slots(hub).extras(r)`) to push its work and end its turn,
   * and queues it with a resume message; returns the ones it paused. The tasks area sets it (Rust `pause_extras`).
   */
  pauseExtras(r: ProjectRef, maxAgents: number): Promise<TaskId[]>;
};

/** What `setCaps` takes from the tasks area. Until it sets them, extras are never paused. */
export const capHooks = (hub: Hub): CapHooks =>
  hub.area<CapHooks>("slots_cap", () => ({ pauseExtras: async () => [] }));

function capEvent(
  hub: Hub,
  r: ProjectRef | undefined,
  machine: MachineId | undefined,
  from: number,
  to: number,
  running: number,
  queued: number,
  paused: TaskId[],
  line: string,
): void {
  const count = (n: number) => Math.max(n, 0);
  // Keys in the Rust struct's order.
  const data: Record<string, unknown> = {};
  if (r) data.projectRef = r;
  Object.assign(data, { from: count(from), to: count(to), running: count(running), queued: count(queued) });
  if (paused.length > 0) data.paused = paused;
  events(hub).append({
    at: isoMs(hub.clock.now()),
    type: "agents.cap",
    ...(r ? { machineId: r.machineId, projectId: r.projectId } : machine !== undefined ? { machineId: machine } : {}),
    summary: line,
    data: data as AgentsCapData,
  });
}

/** `cap_set`'s change, checked against the fleet cap, applied, announced, and the lead woken on a raise. */
export async function setCaps(hub: Hub, change: CapChange): Promise<CapOutcome> {
  const board = slots(hub);
  // Unset until someone sets it: the machines' own caps are the only limit across projects.
  const capBefore = board.cap();
  const totalBefore = board.total();
  const fleet = change.cap ?? capBefore;
  const pick = (cap: number) => `Pick 1 to ${cap}, or raise the fleet cap first.`;
  const projectMax = change.project?.maxAgents;
  if (projectMax !== undefined && fleet !== undefined && projectMax > fleet) {
    throw new ToolError("invalid", `Max agents ${projectMax} is above the fleet's ${fleet} slots.`, pick(fleet));
  }
  const machineMax = change.machine?.maxAgents;
  if (change.machine && machineMax !== undefined && fleet !== undefined && machineMax > fleet) {
    throw new ToolError(
      "invalid",
      `Max agents ${machineMax} on ${change.machine.machineId} is above the fleet's ${fleet} slots.`,
      pick(fleet),
    );
  }
  const machineBefore = change.machine && {
    cap: board.machineCap(change.machine.machineId),
    setting: board.machineSetting(change.machine.machineId),
  };
  const before = change.project && board.agents(change.project.projectRef);
  // The board grants every queued claim that now fits before this returns; the release listener starts them.
  board.setCap({
    ...(change.cap !== undefined ? { cap: change.cap } : {}),
    ...(change.machine ? { machine: change.machine } : {}),
    ...(change.project
      ? { maxAgents: { projectRef: change.project.projectRef, maxAgents: change.project.maxAgents } }
      : {}),
  });

  let paused: TaskId[] = [];
  const lines: string[] = [];
  if (change.cap !== undefined && change.cap !== capBefore) {
    const cap = change.cap;
    const after = board.state();
    const line = fleetLine(capBefore, cap, totalBefore);
    capEvent(hub, undefined, undefined, capBefore ?? totalBefore, cap, after.used, after.queued, [], line);
    lines.push(line);
  }
  if (change.machine && machineBefore && machineBefore.setting !== change.machine.maxAgents) {
    const id = change.machine.machineId;
    const to = board.machineCap(id);
    const after = board.state();
    const line = machineLine(id, machineBefore.cap, to, machineBefore.setting !== undefined, machineMax !== undefined);
    capEvent(hub, undefined, id, machineBefore.cap, to, after.used, after.queued, [], line);
    lines.push(line);
  }
  if (change.project && before) {
    const r = change.project.projectRef;
    const from = before.maxAgents;
    const to = board.agents(r).maxAgents;
    // Back to the default from a max of its own: a change even at the same number.
    const back = change.project.maxAgents === undefined && before.source.kind === "project";
    // At the same max too: the app applies a lower max first and offers the pause after it.
    if (to <= from && change.project.pauseExtras) paused = await capHooks(hub).pauseExtras(r, to);
    const after = board.agents(r);
    const free = board.room(r);
    const started = Math.max(after.running - before.running, 0);
    const line = projectLine({ from, to, started, free, paused: paused.length, running: after.running, back });
    if (to !== from || back || paused.length > 0) {
      capEvent(hub, r, undefined, from, to, after.running, after.queued, paused, line);
      lines.push(line);
    }
    if (to > from) leadWakes(hub).trigger(r, { kind: "line", line: "cap_raised", text: capRaisedText(to, free) });
  }
  return { slots: board.state(), paused, next: lines.length === 0 ? "Nothing changed." : lines.join(" ") };
}

/** The `cap_set` tool (Rust tasks/tools.rs), with its contract's `checked!` rules, which the decoder leaves out. */
export async function capSet(hub: Hub, caller: Caller, input: CapSetInput): Promise<CapSetOutput> {
  if (input.cap === undefined && input.machine === undefined && input.project === undefined) {
    throw new ToolError("invalid", "expected cap, machine, project or more");
  }
  if (input.machine && (input.machine.maxAgents !== undefined) === (input.machine.auto === true)) {
    throw new ToolError("invalid", "expected machine.maxAgents or machine.auto: true");
  }
  if (input.project && (input.project.maxAgents !== undefined) === (input.project.followDefault === true)) {
    throw new ToolError("invalid", "expected project.maxAgents or project.followDefault: true");
  }
  if ((input.cap !== undefined || input.machine !== undefined) && !allowsEverywhere(caller, "admin")) {
    throw refused(caller, "admin");
  }
  const hubStore = store(hub);
  if (input.machine && !hubStore.machineGet(input.machine.machineId)) throw unknownMachine(input.machine.machineId);
  if (input.project) {
    requireRole(caller, "operate", input.project.projectRef.machineId);
    if (!hubStore.projectGet(input.project.projectRef)) throw unknownProject(input.project.projectRef);
  }
  const outcome = await setCaps(hub, {
    ...(input.cap !== undefined ? { cap: input.cap } : {}),
    ...(input.machine ? { machine: { machineId: input.machine.machineId, maxAgents: input.machine.maxAgents } } : {}),
    ...(input.project
      ? {
          project: {
            projectRef: input.project.projectRef,
            maxAgents: input.project.maxAgents,
            pauseExtras: input.project.pauseExtras ?? false,
          },
        }
      : {}),
  });
  return {
    slots: outcome.slots,
    ...(outcome.paused.length > 0 ? { paused: outcome.paused } : {}),
    next: outcome.next,
  };
}
