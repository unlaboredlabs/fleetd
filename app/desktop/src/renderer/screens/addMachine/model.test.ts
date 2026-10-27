import { describe, expect, it } from "vitest";
import type { MachineAddRun, MachineHost } from "../../../shared/contracts";
import { hereOf, hostLine, joinSteps, pickable, resumable, shortOutput } from "./model";

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
  it("adds the hub's own machine through the hub, and any other computer through main", () => {
    expect(hereOf([hub, builder], "devbox.local", new Set())).toEqual({ kind: "hub", machineId: "devbox", joined: true });
    expect(hereOf([hub, builder], "Ada's MacBook", new Set(["ada-s-macbook"]))).toEqual({ kind: "app", machineId: "ada-s-macbook", joined: true });
    expect(hereOf([hub], "", new Set())).toBeUndefined();
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
