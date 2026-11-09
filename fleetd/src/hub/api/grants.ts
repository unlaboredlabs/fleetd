// The grant checks handlers share, with the same words.
import type { MachineId, Role } from "../../shared/contracts.ts";
import { ToolError } from "../../shared/errors.ts";
import { allows } from "../auth/index.ts";
import type { Caller } from "./registry.ts";

/** The fix for a person's device refused an admin write. */
export const REPAIR_FIX =
  "Run `fleetd pair` on the hub machine, then pair this app again with the new code: it grants admin.";

export const isHuman = (caller: Caller) => caller.kind === "human";

export function forbidden(role: Role, machine?: MachineId): ToolError {
  const message = machine === undefined ? `This key lacks the ${role} role.` : `This key has no ${role} grant on machine ${machine}.`;
  return new ToolError(
    "forbidden",
    message,
    "Ask the hub admin for a key with that grant (fleetd hub key create --role … --machines …).",
  );
}

/** `forbidden`, with the re-pair fix when a person's device lacks admin. */
export function refused(caller: Caller, role: Role, machine?: MachineId): ToolError {
  const refusal = forbidden(role, machine);
  return role === "admin" && isHuman(caller) ? new ToolError(refusal.code, refusal.message, REPAIR_FIX) : refusal;
}

/** Throws unless some grant of the caller's gives at least `role` (on `machine`, when named). */
export function requireRole(caller: Caller, role: Role, machine?: MachineId): void {
  if (!allows(caller, role, machine)) throw refused(caller, role, machine);
}

/** Whether the key may read `machine`: the per-item filter for fleet-wide lists. */
export const readable = (caller: Caller, machine: MachineId) => allows(caller, "read", machine);
