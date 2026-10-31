import { describe, expect, it } from "vitest";
import type { HubState, UpdateRun } from "./desktop";
import type { Machine } from "./store";
import { shortVersion, UPDATE_NOTE, updateSection, type UpdateInput } from "./updates";

const NOW = Date.parse("2026-10-29T12:00:00Z");
const HUB: HubState = { phase: "live", hub: "http://devbox:4790", protocol: 1, version: "0.9.0" };
const machine = (machineId: string, nodeVersion = "0.9.0", status: Machine["status"] = "online"): Machine => ({
  machineId,
  name: machineId,
  nodeVersion,
  status,
  tags: [],
  lastSeenAt: "2026-10-29T11:59:00Z",
});
const MACHINES = [machine("devbox"), machine("buildbox")];

const input = (over: Partial<UpdateInput> = {}): UpdateInput => ({ admin: true, hub: HUB, machines: MACHINES, run: null, flow: { phase: "idle" }, ready: null, now: NOW, ...over });

const run = (parts: UpdateRun["parts"], finished = false): UpdateRun => ({
  id: "u1",
  channel: "stable",
  to: "0.9.1",
  startedAt: "2026-10-29T11:58:00Z",
  ...(finished ? { finishedAt: "2026-10-29T11:59:30Z" } : {}),
  parts,
});
const part = (p: "hub" | "node", name: string, state: string, extra: Partial<UpdateRun["parts"][number]> = {}): UpdateRun["parts"][number] => ({
  part: p,
  name,
  from: "0.9.0",
  state,
  ...(p === "node" ? { machineId: name } : {}),
  ...extra,
});

describe("updateSection", () => {
  it("offers the hub's ready build to an admin, and to no one else", () => {
    expect(updateSection(input({ ready: "0.9.1" }))).toEqual({ offer: { title: "Update fleetd", detail: "0.9.1 is ready", note: UPDATE_NOTE }, progress: null, parts: [], going: false, startOver: null, updateNow: false });
    expect(updateSection(input({ ready: "0.9.1", admin: false }))).toBeNull();
    // Not read yet: nothing, rather than a row that comes and goes.
    expect(updateSection(input({ ready: "0.9.1", admin: undefined }))).toBeNull();
    expect(updateSection(input({ ready: "0.9.1", hub: { phase: "retrying", hub: HUB.hub, reason: "gone", retryAt: NOW } }))).toBeNull();
  });

  it("offers it for a machine behind the hub, and says nothing when all are up to date", () => {
    expect(updateSection(input({ machines: [machine("devbox"), machine("buildbox", "0.8.9")] }))?.offer).toEqual({ title: "Update fleetd", detail: "0.9.0 is available", note: UPDATE_NOTE });
    expect(updateSection(input())).toBeNull();
  });

  it("puts an Edge build's label under the title, where it fits", () => {
    expect(updateSection(input({ hub: { ...HUB, version: "0.0.0-edge.202610281816+e6ed04e" }, machines: [], ready: "0.0.0-edge.202610292301+c1d2e3f4" }))?.offer).toEqual({ title: "Update fleetd", detail: "Edge · Oct 29, 23:01 UTC · c1d2e3f is ready", note: UPDATE_NOTE });
  });

  it("follows a run: starting, the hub, then the machines one by one", () => {
    expect(updateSection(input({ ready: "0.9.1", flow: { phase: "starting" } }))).toMatchObject({ offer: null, progress: { text: "Starting the update…" }, going: true });
    const hubGoing = updateSection(input({ flow: { phase: "following", reconnecting: true, since: NOW }, run: run([part("hub", "devbox", "restarting"), part("node", "devbox", "waiting"), part("node", "buildbox", "waiting")]) }));
    expect(hubGoing?.progress?.text).toBe("Updating the hub…");
    expect(hubGoing?.parts.map((p) => p.name)).toEqual(["The hub", "buildbox", "devbox"]);
    const machines = updateSection(input({ hub: { ...HUB, version: "0.9.1" }, flow: { phase: "following", reconnecting: false, since: NOW }, run: run([part("hub", "devbox", "done"), part("node", "buildbox", "done"), part("node", "devbox", "downloading")]) }));
    expect(machines?.progress?.text).toBe("Updating the machines: 1 of 2 done");
    expect(machines?.parts.map((p) => [p.name, p.state])).toEqual([
      ["The hub", "Done"],
      ["buildbox", "Done"],
      ["devbox", "Updating…"],
    ]);
  });

  it("ends in the outcome: updated, or a machine put back with Retry", () => {
    const done = updateSection(input({ hub: { ...HUB, version: "0.9.1" }, machines: [machine("devbox", "0.9.1"), machine("buildbox", "0.9.1")], flow: { phase: "finished", updated: true }, run: run([part("hub", "devbox", "done"), part("node", "buildbox", "done"), part("node", "devbox", "done")], true) }));
    expect(done).toMatchObject({ offer: null, progress: { tone: "quiet", text: "Updated to 0.9.1" }, going: false });
    const back = updateSection(
      input({
        hub: { ...HUB, version: "0.9.1" },
        machines: [machine("devbox"), machine("buildbox", "0.9.1")],
        flow: { phase: "finished", updated: false },
        run: run([part("hub", "devbox", "done"), part("node", "buildbox", "done"), part("node", "devbox", "rolled_back", { stage: "health", message: "the node didn't come back" })], true),
      }),
    );
    expect(back?.progress).toEqual({ tone: "danger", text: "Update failed: devbox. The rest updated; Retry tries it again." });
    expect(back?.parts.find((p) => p.name === "devbox")).toMatchObject({ tone: "danger", retry: { kind: "machine", machineId: "devbox" } });
  });

  it("says why the hub wouldn't start it", () => {
    expect(updateSection(input({ ready: "0.9.1", flow: { phase: "refused", message: "Only an admin can update the hub." } }))?.progress).toEqual({ tone: "danger", text: "Couldn't start the update: Only an admin can update the hub." });
  });
});

describe("shortVersion", () => {
  it("keeps an Edge build to its day and minute, and a release as it is", () => {
    expect(shortVersion("0.0.0-edge.202610291816+e6ed04e")).toBe("Edge · Oct 29, 18:16");
    expect(shortVersion("0.9.1")).toBe("0.9.1");
    expect(shortVersion("0.9.1+abc1234")).toBe("0.9.1");
  });
});
