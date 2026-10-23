import { describe, expect, it } from "vitest";
import type { HubEvent, ProjectSummary } from "./contracts";
import type { Request } from "./discovery";
import { hubMessages, initialAdd, step, type AddMsg, type AddState, type Call } from "./flow";

const names = (id: string) => `${id}-name`;
const AT = "2026-10-18T10:00:00.000Z";

/** Runs messages through the reducer, collecting every call it asks for. */
const run = (s: AddState, ...msgs: Array<AddMsg>): [AddState, Array<Call>] => {
  const calls: Array<Call> = [];
  let state = s;
  for (const m of msgs) {
    const [next, out] = step(state, m, names);
    state = next;
    calls.push(...out);
  }
  return [state, calls];
};

const only = (calls: Array<Call>, purpose: Call["purpose"]): Call => {
  const found = calls.filter((c) => c.purpose === purpose);
  expect(found, `one ${purpose} call`).toHaveLength(1);
  return found[0] as Call;
};

const live = (): AddState => run(initialAdd, { t: "snapshot", projects: [] })[0];
const project = (path: string) => ({ machineId: "devbox", projectId: "p7", title: "ledger", workspaceRoot: path, lastActivityAt: AT, threads: {} }) as ProjectSummary;

const event = (seq: number, type: string, data: Record<string, unknown>): AddMsg => {
  const e: HubEvent = { seq, at: AT, type, machineId: "devbox", summary: "", data, ...(type === "project.added" ? { projectId: "p7" } : {}) };
  return { t: "event", event: e };
};

const added = (addId: string) => ({
  addId,
  title: "ledger",
  path: "/home/me/src/ledger",
  created: true,
  inspect: { ci: { workflows: [], requiredChecks: [] }, merge: { protected: false, rulesets: [] }, leadNeeds: "ok", notes: [] },
});

const cloneReq: Request = { kind: "clone", repo: "acme/ledger", machineId: "devbox", useExisting: false };
const start = (request: Request = cloneReq): AddMsg => ({ t: "start", request, path: "/p" });
const ok = (c: Call, output: unknown): AddMsg => ({ t: "answer", call: c, outcome: { ok: true, output } });
const err = (c: Call, code: string, message: string): AddMsg => ({ t: "answer", call: c, outcome: { ok: false, error: { code, message, fix: "" } } });

describe("the add flow", () => {
  it("holds a failure that comes before the answer, then ends the add with it", () => {
    const [started, calls] = run(live(), start());
    let s = started;
    const add = only(calls, "add");
    expect(add.input).toEqual({ machineId: "devbox", url: "acme/ledger" });
    [s] = run(s, event(11, "project.add_failed", { addId: "a1", repo: "acme/ledger", path: "/p", code: "clone_failed", message: "git: remote hung up", fix: "Try again." }));
    expect(s.phase.kind).toBe("working");
    [s] = run(s, ok(add, { machineId: "devbox", path: "/p", created: true, addId: "a1" }));
    expect(s.phase).toMatchObject({ kind: "failed", failure: { message: "git: remote hung up", fix: "Try again." } });
    expect(s.request).toBeUndefined();
  });

  it("ignores someone else's add and matches its own by addId", () => {
    const [started, calls] = run(live(), start());
    let s = started;
    const add = only(calls, "add");
    [s] = run(s, event(12, "project.added", added("other")), ok(add, { machineId: "devbox", path: "/p", created: true, addId: "a2" }));
    expect(s.phase.kind).toBe("working");
    [s] = run(s, event(13, "project.clone_progress", { addId: "a2", path: "/p", phase: "receiving", percent: 50, detail: "4.10 MiB | 2.00 MiB/s" }));
    expect(s.phase).toMatchObject({ kind: "working", job: { step: "clone", detail: "Receiving objects 50% · 4.10 MiB | 2.00 MiB/s", fraction: 0.5 } });
    [s] = run(s, event(14, "project.added", added("a2")));
    expect(s.phase).toMatchObject({ kind: "ready", ready: { project: { machineId: "devbox", projectId: "p7" }, machine: "devbox-name" } });
  });

  it("after a reconnect, the snapshot says added or not listed yet, never failed, and never shows old progress as live", () => {
    let [s, calls] = run(live(), start());
    [s] = run(s, ok(only(calls, "add"), { machineId: "devbox", path: "/p", created: true, addId: "a1" }));
    [s] = run(s, event(11, "project.clone_progress", { addId: "a1", path: "/p", phase: "receiving", percent: 42 }), { t: "live", live: false });
    expect(s.phase).toMatchObject({ kind: "working", job: { detail: expect.stringContaining("Lost the connection") as unknown } });
    expect(s.phase.kind === "working" ? s.phase.job.fraction : "not working").toBeUndefined();
    [s, calls] = run(s, { t: "live", live: true }, { t: "snapshot", projects: [project("/elsewhere"), project("/p")] });
    expect(calls).toEqual([]);
    expect(s.phase).toMatchObject({ kind: "ready", ready: { project: { machineId: "devbox", projectId: "p7" }, machine: "devbox-name" } });

    // The answer was lost and the hub doesn't list it: not on the hub yet (a clone may still run), with the request kept for a retry.
    [s, calls] = run(s, start());
    [s] = run(s, err(only(calls, "add"), "disconnected", "the connection closed"));
    expect(s.phase.kind).toBe("working");
    [s, calls] = run(s, { t: "snapshot", projects: [] });
    expect(calls).toEqual([]);
    expect(s.phase).toEqual({ kind: "unlisted", what: "acme/ledger", path: "/p", request: cloneReq });
    expect(run(s, { t: "back" })[0].phase.kind).toBe("pick");
  });

  it("offers the existing folder only when a dry run says it is the same repo", () => {
    const target = (sameRemote: boolean, projectId?: string) => ({
      machineId: "devbox",
      path: "/p",
      created: false,
      inspect: { ci: { workflows: [], requiredChecks: [] }, merge: { protected: false, rulesets: [] }, leadNeeds: "ok", notes: [] },
      clone: { machineId: "devbox", path: "/p", exists: true, sameRemote, ...(projectId ? { projectId } : {}) },
    });
    const cases = [
      { same: true, project: undefined, want: { kind: "use_existing", request: { ...cloneReq, useExisting: true } } },
      { same: false, project: undefined, want: undefined },
      { same: true, project: "p3", want: { kind: "open", project: { machineId: "devbox", projectId: "p3" } } },
    ];
    for (const c of cases) {
      let [s, calls] = run(live(), start());
      [s, calls] = run(s, err(only(calls, "add"), "invalid", "devbox already has a checkout at /p"));
      const inspect = only(calls, "inspect");
      expect(inspect).toMatchObject({ purpose: "inspect", input: { machineId: "devbox", url: "acme/ledger", dryRun: true } });
      expect(s.phase.kind).toBe("working");
      [s] = run(s, ok(inspect, target(c.same, c.project)));
      expect(s.phase.kind).toBe("failed");
      if (s.phase.kind !== "failed") continue;
      expect(s.phase.failure.action).toEqual(c.want);
      expect(s.phase.failure.fix, "an empty fix is no fix").toBeUndefined();
    }
    // A clone that fails with dest_exists after it was accepted also asks.
    let [s, calls] = run(live(), start());
    [s] = run(s, ok(only(calls, "add"), { machineId: "devbox", path: "/p", created: true, addId: "a1" }));
    [, calls] = run(s, event(11, "project.add_failed", { addId: "a1", path: "/p", code: "dest_exists", message: "exists" }));
    only(calls, "inspect");
    // A folder add that fails needs no inspect.
    [s, calls] = run(live(), start({ kind: "folder", machineId: "devbox", path: "/srv/x" }));
    [s, calls] = run(s, err(only(calls, "add"), "invalid", "not a git repo"));
    expect(calls).toEqual([]);
    expect(s.phase).toMatchObject({ kind: "failed", what: "x" });
  });

  it("ignores an answer to an earlier add", () => {
    const [started, calls] = run(live(), start());
    let s = started;
    const first = only(calls, "add");
    [s] = run(s, err(first, "invalid", "nope"), { t: "back" });
    [s] = run(s, start({ kind: "folder", machineId: "devbox", path: "/srv/x" }));
    [s] = run(s, ok(first, { machineId: "devbox", path: "/p", created: true, addId: "stale" }));
    expect(s.addId).toBeUndefined();
    expect(s.awaiting).toBe(true);
  });

  it("joins a connection that was live before it listened (the palette or Machines opened first)", () => {
    const fresh = { live: true, fresh: true, projects: {}, events: [{ seq: 39, at: AT, type: "project.added", summary: "" }] };
    const first = hubMessages(undefined, fresh, 40);
    expect(first).toEqual([
      { t: "live", live: true },
      { t: "snapshot", projects: [] },
    ]);
    const [s] = run(initialAdd, ...first);
    const [, adding] = run(s, start());
    expect(only(adding, "add").input).toEqual({ machineId: "devbox", url: "acme/ledger" });
    // Later, only events past the last one seen are news; a drop and a fresh snapshot are passed on.
    const next = { ...fresh, events: [...fresh.events, { seq: 41, at: AT, type: "project.clone_progress", summary: "" }] };
    expect(hubMessages(fresh, next, 40).map((m) => m.t)).toEqual(["event"]);
    const down = { ...next, live: false, fresh: false };
    expect(hubMessages(next, down, 41)).toEqual([{ t: "live", live: false }]);
    expect(hubMessages(down, { ...next, projects: { "devbox/p7": project("/p") } }, 41)).toEqual([
      { t: "live", live: true },
      { t: "snapshot", projects: [project("/p")] },
    ]);
  });
});
