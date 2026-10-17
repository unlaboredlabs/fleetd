import type { ThreadId } from "@fleetd/contracts";
import * as Effect from "effect/Effect";
import { describe, expect, it } from "vitest";
import * as EventLog from "../store/EventLog.ts";
import * as HubStore from "../store/HubStore.ts";
import * as Leads from "./Leads.ts";
import * as Workstreams from "./Workstreams.ts";
import { readLeadPrompt } from "./prompt.ts";
import { makeKit, REF, runKit } from "./testKit.ts";

const leads = Leads.Leads;

const threadRow = (threadId: string, status: "running" | "completed") => ({
  machineId: REF.machineId,
  projectId: REF.projectId,
  threadId: threadId as ThreadId,
  title: "lead",
  status,
  headline: "",
  latestMessageTail: "",
  lastProgressAt: "1970-01-01T00:00:00.000Z",
  stale: false,
  asOf: "1970-01-01T00:00:00.000Z",
});

describe("Leads", () => {
  it("lead_start launches one lead per project, even for concurrent calls, and returns it again after", async () => {
    const kit = makeKit();
    await runKit(
      kit,
      Effect.gen(function* () {
        yield* kit.addProject(REF, "Demo");
        const l = yield* leads;
        const [a, b] = yield* Effect.all([l.start(REF), l.start(REF)], { concurrency: "unbounded" });
        const c = yield* l.start(REF);
        expect(kit.launches).toHaveLength(1);
        expect([a.threadId, b.threadId, c.threadId]).toEqual(["t1", "t1", "t1"]);
        expect(a).toMatchObject({ projectRef: REF, state: "starting", sessionGeneration: 0 });

        const { input } = kit.launches[0]!;
        expect(input).toMatchObject({ model: "claude-opus-5-5", effort: "high", runtimeMode: "full-access", projectId: "p1" });
        expect(input.prompt.startsWith("You are the lead of project Demo (lab-a/p1).")).toBe(true);
        expect(input.prompt).toContain("# fleetd digest: project Demo");

        // The state follows the lead thread as the shell stream reports it.
        const store = yield* HubStore.HubStore;
        yield* store.threads.upsert(threadRow("t1", "running"));
        expect((yield* l.get(REF))?.state).toBe("working");
        yield* store.threads.upsert(threadRow("t1", "completed"));
        expect((yield* l.get(REF))?.state).toBe("idle");

        const started = yield* (yield* EventLog.EventLog).wait({ cursor: 0, types: ["lead.started"], timeoutSec: 0 });
        expect(started.events).toHaveLength(1);
      }),
    );
  });

  it("uses per-project model and effort over the hub default, and refuses an unknown project", async () => {
    const kit = makeKit({ prompt: "Lead {{project}}", model: "claude-haiku-5-5", effort: "low" });
    await runKit(
      kit,
      Effect.gen(function* () {
        yield* kit.addProject(REF);
        const l = yield* leads;
        const missing = yield* Effect.flip(l.start({ ...REF, projectId: "nope" as never }));
        expect(missing.code).toBe("not_found");

        yield* l.configure(REF, { model: "claude-sonnet-5-5" });
        yield* l.start(REF);
        expect(kit.launches[0]!.input).toMatchObject({ model: "claude-sonnet-5-5", effort: "low" });
      }),
    );
  });

  it("lead_restart starts a fresh thread from the digest and bumps the session generation", async () => {
    const kit = makeKit();
    await runKit(
      kit,
      Effect.gen(function* () {
        yield* kit.addProject(REF);
        const l = yield* leads;
        expect((yield* Effect.flip(l.restart(REF))).code).toBe("not_found");
        yield* l.start(REF);
        const restarted = yield* l.restart(REF);
        expect(restarted).toMatchObject({ threadId: "t2", sessionGeneration: 1, state: "starting" });
        expect(kit.launches.map((x) => x.input.clientRequestId)).toEqual(["fleetd-lead:lab-a/p1:0:0", "fleetd-lead:lab-a/p1:1:0"]);
        expect(kit.launches[1]!.input.prompt).toContain("# fleetd digest");
        expect((yield* l.start(REF)).threadId).toBe("t2");
      }),
    );
  });

  it("maps an offline machine to machine_offline and records no lead", async () => {
    const kit = makeKit();
    await runKit(
      kit,
      Effect.gen(function* () {
        yield* kit.addProject(REF);
        kit.setOffline(true);
        const l = yield* leads;
        expect((yield* Effect.flip(l.start(REF))).code).toBe("machine_offline");
        expect(yield* l.get(REF)).toBeUndefined();
      }),
    );
  });

  it("ships a prompt that states every rule the specs list", () => {
    const prompt = readLeadPrompt();
    for (const needle of [
      "{{project}}",
      "never write code",
      "delegate",
      "fleetd task spawn",
      "explicit areas",
      "arrives inline in a later wake",
      "fleetd brief create",
      "product, money, credentials or irreversible",
      "fleetd ask",
      "fleetd decide",
      "Never block on a question",
      "fleetd status set",
      "The digest is the truth, not your memory",
      "Source: <its --serves>",
      "only fleetd's merge train merges",
      "never post the `fleetd/train` status",
      "fleetd change enqueue",
    ]) {
      expect(prompt).toContain(needle);
    }
  });

  it("when T3 deletes the project, its open workstreams stop with the reason and its lead reads as stopped", async () => {
    const kit = makeKit();
    await runKit(
      kit,
      Effect.gen(function* () {
        yield* kit.addProject(REF, "Demo");
        const l = yield* leads;
        const workstreams = yield* Workstreams.Workstreams;
        const store = yield* HubStore.HubStore;
        const events = yield* EventLog.EventLog;
        yield* l.start(REF);
        yield* store.threads.upsert(threadRow("t1", "completed"));
        const { workstreamId } = yield* workstreams.intake({ ref: REF, text: "add a /health endpoint", clientRequestId: "r1", channel: "app", by: "human" });

        // What the executor does on a project.removed shell item or a snapshot without the project.
        const cursor = yield* events.head();
        yield* store.projects.remove(REF);
        yield* events.append({ at: "1970-01-01T00:00:00.000Z", type: "project.removed", machineId: REF.machineId, projectId: REF.projectId, summary: 'Project "Demo" on lab-a was deleted in T3' });

        const stopped = yield* events.wait({ cursor, types: ["workstream.state"], timeoutSec: 3600 });
        expect(stopped.events.map((e) => e.summary)).toEqual([`${workstreamId} is stopped: its project was deleted in T3`]);
        expect(yield* workstreams.get(workstreamId)).toMatchObject({ state: "stopped", headline: "Stopped: its project was deleted in T3." });
        expect((yield* l.get(REF))?.state).toBe("stopped");
        expect(yield* store.threads.get({ machineId: REF.machineId, threadId: "t1" as ThreadId })).toBeUndefined();
      }),
    );
  });
});
