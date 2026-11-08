// Intake, briefs and closes (crates/fleetd/src/hub/leads/workstreams.rs). A workstream's brief is a plain record the
// lead sets and edits; every write is an event, so the history shows each version.
import type { Brief, HubEventType, IntakeChannel, ProjectRef, Workstream, WorkstreamState } from "../../shared/contracts.ts";
import { ToolError } from "../../shared/errors.ts";
import type { Hub } from "../api/hub.ts";
import { events } from "../store/events.ts";
import { store } from "../store/hub_store.ts";
import { isoMs, nowMs, parseMs } from "../store/time.ts";
import { leadWakes } from "./seams.ts";
import { leadWiring, unlanded } from "./ports.ts";
import { isClosed, LeadRecords } from "./records.ts";
import { runHuman, setRequested } from "./requested.ts";
import { clip } from "./text.ts";

export type IntakeInput = {
  projectRef: ProjectRef;
  text: string;
  clientRequestId: string;
  channel: IntakeChannel;
  /** An agent keyId, "human" or "lead:<machineId>/<projectId>". */
  by: string;
};

const sameProject = (a: ProjectRef, b: ProjectRef) => a.machineId === b.machineId && a.projectId === b.projectId;

const titleOf = (text: string) => clip((text.trim().split("\n")[0] ?? "").trim(), 200);

export const noProject = (r: ProjectRef) =>
  new ToolError("not_found", `No project ${r.projectId} on ${r.machineId}.`, `Call project_get with machineId ${r.machineId} and no projectId.`);

export class Workstreams {
  private readonly records: LeadRecords;

  constructor(private readonly hub: Hub) {
    this.records = new LeadRecords(hub.db);
  }

  private nowIso(): string {
    return isoMs(nowMs(this.hub.clock));
  }

  private event(w: Workstream, type: HubEventType, summary: string, data: Record<string, unknown>): void {
    events(this.hub).append({ at: w.updatedAt, type, machineId: w.projectRef.machineId, projectId: w.projectRef.projectId, summary, data });
  }

  /** The caller's own workstream, or a refusal that says why. */
  private own(caller: ProjectRef, id: string): Workstream {
    const w = this.records.workstreamGet(id);
    if (!w) throw new ToolError("not_found", `There is no workstream ${id}.`, "Use a workstream id from the digest at the top of your last wake.");
    if (!sameProject(w.projectRef, caller)) throw new ToolError("forbidden", `${id} belongs to another project.`, "Use a workstream id from your own digest.");
    return w;
  }

  /** Creates a draft workstream for the intent and wakes the lead. Idempotent per clientRequestId. */
  intake(input: IntakeInput): { workstreamId: string } {
    return this.create(input, true);
  }

  /** A `brief` without a workstream opens one: the same draft, with no intent wake. `asked` is a Navi message's handle. */
  open(input: IntakeInput, asked?: string): { workstreamId: string } {
    return this.create(input, false, asked);
  }

  private create(input: IntakeInput, wake: boolean, asked?: string): { workstreamId: string } {
    if (!store(this.hub).projectGet(input.projectRef)) throw noProject(input.projectRef);
    const { workstream, created } = this.records.workstreamCreate({
      projectRef: input.projectRef,
      title: titleOf(input.text),
      text: input.text,
      channel: input.channel,
      by: input.by,
      at: this.nowIso(),
      clientRequestId: input.clientRequestId,
    });
    const id = workstream.workstreamId;
    if (created && input.channel === "lead") this.stampRequested(workstream);
    if (created) {
      this.event(workstream, "workstream.created", `New intent ${id}: ${workstream.title}`, asked === undefined ? { workstreamId: id } : { workstreamId: id, asked });
    }
    if (created && wake) leadWakes(this.hub).trigger(input.projectRef, { kind: "intent", workstreamId: id, text: input.text });
    return { workstreamId: id };
  }

  /** An order the lead opens was asked for at the earliest human message of the run that opens it, else when it opened. */
  private stampRequested(w: Workstream): void {
    const r = w.projectRef;
    const now = nowMs(this.hub.clock);
    const lead = this.records.leadGet(r);
    const human = lead ? runHuman(this.hub.db, r, lead.threadId, now) : undefined;
    // Who started it: the writer of the message the lead was answering.
    if (human?.person) this.records.workstreamPut({ ...w, startedBy: human.person });
    setRequested(this.hub.db, w, human ? { atMs: human.atMs, basis: "chat" } : { atMs: parseMs(w.createdAt) ?? now, basis: "opened" });
  }

  /**
   * `brief` from the lead of `caller`: sets the brief of a draft and starts it, or edits it. `folded` is a Navi
   * message the lead folds into it, said in a `workstream.state` event of its own.
   */
  briefCreate(caller: ProjectRef, workstreamId: string, brief: Brief, folded?: string): { workstreamId: string; state: WorkstreamState; next: string } {
    const w = this.own(caller, workstreamId);
    const id = w.workstreamId;
    if (isClosed(w.state)) throw new ToolError("invalid", `${id} is ${w.state}; its brief can no longer change.`);
    const running = `Spawn its agents with \`spawn_agent\` for ${id}.`;
    if (folded !== undefined) this.event(w, "workstream.state", `${id} takes ask ${folded}`, { workstreamId: id, state: w.state, asked: folded });
    if (w.brief !== undefined && JSON.stringify(w.brief) === JSON.stringify(brief)) return { workstreamId: id, state: w.state, next: `Unchanged. ${running}` };
    // A draft starts running: it stays open, now with a brief.
    const starts = w.brief === undefined;
    const next: Workstream = { ...w, brief, updatedAt: this.nowIso() };
    this.records.workstreamPut(next);
    if (starts) {
      this.event(next, "workstream.running", `${id} is running: ${w.title}`, { workstreamId: id });
      return { workstreamId: id, state: w.state, next: `Brief set. ${running}` };
    }
    this.event(next, "workstream.state", `${id} brief edited`, { workstreamId: id, state: w.state, briefEdited: true });
    return { workstreamId: id, state: w.state, next: `Brief edited. ${running}` };
  }

  /**
   * `close` from the lead of `caller`: the workstream is done, with why, and its agents still at it are stopped.
   * Refused while any of its PRs is still in the train.
   */
  async close(caller: ProjectRef, workstreamId: string, why: string, by: string): Promise<{ workstreamId: string; state: WorkstreamState; next: string }> {
    const w = this.own(caller, workstreamId);
    const id = w.workstreamId;
    if (isClosed(w.state)) throw new ToolError("invalid", `${id} is already ${w.state}.`, "Open a new workstream if there is more to do.");
    const left = unlanded(this.hub, caller, id);
    if (left.length > 0) {
      throw new ToolError(
        "invalid",
        `${id} still has PRs in the train: ${left.join(", ")}.`,
        "Close it once they merge. To drop one, close the PR on GitHub and the train lets it go.",
      );
    }
    const done: Workstream = { ...w, state: "done", updatedAt: this.nowIso() };
    this.records.workstreamPut(done);
    this.event(done, "workstream.done", `${id} is done: ${why}`, { workstreamId: id, reason: why, by });
    const { stopped, running } = await this.stopLeftovers(caller, id, why);
    let next = "Closed.";
    if (stopped.length > 0) next += ` Stopped its agents still at it: ${stopped.join(", ")}.`;
    if (running.length > 0) next += ` ${running.join(", ")} could not be stopped yet: call stop_agent on each shortly.`;
    return { workstreamId: id, state: "done", next };
  }

  /** Cancels the closed workstream's leftover agents: those it stopped, and those still live after. */
  private async stopLeftovers(r: ProjectRef, id: string, why: string): Promise<{ stopped: string[]; running: string[] }> {
    const tasks = leadWiring(this.hub).hooks.tasks;
    if (!tasks) return { stopped: [], running: [] };
    const leftovers = tasks.leftovers(r, id);
    const reason = `Cancelled: ${id} was closed (${why}).`;
    for (const t of leftovers) await tasks.cancel(r, t, reason);
    const still = new Set(tasks.leftovers(r, id));
    return { stopped: leftovers.filter((t) => !still.has(t)), running: leftovers.filter((t) => still.has(t)) };
  }
}

export const workstreams = (hub: Hub) => hub.area("lead_workstreams", (h) => new Workstreams(h));

/**
 * Order intake as other areas use it (the train's fixes, automations), `hub.area("intake")`: `intake` (and its alias
 * `submit`) opens an order once per clientRequestId and wakes the lead; `close` closes one as its lead's `close` does.
 * Both throw a ToolError to refuse.
 */
export type Intake = {
  intake(input: IntakeInput): { workstreamId: string };
  submit(input: IntakeInput): { workstreamId: string };
  close(r: ProjectRef, workstreamId: string, reason: string, by: string): Promise<{ workstreamId: string; state: WorkstreamState; next: string }>;
};

/** Made at the leads area's start, so the name has one maker and areas that peek it find it. */
export const intake = (hub: Hub) =>
  hub.area<Intake>("intake", (h) => ({
    intake: (input) => workstreams(h).intake(input),
    submit: (input) => workstreams(h).intake(input),
    close: (r, id, reason, by) => workstreams(h).close(r, id, reason, by),
  }));
