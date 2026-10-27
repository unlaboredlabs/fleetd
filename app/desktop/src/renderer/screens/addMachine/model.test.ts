import { describe, expect, it } from "vitest";
import type { MachineAddRun, MachineHost } from "../../../shared/contracts";
import { hereLine, hereOf, hostLine, joinSteps, pickable, resumable, shortOutput } from "./model";

const hub: MachineHost = { machineId: "devbox", source: "hub", joined: true };
const builder: MachineHost = { machineId: "builder-1", host: "builder-1", source: "ssh_config", joined: false };
const mac: MachineHost = { machineId: "mac-mini", host: "mac-mini.tail1234.ts.net", source: "tailnet", joined: true };
const run = (runId: string, state: MachineAddRun["state"]): MachineAddRun => ({
  runId,
  machineId: "builder-1",
  state,
  steps: [],
  notes: [],
  startedAt: "2026-10-26T10:00:00.000Z",
});

describe("Add machine's model", () => {
  const ID = "a".repeat(64);

  it("adds any computer with no hub or node through main, whatever its name", () => {
    const none = { kind: "none" } as const;
    // Named as the hub's machine, but its fleetd dir holds no hub: never the hub's own path.
    expect(hereOf([hub, builder], ID, "devbox.local", none, new Set())).toEqual({ kind: "app", machineId: "devbox", joined: false });
    expect(hereOf([hub, builder], ID, "Ada's MacBook", none, new Set(["ada-s-macbook"]))).toEqual({ kind: "app", machineId: "ada-s-macbook", joined: true });
    expect(hereOf([hub], ID, "", none, new Set())).toBeUndefined();
  });

  it("takes the hub's own path only where this computer holds the connected hub", () => {
    // Added with --machine-id devbox, or renamed since: its name says nothing, its fleetd dir holds this very hub.
    expect(hereOf([hub, builder], ID, "studio-2", { kind: "hub", hubId: ID }, new Set())).toEqual({ kind: "hub", machineId: "devbox", joined: true });
    // A hub of its own, or one that has no id yet: this app's hub can't add it.
    for (const other of [{ kind: "hub", hubId: "b".repeat(64) }, { kind: "hub" }] as const) {
      const here = hereOf([hub, builder], ID, "studio-2", other, new Set());
      expect(here).toEqual({ kind: "other-hub" });
      expect(hereLine(here)).toBe("This computer runs a different hub, so it can't be one of this hub's machines.");
    }
  });

  it("never adds a computer whose node is enrolled already", () => {
    const node = { kind: "node", machineId: "studio", hub: "http://devbox:4790" } as const;
    expect(hereOf([hub], ID, "laptop", node, new Set(["studio"]))).toEqual({ kind: "node", machineId: "studio", hub: "http://devbox:4790", ours: true });
    expect(hereLine(hereOf([hub], ID, "laptop", node, new Set(["studio"])))).toBe("This computer is already part of the hub as studio.");
    expect(hereLine(hereOf([hub], ID, "laptop", node, new Set()))).toBe("This computer is already part of another hub (http://devbox:4790) as studio.");
  });

  it("lists hosts that aren't machines yet first, each with where the hub found it", () => {
    expect(pickable([hub, mac, builder]).map((h) => h.machineId)).toEqual(["builder-1", "devbox", "mac-mini"]);
    expect(hostLine(builder)).toBe("~/.ssh/config");
    expect(hostLine(mac)).toBe("mac-mini.tail1234.ts.net · tailnet");
    expect(hostLine(hub)).toBe("the hub's own machine");
  });

  it("opens on a run still going, else on the newest if it failed", () => {
    expect(resumable([run("a", "done"), run("b", "running")])?.runId).toBe("b");
    expect(resumable([run("a", "failed"), run("b", "done")])?.runId).toBe("a");
    expect(resumable([run("a", "done"), run("b", "failed")])).toBeUndefined();
  });

  it("shows a done step's short answer, never a long output", () => {
    expect(shortOutput({ state: "done", output: "enrolled" })).toBe("enrolled");
    expect(shortOutput({ state: "done", output: "a\nb" })).toBeUndefined();
    expect(shortOutput({ state: "failed", output: "enrolled" })).toBeUndefined();
  });

  it("ends this computer's join with the wait for its node", () => {
    const join = { machineId: "laptop", state: "done" as const, steps: [{ title: "put it in place", state: "done" as const }] };
    expect(joinSteps(join, false).at(-1)).toEqual({ title: "wait until laptop is online", state: "running" });
    expect(joinSteps(join, true).at(-1)?.state).toBe("done");
    expect(joinSteps({ ...join, state: "running" }, false).at(-1)?.state).toBe("planned");
  });
});
