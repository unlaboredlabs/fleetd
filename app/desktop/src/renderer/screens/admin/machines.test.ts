import { describe, expect, it } from "vitest";
import type { DoctorCheck, MachineHost } from "../../../shared/contracts";
import { fixPlace, needsOf, problemsOf, removeLine, repairOf, statusWords } from "./machines";

const hosts: MachineHost[] = [
  { machineId: "devbox", source: "hub", joined: true },
  { machineId: "builder-1", host: "builder-1", source: "set_up", joined: true },
  { machineId: "mac-mini", host: "mac-mini", source: "tailnet", joined: false },
];
const check = (id: string, status: DoctorCheck["status"], message = id): DoctorCheck => ({ id, scope: "machine", machineId: id.slice(0, id.indexOf("/")), status, message });

describe("Administration › Machines' model", () => {
  it("repairs over SSH where the hub reaches the machine, else with a line that enrolls it again", () => {
    expect(repairOf("builder-1", hosts)).toEqual({ kind: "plan", host: hosts[1] });
    expect(repairOf("devbox", hosts)).toEqual({ kind: "plan", host: hosts[0] });
    // Found on the tailnet: repaired as a machine, whatever the list said.
    expect(repairOf("mac-mini", hosts)).toEqual({ kind: "plan", host: { ...hosts[2], joined: true } });
    expect(repairOf("laptop", hosts)).toEqual({ kind: "line", machineId: "laptop", rejoin: true });
    expect(repairOf("laptop", undefined)).toEqual({ kind: "line", machineId: "laptop", rejoin: true });
  });

  it("says a machine's state in a few words: online, what the hub says is wrong, or offline since when", () => {
    expect(statusWords({ name: "laptop", status: "online" })).toBe("Online");
    // The hub's reason without its own "Fix: …": the page's row has the fix.
    expect(statusWords({ name: "laptop", status: "degraded", degradedReason: "claude is not logged in. Fix: claude auth login" })).toBe("Claude is not logged in");
    expect(statusWords({ name: "laptop", status: "degraded" })).toBe("Needs a look");
    expect(statusWords({ name: "laptop", status: "offline" })).toBe("Offline");
    // The hub last heard from it then.
    expect(statusWords({ name: "laptop", status: "offline", lastSeenAt: "2026-10-27T10:00:00.000Z" }, Date.parse("2026-11-07T12:00:00.000Z"))).toBe("Offline since Oct 27");
  });

  it("gives a list row its dot only where the machine needs someone, with why", () => {
    const laptop = { machineId: "laptop", name: "laptop" };
    expect(needsOf({ ...laptop, status: "online" }, undefined)).toBeUndefined();
    expect(needsOf({ ...laptop, status: "online" }, [check("laptop/claude_login", "ok"), check("laptop/android", "warn")])).toBeUndefined();
    // Online, but a check of its own failed; another machine's doesn't mark it.
    expect(needsOf({ ...laptop, status: "online" }, [check("laptop/claude_login", "fail", "claude is not logged in")])).toBe("Claude is not logged in");
    expect(needsOf({ ...laptop, status: "online" }, [check("devbox/claude_login", "fail")])).toBeUndefined();
    expect(needsOf({ ...laptop, status: "degraded", degradedReason: "claude is not logged in. Fix: claude auth login" }, [])).toBe("Claude is not logged in");
    expect(needsOf({ ...laptop, status: "offline" }, undefined)).toBe("Offline");
  });

  it("says where a fix runs as the hub says: the machine, or the hub's machine", () => {
    const fix = { kind: "manual", label: "Run machine setup again from the hub", command: "fleetd machine add builder-1" } as const;
    expect(fixPlace({ ...fix, on: "hub" }, "builder-1", hosts)).toBe("devbox, the hub");
    expect(fixPlace({ ...fix, on: "hub" }, "builder-1", undefined)).toBe("the hub's machine");
    expect(fixPlace({ ...fix, on: "machine" }, "builder-1", hosts)).toBe("builder-1");
    // A hub before it says: nowhere, and the label says where.
    expect(fixPlace(fix, "builder-1", hosts)).toBeNull();
  });

  it("says what Remove does: the service and the key, or the key alone", () => {
    expect(removeLine("builder-1", hosts)).toContain("stops and removes builder-1's node service");
    expect(removeLine("laptop", hosts)).toContain("It joined by itself");
  });

  it("makes a problem of each of the machine's own checks that failed or warns, failed first, and none of one that passed", () => {
    const fix = { kind: "manual", label: "Let ada use KVM", command: "sudo usermod -aG kvm ada", on: "machine" } as const;
    const problems = problemsOf(
      [
        check("laptop/claude_version", "ok", "claude 2.1.314"),
        { ...check("laptop/android", "warn", "Android screens are off: /dev/kvm isn't readable by ada."), fix },
        check("laptop/desktop", "warn", "Linux desktops are off on laptop. Turn them on in Screens."),
        check("laptop/claude_login", "fail", "laptop: claude is not logged in, so its sessions can't start."),
        check("laptop/commit_identity", "warn", "laptop has no commit identity. Fix: join it again."),
        check("laptop/git_fetch", "unknown", "laptop's node is not linked to the hub"),
        check("devbox/git_fetch", "fail"),
        // No iOS: the agents' Mac lends its simulators (D298), so its check isn't a screen here.
        check("laptop/ios", "fail", "iOS simulators are off"),
      ],
      "laptop",
    );
    // The hub's own words, cut to their first sentence, without the machine's name in front or the last period.
    expect(problems.map((p) => [p.key, p.failed, p.words])).toEqual([
      ["claude_login", true, "Claude is not logged in, so its sessions can't start"],
      ["commit_identity", false, "laptop has no commit identity"],
      ["android", false, "Android screens are off: /dev/kvm isn't readable by ada"],
      ["desktop", false, "Linux desktops are off on laptop"],
    ]);
    // Claude's login is fixed from the page; a screen kind with no command of the hub's, in Screens.
    expect(problems.map((p) => [p.login === true, p.screens === true, p.fix?.command])).toEqual([
      [true, false, undefined],
      [false, false, undefined],
      [false, false, "sudo usermod -aG kvm ada"],
      [false, true, undefined],
    ]);
    expect(problemsOf([check("laptop/claude_version", "ok"), check("laptop/claude_login", "ok"), check("laptop/android", "ok")], "laptop")).toEqual([]);
    expect(problemsOf([], "laptop")).toEqual([]);
  });
});
