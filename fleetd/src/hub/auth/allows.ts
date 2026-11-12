// A key's text and what its grants allow, without the database (index.ts checks keys against it).
import type { AgentKeyInfo, MachineId, Role } from "../../shared/contracts.ts";

export const sha256 = (text: string) => new Bun.CryptoHasher("sha256").update(text).digest("hex");

/** `^fld_[a-z2-7]{52}$` */
export const isAgentKey = (key: string) => /^fld_[a-z2-7]{52}$/.test(key);

/** Drops a leading `Bearer ` (any case, any run of whitespace), then trims. */
export function stripBearer(bearer: string): string {
  const scheme = bearer.slice(0, 6);
  if (scheme.toLowerCase() === "bearer") {
    const after = bearer.slice(6);
    const stripped = after.trimStart();
    if (stripped.length < after.length) return stripped.trim();
  }
  return bearer.trim();
}

export const RANK: Record<Role, number> = { read: 0, operate: 1, admin: 2 };

/**
 * Whether some grant gives at least `role` on `machine`. Without a machine (fleet-wide reads) any grant of that role
 * is enough; the caller then filters results per machine.
 */
export function allows(info: AgentKeyInfo, role: Role, machine?: MachineId): boolean {
  return (
    info.revokedAt === undefined &&
    info.grants.some(
      (g) => RANK[g.role] >= RANK[role] && (machine === undefined || g.machines === "*" || g.machines.includes(machine)),
    )
  );
}

/** Some grant of the caller's gives `role` on every machine (api/grants.rs `allows_everywhere`). */
export const allowsEverywhere = (caller: AgentKeyInfo, role: "admin" | "operate" | "read") =>
  caller.grants.some((g) => g.machines === "*" && allows({ ...caller, grants: [g] }, role));

/** Milliseconds as the hub writes timestamps: `2026-11-08T14:00:00.000Z`. */
export const isoMs = (ms: number) => new Date(ms).toISOString();
