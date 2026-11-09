// doctor_list and doctor_fix.
import type { DoctorCheck, MachineId } from "../../shared/contracts.ts";
import { ToolError } from "../../shared/errors.ts";
import { allows } from "../auth/index.ts";
import { isHuman, readable, requireRole } from "../api/grants.ts";
import type { Registry } from "../api/registry.ts";
import { doctor, machineOf } from "./index.ts";

/** A machine id as the contracts check it (`MachineId`'s pattern). */
const MACHINE_ID = /^[a-z0-9-]{1,32}$/;

export function register(tools: Registry): void {
  tools.add("doctor_list", async (hub, caller, input) => {
    if (input.machineId !== undefined) requireRole(caller, "read", input.machineId);
    const results = await doctor(hub).list(input.rerun === true);
    const wanted = input.machineId;
    const shown = results.checks.filter((c) =>
      c.machineId === undefined
        ? wanted === undefined
        : MACHINE_ID.test(c.machineId) && readable(caller, c.machineId) && (wanted === undefined || wanted === c.machineId),
    );
    const failing = shown.filter((c) => c.status === "fail" || c.status === "warn");
    const next = failing.some((c) => c.fix?.kind === "auto")
      ? "Run doctor_fix with a checkId to apply its automatic fix; manual fixes name the command to run."
      : failing.length > 0
        ? "Each failing check names the command that fixes it."
        : "Every check passes. rerun: true runs them now; the hub also runs them every 15 minutes and emits doctor.changed.";
    // Each machine's check carries when that machine's checks last ran.
    const checks: DoctorCheck[] = shown.map((c) => {
      const at = c.machineId === undefined ? undefined : results.machinesCheckedAt.get(c.machineId);
      return at === undefined ? c : { ...c, checkedAt: at };
    });
    return { checks, checkedAt: results.checkedAt, next };
  });

  tools.add("doctor_fix", async (hub, caller, input) => {
    const scope = machineOf(input.checkId);
    const machine = scope !== undefined && MACHINE_ID.test(scope) ? (scope as MachineId) : undefined;
    // The fixes are safe but act on machines: admin keys, or a person's own device (a human key).
    if (!allows(caller, "admin", machine) && !(isHuman(caller) && allows(caller, "operate", machine))) {
      throw new ToolError(
        "forbidden",
        "doctor_fix needs an admin key, or a person's device (a human key) with operate on the machine.",
        "Run it from the desktop app, or with a key from fleetd hub key create --role admin.",
      );
    }
    const refused = await doctor(hub).fix(input.checkId);
    throw new ToolError("invalid", refused.message, refused.fix);
  });
}
