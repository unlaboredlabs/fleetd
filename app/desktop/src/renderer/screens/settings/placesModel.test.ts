import { describe, expect, it } from "vitest";
import { isolationOf, loadWords, machineMark } from "./placesModel";

describe("a place's state", () => {
  it("marks a machine ready only while online with nothing failing", () => {
    expect(machineMark("online", undefined)).toBe("ready");
    expect(machineMark("online", "Claude is not logged in")).toBe("needs");
    expect(machineMark("offline", "Offline since Fri 09:03")).toBe("needs");
    expect(machineMark("degraded", "Needs a look")).toBe("needs");
  });

  it("says what runs on a well machine, only the kinds it is for, and Idle with nothing", () => {
    expect(loadWords({ agents: 8, screens: 2 })).toBe("8 agents · 2 screens");
    expect(loadWords({ agents: 1 })).toBe("1 agent");
    expect(loadWords({ screens: 1 })).toBe("1 screen");
    expect(loadWords({ agents: 0, screens: 0 })).toBe("Idle");
    expect(loadWords({})).toBe("Idle");
  });
});

describe("where a machine's agents run", () => {
  const MEM = "memory 60 GB, about 2 GB an agent";

  it("reads the node's own word, and keeps the cap's reason apart from it", () => {
    expect(isolationOf(`${MEM}; each agent in a VM of its own`, { kind: "microvm" })).toEqual({ why: MEM, isolation: { vm: true } });
    // In VMs, but agents with no Claude account of their bot's not (a machine signed in with `claude login`).
    expect(isolationOf(`${MEM}; each agent in a VM of its own, but no token`, { kind: "microvm", why: "no token, so some run as plain processes", fix: "claude setup-token" })).toEqual({
      why: MEM,
      isolation: { vm: true, why: "No token, so some run as plain processes.", fix: "claude setup-token" },
    });
    expect(isolationOf(`${MEM}; agents run as plain processes: no KVM Fix: sudo modprobe kvm`, { kind: "process", why: "no KVM", fix: "sudo modprobe kvm" })).toEqual({
      why: MEM,
      isolation: { vm: false, why: "No KVM.", expected: false, fix: "sudo modprobe kvm" },
    });
    // A VM that didn't start: its console comes along apart from the sentence, for whoever asks to see it.
    expect(isolationOf(`${MEM}; agents run as plain processes: the last VM didn't start`, { kind: "process", why: "the last VM didn't start", detail: "fleetd-init: …" }).isolation).toEqual({
      vm: false,
      why: "The last VM didn't start.",
      expected: false,
      detail: "fleetd-init: …",
    });
    // By choice or the machine's design: nothing to fix, even where a fix was given.
    expect(isolationOf(`${MEM}; agents run as plain processes: turned off`, { kind: "process", why: "turned off", fix: "x", expected: true }).isolation).toEqual({
      vm: false,
      why: "Turned off.",
      expected: true,
    });
  });

  it("reads the words alone a moment after a hub restart, and says nothing from a node that doesn't say", () => {
    expect(isolationOf(`${MEM}; each agent in a VM of its own`)).toEqual({ why: MEM, isolation: { vm: true } });
    // A reason with its own semicolon stays whole.
    expect(isolationOf(`${MEM}; agents run as plain processes: VMs need Linux with KVM; this machine runs macOS.`).isolation).toEqual({
      vm: false,
      why: "VMs need Linux with KVM; this machine runs macOS.",
      expected: false,
    });
    expect(isolationOf(`${MEM}; agents run as plain processes: AppArmor blocks it. Fix: sudo sysctl -w a=0`).isolation).toEqual({
      vm: false,
      why: "AppArmor blocks it.",
      expected: false,
      fix: "sudo sysctl -w a=0",
    });
    expect(isolationOf(MEM)).toEqual({ why: MEM });
  });
});
