// `people.changed` (`announce`, `account_removed`), and the seam other
// areas use to forget a person removed from the hub.
import type { PeopleChange, PeopleChangedData, PersonId, PersonRef } from "../../shared/contracts.ts";
import type { Hub } from "../api/hub.ts";
import { events } from "../store/events.ts";
import { isoMs } from "../store/time.ts";

/** `people.changed` about `person`, by `by`. */
export const change = (change: PeopleChange, person: PersonRef, by: PersonRef | undefined): PeopleChangedData => ({
  ...(by === undefined ? {} : { by }),
  change,
  person,
});

/** Appends `people.changed` to the hub's log. A failure to record it is logged, never the call's. */
export function announce(hub: Hub, data: PeopleChangedData, summary: string): void {
  try {
    // Keys in the Rust struct's order: change, person, by, inviteId, keyId.
    const ordered: Record<string, unknown> = { change: data.change, person: data.person };
    if (data.by !== undefined) ordered.by = data.by;
    if (data.inviteId !== undefined) ordered.inviteId = data.inviteId;
    if (data.keyId !== undefined) ordered.keyId = data.keyId;
    events(hub).append({ at: isoMs(hub.clock.now()), type: "people.changed", summary, data: ordered });
  } catch (error) {
    console.warn("people.changed event not recorded:", error);
  }
}

/**
 * `people.changed` for one of `person`'s accounts removed (`what`: "Claude subscription", "1Password token",
 * "GitHub connection"): every open app reads the Hub's people and that person's accounts again.
 */
export const accountRemoved = (hub: Hub, person: PersonRef, what: string) =>
  announce(hub, change("account_removed", person, person), `${person.name} removed their ${what}`);

/**
 * What else goes with a removed person, in the Rust hub's order: their Claude subscription, 1Password token and GitHub
 * connection are forgotten. Each owning area adds its own with `onPersonRemoved(hub, fn)`; until it does, nothing more happens.
 */
type Forget = (personId: PersonId) => Promise<void> | void;

const forgets = (hub: Hub) => hub.area("people_forget", () => [] as Forget[]);

export function onPersonRemoved(hub: Hub, fn: Forget): void {
  forgets(hub).push(fn);
}

/** Runs every area's forget for `personId`; one failing is logged and the rest still run. */
export async function forgetPerson(hub: Hub, personId: PersonId): Promise<void> {
  for (const fn of forgets(hub)) {
    try {
      await fn(personId);
    } catch (error) {
      console.warn("people: forgetting a removed person failed:", error);
    }
  }
}
