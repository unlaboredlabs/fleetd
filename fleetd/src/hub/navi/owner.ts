// Who a caller acts as. Every project is everyone's on its hub (D491): nothing here hides or refuses one.
//
// A key with no person counts as the hub's owner.
import type { Database } from "bun:sqlite";
import type { PersonId, ProjectRef } from "../../shared/contracts.ts";
import type { Caller } from "../api/registry.ts";

const key = (r: ProjectRef) => `${r.machineId}\u0000${r.projectId}`;

/** A set of project refs, by value. */
export class Refs {
  private readonly keys: Set<string>;
  constructor(refs: ProjectRef[]) {
    this.keys = new Set(refs.map(key));
  }
  get size(): number {
    return this.keys.size;
  }
  has(r: ProjectRef): boolean {
    return this.keys.has(key(r));
  }
}

function ownerOn(c: Database): PersonId | undefined {
  return (
    c
      .query<{ person_id: string }, []>(
        "SELECT person_id FROM people WHERE role = 'owner' AND removed_ms IS NULL ORDER BY created_ms, rowid LIMIT 1",
      )
      .get()?.person_id ?? undefined
  );
}

/** The person `caller` acts as: their own, or the hub's first owner for a key with no person. */
export function who(c: Database, caller: Caller): PersonId | undefined {
  return caller.person ? caller.person.personId : ownerOn(c);
}
