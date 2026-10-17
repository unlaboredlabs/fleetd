// The doctor (M11): every setup check, live. Runs on demand (doctor_list with rerun) and from the sweep every 15
// min; emits one doctor.changed per machine (and one for the hub) whose checks changed status since the last run.
// doctor_fix runs only the three safe automatic fixes and refuses the rest with the command a person runs.
import type { DoctorCheck, Machine, MachineId, McpToolError, UsageStatus } from "@fleetd/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Semaphore from "effect/Semaphore";
import { ghRunner, type GhRunner } from "../checks/GitHub.ts";
import { NodeActions } from "../checks/NodeCommands.ts";
import { Executors } from "../executor/Executors.ts";
import { FLEETD_INSTANCE } from "../executor/ProviderList.ts";
import * as EventLog from "../store/EventLog.ts";
import * as HubDb from "../store/HubDb.ts";
import * as HubStore from "../store/HubStore.ts";
import { Sweep } from "../sweep/Sweep.ts";
import * as Usage from "../usage/Usage.ts";
import { UsageSource } from "../usage/UsageSource.ts";
import * as Checks from "./checks.ts";
import { type HubConfig, readHubConfig } from "./config.ts";
import { T3Settings } from "./T3Settings.ts";

export const DOCTOR_EVERY_MS = 15 * 60_000;
/** How long a fix waits for the machine's T3 connection to come back before checking again. */
const RECONNECT_WAIT = Duration.seconds(20);

export class DoctorRefused extends Data.TaggedError("DoctorRefused")<McpToolError> {}

export interface DoctorResults {
  readonly checks: ReadonlyArray<DoctorCheck>;
  readonly checkedAt: string;
}

export class Doctor extends Context.Service<
  Doctor,
  {
    /** The latest results; runs every check first when `rerun` is set or nothing has run yet. */
    readonly list: (options?: { readonly rerun?: boolean }) => Effect.Effect<DoctorResults>;
    /** Runs a check's automatic fix, then that check's group again. */
    readonly fix: (checkId: string) => Effect.Effect<{ readonly ran: string; readonly check: DoctorCheck }, DoctorRefused>;
    /** The sweep's hook: runs every check when the last run is 15 min old. */
    readonly runIfDue: Effect.Effect<void>;
  }
>()("fleetd/doctor/Doctor") {}

/** Everything the checks read and the fixes act through; the layer wires the hub's services, tests pass fakes. */
export interface DoctorDeps {
  /** Where the hub listens, for its own reachability check. */
  readonly listen: { readonly host: string; readonly port: number };
  readonly config: () => { readonly config: HubConfig; readonly problem?: string };
  readonly machines: () => Effect.Effect<ReadonlyArray<Machine>>;
  readonly connected: (machineId: MachineId) => Effect.Effect<boolean>;
  readonly awaitLive: (machineId: MachineId) => Effect.Effect<void>;
  readonly settings: T3Settings["Service"];
  readonly usage: (machineId: MachineId) => Effect.Effect<UsageStatus>;
  readonly actions: NodeActions["Service"];
  readonly gh: GhRunner;
  /** Push subscriptions the hub keeps; undefined when it keeps none at all (no push store). */
  readonly pushDevices: Effect.Effect<number | undefined>;
  /** GET `url`/healthz with a short timeout. */
  readonly health: (url: string) => Effect.Effect<Checks.Probe>;
  readonly append: EventLog.EventLog["Service"]["append"];
}

const describe = (error: unknown) =>
  typeof error === "object" && error !== null && "message" in error && typeof error.message === "string" ? error.message : String(error);

/** A loopback URL for a listen address: a wildcard host is reached on loopback. */
export const selfUrl = (listen: DoctorDeps["listen"]) => {
  const host = listen.host === "0.0.0.0" || listen.host === "" ? "127.0.0.1" : listen.host === "::" ? "::1" : listen.host;
  return `http://${host.includes(":") ? `[${host}]` : host}:${listen.port}`;
};

const machineOf = (checkId: string) => {
  const scope = checkId.slice(0, checkId.indexOf("/"));
  return scope === "hub" ? undefined : (scope as MachineId);
};

export const make = (deps: DoctorDeps) =>
  Effect.sync(() => {
    const lock = Semaphore.makeUnsafe(1);
    /** Latest entry per check id, hub checks first, then machines in id order. */
    let latest: ReadonlyArray<Checks.Entry> = [];
    let checkedAt: string | undefined;
    let lastRunMs: number | undefined;
    const nowIso = Effect.map(Clock.currentTimeMillis, (ms) => new Date(ms).toISOString());

    const hubChecks = Effect.gen(function* () {
      const config = deps.config();
      const self = `${selfUrl(deps.listen)}/healthz`;
      const publicUrl = config.config.publicUrl;
      const [reachable, gh, devices, https] = yield* Effect.all(
        [
          deps.health(selfUrl(deps.listen)),
          deps.gh(["auth", "status"]).pipe(Effect.catch((error) => Effect.succeed(error))),
          deps.pushDevices,
          publicUrl?.startsWith("https://") && config.problem === undefined ? deps.health(publicUrl.replace(/\/+$/u, "")) : Effect.succeed(undefined),
        ],
        { concurrency: "unbounded" },
      );
      return [
        Checks.hubReachable(self, reachable),
        Checks.ghAuth(gh),
        Checks.pushConfigured(devices, publicUrl),
        Checks.httpsReachable(config, deps.listen.port, https),
      ];
    });

    const machineChecks = (machine: Machine) =>
      Effect.gen(function* () {
        const id = machine.machineId;
        const connected = yield* deps.connected(id);
        const t3Reason =
          machine.status === "offline"
            ? `${id} is offline.`
            : machine.status === "degraded"
              ? `T3 on ${id} is down.`
              : `The hub has no T3 connection to ${id}.`;
        const [settings, usage, probe] = yield* Effect.all(
          [
            connected && machine.status === "online"
              ? deps.settings.read(id).pipe(Effect.catch((error) => Effect.succeed({ unreadable: `Could not read T3's settings on ${id}: ${describe(error)}` })))
              : Effect.succeed({ unreadable: t3Reason }),
            deps.usage(id),
            machine.status === "offline"
              ? Effect.succeed({ unreadable: `${id} is offline.` })
              : deps.actions.run(id, "probe").pipe(
                  Effect.map((outcome) => outcome.probe ?? { unreadable: `${id}'s node did not probe: ${outcome.message}` }),
                  Effect.catch((error) => Effect.succeed({ unreadable: error.message })),
                ),
          ],
          { concurrency: "unbounded" },
        );
        return [
          Checks.machineOnline(machine, connected),
          Checks.t3Version(machine),
          ...Checks.instanceChecks(id, settings),
          Checks.probeCounter(id, usage.probes),
          Checks.commitIdentity(id, probe, deps.config().config),
          Checks.diskSpace(id, probe),
          Checks.usageBreaker(id, usage.breaker),
        ];
      });

    /** Changed statuses per machine ("hub" for hub checks); new checks count only after the first run. */
    const emitChanges = (before: ReadonlyMap<string, Checks.Entry>, after: ReadonlyArray<Checks.Entry>, baseline: boolean) =>
      Effect.gen(function* () {
        const groups = new Map<string, Array<{ readonly id: string; readonly from?: string; readonly to: string }>>();
        for (const { check } of after) {
          const from = before.get(check.id)?.check.status;
          if (from === check.status || (from === undefined && (baseline || check.status === "ok"))) continue;
          const key = check.machineId ?? "hub";
          groups.set(key, [...(groups.get(key) ?? []), { id: check.id, ...(from === undefined ? {} : { from }), to: check.status }]);
        }
        const at = yield* nowIso;
        for (const [key, changes] of groups) {
          const text = changes.map((c) => `${c.id} ${c.from ?? "new"} → ${c.to}`).join(", ");
          const summary = `doctor: ${text}`;
          yield* deps.append({
            at,
            type: "doctor.changed",
            ...(key === "hub" ? {} : { machineId: key as MachineId }),
            summary: summary.length > 200 ? `${summary.slice(0, 199)}…` : summary,
            data: { changes: changes.slice(0, 20) },
          });
        }
      });

    /** Replaces the entries of the groups just run (all of them when `machineIds` is absent) and emits changes. */
    const record = (fresh: ReadonlyArray<Checks.Entry>, scope: { readonly hub: boolean; readonly machineIds?: ReadonlyArray<MachineId> }) =>
      Effect.gen(function* () {
        const before = new Map(latest.map((e) => [e.check.id, e]));
        const replaced = (e: Checks.Entry) =>
          scope.machineIds === undefined || (e.check.scope === "hub" ? scope.hub : scope.machineIds.includes(e.check.machineId!));
        const kept = latest.filter((e) => !replaced(e));
        const merged = [...kept, ...fresh];
        latest = [
          ...merged.filter((e) => e.check.scope === "hub"),
          ...merged.filter((e) => e.check.scope === "machine").toSorted((a, b) => a.check.machineId!.localeCompare(b.check.machineId!)),
        ];
        yield* emitChanges(before, fresh, checkedAt === undefined);
        checkedAt = yield* nowIso;
      });

    const runAll = Effect.gen(function* () {
      const machines = yield* deps.machines();
      const [hub, perMachine] = yield* Effect.all([hubChecks, Effect.forEach(machines, machineChecks, { concurrency: 8 })], { concurrency: 2 });
      yield* record([...hub, ...perMachine.flat()], { hub: true });
      lastRunMs = yield* Clock.currentTimeMillis;
    }).pipe(lock.withPermit);

    const results = Effect.sync((): DoctorResults => ({ checks: latest.map((e) => e.check), checkedAt: checkedAt ?? new Date(0).toISOString() }));

    const list: Doctor["Service"]["list"] = (options) =>
      Effect.andThen(options?.rerun === true || checkedAt === undefined ? runAll : Effect.void, results);

    const runIfDue = Effect.gen(function* () {
      const now = yield* Clock.currentTimeMillis;
      if (lastRunMs === undefined || now - lastRunMs >= DOCTOR_EVERY_MS) yield* runAll;
    });

    const refused = (message: string, fix?: string) =>
      new DoctorRefused({ code: "invalid", message, ...(fix === undefined ? {} : { fix }) });

    /** Re-applies the fleetd instance (launch args with every required deny) and turns auto-resume off. */
    const reapply = (machineId: MachineId) =>
      Effect.gen(function* () {
        const settings = yield* deps.settings.read(machineId);
        const instance = Checks.reapplicable(settings);
        const config = instance === undefined ? {} : (instance.config as Record<string, unknown>);
        yield* deps.settings.update(machineId, {
          patch: { autoResumeLimitedThreads: false },
          ...(instance === undefined
            ? {}
            : {
                providerInstanceMutation: {
                  operation: "upsert" as const,
                  instanceId: FLEETD_INSTANCE as never,
                  instance: { ...instance, config: { ...config, launchArgs: Checks.withRequiredArgs(String(config.launchArgs ?? "")) } },
                },
              }),
        });
        return instance === undefined
          ? `turned off auto-resume of usage-limited threads on ${machineId}`
          : `re-applied the fleetd instance config on ${machineId} (launch args and auto-resume off)`;
      });

    const runAction = (machineId: MachineId, action: Checks.AutoAction) =>
      Effect.gen(function* () {
        if (action === "reapply_instance") return yield* reapply(machineId).pipe(Effect.mapError((error) => refused(`Re-applying the config on ${machineId} failed: ${describe(error)}`)));
        const outcome = yield* deps.actions.run(machineId, action).pipe(Effect.mapError((error) => refused(error.message)));
        if (!outcome.ok) return yield* refused(`${machineId}'s node could not do it: ${outcome.message}`);
        // The node sends the new session or reports T3 up; wait briefly for the hub's T3 connection before re-checking.
        yield* deps.awaitLive(machineId).pipe(Effect.timeoutOption(RECONNECT_WAIT));
        return `${machineId}'s node ${outcome.message}`;
      });

    const fix: Doctor["Service"]["fix"] = (checkId) =>
      Effect.gen(function* () {
        const machineId = machineOf(checkId);
        const machines = yield* deps.machines();
        const machine = machines.find((m) => m.machineId === machineId);
        if (machineId !== undefined && machine === undefined) return yield* refused(`No machine ${machineId}.`, "Call doctor_list for the current checks.");
        // The check as it stands now, so the fix matches the current state, not the last sweep's.
        const before = machine === undefined ? yield* hubChecks : yield* machineChecks(machine);
        const entry = before.find((e) => e.check.id === checkId);
        if (entry === undefined) return yield* refused(`No doctor check ${checkId}.`, "Call doctor_list for the current checks.");
        if (entry.check.fix === undefined || entry.action === undefined) {
          const f = entry.check.fix;
          return yield* refused(
            entry.check.fix === undefined ? `${checkId} has nothing to fix (${entry.check.status}).` : `${checkId} needs a person: ${f!.label}.`,
            f?.command,
          );
        }
        const ran = yield* runAction(machineId!, entry.action);
        const after = yield* machineChecks((yield* deps.machines()).find((m) => m.machineId === machineId) ?? machine!);
        yield* record(after, { hub: false, machineIds: [machineId!] });
        return { ran, check: after.find((e) => e.check.id === checkId)!.check };
      }).pipe(lock.withPermit);

    return Doctor.of({ list, fix, runIfDue });
  });

/** GET `<url>/healthz`: a refused connection, a timeout and a non-2xx answer all fail. */
const fetchHealth = (url: string): Effect.Effect<Checks.Probe> =>
  Effect.tryPromise({
    try: async (signal) => {
      const response = await fetch(`${url}/healthz`, { redirect: "manual", signal: AbortSignal.any([signal, AbortSignal.timeout(5_000)]) });
      await response.body?.cancel();
      return response.ok ? ({ ok: true } as const) : ({ ok: false, why: `HTTP ${response.status}` } as const);
    },
    catch: (error) => {
      const cause = (error as { cause?: { code?: unknown } }).cause?.code;
      return typeof cause === "string" ? cause : error instanceof Error ? error.name : "error";
    },
  }).pipe(Effect.catch((why) => Effect.succeed({ ok: false, why } as const)));

/** Rows of the push store, when this hub has one (M8's `push_subscriptions`). */
const pushDevicesOf = (db: HubDb.HubDb["Service"]["db"]) =>
  Effect.sync(() => {
    try {
      return Number(db.prepare("SELECT COUNT(*) AS n FROM push_subscriptions").get()?.n ?? 0);
    } catch {
      return undefined;
    }
  });

/**
 * The doctor over the hub's services, registered with the sweep. Needs HubStore, EventLog, HubDb, Executors (with its
 * T3Settings), NodeActions, Usage with its UsageSource, and the Sweep.
 */
export const layer = (options: { readonly home: string; readonly listen: DoctorDeps["listen"] }) =>
  Layer.effect(
    Doctor,
    Effect.gen(function* () {
      const store = yield* HubStore.HubStore;
      const events = yield* EventLog.EventLog;
      const { db } = yield* HubDb.HubDb;
      const executors = yield* Executors;
      const usage = yield* Usage.Usage;
      const usageSource = yield* UsageSource;
      const doctor = yield* make({
        listen: options.listen,
        config: () => readHubConfig(options.home),
        machines: () => store.machines.list(),
        connected: executors.isConnected,
        awaitLive: executors.awaitLive,
        settings: yield* T3Settings,
        usage: (machineId) => usage.status(machineId, usageSource.read(machineId)),
        actions: yield* NodeActions,
        gh: ghRunner,
        pushDevices: pushDevicesOf(db),
        health: fetchHealth,
        append: events.append,
      });
      yield* (yield* Sweep).register({ name: "doctor", run: doctor.runIfDue });
      return doctor;
    }),
  );
