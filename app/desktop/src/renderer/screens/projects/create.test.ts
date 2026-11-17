import { describe, expect, it } from "vitest";
import type { HubEvent } from "./contracts";
import { botName, busy, createStep, initialCreate, outcomeLine, type Call, type CreateState, type Draft, type Outcome } from "./create";

const live: CreateState = { ...initialCreate, live: true };
const inspect = { ci: { workflows: [], requiredChecks: [] }, merge: { protected: false, rulesets: [] }, leadNeeds: "a plain folder", notes: [] };
const made = (path = "/home/w/fleetd/projects/shop"): Outcome => ({ ok: true, output: { machineId: "devbox", path, projectId: "p1", created: true, inspect } });
const ev = (seq: number, type: string, data: Record<string, unknown>): HubEvent => ({ seq, at: "2026-11-17T10:00:00.000Z", type, machineId: "devbox", projectId: "p1", summary: "", data });

const start = (draft: Draft) => createStep(live, { t: "start", draft });

describe("a new bot", () => {
  it("with no repo is made in a folder the hub makes, named as typed", () => {
    const [s, calls] = start({ name: " Field notes ", machineId: "devbox", repos: [] });
    expect(s.phase).toEqual({ kind: "creating", title: "Field notes" });
    expect(calls).toEqual([{ kind: "create", gen: 1, input: { machineId: "devbox", create: true, title: "Field notes" } }]);
    const [after, more] = createStep(s, { t: "answer", call: calls[0] as Call, outcome: made() });
    expect(after.phase).toEqual({ kind: "made", bot: { project: { machineId: "devbox", projectId: "p1" }, title: "Field notes", path: "/home/w/fleetd/projects/shop" } });
    expect(more).toEqual([]);
    expect(busy(after)).toBe(false);
  });

  it("with no name takes its first repo's", () => {
    expect(botName("", [{ kind: "clone", repo: "acme/shop" }])).toBe("shop");
    expect(botName("  ", [{ kind: "folder", path: "/home/w/src/notes/" }])).toBe("notes");
    expect(botName("", [])).toBe("");
  });

  it("lives in the first folder listed, and adds every other repo to it once made", () => {
    const [s, calls] = start({
      name: "Shop",
      machineId: "devbox",
      repos: [
        { kind: "clone", repo: "acme/api" },
        { kind: "folder", path: "/home/w/src/shop" },
        { kind: "folder", path: "/home/w/src/docs" },
        // The same repo again is listed once.
        { kind: "clone", repo: "Acme/API" },
      ],
    });
    expect(calls[0]?.input).toEqual({ machineId: "devbox", path: "/home/w/src/shop", title: "Shop" });
    expect(s.jobs.map((j) => j.key)).toEqual(["gh:acme/api", "dir:/home/w/src/shop", "dir:/home/w/src/docs"]);
    const [after, repoCalls] = createStep(s, { t: "answer", call: calls[0] as Call, outcome: made("/home/w/src/shop") });
    expect(after.jobs.map((j) => j.state.t)).toEqual(["adding", "added", "adding"]);
    expect(repoCalls).toEqual([
      { kind: "repo", gen: 1, key: "gh:acme/api", input: { machineId: "devbox", projectId: "p1", url: "acme/api" } },
      { kind: "repo", gen: 1, key: "dir:/home/w/src/docs", input: { machineId: "devbox", projectId: "p1", path: "/home/w/src/docs" } },
    ]);
  });

  it("that the hub refuses is not made: Back returns to the form", () => {
    const [s, calls] = start({ name: "Old notes", machineId: "devbox", repos: [{ kind: "clone", repo: "acme/x" }] });
    const [failed] = createStep(s, { t: "answer", call: calls[0] as Call, outcome: { ok: false, error: { code: "invalid", message: "it already holds files", fix: "Give it another name" } } });
    expect(failed.phase).toEqual({ kind: "failed", title: "Old notes", message: "it already holds files.", fix: "Give it another name." });
    expect(createStep(failed, { t: "back" })[0].phase).toEqual({ kind: "form" });
  });

  it("whose answer is lost to a drop says so, never that it failed outright", () => {
    const [s, calls] = start({ name: "Shop", machineId: "devbox", repos: [] });
    const [lost] = createStep(s, { t: "answer", call: calls[0] as Call, outcome: { ok: false, error: { code: "disconnected", message: "closed" } } });
    expect(lost.phase).toMatchObject({ kind: "failed", message: "Lost the connection to the hub before it answered." });
  });
});

describe("its repos", () => {
  const cloning = () => {
    const [s, calls] = start({ name: "Shop", machineId: "devbox", repos: [{ kind: "clone", repo: "acme/api" }, { kind: "clone", repo: "acme/web" }] });
    const [m, repoCalls] = createStep(s, { t: "answer", call: calls[0] as Call, outcome: made() });
    return { m, api: repoCalls[0] as Call, web: repoCalls[1] as Call };
  };

  it("follow a clone's progress by its addId, events before its answer included, to added", () => {
    const { m, api } = cloning();
    // The clone's first event beats the answer naming it.
    let s = createStep(m, { t: "event", event: ev(5, "project.clone_progress", { addId: "a1", repo: "acme/api", path: "/home/w/src/api", phase: "receiving", percent: 10 }) })[0];
    expect(s.early).toHaveLength(1);
    s = createStep(s, { t: "answer", call: api, outcome: { ok: true, output: { path: "/home/w/src/api", addId: "a1" } } })[0];
    expect(s.jobs[0]?.state).toEqual({ t: "adding", detail: "Receiving objects 10%", fraction: 0.1 });
    s = createStep(s, { t: "event", event: ev(6, "project.clone_progress", { addId: "a1", repo: "acme/api", path: "/home/w/src/api", phase: "receiving", percent: 42 }) })[0];
    expect(s.jobs[0]?.state).toMatchObject({ fraction: 0.42 });
    s = createStep(s, { t: "event", event: ev(7, "project.added", { addId: "a1", created: true, path: "/home/w/src/api", title: "Shop", inspect }) })[0];
    expect(s.jobs[0]?.state).toEqual({ t: "added", path: "/home/w/src/api" });
    // Another add's events are none of its business.
    s = createStep(s, { t: "event", event: ev(8, "project.add_failed", { addId: "zz", code: "clone_failed", message: "no", path: "/x" }) })[0];
    expect(s.jobs[0]?.state.t).toBe("added");
  });

  it("fail on their own with the hub's words, and Retry sends the add again; a busy dialog stays busy", () => {
    const { m, web } = cloning();
    let s = createStep(m, { t: "answer", call: web, outcome: { ok: true, output: { path: "/home/w/src/web", addId: "a2" } } })[0];
    s = createStep(s, { t: "event", event: ev(9, "project.add_failed", { addId: "a2", code: "clone_failed", message: "fatal: no space left", fix: "Free disk space on devbox", path: "/home/w/src/web" }) })[0];
    expect(s.jobs[1]?.state).toEqual({ t: "failed", message: "fatal: no space left.", fix: "Free disk space on devbox." });
    expect(busy(s)).toBe(true);
    const [again, calls] = createStep(s, { t: "retry", key: "gh:acme/web" });
    expect(again.jobs[1]?.state.t).toBe("adding");
    expect(calls).toEqual([{ kind: "repo", gen: 1, key: "gh:acme/web", input: { machineId: "devbox", projectId: "p1", url: "acme/web" } }]);
  });

  it("whose clone folder already holds the repo offer to use that checkout", () => {
    const { m, api } = cloning();
    const fix = "Add that checkout instead (useExisting), or clone into another folder (dest)";
    const s = createStep(m, { t: "answer", call: api, outcome: { ok: false, error: { code: "invalid", message: "devbox already has a checkout of acme/api at /home/w/src/api", fix } } })[0];
    expect(s.jobs[0]?.state).toEqual({ t: "failed", message: "devbox already has a checkout of acme/api at /home/w/src/api.", existing: true });
    const [, calls] = createStep(s, { t: "retry", key: "gh:acme/api", useExisting: true });
    expect(calls[0]?.input).toEqual({ machineId: "devbox", projectId: "p1", url: "acme/api", useExisting: true });
  });

  it("left out after failing are dropped from the list, and the outcome line says how it ended", () => {
    const { m, api, web } = cloning();
    let s = createStep(m, { t: "answer", call: api, outcome: { ok: true, output: { path: "/home/w/src/api", repo: { path: "/home/w/src/api" } } } })[0];
    expect(outcomeLine(s)).toBeNull();
    s = createStep(s, { t: "answer", call: web, outcome: { ok: false, error: { code: "not_found", message: "gh can't see acme/web" } } })[0];
    expect(outcomeLine(s)).toEqual({ title: "Couldn't add web to Shop", problem: true });
    s = createStep(s, { t: "dismiss", key: "gh:acme/web" })[0];
    expect(outcomeLine(s)).toEqual({ title: "Shop has its repo", problem: false });
  });

  it("added while the link was down show as added once a snapshot lists them", () => {
    const { m } = cloning();
    const s = createStep(m, {
      t: "snapshot",
      projects: [{ machineId: "devbox", projectId: "p1", title: "Shop", workspaceRoot: "/w", threads: { running: 0, waiting: 0, idle: 0, failed: 0 }, lastActivityAt: "", repos: [{ name: "api", path: "/home/w/src/api", repoId: "R1", checkout: { machineId: "devbox", projectId: "c1" } }] }],
    })[0];
    expect(s.jobs.map((j) => j.state.t)).toEqual(["added", "adding"]);
  });
});
