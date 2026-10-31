import { afterEach, describe, expect, it, vi } from "vitest";
import type { Call, UpdatePart, UpdateRun } from "../../../shared/contracts";
import type { HubError } from "../../../shared/hub";
import type { AppUpdate, UpdatesState } from "../../../shared/updates";
import { BEFORE_UPDATE, currentAuto, currentFlow, currentReady, currentRun, loadRun, resetFlow, retryMachine, setAutoUpdates, startOver, startUpdate, updateNow, type FlowDeps } from "./flow";

const NEXT = "0.0.0-edge.202610261056+1b563d7";

const runOf = (hub: UpdatePart["state"], finished: boolean): UpdateRun => ({
  id: "U1",
  channel: "edge",
  to: NEXT,
  startedAt: "2026-10-26T10:00:00.000Z",
  ...(finished ? { finishedAt: "2026-10-26T10:03:00.000Z" } : {}),
  parts: [{ part: "hub", name: "the hub", from: "0.0.0", state: hub }],
});

type Answer = { ok: true; run?: UpdateRun; ready?: string } | { ok: false; error: HubError };

/** A hub that answers hub_update, then each hub_update_status in turn; and this app's updater. */
const deps = (start: Answer, statuses: Answer[], app: AppUpdate | AppUpdate[]) => {
  const calls: string[] = [];
  const inputs: unknown[] = [];
  const answer = (a: Answer) =>
    a.ok ? { ok: true as const, output: { ...(a.run === undefined ? {} : { run: a.run }), ...(a.ready === undefined ? {} : { ready: a.ready }) } } : a;
  const call = ((tool: string, input: unknown) => {
    calls.push(tool);
    inputs.push(input);
    const next = tool === "hub_update" ? start : (statuses.shift() ?? statuses[0] ?? start);
    return Promise.resolve(answer(next));
  }) as unknown as Call;
  // `app`, or each in turn per sleep: this app's own check moving on while the run goes.
  const apps: AppUpdate[] = Array.isArray(app) ? [...app] : [app];
  const state = (): UpdatesState => ({ current: "0.0.0-edge.202610251000+aaaaaaa", app: apps[0] ?? { kind: "idle" }, release: null });
  const d = {
    call,
    retry: vi.fn(),
    sleep: vi.fn((_ms: number) => {
      if (apps.length > 1) apps.shift();
      return Promise.resolve();
    }),
    app: { state, check: vi.fn(), install: vi.fn() },
  } satisfies FlowDeps;
  return { d, calls, inputs };
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
    // Read every half second: a part that settled shows within one, and the hub back from its restart is dialled again.
    expect(d.sleep.mock.calls.map(([ms]) => ms)).toEqual([500, 500, 500, 500]);
  });

  it("leaves this app alone when the hub didn't update, and ends", async () => {
    for (const hub of ["failed", "rolled_back"] as const) {
      resetFlow();
      const { d } = deps({ ok: true, run: runOf("downloading", false) }, [{ ok: true, run: runOf(hub, true) }], { kind: "ready", version: NEXT });
      await startUpdate(d);
      expect(d.app.install).not.toHaveBeenCalled();
      expect(currentFlow()).toEqual({ phase: "finished", updated: false });
    }
  });

  it("keeps a failed machine's words on screen: no restart of this app after a part failed", async () => {
    const run = runOf("done", true);
    const mixed = { ...run, parts: [...run.parts, { part: "node", machineId: "mac", name: "mac", from: "0.0.0", state: "rolled_back", stage: "health" }] };
    const { d } = deps({ ok: true, run: mixed }, [], { kind: "ready", version: NEXT });
    await startUpdate(d);
    expect(d.app.install).not.toHaveBeenCalled();
    expect(currentFlow()).toEqual({ phase: "finished", updated: false });
  });

  it("ends without a restart when this app is current, and checks it first", async () => {
    const { d } = deps({ ok: true, run: runOf("current", true) }, [], { kind: "current" });
    await startUpdate(d);
    expect(d.app.check).toHaveBeenCalledOnce();
    expect(d.app.install).not.toHaveBeenCalled();
    expect(currentFlow()).toEqual({ phase: "finished", updated: true });
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
    expect(currentFlow()).toEqual({ phase: "finished", updated: true });

    resetFlow();
    const done = deps({ ok: true }, [{ ok: true, run: runOf("done", true) }], { kind: "current" });
    await loadRun(done.d);
    expect(done.calls).toEqual(["hub_update_status"]);
    expect(currentFlow()).toEqual({ phase: "idle" });
  });

  it("ends updated, so the sheet closes itself, only when every machine came through", async () => {
    const run = runOf("done", true);
    const skipped = { ...run, parts: [...run.parts, { part: "node", machineId: "mac", name: "mac", from: "0.0.0", state: "skipped", message: "offline" }] };
    const calm = { ...run, parts: [...run.parts, { part: "claude", machineId: "mac", name: "mac", from: "2.1.310", state: "skipped", message: "Claude Code is managed by Homebrew" }] };
    for (const [r, updated] of [[run, true], [skipped, false], [calm, true]] as const) {
      resetFlow();
      const { d } = deps({ ok: true, run: r }, [], { kind: "current" });
      await startUpdate(d);
      expect(currentFlow()).toEqual({ phase: "finished", updated });
    }
  });

  it("reads the build the hub has ready, and forgets it once an update starts", async () => {
    const { d } = deps({ ok: true, run: runOf("downloading", false) }, [{ ok: true, ready: NEXT }, { ok: true, run: runOf("done", true) }], { kind: "current" });
    await loadRun(d);
    expect(currentReady()).toBe(NEXT);
    await startUpdate(d);
    expect(currentReady()).toBeNull();
  });

  it("retries one machine: the hub updates it again, and this app isn't restarted", async () => {
    const run = runOf("done", true);
    const again = { ...run, parts: [...run.parts, { part: "node", machineId: "mac", name: "mac", from: "0.0.0", state: "done" }] };
    const { d, calls, inputs } = deps(
      { ok: true, run: { ...again, finishedAt: undefined } as unknown as UpdateRun },
      [{ ok: true, run: again }],
      { kind: "ready", version: NEXT },
    );
    await retryMachine(d, "mac");
    expect(calls).toEqual(["hub_update", "hub_update_status"]);
    expect(inputs[0]).toEqual({ machine: "mac" });
    expect(d.app.install).not.toHaveBeenCalled();
    expect(currentFlow()).toEqual({ phase: "finished", updated: true });
  });

  it("says why the hub wouldn't retry", async () => {
    const { d } = deps(
      { ok: false, error: { code: "failed", message: "There is nothing to retry.", fix: "Press Update to update everything." } },
      [],
      { kind: "current" },
    );
    await retryMachine(d, "mac");
    expect(currentFlow()).toEqual({ phase: "refused", message: "There is nothing to retry. Press Update to update everything." });
  });

  it("never restarts this app at the end of a run this window didn't start, however long it ran", async () => {
    const { d } = deps(
      { ok: true },
      [{ ok: true, run: runOf("restarting", false) }, { ok: true, run: runOf("done", false) }, { ok: true, run: runOf("done", true) }],
      { kind: "ready", version: NEXT },
    );
    await loadRun(d);
    expect(d.app.install).not.toHaveBeenCalled();
    expect(currentFlow()).toEqual({ phase: "finished", updated: true });

    // Update pressed here afterwards still ends with the restart.
    resetFlow();
    const pressed = deps({ ok: true, run: runOf("current", true) }, [], { kind: "ready", version: NEXT });
    await startUpdate(pressed.d);
    expect(pressed.d.app.install).toHaveBeenCalledOnce();
  });

  it("starts over: the hub ends a run that stopped moving, and this window follows the new one through", async () => {
    const waiting: UpdatePart = { part: "node", machineId: "devbox", name: "devbox", from: "0.0.0", state: "waiting", message: "waits for 1 live session" };
    const stuck: UpdateRun = { ...runOf("done", false), parts: [...runOf("done", false).parts, waiting] };
    const fresh: UpdateRun = { ...runOf("current", true), id: "U2" };
    const calls: [string, unknown][] = [];
    let started = false;
    let now = 1_000;
    const call = ((tool: string, input: unknown) => {
      calls.push([tool, input]);
      if (tool === "hub_update") started = true;
      const output = tool === "hub_update" || started ? { run: fresh } : { run: stuck, leftOver: true };
      return Promise.resolve({ ok: true as const, output });
    }) as unknown as Call;
    const d = {
      call,
      retry: vi.fn(),
      now: () => now,
      // A real turn of the event loop, so the test acts while the run is followed.
      sleep: vi.fn(() => {
        now += 500;
        return new Promise<void>((done) => setTimeout(done, 0));
      }),
      app: { state: (): UpdatesState => ({ current: NEXT, app: { kind: "current" }, release: null }), check: vi.fn(), install: vi.fn() },
    } satisfies FlowDeps;

    const followed = loadRun(d);
    // Followed, unchanged since this window first read it, and the hub says nothing drives it.
    await vi.waitFor(() => expect(currentFlow()).toEqual({ phase: "following", reconnecting: false, since: 1_000, leftOver: true }));
    await startOver(d);
    await followed;
    expect(calls.filter(([tool]) => tool === "hub_update")).toEqual([["hub_update", { startOver: true }]]);
    // The earlier follow stopped: nothing read after the new run ended.
    expect(calls.at(-1)?.[0]).toBe("hub_update");
    expect(currentFlow()).toEqual({ phase: "finished", updated: true });
  });

  it("updates now: the hub stops its machines' wait for their agents, and the run followed goes on", async () => {
    const now: UpdateRun = { ...runOf("done", false), now: true };
    const { d, inputs } = deps({ ok: true, run: now }, [], { kind: "current" });
    await updateNow(d);
    expect(inputs).toEqual([{ now: true }]);
    expect(currentRun()?.now).toBe(true);
  });

  it("turns automatic updates on through the hub, keeps what it says, and passes on a refusal", async () => {
    const calls: [string, unknown][] = [];
    const call = ((tool: string, input: unknown) => {
      calls.push([tool, input]);
      return Promise.resolve({ ok: true as const, output: { settings: { auto: true, drainMinutes: 10 }, autoAt: "2026-10-26T11:00:00.000Z" } });
    }) as unknown as Call;
    expect(await setAutoUpdates({ call }, true)).toBeNull();
    expect(calls).toEqual([["hub_update_settings", { auto: true }]]);
    expect(currentAuto()).toEqual({ settings: { auto: true, drainMinutes: 10 }, at: "2026-10-26T11:00:00.000Z", skips: null });
    const refused = (() => Promise.resolve({ ok: false as const, error: { code: "forbidden", message: "Needs Admin.", fix: "Ask an owner." } })) as unknown as Call;
    expect(await setAutoUpdates({ call: refused }, false)).toBe("Needs Admin. Ask an owner.");
    expect(currentAuto()?.settings.auto).toBe(true);
  });
});
