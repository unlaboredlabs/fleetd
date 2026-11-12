// Requests (`Q<n>`), ported from crates/fleetd/src/hub/approvals/mod.rs: what a lead needs a person for that a chat
// can't carry safely, shown inline in the project's chat.
// - secret (`request_secret`): the desktop app seals the value to the sink machine's box key; the hub relays the
//   ciphertext to that node without storing it and keeps only the fingerprint the node reports. An `order:` sink
//   makes it one variable of an open order's agents on the project's machine, until the order closes.
// - approval of a command (`gated_run`): the exact command is stored; once a person approves it, the project's node
//   runs those bytes and the exit code and output tail go to the lead.
// - approval of a Navi's purchase or secure input (purchases.ts, secure_input.ts), and of a tool prompt
//   (permissions.ts).
// Every change is announced as `request.opened` / `request.updated`; the chat shows each request as its item.
import type { Clock } from "../../shared/clock.ts";
import type { HumanRequest, PersonRef, ProjectRef, RequestState } from "../../shared/contracts.ts";
import { ToolError } from "../../shared/errors.ts";
import type { Hub } from "../api/hub.ts";
import { isoMs } from "../store/time.ts";
import { AUTOMATION_CONFIRM_TOOL, PROJECT_PROPOSE_TOOL, projectOf } from "./names.ts";
import { requestAttention } from "./outcome.ts";
import { answerPrompt, refusePrompt } from "./permissions.ts";
import {
  type ApprovalEvents,
  type ApprovalHooks,
  type ApprovalHub,
  type ApprovalNodes,
  type GatedOutcome,
  NodeCommandError,
} from "./ports.ts";
import { base64Bytes, envNameReserved, isFingerprint, parseSecretSink, SEAL_OVERHEAD, secretEnvName } from "./sink.ts";
import { type NewRequest, type RequestFilter, RequestStoreError, Requests, settled } from "./store.ts";
import {
  EVIDENCE_MAX,
  gatedRefusal,
  type GatedRunInput,
  HUMAN_ONLY_SECRET_FIX,
  mayHaveRun,
  NO_ASK,
  NOT_RUN_AFTER_RESTART,
  OFFLINE_WAIT_MS,
  RELINK_POLL_MS,
  RELINK_WAIT_MS,
  type RequestSecretCall,
  RUNNING,
} from "./rules.ts";
import { clip, shownArgv } from "./text.ts";

export { AUTOMATION_CONFIRM_TOOL, PROJECT_PROPOSE_TOOL, projectOf } from "./names.ts";
export {
  GATED_DEFAULT_TIMEOUT_SEC,
  GATED_MAX_TIMEOUT_SEC,
  type GatedRunInput,
  HUMAN_ONLY_SECRET_FIX,
  NO_ASK,
  NOT_RUN_AFTER_RESTART,
  type RequestSecretCall,
} from "./rules.ts";

/** Who called: a human or agent key, by name, with its grants. */
export type ApprovalCaller = {
  human: boolean;
  name: string;
  /** A human key's person, recorded as who answered. */
  person?: PersonRef;
  /** Whether the key holds operate on `machine`. */
  allowsOperate: (machine: string) => boolean;
};

export type ApprovalsDeps = {
  requests: Requests;
  nodes: ApprovalNodes;
  hub: ApprovalHub;
  hooks: ApprovalHooks;
  events: ApprovalEvents;
  clock: Clock;
  /** Waits `ms` (tests pass their own). */
  sleep?: (ms: number) => Promise<void>;
  /** Aborts the followers when the hub stops. */
  signal?: AbortSignal;
};

export const refuse = (code: ToolError["code"], message: string, fix?: string) => new ToolError(code, message, fix);

export const notFound = (id: string) =>
  refuse("not_found", `No request ${id}.`, "Use a requestId from the chat or requests_list.");

/** A store failure in the tools' words. */
export function storeRefusal(e: unknown): ToolError {
  if (e instanceof ToolError) return e;
  if (e instanceof RequestStoreError) {
    if (e.kind === "not_found") return notFound(e.id);
    if (e.kind === "invalid") return refuse("invalid", e.message);
    return refuse("invalid", `${e.message}.`, "Nothing to do: someone settled it first.");
  }
  console.error("approvals: request store failed:", e);
  return refuse("failed", "The hub failed while saving the request.", "Try again shortly.");
}

const sameProject = (a: ProjectRef, b: ProjectRef) => a.machineId === b.machineId && a.projectId === b.projectId;

export class Approvals {
  /** The prompts a Navi's checker is judging now (machine, thread, prompt): each is judged once. */
  readonly checking = new Set<string>();
  /** Called whenever a checker's verdict landed. */
  readonly idle = new Set<() => void>();

  constructor(readonly deps: ApprovalsDeps) {}

  sleep(ms: number): Promise<void> {
    return this.deps.sleep ? this.deps.sleep(ms) : Bun.sleep(ms);
  }

  now(): string {
    return isoMs(this.deps.clock.now());
  }

  get(id: string): HumanRequest | undefined {
    try {
      return this.deps.requests.get(id);
    } catch (e) {
      console.warn("approvals: a request was not read:", e);
      return undefined;
    }
  }

  list(filter: RequestFilter): HumanRequest[] {
    try {
      return this.deps.requests.list(filter);
    } catch (e) {
      throw storeRefusal(e);
    }
  }

  /** Every request in `states` of `kind`, or none when the store fails. */
  listQuiet(filter: Omit<RequestFilter, "limit">): HumanRequest[] {
    try {
      return this.deps.requests.list({ ...filter, limit: Number.MAX_SAFE_INTEGER });
    } catch (e) {
      console.warn("approvals: requests not listed:", e);
      return [];
    }
  }

  announce(type: "request.opened" | "request.updated", r: HumanRequest): void {
    const project = projectOf(r);
    let what = "";
    if (r.secret) what = `secret ${r.secret.key}`;
    else if (r.gated) what = shownArgv(r.gated.argv);
    else if (r.permission) what = `${r.permission.toolName} ${r.permission.summary}`;
    else if (r.purchase) what = `purchase at ${r.purchase.shop.domain} (${r.purchase.total.amount} ${r.purchase.total.currency})`;
    const attention = requestAttention(r);
    this.deps.events.append({
      at: this.now(),
      type,
      machineId: project.machineId,
      projectId: project.projectId,
      summary: clip(`${r.requestId} ${r.state}: ${what}`, 200),
      data: {
        requestId: r.requestId,
        kind: r.kind,
        state: r.state,
        workstreamId: r.workstreamId ?? null,
        by: r.answeredBy ?? null,
      },
      ...(attention ? { attention } : {}),
    });
  }

  create(add: NewRequest): HumanRequest {
    let r: HumanRequest;
    try {
      r = this.deps.requests.create(add);
    } catch (e) {
      throw storeRefusal(e);
    }
    this.announce("request.opened", r);
    return r;
  }

  /**
   * A request kept as a record and approved as it opens, with no ask (D310: a purchase, a 1Password secure input):
   * announced once approved, so no card waits on the person and no notification asks them.
   */
  createApproved(add: NewRequest): HumanRequest {
    let r: HumanRequest;
    try {
      const opened = this.deps.requests.create(add);
      const at = this.now();
      r = this.deps.requests.updateFrom(opened.requestId, "open", (r) => {
        r.state = "approved";
        r.answeredAt = at;
        r.answeredBy = NO_ASK;
      });
    } catch (e) {
      throw storeRefusal(e);
    }
    this.announce("request.opened", r);
    return r;
  }

  /** Saves a change to a request and announces it. */
  change(id: string, f: (r: HumanRequest) => void): HumanRequest {
    let r: HumanRequest;
    try {
      r = this.deps.requests.update(id, f);
    } catch (e) {
      throw storeRefusal(e);
    }
    this.announce("request.updated", r);
    return r;
  }

  /** As `change`, only while the request is still `from`: the one write that moves it wins, any other is refused. */
  changeFrom(id: string, from: RequestState, f: (r: HumanRequest) => void): HumanRequest {
    let r: HumanRequest;
    try {
      r = this.deps.requests.updateFrom(id, from, f);
    } catch (e) {
      throw storeRefusal(e);
    }
    this.announce("request.updated", r);
    return r;
  }

  /** An approved request back to open, with why. */
  reopen(id: string, why: string): HumanRequest {
    const evidence = clip(why, EVIDENCE_MAX);
    return this.changeFrom(id, "approved", (r) => {
      r.state = "open";
      r.evidence = evidence;
      delete r.answeredAt;
      delete r.answeredBy;
      delete r.answeredByPerson;
    });
  }

  /** Records `evidence` on a request. */
  note(id: string, evidence: string): HumanRequest {
    const text = clip(evidence, EVIDENCE_MAX);
    return this.change(id, (r) => {
      r.evidence = text;
    });
  }

  /** Runs `f`, logging instead of throwing: a background step's write that may lose to another. */
  quietly<T>(f: () => T): T | undefined {
    try {
      return f();
    } catch (e) {
      if (!(e instanceof ToolError)) console.warn("approvals:", e);
      return undefined;
    }
  }

  /** `request_secret`: a secret the person enters in the project's chat. Returns the open request. */
  async requestSecret(project: ProjectRef, call: RequestSecretCall): Promise<HumanRequest> {
    const sink = parseSecretSink(call.sink);
    if (!sink) {
      throw refuse(
        "invalid",
        `${call.sink} is not a sink fleetd can write.`,
        "Use env:<machine>:<absolute path> or file:<machine>:<absolute path>.",
      );
    }
    if (sink.fill !== undefined) {
      throw refuse(
        "invalid",
        "A fill: sink is a project's secure input, which its browser session asks for.",
        "The lead calls request_secure_input on the page with the field instead.",
      );
    }
    if (call.envName !== undefined && !call.sink.startsWith("env:") && !call.sink.startsWith("order:")) {
      throw refuse("invalid", "only an env: or order: sink has an env name");
    }
    if ((await this.deps.hub.boxKey(sink.machineId)) === undefined) {
      throw refuse("not_found", `No machine ${sink.machineId}.`, "Name a machine from fleetd_status in the sink.");
    }
    let workstreamId = call.workstreamId;
    if (sink.order !== undefined) {
      await this.orderSink(project, sink.order, sink.machineId, call);
      workstreamId = sink.order;
    }
    const now = this.deps.clock.now();
    // The vault keeps it (W549): the app seals it to the hub's key, and the hub delivers it to the sink.
    const sealTo = this.deps.hooks.vaultSealTo();
    return this.create({
      projectRef: project,
      workstreamId,
      kind: "secret",
      text: call.text,
      secret: {
        key: call.key,
        sink: call.sink,
        ...(call.envName !== undefined ? { envName: call.envName } : {}),
        ...(sealTo !== undefined ? { sealTo } : {}),
      },
      at: isoMs(now),
      atMs: now,
    });
  }

  /** An `order:` sink's checks: the project's machine, an open order of the project, and a name not fleetd's own. */
  private async orderSink(project: ProjectRef, order: string, machineId: string, call: RequestSecretCall): Promise<void> {
    if (machineId !== project.machineId) {
      throw refuse(
        "invalid",
        `An order's variable goes to the machine its agents run on, ${project.machineId}, not ${machineId}.`,
        `Use order:${project.machineId}:${order}.`,
      );
    }
    if (call.workstreamId !== undefined && call.workstreamId !== order) {
      throw refuse(
        "invalid",
        `The sink names ${order} but workstreamId is another order.`,
        "Leave workstreamId out, or name the same order.",
      );
    }
    const why = await this.deps.hooks.orderRefusal(project, order);
    if (why !== undefined) throw refuse("invalid", why, "Name an open order of this project in the sink.");
    const name = call.envName ?? secretEnvName(call.key);
    if (name === undefined) throw refuse("invalid", `${call.key} names no valid variable.`, "Ask again with envName.");
    if (envNameReserved(name)) {
      throw refuse("invalid", `${name} is fleetd's or claude's own: an order can't set it.`, "Ask for it under another envName.");
    }
  }

  /** `secret_submit`: relays the sealed value to the sink's node and stores the request with the node's fingerprint. */
  async submitSecret(caller: ApprovalCaller, requestId: string, sealed: string): Promise<Record<string, unknown>> {
    if (!caller.human) throw refuse("forbidden", "Only a person enters secrets.", HUMAN_ONLY_SECRET_FIX);
    const r = this.get(requestId);
    const secret = r?.secret;
    if (!r || !secret) throw notFound(requestId);
    const sink = parseSecretSink(secret.sink);
    if (!sink) throw notFound(requestId);
    for (const m of [...new Set([sink.machineId, r.projectRef.machineId])].sort()) {
      if (!caller.allowsOperate(m)) {
        throw refuse("forbidden", `This key has no operate grant on machine ${m}.`, "Use a human key with an operate grant there.");
      }
    }
    const id = r.requestId;
    if (r.state !== "open") throw refuse("invalid", `${settled(id, r.state)}.`, "Nothing to enter: it is settled.");
    // The order may have closed since the lead asked: its variable would outlive it.
    if (sink.order !== undefined) {
      const why = await this.deps.hooks.orderRefusal(projectOf(r), sink.order);
      if (why !== undefined) {
        throw refuse("invalid", why, "Nothing to enter: tell the lead in chat if an open order still needs it.");
      }
    }
    const m = sink.machineId;
    const box = await this.deps.hub.boxKey(m);
    if (box === undefined) {
      throw refuse("not_found", `No machine ${m}.`, "Tell the lead in chat: it asks again with a sink on a known machine.");
    }
    // Sealed to the hub's key: the vault keeps it and delivers it; sealed to the node's: relayed as before.
    const kept =
      sink.fill === undefined
        ? await this.deps.hooks.vaultSecret(r, sealed, {
            name: caller.name,
            ...(caller.person ? { person: caller.person } : {}),
            machines: [...new Set([sink.machineId, r.projectRef.machineId])],
          })
        : undefined;
    if (kept !== undefined) return this.stored(caller, r, kept.fingerprint);
    if (box === null) {
      throw refuse("invalid", `${m}'s node takes no secrets: it publishes no box key.`, `Update fleetd on ${m} and restart its node.`);
    }
    const key = secret.key;
    const input: Record<string, unknown> = { sink: secret.sink, sealed, secretKey: key };
    if (secret.envName !== undefined) input.envName = secret.envName;
    if (sink.order !== undefined) input.projectId = r.projectRef.projectId;
    // A secure input's value fills its own field, of the several its browser session may wait for.
    if (sink.fill !== undefined) input.requestId = id;
    // The ciphertext is never queued: the person enters it again once the node is back.
    let delivered;
    try {
      delivered = await this.deps.nodes.deliverSecret(m, input);
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      throw refuse("machine_offline", `${m}'s node did not take the secret: ${message}.`, `Try again when ${m} is online.`);
    }
    // The node writes the sink before it answers: a fingerprint that doesn't parse still means it was saved.
    const fingerprint = delivered.fingerprint;
    if (fingerprint === undefined) {
      throw refuse(
        "invalid",
        `${m}'s node could not save it: ${delivered.error ?? "no reason given"}.`,
        "Seal it to the machine's current boxPubKey and try again, or tell the lead in chat to fix the sink.",
      );
    }
    if (sink.order !== undefined) {
      const name = secret.envName ?? secretEnvName(key) ?? "";
      const bytes = Math.max(0, (base64Bytes(sealed) ?? 0) - SEAL_OVERHEAD);
      const why = await this.deps.hooks.orderEnvSaved(
        { project: projectOf(r), orderId: sink.order, name, fingerprint, bytes, requestId: id },
        this.now(),
      );
      if (why !== undefined) throw refuse("failed", why, "Enter it again; the request is still open.");
    }
    return this.stored(caller, r, fingerprint, `Saved on ${m}; the lead hears it in its next wake.`);
  }

  /** Marks a secret request stored with the node's fingerprint and wakes its lead. */
  private async stored(caller: ApprovalCaller, r: HumanRequest, fingerprint: string, savedNext?: string): Promise<Record<string, unknown>> {
    const id = r.requestId;
    const by = `human:${caller.name}`;
    const at = this.now();
    if (!isFingerprint(fingerprint)) {
      console.warn(`approvals: ${id}: the node's fingerprint is not 8 hex characters; kept in evidence only`);
    }
    const saved = this.changeFrom(id, "open", (r) => {
      r.state = "stored";
      if (r.secret) {
        if (isFingerprint(fingerprint)) r.secret.fingerprint = fingerprint;
        else delete r.secret.fingerprint;
      }
      r.evidence = `fingerprint ${fingerprint}`;
      if (r.secureInput) r.secureInput.filledAt = at;
      r.answeredAt = at;
      r.answeredBy = by;
      if (caller.person) r.answeredByPerson = caller.person;
      else delete r.answeredByPerson;
    });
    await this.deps.hub.wakeRequest(saved);
    if (saved.secureInput) {
      return {
        requestId: id,
        fingerprint,
        next: `Filled into ${saved.secureInput.label} on ${saved.secureInput.site.domain}; the lead never sees it.`,
      };
    }
    return { requestId: id, fingerprint, next: savedNext ?? "Kept in fleetd's vault and delivered to its machine; the lead hears it in its next wake." };
  }

  /** `gated_run`: opens the approval holding exactly this command, run in the project workspace by default. */
  async gatedRun(project: ProjectRef, call: GatedRunInput): Promise<HumanRequest> {
    const root = await this.deps.hub.workspaceRoot(project);
    if (root === undefined) {
      throw refuse(
        "not_found",
        `The hub has no record of project ${project.projectId} on ${project.machineId}.`,
        "Check fleetd_status, then run it again.",
      );
    }
    // Stored resolved, so the person approves the exact directory too.
    const cwd = call.cwd ?? root;
    const why = gatedRefusal(call, cwd);
    if (why) throw refuse("invalid", `The command is not one fleetd can store: ${why}.`);
    const now = this.deps.clock.now();
    return this.create({
      projectRef: project,
      workstreamId: call.workstreamId,
      kind: "approval",
      text: clip(`Run ${shownArgv(call.argv)} on ${project.machineId} in ${cwd}: ${call.reason}`, 500),
      gated: {
        argv: call.argv,
        cwd,
        class: call.class as never,
        reason: call.reason,
        timeoutSec: call.timeoutSec,
        ...(call.secretEnv !== undefined ? { secretEnv: call.secretEnv } : {}),
      },
      at: isoMs(now),
      atMs: now,
    });
  }

  /**
   * `approval_answer`: a person approves or denies an open approval. A command runs on the project's node; a tool
   * prompt's answer goes to the waiting run.
   */
  async answer(caller: ApprovalCaller, requestId: string, approve: boolean, message?: string): Promise<HumanRequest> {
    if (!caller.human) {
      throw refuse("forbidden", "Only a person approves or denies a request.", "Answer it in the fleetd app, or with a --human key.");
    }
    const r = this.get(requestId);
    if (!r || r.kind !== "approval") throw notFound(requestId);
    const machine = r.projectRef.machineId;
    if (!caller.allowsOperate(machine)) {
      throw refuse("forbidden", `This key has no operate grant on machine ${machine}.`, "Use a human key with an operate grant there.");
    }
    if (r.state !== "open") throw refuse("invalid", `${settled(r.requestId, r.state)}.`, "Nothing to answer: it is settled.");
    const by = `human:${caller.name}`;
    const at = this.now();
    const reason = !approve && message !== undefined && message.trim() !== "" ? message : undefined;
    // Guarded on open: of two answers at once only one moves it, so a command runs at most once per approval.
    const answered = this.changeFrom(r.requestId, "open", (r) => {
      r.state = approve ? "approved" : "denied";
      // A denial reason goes to the lead with it.
      if (reason !== undefined) r.evidence = clip(reason, EVIDENCE_MAX);
      else delete r.evidence;
      r.answeredAt = at;
      r.answeredBy = by;
      if (caller.person) r.answeredByPerson = caller.person;
      else delete r.answeredByPerson;
    });
    const p = answered.permission;
    if (p) {
      // Letting an automation run on its own is the person's alone: their approval marks it here.
      if (approve && p.toolName === AUTOMATION_CONFIRM_TOOL && p.preview) {
        let shown: unknown;
        try {
          shown = JSON.parse(p.preview.input);
        } catch {
          shown = undefined;
        }
        if (shown !== undefined) await this.deps.hooks.naviAutomationConfirm(projectOf(answered), shown, by);
      }
      // A new project is the person's alone to make: their approval of the card makes it here, as theirs, before the
      // lead's call runs. Not made, the lead hears why in place of the go-ahead.
      if (approve && p.toolName === PROJECT_PROPOSE_TOOL) {
        const why = await this.makeProposed(answered, caller);
        if (why !== undefined) {
          await refusePrompt(this, answered, why);
          return this.get(requestId) ?? answered;
        }
      }
      await answerPrompt(this, answered, reason);
      return this.get(requestId) ?? answered;
    }
    // A purchase or a secure input runs nothing here: the Navi hears the answer, and its node fills it if approved.
    if (answered.purchase || answered.secureInput) {
      await this.deps.hub.wakeRequest(answered);
      return answered;
    }
    if (approve) void this.runApproved(answered).catch((e) => console.error(`approvals: ${answered.requestId} didn't run:`, e));
    else await this.deps.hub.wakeRequest(answered);
    return this.get(requestId) ?? answered;
  }

  /** Makes the project an approved `project_propose` card showed, as the person's who approved it; a string is why not. */
  private async makeProposed(r: HumanRequest, caller: ApprovalCaller): Promise<string | undefined> {
    let shown: unknown;
    try {
      shown = JSON.parse(r.permission?.preview?.input ?? "");
    } catch {
      return "its card showed nothing to create";
    }
    try {
      const by = { name: caller.name, ...(caller.person ? { person: caller.person } : {}) };
      return await this.deps.hooks.projectProposed(projectOf(r), shown, by, r.requestId);
    } catch (e) {
      return e instanceof Error ? e.message : String(e);
    }
  }

  /** `request_withdraw`: the lead takes back an open request of its own project. A secret is withdrawn; an approval denied. */
  async withdraw(project: ProjectRef, by: string, requestId: string): Promise<HumanRequest> {
    const r = this.get(requestId);
    if (!r || !sameProject(projectOf(r), project)) {
      throw refuse(
        "not_found",
        `There is no request ${requestId} in your project.`,
        "Use a requestId your own request_secret or gated_run returned.",
      );
    }
    if (r.state !== "open") throw refuse("invalid", `${settled(r.requestId, r.state)}.`, "Nothing to withdraw.");
    const at = this.now();
    const done = this.changeFrom(r.requestId, "open", (r) => {
      r.state = r.kind === "secret" ? "withdrawn" : "denied";
      r.evidence = "withdrawn by the lead";
      r.answeredAt = at;
      r.answeredBy = by;
    });
    // A waiting tool prompt hears it was refused.
    await answerPrompt(this, done, undefined);
    return done;
  }

  /** Closes every open request of a project (or of one of its orders) nobody needs any more. `why` is the evidence. */
  async closeOpen(project: ProjectRef, workstream: string | undefined, why: string): Promise<void> {
    for (const r of this.listQuiet({ projectRef: project, states: ["open"] })) {
      if (workstream !== undefined && r.workstreamId !== workstream) continue;
      const at = this.now();
      const closed = this.quietly(() =>
        this.changeFrom(r.requestId, "open", (r) => {
          r.state = r.kind === "secret" ? "withdrawn" : "denied";
          r.evidence = why;
          r.answeredAt = at;
          r.answeredBy = "hub";
        }),
      );
      // A waiting tool prompt hears it was refused.
      if (closed) await answerPrompt(this, closed, undefined);
    }
  }

  /**
   * The approved commands running on the machine, as the hub's database records them: approved and sent to its node,
   * with no result yet. Kept across a hub restart, as each one's run goes on (node/gated), so an update of the machine
   * waits for them before restarting its node, which would cut them off.
   */
  runningOn(machineId: string): number {
    return this.listQuiet({ states: ["approved"], kind: "approval" }).filter(
      (r) => r.gated !== undefined && r.projectRef.machineId === machineId && r.evidence?.startsWith(RUNNING) === true,
    ).length;
  }

  /**
   * Approved commands the hub never saw finish: one it never sent goes back to the person, never run late; one that
   * was running is asked of its node once it links again (`recover`), never silently lost.
   */
  reopenUnfinished(): void {
    for (const r of this.listQuiet({ states: ["approved"], kind: "approval" })) {
      if (!r.gated) continue;
      if (r.evidence?.startsWith(RUNNING)) {
        void this.recover(r, `the hub restarted while it ran on ${r.projectRef.machineId}`).catch((e) =>
          console.error(`approvals: ${r.requestId}'s result wasn't recovered:`, e),
        );
      } else {
        this.quietly(() => this.reopen(r.requestId, NOT_RUN_AFTER_RESTART));
      }
    }
  }

  /** Runs an approval's stored command on its project's node after a person approved it. */
  async runApproved(r: HumanRequest): Promise<void> {
    const spec = r.gated;
    if (!spec) return;
    const project = projectOf(r);
    const id = r.requestId;
    const machine = project.machineId;
    const by = r.answeredBy ?? "";
    const cwd = spec.cwd ?? (await this.deps.hub.workspaceRoot(project));
    // Marks it in flight, so after a hub restart before the result arrives it is asked of the node, never run again.
    this.quietly(() => this.note(id, `${RUNNING} ${machine}, approved by ${by}`));
    let ran: GatedOutcome;
    if (cwd === undefined) {
      ran = { outputTail: "", timedOut: false, error: "the project has no workspace on record" };
    } else {
      const input: Record<string, unknown> = { argv: spec.argv, cwd, timeoutSec: spec.timeoutSec, requestId: id };
      if (spec.secretEnv !== undefined) input.secretEnv = spec.secretEnv;
      try {
        ran = await this.runOnceLinked(machine, input);
      } catch (e) {
        const err = e instanceof NodeCommandError ? e : new NodeCommandError("failed", String(e));
        if (err.reason === "offline") {
          // Nothing ran, so the person can approve it again once the machine is back.
          const done = this.quietly(() =>
            this.reopen(
              id,
              `not run: ${machine}'s node was offline when ${by} approved it; approve it again once it is online`,
            ),
          );
          if (done) await this.deps.hub.wakeRequest(done);
          return;
        }
        // A link that dropped mid-run: the node keeps the command going and its result, for when it is back.
        await this.recover(r, err.message);
        return;
      }
    }
    const done = this.quietly(() => this.settle(r, ran));
    if (done) await this.deps.hub.wakeRequest(done);
  }

  /** Runs an approved command on `machine`'s node. Offline, nothing was sent: a node restarting (an update) gets
   * OFFLINE_WAIT_MS to link again, and past it the offline error is thrown. */
  private async runOnceLinked(machine: string, input: Record<string, unknown>): Promise<GatedOutcome> {
    const deadline = this.deps.clock.now() + OFFLINE_WAIT_MS;
    for (;;) {
      try {
        return await this.deps.nodes.runGated(machine, input);
      } catch (e) {
        if (!(e instanceof NodeCommandError && e.reason === "offline") || this.deps.clock.now() >= deadline) throw e;
        await this.sleep(RELINK_POLL_MS);
        if (!(await this.linkedBy(machine, deadline))) throw e;
      }
    }
  }

  /** Whether `machine`'s node is linked, or links again before `deadline`, looking every RELINK_POLL_MS. A hub
   * shutting down stops looking. */
  private async linkedBy(machine: string, deadline: number): Promise<boolean> {
    for (;;) {
      if (await this.deps.nodes.isLinked(machine)) return true;
      if (this.deps.clock.now() >= deadline || this.deps.signal?.aborted) return false;
      await this.sleep(RELINK_POLL_MS);
    }
  }

  /**
   * The approved command `r` was running when its result was lost. Once its node is linked again it is asked for
   * that result, which settles it as if it had come in time. Only when the node has none either, or isn't back within
   * RELINK_WAIT, does it go back to the person, saying it may have run.
   */
  async recover(r: HumanRequest, lost: string): Promise<void> {
    const id = r.requestId;
    const machine = r.projectRef.machineId;
    const timeoutSec = r.gated?.timeoutSec ?? 0;
    const deadline = this.deps.clock.now() + RELINK_WAIT_MS;
    let why: string;
    for (;;) {
      if (this.deps.signal?.aborted) return;
      if (!(await this.linkedBy(machine, deadline))) {
        if (this.deps.signal?.aborted) return;
        why = `${lost}, and ${machine}'s node has not linked again since`;
        break;
      }
      try {
        const o = await this.deps.nodes.resumeGated(machine, id, timeoutSec);
        if (o.unknown !== undefined) {
          why = `${lost}, and ${o.unknown}`;
          break;
        }
        const done = this.quietly(() => this.settle(r, o));
        if (done) await this.deps.hub.wakeRequest(done);
        return;
      } catch (e) {
        const err = e instanceof NodeCommandError ? e : new NodeCommandError("failed", String(e));
        // Dropped again while the node answered: it still keeps the result.
        if ((err.reason === "lost" || err.reason === "offline") && this.deps.clock.now() < deadline) {
          await this.sleep(RELINK_POLL_MS);
          continue;
        }
        why = `${lost}, and ${err.message}`;
        break;
      }
    }
    const done = this.quietly(() => this.reopen(id, mayHaveRun(why, machine)));
    if (done) await this.deps.hub.wakeRequest(done);
  }

  /** Records the node's answer for the approved command `r`: it ran (its exit code and output) or it didn't (why). */
  settle(r: HumanRequest, o: GatedOutcome): HumanRequest {
    const id = r.requestId;
    const machine = r.projectRef.machineId;
    const by = r.answeredBy ?? "";
    const timeoutSec = r.gated?.timeoutSec ?? 0;
    const at = this.now();
    if (o.error !== undefined) {
      const why = clip(`not run on ${machine}: ${o.error}`, EVIDENCE_MAX);
      return this.changeFrom(id, "approved", (r) => {
        r.state = "failed";
        r.finishedAt = at;
        r.evidence = why;
      });
    }
    const code = o.exitCode === undefined ? "none (ended by a signal)" : String(o.exitCode);
    const head = o.timedOut
      ? `killed after ${timeoutSec} s on ${machine}, approved by ${by}`
      : `exit ${code} on ${machine}, approved by ${by}`;
    const tail = clip(o.outputTail.trimEnd(), EVIDENCE_MAX);
    return this.changeFrom(id, "approved", (r) => {
      r.state = "ran";
      r.finishedAt = at;
      r.evidence = head;
      if (o.exitCode !== undefined) r.exitCode = o.exitCode;
      else delete r.exitCode;
      r.outputTail = tail;
    });
  }

  /** Follows `project.removed`: a removed project's open requests are closed. */
  async followRemovals(): Promise<void> {
    let cursor = this.deps.events.head();
    while (!this.deps.signal?.aborted) {
      const page = await this.deps.events.wait({ cursor, types: ["project.removed"], timeoutSec: 3600 }, this.deps.signal);
      cursor = page.cursor;
      for (const event of page.events) {
        if (event.machineId === undefined || event.projectId === undefined) continue;
        // One event's failure is logged, never the follower's end.
        try {
          await this.closeOpen({ machineId: event.machineId, projectId: event.projectId }, undefined, "the project was removed");
        } catch (e) {
          console.error(`approvals: a removed project's requests weren't closed (${event.seq}):`, e);
        }
      }
    }
  }
}

/** The hub's approvals, `hub.area("approvals")`: `approvals(hub).requestSecret(…)`. */
export const approvals = (hub: Hub) => hub.area("approvals", (h) => new Approvals(hubDeps(h)));

import { hubDeps } from "./wire.ts";

/**
 * Every open request, newest first, at most `limit` (leads/wiring.rs `open_requests`); of one project when `project`
 * is given. What the orders board counts per workstream (D352).
 */
export function openRequests(hub: Hub, limit: number, project?: ProjectRef): HumanRequest[] {
  return new Requests(hub.db).list({ ...(project ? { projectRef: project } : {}), states: ["open"], limit });
}
