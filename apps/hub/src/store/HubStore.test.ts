import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  MachineId,
  ProjectId,
  ThreadId,
  type Machine,
  type ProjectSummary,
  type ThreadSummary,
} from "@fleetd/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as EventLog from "./EventLog.ts";
import * as HubDb from "./HubDb.ts";
import * as HubStore from "./HubStore.ts";

const at = (minute: number) => new Date(Date.UTC(2026, 9, 17, 10, minute)).toISOString();
const machineId = MachineId.make("lab-a");
const projectId = ProjectId.make("p1");

const project = (id: string, title: string, workspaceRoot: string, minute: number): ProjectSummary => ({
  machineId,
  projectId: ProjectId.make(id),
  title,
  workspaceRoot,
  threads: { running: 0, waiting: 0, idle: 0, failed: 0 },
  lastActivityAt: at(minute),
});

const thread = (id: string, minute: number): ThreadSummary => ({
  machineId,
  threadId: ThreadId.make(id),
  projectId,
  title: id,
  status: "running",
  headline: "",
  latestMessageTail: "",
  lastProgressAt: at(minute),
  stale: false,
  asOf: at(minute),
});

const run = <A>(effect: Effect.Effect<A, never, HubStore.HubStore>) =>
  Effect.runPromise(effect.pipe(Effect.provide(HubStore.layer.pipe(Layer.provide(HubDb.layerMemory)))));

describe("HubStore", () => {
  it("filters projects by machine and by a case-insensitive literal query, newest activity first", () =>
    run(
      Effect.gen(function* () {
        const { projects } = yield* HubStore.HubStore;
        yield* projects.upsertMany(machineId, [
          project("p1", "Fleetd Hub", "/src/fleetd", 1),
          project("p2", "100% done", "/src/other", 2),
          project("p3", "web", "/src/FLEETD-web", 3),
        ]);
        const ids = (list: ReadonlyArray<ProjectSummary>) => list.map((p) => p.projectId);
        expect(ids(yield* projects.list())).toEqual(["p3", "p2", "p1"]);
        expect(ids(yield* projects.list({ query: "fleetd" }))).toEqual(["p3", "p1"]);
        expect(ids(yield* projects.list({ query: "0%" }))).toEqual(["p2"]);
        expect(ids(yield* projects.list({ query: "_" }))).toEqual([]);
        expect(yield* projects.list({ machineId: MachineId.make("lab-b") })).toEqual([]);
      }),
    ));

  it("keeps a thread's lastSequence when an update omits it, and lists a project's threads newest first", () =>
    run(
      Effect.gen(function* () {
        const { threads } = yield* HubStore.HubStore;
        yield* threads.upsert({ ...thread("t1", 1), lastSequence: 7 });
        yield* threads.upsert({ ...thread("t1", 4), status: "completed" });
        yield* threads.upsert(thread("t2", 2));
        yield* threads.upsert(thread("t3", 3));
        expect(yield* threads.get({ machineId, threadId: ThreadId.make("t1") })).toMatchObject({
          status: "completed",
          lastSequence: 7,
        });
        const listed = yield* threads.listByProject({ machineId, projectId }, 2);
        expect(listed.map((t) => t.threadId)).toEqual(["t1", "t3"]);
        expect(listed[0]).not.toHaveProperty("lastSequence");
      }),
    ));

  it("sets a known machine's status and ignores unknown machines", () =>
    run(
      Effect.gen(function* () {
        const { machines } = yield* HubStore.HubStore;
        const machine: Machine = {
          machineId,
          name: "Lab A",
          tags: [],
          status: "online",
          lastSeenAt: at(0),
          t3: null,
          nodeVersion: "0.0.0",
        };
        yield* machines.upsert(machine);
        yield* machines.setStatus(machineId, "offline", at(5));
        yield* machines.setStatus(MachineId.make("ghost"), "offline", at(5));
        expect(yield* machines.list()).toEqual([{ ...machine, status: "offline", lastSeenAt: at(5) }]);
      }),
    ));
});

describe("HubDb", () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "fleetd-hubdb-"));
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it("refuses homes inside ~/.t3, including through a symlink, and defaults to ~/.fleetd/hub", async () => {
    const user = path.join(dir, "user");
    fs.mkdirSync(path.join(user, ".t3", "userdata"), { recursive: true });
    fs.symlinkSync(path.join(user, ".t3", "userdata"), path.join(dir, "sneaky"));
    const resolve = (home: string | undefined) =>
      Effect.runPromise(
        HubDb.resolveHubHome(home, user).pipe(
          Effect.match({ onFailure: (e) => `refused ${e.home}`, onSuccess: (h) => h }),
        ),
      );
    expect(await resolve(undefined)).toBe(path.join(user, ".fleetd", "hub"));
    expect(await resolve("~/hub")).toBe(path.join(user, "hub"));
    expect(await resolve("~/.t3")).toBe(`refused ${path.join(user, ".t3")}`);
    expect(await resolve(path.join(user, ".t3", "userdata", "hub"))).toMatch(/^refused /u);
    expect(await resolve(path.join(dir, "sneaky", "hub"))).toMatch(/^refused /u);
    expect(await resolve(path.join(user, ".t3x"))).toBe(path.join(user, ".t3x"));
  });

  it("opens a file database in WAL mode, migrates once, and keeps event seqs across reopen", async () => {
    const home = path.join(dir, "hub");
    const appendOne = Effect.gen(function* () {
      const log = yield* EventLog.EventLog;
      const { db } = yield* HubDb.HubDb;
      const appended = yield* log.append({ at: at(0), type: "machine.online", summary: "up" });
      return {
        seq: appended.seq,
        mode: db.prepare("PRAGMA journal_mode").get()?.journal_mode,
        version: db.prepare("PRAGMA user_version").get()?.user_version,
      };
    });
    const once = () =>
      Effect.runPromise(appendOne.pipe(Effect.provide(EventLog.layer.pipe(Layer.provideMerge(HubDb.layer(home))))));
    expect(await once()).toEqual({ seq: 1, mode: "wal", version: HubDb.SCHEMA_VERSION });
    expect(await once()).toEqual({ seq: 2, mode: "wal", version: HubDb.SCHEMA_VERSION });
    expect(fs.statSync(home).mode & 0o777).toBe(0o700);
  });
});
