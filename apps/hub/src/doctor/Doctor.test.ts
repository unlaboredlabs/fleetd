import type { HubEvent, Machine, MachineId, NodeAction, UsageStatus } from "@fleetd/contracts";
import type { ServerSettings } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type * as Scope from "effect/Scope";
import { TestClock } from "effect/testing";
import { describe, expect, it } from "vitest";
import type { ActionOutcome } from "../checks/NodeCommands.ts";
import { DOCTOR_EVERY_MS, make, selfUrl } from "./Doctor.ts";
import type { SettingsUpdate } from "./T3Settings.ts";

const AT = "2026-10-17T10:00:00.000Z";
const ARGS = "--disallowedTools mcp__t3-code__*,Task,Workflow";

const machine = (id: string, patch: Partial<Machine> = {}): Machine => ({
  machineId: id as MachineId,
  name: id,
  tags: [],
  status: "online",
  lastSeenAt: AT,
  t3: { version: "0.1.1-nightly.20261017.3238", protocol: 2 },
  nodeVersion: "0.0.0",
  ...patch,
});

/** A healthy one-machine fleet whose every reading the test can change; records what the doctor did. */
const fakeFleet = () => {
  const state = {
    machines: [machine("lab-a")],
    connected: new Set(["lab-a"]),
    launchArgs: ARGS,
    autoResume: false,
    diskFreeBytes: 20e9,
    runs: 0,
    events: [] as Array<Omit<HubEvent, "seq">>,
    actions: [] as Array<NodeAction["action"]>,
    updates: [] as Array<SettingsUpdate>,
    /** What each node action does to the fleet and answers. */
    onAction: (_action: NodeAction["action"]): ActionOutcome => ({ ok: true, message: "did it" }),
  };
  const settings = () =>
    ({
      autoResumeLimitedThreads: state.autoResume,
      providerInstances: {
        fleetd: {
          driver: "claudeAgent",
          environment: [{ name: "ANTHROPIC_AUTH_TOKEN", value: "", redacted: true, sensitive: true }],
          config: { homePath: "/lab/claude-a", launchArgs: state.launchArgs },
        },
      },
    }) as unknown as ServerSettings;
  const usage = (machineId: MachineId): UsageStatus => ({
    machineId,
    login: "subscription",
    breaker: { state: "closed" },
    parked: { leads: 0, tasks: 0 },
    lastEvents: [],
    probes: { observable: true, count: 0, source: "/lab/logs" },
  });
  const doctor = make({
    listen: { host: "127.0.0.1", port: 4790 },
    hubPlatform: { platform: "linux", uid: 1000 },
    config: () => ({ config: { url: "https://hub.ts.net", gitIdentity: { name: "w", email: "1+w@users.noreply.github.com" } } }),
    machines: () => Effect.sync(() => (state.runs++, state.machines)),
    connected: (id) => Effect.sync(() => state.connected.has(id)),
    awaitLive: () => Effect.void,
    settings: {
      read: () => Effect.sync(settings),
      update: (_id, update) =>
        Effect.sync(() => {
          state.updates.push(update);
          const fleetd = update.providerInstanceMutation;
          if (fleetd?.operation === "upsert") state.launchArgs = String((fleetd.instance.config as { launchArgs: string }).launchArgs);
          if (update.patch.autoResumeLimitedThreads !== undefined) state.autoResume = update.patch.autoResumeLimitedThreads;
          return settings();
        }),
    },
    usage: (id) => Effect.succeed(usage(id)),
    actions: {
      run: (_id, action) =>
        Effect.sync(() => {
          if (action === "probe") return { ok: true, message: "probed", probe: { gitEmail: "1+w@users.noreply.github.com", gitEmailFrom: "env" as const, diskPath: "/home/lab", diskFreeBytes: state.diskFreeBytes } };
          state.actions.push(action);
          return state.onAction(action);
        }),
    },
    gh: () => Effect.succeed({ exitCode: 0, stdout: "", stderr: "Logged in to github.com account wynn-dev" }),
    pushDevices: Effect.succeed(1),
    health: () => Effect.succeed({ ok: true }),
    append: (event) => Effect.sync(() => (state.events.push(event), { ...event, seq: state.events.length }) as HubEvent),
  });
  return { state, doctor };
};

const run = <A, E>(effect: Effect.Effect<A, E, Scope.Scope>) => Effect.runPromise(effect.pipe(Effect.scoped, Effect.provide(Layer.mergeAll(TestClock.layer()))));

const statuses = (checks: ReadonlyArray<{ readonly id: string; readonly status: string }>) => Object.fromEntries(checks.map((c) => [c.id, c.status]));

describe("doctor", () => {
  it("runs every check, stays quiet on the first run, then emits doctor.changed per machine for what changed", () =>
    run(
      Effect.gen(function* () {
        const { state, doctor: make } = fakeFleet();
        const doctor = yield* make;
        const first = yield* doctor.list();
        expect(first.checks.map((c) => c.id)).toEqual([
          "hub/reachable",
          "hub/gh_auth",
          "hub/push",
          "hub/https",
          "lab-a/online",
          "lab-a/t3_version",
          "lab-a/instance_args",
          "lab-a/auto_resume",
          "lab-a/probes",
          "lab-a/commit_identity",
          "lab-a/disk",
          "lab-a/usage_breaker",
        ]);
        expect(first.checks.every((c) => c.status === "ok")).toBe(true);
        expect(state.events).toEqual([]);

        // Cached until a rerun.
        state.diskFreeBytes = 1e9;
        expect((yield* doctor.list()).checks.find((c) => c.id === "lab-a/disk")?.status).toBe("ok");
        expect(state.runs).toBe(1);

        state.machines = [...state.machines, machine("lab-b", { status: "offline" })];
        const second = yield* doctor.list({ rerun: true });
        expect(statuses(second.checks)).toMatchObject({ "lab-a/disk": "fail", "lab-b/online": "fail", "lab-b/disk": "unknown", "lab-b/t3_version": "ok" });
        expect(state.events.map((e) => [e.type, e.machineId, e.summary])).toEqual([
          ["doctor.changed", "lab-a", "doctor: lab-a/disk ok → fail"],
          ["doctor.changed", "lab-b", "doctor: lab-b/online new → fail, lab-b/instance_args new → unknown, lab-b/auto_resume new → unknown, lab-b/commit_identity new → unknown, lab-b/disk new → unknown"],
        ]);
        expect(state.events[0]!.data).toEqual({ changes: [{ id: "lab-a/disk", from: "ok", to: "fail" }] });
      }),
    ));

  it("runs from the sweep only once the last run is 15 minutes old", () =>
    run(
      Effect.gen(function* () {
        const { state, doctor: make } = fakeFleet();
        const doctor = yield* make;
        yield* doctor.runIfDue;
        expect(state.runs).toBe(1);
        yield* TestClock.adjust(DOCTOR_EVERY_MS - 60_000);
        yield* doctor.runIfDue;
        expect(state.runs).toBe(1);
        yield* TestClock.adjust(60_000);
        yield* doctor.runIfDue;
        expect(state.runs).toBe(2);
      }),
    ));

  it("restarts T3 on a degraded machine through its node, then checks again", () =>
    run(
      Effect.gen(function* () {
        const { state, doctor: make } = fakeFleet();
        const doctor = yield* make;
        state.machines = [machine("lab-a", { status: "degraded", degradedReason: "T3 failed 3 health checks in a row" })];
        state.connected.clear();
        expect((yield* doctor.list()).checks.find((c) => c.id === "lab-a/online")?.fix?.kind).toBe("auto");
        state.onAction = () => {
          state.machines = [machine("lab-a")];
          state.connected.add("lab-a");
          return { ok: true, message: "ran the T3 restart command" };
        };
        const fixed = yield* doctor.fix("lab-a/online");
        expect(state.actions).toEqual(["restart_t3"]);
        expect(fixed).toMatchObject({ ran: "lab-a's node ran the T3 restart command", check: { id: "lab-a/online", status: "ok" } });
        expect(state.events).toHaveLength(1);
        expect(state.events[0]!.summary).toMatch(/^doctor: lab-a\/online fail → ok, lab-a\/instance_args unknown → ok/u);
      }),
    ));

  it("re-mints the hub's T3 session when the node is linked but T3 is not connected, and reports a node that could not", () =>
    run(
      Effect.gen(function* () {
        const { state, doctor: make } = fakeFleet();
        const doctor = yield* make;
        state.connected.clear();
        state.onAction = () => ({ ok: false, message: "no new T3 session within 30 s; T3 may be down (see the node log)" });
        const refused = yield* Effect.flip(doctor.fix("lab-a/online"));
        expect(refused.message).toBe("lab-a's node could not do it: no new T3 session within 30 s; T3 may be down (see the node log)");
        state.onAction = () => (state.connected.add("lab-a"), { ok: true, message: "minted a fresh T3 session and sent it to the hub" });
        expect((yield* doctor.fix("lab-a/online")).check.status).toBe("ok");
        expect(state.actions).toEqual(["remint_session", "remint_session"]);
      }),
    ));

  it("re-applies the fleetd instance with every required deny, keeping its other args and stored env, and turns auto-resume off", () =>
    run(
      Effect.gen(function* () {
        const { state, doctor: make } = fakeFleet();
        const doctor = yield* make;
        state.launchArgs = "--verbose --disallowedTools Bash";
        state.autoResume = true;
        const fixed = yield* doctor.fix("lab-a/instance_args");
        expect(fixed.ran).toBe("re-applied the fleetd instance config on lab-a (launch args and auto-resume off)");
        expect(fixed.check.status).toBe("ok");
        expect(state.updates).toEqual([
          {
            patch: { autoResumeLimitedThreads: false },
            providerInstanceMutation: {
              operation: "upsert",
              instanceId: "fleetd",
              instance: {
                driver: "claudeAgent",
                environment: [{ name: "ANTHROPIC_AUTH_TOKEN", value: "", redacted: true, sensitive: true }],
                config: { homePath: "/lab/claude-a", launchArgs: "--verbose --disallowedTools mcp__t3-code__*,Task,Workflow,Bash" },
              },
            },
          },
        ]);
        expect(statuses((yield* doctor.list()).checks)).toMatchObject({ "lab-a/instance_args": "ok", "lab-a/auto_resume": "ok" });
      }),
    ));

  it("refuses manual fixes with their command, and checks with nothing to fix", () =>
    run(
      Effect.gen(function* () {
        const { state, doctor: make } = fakeFleet();
        const doctor = yield* make;
        state.diskFreeBytes = 1e9;
        const manual = yield* Effect.flip(doctor.fix("lab-a/disk"));
        expect(manual).toMatchObject({ code: "invalid", message: "lab-a/disk needs a person: Free disk space on lab-a.", fix: "df -h /home/lab" });
        expect((yield* Effect.flip(doctor.fix("hub/gh_auth"))).message).toBe("hub/gh_auth has nothing to fix (ok).");
        expect((yield* Effect.flip(doctor.fix("lab-z/disk"))).message).toBe("No machine lab-z.");
        expect(state.actions).toEqual([]);
      }),
    ));

  it("reaches a wildcard listen address on loopback", () => {
    expect(selfUrl({ host: "0.0.0.0", port: 4790 })).toBe("http://127.0.0.1:4790");
    expect(selfUrl({ host: "::1", port: 4790 })).toBe("http://[::1]:4790");
  });
});
