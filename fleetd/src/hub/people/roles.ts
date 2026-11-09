// A person's hub role and what it caps (crates/fleetd/src/hub/people/mod.rs `role_of`, `role_cap`, `capped`,
// `clean_name`).
import type { Grant, HubRole, Role } from "../../shared/contracts.ts";

/** The owner's name when the machine's user has none. */
export const OWNER_FALLBACK = "Owner";

/** An unreadable role grants the least, never more. */
export function roleOf(text: string): HubRole {
  return text === "owner" ? "owner" : text === "admin" ? "admin" : "member";
}

export const administers = (role: HubRole) => role === "owner" || role === "admin";

/** The most a device of a person in `role` may hold: a member operates, an owner or admin administers. */
export const roleCap = (role: HubRole): Role => (administers(role) ? "admin" : "operate");

const RANK: Record<Role, number> = { read: 0, operate: 1, admin: 2 };

/** `grants` with nothing above `cap`: what a device may do once its person's role is applied. */
export function capped(grants: Grant[], cap: Role): Grant[] {
  return grants.map((g) => ({ role: RANK[g.role] <= RANK[cap] ? g.role : cap, machines: g.machines }));
}

/** A person's name as given: trimmed, control characters dropped, at most 80 characters; undefined when empty. */
export function cleanName(name: string): string | undefined {
  const kept = [...name.trim().replace(/\p{Cc}/gu, "")].slice(0, 80).join("").trim();
  return kept === "" ? undefined : kept;
}
