import { describe, expect, it } from "vitest";
import type { DoctorCheck, MachineHost } from "../../../shared/contracts";
import { checklistOf, fixPlace, removeLine, repairOf, statusLine } from "./machines";

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

  it("says under a machine that isn't online what it needs, and where", () => {
    expect(statusLine({ name: "laptop", status: "online" })).toBeNull();
    expect(statusLine({ name: "laptop", status: "degraded", degradedReason: "claude is not logged in. Fix: claude auth login" })).toBe("Claude is not logged in. Open laptop for the fix.");
    expect(statusLine({ name: "laptop", status: "degraded" })).toBe("Something needs a look. Open laptop for the fix.");
    expect(statusLine({ name: "laptop", status: "offline" })).toContain("Repair sets its node up again");
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

  it("makes four items from the machine's own checks, the worst one deciding each", () => {
    const items = checklistOf(
      [
        check("laptop/claude_version", "ok", "claude 2.1.314"),
        check("laptop/claude_login", "fail", "not logged in"),
        check("laptop/commit_identity", "warn", "no identity"),
        check("devbox/git_fetch", "fail"),
        check("laptop/ios", "ok", "iOS screens are ready"),
      ],
      "laptop",
    );
    expect(items.map((i) => [i.key, i.state])).toEqual([
      ["claude", "failed"],
      ["identity", "warn"],
      ["github", "waiting"],
      ["capabilities", "done"],
    ]);
    expect(items[0]?.login).toBe(true);
    expect(items[0]?.lines).toEqual(["not logged in"]);
    expect(items[3]?.lines).toEqual(["iOS screens are ready"]);
    const ready = checklistOf([check("laptop/claude_version", "ok", "claude 2.1.314"), check("laptop/claude_login", "ok")], "laptop");
    expect(ready[0]).toEqual({ key: "claude", title: "Claude", state: "done", lines: ["claude 2.1.314"] });
  });
});
