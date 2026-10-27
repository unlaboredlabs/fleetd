import { describe, expect, it } from "vitest";
import type { MachineAddRun, MachineHost } from "../../../shared/contracts";
import { hereLine, hereOf, hostLine, joinSteps, lineState, lineWords, machineIdProblem, pickable, resumable, shortOutput } from "./model";

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
  const FP = "a".repeat(64);

  it("adds any computer that isn't the hub's through main, whatever its name", () => {
    const none = { kind: "none", fingerprint: "c".repeat(64) } as const;
    // Named as the hub's machine, but another computer: never the hub's own path.
    expect(hereOf([hub, builder], FP, "devbox.local", none, new Set())).toEqual({ kind: "app", machineId: "devbox", joined: false });
    expect(hereOf([hub, builder], FP, "Ada's MacBook", none, new Set(["ada-s-macbook"]))).toEqual({ kind: "app", machineId: "ada-s-macbook", joined: true });
    expect(hereOf([hub], FP, "", none, new Set())).toBeUndefined();
  });

  it("takes the hub's own path only on the computer whose fingerprint the hub gives", () => {
    // Added with --machine-id devbox, renamed since, or its hub's data in a folder of its own: the same computer.
    for (const kind of ["hub", "node", "none"] as const) {
      const here = kind === "node" ? { kind, machineId: "devbox", hub: "http://devbox:4790", fingerprint: FP } : { kind, fingerprint: FP };
      expect(hereOf([hub, builder], FP, "studio-2", here, new Set())).toEqual({ kind: "hub", machineId: "devbox", joined: true });
    }
    // A hub on another computer, or a hub that doesn't say: this app's hub can't add it.
    for (const fp of ["b".repeat(64), undefined]) {
      const here = hereOf([hub, builder], fp, "studio-2", { kind: "hub", fingerprint: FP }, new Set());
      expect(here).toEqual({ kind: "other-hub" });
      expect(hereLine(here)).toBe("This computer runs a different hub, so it can't be one of this hub's machines.");
    }
    // A computer whose OS gives no id is never taken for the hub's.
    expect(hereOf([hub], undefined, "devbox", { kind: "none" }, new Set())?.kind).toBe("app");
  });

  it("never adds a computer whose node is enrolled already", () => {
    const node = { kind: "node", machineId: "studio", hub: "http://devbox:4790" } as const;
    expect(hereOf([hub], FP, "laptop", node, new Set(["studio"]))).toEqual({ kind: "node", machineId: "studio", hub: "http://devbox:4790", ours: true });
    expect(hereLine(hereOf([hub], FP, "laptop", node, new Set(["studio"])))).toBe("This computer is already part of the hub as studio.");
    expect(hereLine(hereOf([hub], FP, "laptop", node, new Set()))).toBe("This computer is already part of another hub (http://devbox:4790) as studio.");
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

  it("names a machine as the hub will, and follows its line from waiting to joined", () => {
    expect(machineIdProblem("")).toContain("Give it a name");
    expect(machineIdProblem("Ada's laptop")).toContain("Lower-case letters");
    expect(machineIdProblem("x".repeat(33))).toContain("up to 32");
    expect(machineIdProblem(" laptop-2 ")).toBeUndefined();
    const at = Date.parse("2026-10-27T10:00:00.000Z");
    const line = { expiresAt: "2026-10-27T10:15:00.000Z", onlineAtStart: false };
    expect(lineState(line, false, at, true)).toBe("waiting");
    expect(lineState(line, true, at, true)).toBe("joined");
    expect(lineState(line, false, at + 15 * 60_000, true)).toBe("expired");
    // A repair of a machine still online: it waits until its node has restarted, never done before anything ran.
    const repair = { ...line, onlineAtStart: true };
    expect(lineState(repair, true, at, false)).toBe("online");
    expect(lineState(repair, false, at, true)).toBe("waiting");
    expect(lineState(repair, true, at, true)).toBe("joined");
    expect(lineState(repair, true, at + 15 * 60_000, false)).toBe("expired");
    expect(lineWords("waiting", "laptop")).toBe("Waiting for laptop…");
    expect(lineWords("joined", "laptop")).toBe("laptop joined.");
  });
});
