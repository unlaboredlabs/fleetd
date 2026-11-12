// What screens read of other areas' tables, by the Rust tree's own queries: people (hub/people), projects' repos and
// tasks' ends (hub/machine_roles `task_ended`). Reads only; their owners write them.
import type { Database } from "bun:sqlite";
import type { PersonRef, ProjectRef } from "../../shared/contracts.ts";
import type { HubDb } from "../store/db.ts";

type PersonRow = { person_id: string; name: string };

/** The first owner still on the hub (people/mod.rs `owner_on`). */
export function ownerOn(c: Database): PersonRef | undefined {
  const row = c
    .query<PersonRow, []>(
      "SELECT person_id, name FROM people WHERE role = 'owner' AND removed_ms IS NULL ORDER BY created_ms, rowid LIMIT 1",
    )
    .get();
  return row ? { personId: row.person_id, name: row.name } : undefined;
}

/** A person by id (people/mod.rs `get_on`). */
export function personOn(c: Database, id: string): PersonRef | undefined {
  const row = c.query<PersonRow, [string]>("SELECT person_id, name FROM people WHERE person_id = ?").get(id);
  return row ? { personId: row.person_id, name: row.name } : undefined;
}

const OWNER_FALLBACK = "Owner";
const ALPHABET = "abcdefghijklmnopqrstuvwxyz234567";

/** RFC 4648 base32, lower case, unpadded (hub/auth `base32`). */
function base32(bytes: Uint8Array): string {
  let out = "";
  let bits = 0;
  let value = 0;
  for (const b of bytes) {
    value = (value << 8) | b;
    bits += 8;
    while (bits >= 5) {
      out += ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

/**
 * The hub's owner, made for a key with no person on a hub that has none yet (people/mod.rs `ensure_owner_on`). The
 * person's id is `p_` and 5 random bytes in base32, as `new_id` makes it.
 */
export function ensureOwnerOn(c: Database, name: string, now: number): PersonRef {
  const found = ownerOn(c);
  if (found) return found;
  const id = `p_${base32(crypto.getRandomValues(new Uint8Array(5)))}`;
  const clean = name.trim().slice(0, 60) || OWNER_FALLBACK;
  c.query("INSERT INTO people (person_id, name, role, created_ms) VALUES (?, ?, 'owner', ?)").run(id, clean, now);
  c.query("UPDATE agent_keys SET person_id = ? WHERE kind = 'human' AND person_id IS NULL").run(id);
  return { personId: id, name: clean };
}

/** The project's GitHub repos (`owner/name`) from its attached repos (hub/projects repos_of). */
export function projectRepos(db: HubDb, r: ProjectRef): string[] {
  const rows = db.all<{ repo_key: string | null }>(
    "SELECT repo_key FROM repos WHERE machine_id = ? AND project_id = ?",
    [r.machineId, r.projectId],
  );
  return rows.flatMap((row) => (row.repo_key?.startsWith("github.com/") ? [row.repo_key.slice("github.com/".length)] : []));
}
