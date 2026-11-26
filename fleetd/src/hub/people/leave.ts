// Removing a person from the workspace, the one way the app's person_remove and `fleetd people remove` both take: their
// devices and open invites go at once, their Claude subscription, 1Password token and GitHub connection are forgotten
// everywhere, what waited on them in the chats waits on the owner, and each area's own forget (`onPersonRemoved`) runs
// after.
import type { Person, PersonRef } from "../../shared/contracts.ts";
import { ToolError } from "../../shared/errors.ts";
import type { Hub } from "../api/hub.ts";
import { forgetPerson as forgetClaude } from "../claude_accounts/tools.ts";
import { chat } from "../chat/index.ts";
import { state } from "../chat/flow.ts";
import { forgetPerson as forgetGitHub } from "../github_app/sessions.ts";
import { forgetPerson as forgetOnePassword } from "../onepassword/index.ts";
import { announce, change, forgetPerson } from "./events.ts";
import { ownerOn, people, refOf } from "./store.ts";

/** Hands what waited on `person` to the workspace's owner, and says each chat's new state. */
function handOn(hub: Hub, person: PersonRef): void {
  const owner = ownerOn(hub.db.conn);
  if (!owner || owner.personId === person.personId) return;
  for (const r of chat(hub).handOn(person, refOf(owner))) state(hub, r);
}

/** No such person, or one already removed. */
export const unknownPerson = (id: string) =>
  new ToolError("not_found", `No person ${id} on this workspace.`, "Call people_list to see the workspace's people.");

/**
 * Removes `id` from the workspace, `by` the owner or admin who asked (absent: from the workspace's machine, by
 * `fleetd people remove`). An owner goes only by an owner's hand, and never the last one. The person, and how many
 * devices were signed out.
 */
export async function removeFromWorkspace(hub: Hub, id: string, by?: Person): Promise<{ person: Person; revoked: number }> {
  const all = people(hub);
  const found = all.get(id);
  if (!found || found.removedAt !== undefined) throw unknownPerson(id);
  if (found.role === "owner") {
    if (by !== undefined && by.role !== "owner") throw new ToolError("forbidden", "Only an owner removes an owner.", "Ask an owner.");
    if (all.owners() <= 1) throw new ToolError("invalid", `${found.name} is the workspace's only owner.`, "Make someone else an owner first.");
  }
  const removed = all.remove(id);
  if (!removed) throw unknownPerson(id);
  const { person } = removed;
  // Their devices' open app connections close now, not at their next call.
  hub.auth.revokedSome();
  await leave(hub, refOf(person));
  const summary = by === undefined ? `${person.name} was removed from the workspace` : `${by.name} removed ${person.name} from the workspace`;
  announce(hub, change("removed", refOf(person), by === undefined ? undefined : refOf(by)), summary);
  return removed;
}

/** What goes with a removed person, after their row and devices. */
export async function leave(hub: Hub, person: PersonRef): Promise<void> {
  const steps: [string, () => Promise<void> | void][] = [
    ["Claude subscription", () => forgetClaude(hub, person.personId)],
    ["1Password token", () => forgetOnePassword(hub, person.personId)],
    ["GitHub connection", () => forgetGitHub(hub, person.personId)],
    ["waiting cards and questions", () => handOn(hub, person)],
  ];
  for (const [what, step] of steps) {
    try {
      await step();
    } catch (error) {
      console.warn(`people: a removed person's ${what} not handled:`, error);
    }
  }
  await forgetPerson(hub, person.personId);
}
