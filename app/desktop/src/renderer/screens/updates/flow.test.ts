import { afterEach, describe, expect, it, vi } from "vitest";
import type { Call, UpdatePart, UpdateRun } from "../../../shared/contracts";
import type { HubError } from "../../../shared/hub";
import type { AppUpdate, UpdatesState } from "../../../shared/updates";
import { BEFORE_UPDATE, currentFlow, loadRun, resetFlow, startUpdate, type FlowDeps } from "./flow";

const NEXT = "0.0.0-nightly.202610261056+1b563d7";

const runOf = (hub: UpdatePart["state"], finished: boolean): UpdateRun => ({
  id: "U1",
  channel: "nightly",
  to: NEXT,
  startedAt: "2026-10-26T10:00:00.000Z",
  ...(finished ? { finishedAt: "2026-10-26T10:03:00.000Z" } : {}),
  parts: [{ part: "hub", name: "the hub", from: "0.0.0", state: hub }],
});

type Answer = { ok: true; run?: UpdateRun } | { ok: false; error: HubError };

/** A hub that answers hub_update, then each hub_update_status in turn; and this app's updater. */
const deps = (start: Answer, statuses: Answer[], app: AppUpdate | AppUpdate[]) => {
  const calls: string[] = [];
  const answer = (a: Answer) => (a.ok ? { ok: true as const, output: a.run === undefined ? {} : { run: a.run } } : a);
  const call = ((tool: string) => {
    calls.push(tool);
    const next = tool === "hub_update" ? start : (statuses.shift() ?? statuses[0] ?? start);
    return Promise.resolve(answer(next));
  }) as unknown as Call;
  // `app`, or each in turn per sleep: this app's own check moving on while the run goes.
  const apps: AppUpdate[] = Array.isArray(app) ? [...app] : [app];
  const state = (): UpdatesState => ({ current: "0.0.0-nightly.202610251000+aaaaaaa", app: apps[0] ?? { kind: "idle" }, release: null });
  const d = {
    call,
    retry: vi.fn(),
    sleep: () => {
      if (apps.length > 1) apps.shift();
      return Promise.resolve();
    },
    app: { state, check: vi.fn(), install: vi.fn() },
  } satisfies FlowDeps;
  return { d, calls };
};

const offline: Answer = { ok: false, error: { code: "offline", message: "Not connected to the hub." } };

describe("the Update button's run", () => {
  afterEach(resetFlow);

  it("updates the hub, follows it through its restart, then installs this app", async () => {
    const { d, calls } = deps(
      { ok: true, run: runOf("downloading", false) },
      [{ ok: true, run: runOf("restarting", false) }, offline, offline, { ok: true, run: runOf("done", true) }],
      { kind: "available", version: NEXT, percent: 40, restart: false },
    );
    await startUpdate(d);
    expect(calls).toEqual(["hub_update", "hub_update_status", "hub_update_status", "hub_update_status", "hub_update_status"]);
    expect(d.retry).toHaveBeenCalledTimes(2);
    expect(d.app.install).toHaveBeenCalledOnce();
    expect(currentFlow()).toEqual({ phase: "app" });
  });

  it("leaves this app alone when the hub didn't update, and ends", async () => {
    for (const hub of ["failed", "rolled_back"] as const) {
      resetFlow();
      const { d } = deps({ ok: true, run: runOf("downloading", false) }, [{ ok: true, run: runOf(hub, true) }], { kind: "ready", version: NEXT });
      await startUpdate(d);
      expect(d.app.install).not.toHaveBeenCalled();
      expect(currentFlow()).toEqual({ phase: "finished" });
    }
  });

  it("keeps a failed machine's words on screen: no restart of this app after a part failed", async () => {
    const run = runOf("done", true);
    const mixed = { ...run, parts: [...run.parts, { part: "node", machineId: "mac", name: "mac", from: "0.0.0", state: "rolled_back", stage: "health" }] };
    const { d } = deps({ ok: true, run: mixed }, [], { kind: "ready", version: NEXT });
    await startUpdate(d);
    expect(d.app.install).not.toHaveBeenCalled();
    expect(currentFlow()).toEqual({ phase: "finished" });
  });

  it("ends without a restart when this app is current, and checks it first", async () => {
    const { d } = deps({ ok: true, run: runOf("current", true) }, [], { kind: "current" });
    await startUpdate(d);
    expect(d.app.check).toHaveBeenCalledOnce();
    expect(d.app.install).not.toHaveBeenCalled();
    expect(currentFlow()).toEqual({ phase: "finished" });
  });

  it("doesn't miss this app's update when the run ends before this app's check does", async () => {
    const { d } = deps({ ok: true, run: runOf("current", true) }, [], [
      { kind: "checking" },
      { kind: "checking" },
      { kind: "available", version: NEXT, percent: null, restart: false },
    ]);
    await startUpdate(d);
    expect(d.app.install).toHaveBeenCalledOnce();
    expect(currentFlow()).toEqual({ phase: "app" });
  });

  it("tells a hub from before the Update button to run fleetd update there once", async () => {
    const { d } = deps({ ok: false, error: { code: "not_found", message: "No tool hub_update.", fix: "Use a tool name from the hub's MCP tool list." } }, [], { kind: "current" });
    await startUpdate(d);
    expect(currentFlow()).toEqual({ phase: "refused", message: BEFORE_UPDATE });
    expect(BEFORE_UPDATE).toContain("Run `fleetd update` on the hub's machine once");
  });

  it("says why the hub refused", async () => {
    const { d } = deps(
      { ok: false, error: { code: "forbidden", message: "This key lacks the admin role.", fix: "Run `fleetd pair` on the hub machine." } },
      [],
      { kind: "current" },
    );
    await startUpdate(d);
    expect(currentFlow()).toEqual({ phase: "refused", message: "This key lacks the admin role. Run `fleetd pair` on the hub machine." });
  });

  it("follows a run another window started, and only shows a finished one", async () => {
    const going = deps({ ok: true }, [{ ok: true, run: runOf("restarting", false) }, { ok: true, run: runOf("done", true) }], { kind: "current" });
    await loadRun(going.d);
    expect(going.calls).toEqual(["hub_update_status", "hub_update_status"]);
    expect(currentFlow()).toEqual({ phase: "finished" });

    resetFlow();
    const done = deps({ ok: true }, [{ ok: true, run: runOf("done", true) }], { kind: "current" });
    await loadRun(done.d);
    expect(done.calls).toEqual(["hub_update_status"]);
    expect(currentFlow()).toEqual({ phase: "idle" });
  });
});
