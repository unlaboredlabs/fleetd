// Test kit for this area: the real store, event log and auth on an in-memory database, with fake
// executors and node link (W2/W3) that record calls.
import type {
  ActionItem,
  DecisionKey,
  ProjectId,
  Grant,
  KeyKind,
  HubEvent,
  Machine,
  MachineId,
  ProjectSummary,
  Task,
  ThreadId,
  ThreadSummary,
  ThreadTailOutput,
} from "@fleetd/contracts";
import crypto from "node:crypto";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Auth from "../auth/Auth.ts";
import { Doctor, DoctorRefused } from "../doctor/Doctor.ts";
import * as EventLog from "../store/EventLog.ts";
import * as HubDb from "../store/HubDb.ts";
import * as HubStore from "../store/HubStore.ts";
import * as Executors from "../executor/Executors.ts";
import * as NodeLinkServer from "../link/NodeLinkServer.ts";
import * as SecretBox from "../webhooks/SecretBox.ts";
import * as Webhooks from "../webhooks/Webhooks.ts";
import * as WriteQueue from "../queue/WriteQueue.ts";
import * as Wakes from "../wakes/Wakes.ts";
import * as HumanDigests from "../digests/HumanDigests.ts";
import * as Intake from "../intake/Intake.ts";
import { IntakeRouter } from "../intake/Router.ts";
import * as LeadsLayer from "../leads/layer.ts";
import { type AskInput, Asks } from "../ledger/Asks.ts";
import { ThreadWorkspace } from "../executor/ThreadWorkspace.ts";
import * as Leases from "../leases/Leases.ts";
import * as Policy from "../leases/Policy.ts";
import * as Slots from "../slots/Slots.ts";
import * as TaskRecords from "../tasks/TaskRecords.ts";
import * as Tasks from "../tasks/Tasks.ts";
import { UsageSource } from "../usage/UsageSource.ts";
import * as Detectors from "../incidents/Detectors.ts";
import * as Incidents from "../incidents/Incidents.ts";
import { RetroRunner } from "../retro/Retro.ts";
import * as RetroLayer from "../retro/Retro.ts";
import * as RetroRecords from "../retro/RetroRecords.ts";
import * as Receipts from "../receipts/Receipts.ts";
import * as JudgeHook from "../valuebar/JudgeHook.ts";
import * as PrHeads from "../valuebar/PrHeads.ts";
import * as ValueBar from "../valuebar/ValueBar.ts";
import * as Approvals from "../approvals/Approvals.ts";
import * as GitHub from "../checks/GitHub.ts";
import * as FinishAll from "../playbooks/FinishAll.ts";
import * as ProjectRemovals from "../leads/ProjectRemovals.ts";
import * as Push from "../push/Push.ts";
import { generateVapidKeys, type PushRequest } from "../push/webPush.ts";
import { NodeCommands, type GatedOutcome, type SecretOutcome, unlinked } from "../checks/NodeCommands.ts";
import * as ReviewGate from "../train/ReviewGate.ts";
import * as ChangeRecords from "../train/ChangeRecords.ts";
import * as Train from "../train/Train.ts";
import * as TrainGitHub from "../train/TrainGitHub.ts";

export const AT = "2026-10-17T10:00:00.000Z";

export const machine = (id: string, status: Machine["status"] = "online", lastSeenAt = AT): Machine => ({
  machineId: id as MachineId,
  name: id,
  tags: [],
  status,
  lastSeenAt,
  t3: { version: "2fbd4318fc", protocol: 2 },
  nodeVersion: "0.0.0",
});

export const project = (machineId: string, projectId: string, lastActivityAt = AT): ProjectSummary =>
  ({
    machineId,
    projectId,
    title: projectId,
    workspaceRoot: `/w/${projectId}`,
    threads: { running: 0, waiting: 0, idle: 0, failed: 0 },
    lastActivityAt,
  }) as ProjectSummary;

export const thread = (machineId: string, projectId: string, threadId: string, over: Partial<ThreadSummary> = {}): ThreadSummary =>
  ({
    machineId,
    projectId,
    threadId,
    title: threadId,
    status: "completed",
    headline: "OK",
    latestMessageTail: "OK",
    lastProgressAt: AT,
    stale: false,
    asOf: AT,
    ...over,
  }) as ThreadSummary;

export const makeTestHub = () => {
  const connected = new Set<string>();
  const calls: Array<{ op: string; args: unknown }> = [];
  let tail: typeof ThreadTailOutput.Type | undefined;
  let actions: ReadonlyArray<ActionItem> = [];
  let waitCalls = 0;
  const waitWatchers: Array<{ count: number; resolve: () => void }> = [];
  const liveWaiters: Array<{ id: string; resolve: () => void }> = [];

  const executors = Executors.Executors.of({
    attach: () => Effect.void,
    detach: () => Effect.void,
    isConnected: (id) => Effect.sync(() => connected.has(id)),
    awaitLive: (id) =>
      connected.has(id) ? Effect.void : Effect.callback<void>((resume) => void liveWaiters.push({ id, resolve: () => resume(Effect.void) })),
    launch: (machineId, input) =>
      Effect.sync(() => {
        calls.push({ op: "launch", args: { machineId, input } });
        return { threadId: "t-new" as ThreadId };
      }),
    send: (ref, message, clientRequestId) =>
      Effect.sync(() => {
        calls.push({ op: "send", args: { ref, message, clientRequestId } });
        return { queued: false, runId: "r1" };
      }),
    interrupt: (ref, clientRequestId) => Effect.sync(() => void calls.push({ op: "interrupt", args: { ref, clientRequestId } })),
    tail: (ref) =>
      tail === undefined ? Effect.fail(new Executors.ThreadNotFound({ machineId: ref.machineId, threadId: ref.threadId })) : Effect.succeed(tail),
    actions: () => Effect.succeed(actions),
  });

  /** The real event log, counting `wait` calls so a test can act once a long-poll is in flight. */
  const layerWatchedEvents = Layer.effect(
    EventLog.EventLog,
    Effect.gen(function* () {
      const real = yield* EventLog.EventLog;
      return EventLog.EventLog.of({
        ...real,
        wait: (input) =>
          Effect.suspend(() => {
            waitCalls += 1;
            for (const w of waitWatchers.filter((w) => waitCalls >= w.count)) w.resolve();
            return real.wait(input);
          }),
      });
    }),
  ).pipe(Layer.provide(EventLog.layer));

  const posts: Array<Webhooks.WebhookRequest> = [];
  const postWatchers: Array<{ count: number; resolve: () => void }> = [];
  const layerWebhooks = Layer.effect(
    Webhooks.Webhooks,
    Webhooks.make({
      box: SecretBox.fromKey(crypto.randomBytes(32)),
      post: (request) =>
        Effect.sync(() => {
          posts.push(request);
          for (const w of postWatchers.filter((w) => posts.length >= w.count)) w.resolve();
          return 200;
        }),
    }),
  );

  // No policy file anywhere (one area "all"); worktrees start from main.
  const layerTasks = Tasks.layer.pipe(
    Layer.provideMerge(Layer.mergeAll(Slots.layer(), Leases.layer, Policy.layer, ValueBar.layer, Receipts.layer)),
    Layer.provideMerge(Layer.mergeAll(Incidents.layer, PrHeads.layerGh, JudgeHook.layerNoop)),
    Layer.provide(
      Layer.mergeAll(
        Layer.succeed(Policy.PolicySource, Policy.PolicySource.of({ read: () => Effect.succeed(undefined) })),
        // No node answers: tasks fall back to T3's checkpoint paths for their area check.
        Layer.succeed(
          NodeCommands,
          NodeCommands.of({ run: () => Effect.succeed({ exitCode: 1, outputTail: "", timedOut: false }), deliverSecret: unlinked, runGated: unlinked, attach: () => Effect.void, resolve: () => Effect.void }),
        ),
        Layer.succeed(
          ThreadWorkspace,
          ThreadWorkspace.of({
            defaultBranch: () => Effect.succeed("main"),
            changes: () => Effect.succeed({ paths: [], pullRequestUrls: [] }),
            pendingQuestion: () => Effect.succeed(undefined),
          }),
        ),
      ),
    ),
  );

  // No model in unit tests: the router never places an intent, so unrouted intake files the routing ask.
  const layerIntake = Intake.layer.pipe(
    Layer.provide(Layer.succeed(IntakeRouter, IntakeRouter.of({ route: () => Effect.succeed({ why: "no router in tests", runs: [] }) }))),
  );

  // The merge train over the kit's records, never stepped on its own; GitHub and the nodes know of no PR.
  const layerTrain = Train.layer({ autoRun: false }).pipe(
    Layer.provide(
      Layer.mergeAll(
        ReviewGate.layerTierS,
        TrainGitHub.layer(() => Effect.succeed({ exitCode: 1, stdout: "", stderr: "gh: Not Found (HTTP 404)" })),
        Layer.succeed(
          NodeCommands,
          NodeCommands.of({ run: () => Effect.succeed({ exitCode: 1, outputTail: "", timedOut: false }), deliverSecret: unlinked, runGated: unlinked, attach: () => Effect.void, resolve: () => Effect.void }),
        ),
      ),
    ),
  );

  // The nodes' side of secrets and approved commands: every frame is recorded, and the reply is the test's to set.
  const nodeFrames: Array<{ readonly machineId: MachineId; readonly t: "secret_deliver" | "gated_run"; readonly input: unknown }> = [];
  let secretReply: (machineId: MachineId) => SecretOutcome | "offline" = () => ({ fingerprint: "ab12cd34" });
  let gatedReply: (machineId: MachineId) => GatedOutcome | "offline" = () => ({ exitCode: 0, outputTail: "", timedOut: false });
  const answered = <A>(machineId: MachineId, reply: A | "offline") => (reply === "offline" ? unlinked(machineId) : Effect.succeed(reply));
  const layerApprovals = Approvals.layer.pipe(
    Layer.provide(
      Layer.succeed(
        NodeCommands,
        NodeCommands.of({
          run: () => Effect.succeed({ exitCode: 1, outputTail: "", timedOut: false }),
          deliverSecret: (machineId, input) => Effect.suspend(() => (nodeFrames.push({ machineId, t: "secret_deliver", input }), answered(machineId, secretReply(machineId)))),
          runGated: (machineId, input) => Effect.suspend(() => (nodeFrames.push({ machineId, t: "gated_run", input }), answered(machineId, gatedReply(machineId)))),
          attach: () => Effect.void,
          resolve: () => Effect.void,
        }),
      ),
    ),
  );

  // Web Push to the push services: every request is recorded and answered with `pushStatus`.
  const pushes: Array<PushRequest> = [];
  let pushStatus = 201;
  const layerPush = Layer.effect(
    Push.Push,
    Push.make({ keys: generateVapidKeys(), post: (request) => Effect.sync(() => (pushes.push(request), pushStatus)) }),
  );

  // Finish-all's inventory sees a checkout without a GitHub origin and no TODO markers.
  const layerFinishAll = FinishAll.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        GitHub.layer(() => Effect.succeed({ exitCode: 1, stdout: "", stderr: "gh: Not Found (HTTP 404)" })),
        Layer.succeed(
          NodeCommands,
          NodeCommands.of({ run: () => Effect.succeed({ exitCode: 1, outputTail: "", timedOut: false }), deliverSecret: unlinked, runGated: unlinked, attach: () => Effect.void, resolve: () => Effect.void }),
        ),
      ),
    ),
  );

  // The doctor's results are fixed: lab-a has an automatic fix (recorded in doctorFixes), lab-b a manual one.
  const doctorFixes: Array<string> = [];
  const doctorChecks = [
    { id: "hub/gh_auth", scope: "hub", status: "ok", message: "gh is logged in on the hub." },
    { id: "lab-a/online", scope: "machine", machineId: "lab-a" as MachineId, status: "fail", message: "lab-a is degraded: T3 is down.", fix: { kind: "auto", label: "Restart T3 on lab-a" } },
    { id: "lab-b/disk", scope: "machine", machineId: "lab-b" as MachineId, status: "fail", message: "1.0 GB free.", fix: { kind: "manual", label: "Free disk space", command: "df -h /home/lab" } },
  ] as const;
  const layerDoctor = Layer.succeed(
    Doctor,
    Doctor.of({
      list: () => Effect.succeed({ checks: doctorChecks, checkedAt: AT }),
      fix: (checkId) =>
        checkId === "lab-a/online"
          ? Effect.sync(() => (doctorFixes.push(checkId), { ran: "restarted T3", check: { ...doctorChecks[1], status: "ok" as const, message: "lab-a is online." } }))
          : Effect.fail(new DoctorRefused({ code: "invalid", message: `${checkId} needs a person.`, fix: "df -h /home/lab" })),
      runIfDue: Effect.void,
    }),
  );

  // No model in unit tests: a retro run that gets this far records a failed turn.
  const layerRetro = Layer.merge(RetroLayer.layer, Detectors.layer).pipe(
    Layer.provide(
      Layer.merge(
        RetroRecords.layer,
        Layer.succeed(RetroRunner, RetroRunner.of({ ask: () => Effect.succeed({ run: { kind: "orchestrator", model: "none", durationMs: 0, ok: false, error: "no model in tests" } }) })),
      ),
    ),
  );

  const layer = Layer.mergeAll(layerWebhooks, Wakes.layer, HumanDigests.layer, layerIntake, layerTrain, layerApprovals, layerFinishAll, ProjectRemovals.layer, layerPush, layerRetro).pipe(
    Layer.provideMerge(layerTasks),
    Layer.provideMerge(LeadsLayer.layerWithLedger({ prompt: "You lead {{project}}." })),
    Layer.provideMerge(WriteQueue.layer()),
    Layer.provideMerge(
      Layer.mergeAll(
        HubStore.layer,
        layerWatchedEvents,
        Auth.layer,
        Layer.succeed(Executors.Executors, executors),
        // A lab-style machine: a subscription login, its T3 on another host, so no trace file is read.
        Layer.succeed(UsageSource, UsageSource.of({ read: () => Effect.succeed({ login: "subscription", local: false }) })),
        Layer.succeed(NodeLinkServer.NodeLinkServer, NodeLinkServer.NodeLinkServer.of({ handle: () => Effect.void })),
        layerDoctor,
      ),
    ),
    Layer.provideMerge(HubDb.layerMemory),
  );

  type Seeded = HubStore.HubStore | EventLog.EventLog | Auth.Auth | Asks | TaskRecords.TaskRecords | ChangeRecords.ChangeRecords | Incidents.Incidents;
  /** Set once the hub's layer is built, so seeding runs against the same database the server reads. */
  let context: Context.Context<Seeded> | undefined;
  const run = <A>(effect: Effect.Effect<A, unknown, Seeded>) => {
    if (context === undefined) throw new Error("start the hub first");
    return Effect.runPromise(Effect.provideContext(effect, context));
  };

  return {
    layer,
    bind: (built: Context.Context<Seeded>) => void (context = built),
    connected,
    /** Marks the machine connected and wakes whatever waits for it. */
    goLive: (id: string) => {
      connected.add(id);
      for (const w of liveWaiters.filter((w) => w.id === id)) {
        liveWaiters.splice(liveWaiters.indexOf(w), 1);
        w.resolve();
      }
    },
    calls,
    /** Web Push requests the hub sent. */
    pushes,
    setPushStatus: (status: number) => void (pushStatus = status),
    /** secret_deliver and gated_run requests the hub sent to nodes. */
    nodeFrames,
    setSecretReply: (reply: typeof secretReply) => void (secretReply = reply),
    setGatedReply: (reply: typeof gatedReply) => void (gatedReply = reply),
    /** Webhook POSTs the hub made; every one is answered 200. */
    posts,
    /** Resolves once the hub has made `count` webhook POSTs in total. */
    posted: (count: number) => new Promise<void>((resolve) => (posts.length >= count ? resolve() : postWatchers.push({ count, resolve }))),
    setTail: (value: typeof ThreadTailOutput.Type) => void (tail = value),
    setActions: (value: ReadonlyArray<ActionItem>) => void (actions = value),
    /** Resolves once the event log has been waited on `count` times in total. */
    waitCalls: (count: number) => new Promise<void>((resolve) => (waitCalls >= count ? resolve() : waitWatchers.push({ count, resolve }))),
    addMachine: (m: Machine) => run(Effect.flatMap(HubStore.HubStore, (s) => s.machines.upsert(m))),
    addProjects: (machineId: string, projects: ReadonlyArray<ProjectSummary>) =>
      run(Effect.flatMap(HubStore.HubStore, (s) => s.projects.upsertMany(machineId as MachineId, projects))),
    addThread: (t: ThreadSummary & { readonly lastSequence?: number }) => run(Effect.flatMap(HubStore.HubStore, (s) => s.threads.upsert(t))),
    addKey: (name: string, grants: ReadonlyArray<Grant>, kind?: KeyKind) =>
      run(Effect.flatMap(Auth.Auth, (a) => a.createKey(name, grants, kind))).then(({ key, info }) => ({ key, keyId: info.keyId })),
    /** A pairing link's token, as `fleetd hub device add` prints it. */
    pairToken: (name: string) => run(Effect.flatMap(Auth.Auth, (a) => a.createPairToken(name))).then((t) => t.token),
    listKeys: () => run(Effect.flatMap(Auth.Auth, (a) => a.list())),
    revoke: (keyId: string) => run(Effect.flatMap(Auth.Auth, (a) => a.revoke(keyId))),
    append: (event: Omit<HubEvent, "seq">) => run(Effect.flatMap(EventLog.EventLog, (e) => e.append(event))),
    /** An incident as a detector would record it. */
    addIncident: (input: Incidents.IncidentInput) => run(Effect.flatMap(Incidents.Incidents, (i) => i.record(input))),
    /** A task record as Tasks would store it, without running anything. */
    addTask: (task: Omit<Task, "taskId">) => run(Effect.flatMap(TaskRecords.TaskRecords, (r) => r.create(task))),
    /** A repo's merge train for a project, as its first enqueue makes it. */
    addTrain: (repo: string, machineId: string, projectId: string) =>
      run(
        Effect.flatMap(ChangeRecords.ChangeRecords, (r) =>
          r.ensureTrain(repo, { machineId: machineId as MachineId, projectId: projectId as ProjectId }, Date.parse(AT)),
        ),
      ),
    /** Any ask, as its lead would file it. */
    createAsk: (input: AskInput) =>
      run(Effect.flatMap(Asks, (asks) => asks.create(input, `lead:${input.projectRef?.machineId}/${input.projectRef?.projectId}`))),
    /** `fleetd ask` from the lead of a project: a product decide with a recommendation. */
    fileAsk: (machineId: string, projectId: string, key: string, recommendation: string) =>
      run(
        Effect.flatMap(Asks, (asks) =>
          asks.create(
            {
              projectRef: { machineId: machineId as MachineId, projectId: projectId as ProjectId },
              kind: "decide",
              key: key as DecisionKey,
              class: "product",
              text: `${key}?`,
              recommendation,
              blocks: "nothing",
              proceededOnRec: true,
            },
            `lead:${machineId}/${projectId}`,
          ),
        ),
      ),
    /** Check ids doctor_fix ran a fix for. */
    doctorFixes,
  };
};
