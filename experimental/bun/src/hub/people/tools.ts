// The app's people tools (crates/fleetd/src/hub/people/tools.rs): people_list for everyone; invite_create,
// invite_revoke, person_set and person_remove for an owner's or admin's device; device_revoke for a person's own
// devices, or anyone's for an owner or admin.
import type { AgentKeyInfo, Grant, HubRole, LeftProject, Person, Role } from "../../shared/contracts.ts";
import { internalError, ToolError } from "../../shared/errors.ts";
import { allows } from "../auth/index.ts";
import { isHuman } from "../api/grants.ts";
import type { Hub } from "../api/hub.ts";
import type { Caller, Registry } from "../api/registry.ts";
import { pairCodes } from "../pair/codes.ts";
import { deepLink } from "../pair/urls.ts";
import { store } from "../store/hub_store.ts";
import * as avatar from "./avatar.ts";
import { announce, change, forgetPerson } from "./events.ts";
import { administers, cleanName } from "./roles.ts";
import { people, refOf } from "./store.ts";

/** `PEOPLE_MAX`: the most items a people list holds. */
const PEOPLE_MAX = 500;

/** Whether some grant on every machine (`*`) gives at least `role` (grants.rs `allows_everywhere`). */
export const allowsEverywhere = (caller: Caller, role: Role) =>
  caller.grants.some((g: Grant) => g.machines === "*" && allows({ ...caller, grants: [g] }, role));

/**
 * The caller's person, when it is an owner's or admin's device that may administer the hub: a human key of theirs
 * with admin on every machine.
 */
export function administrator(hub: Hub, caller: Caller): Person | undefined {
  if (!isHuman(caller) || caller.person === undefined) return undefined;
  const person = people(hub).get(caller.person.personId);
  return person && administers(person.role) && allowsEverywhere(caller, "admin") ? person : undefined;
}

function requireAdministrator(hub: Hub, caller: Caller): Person {
  const admin = administrator(hub, caller);
  if (admin) return admin;
  throw new ToolError(
    "forbidden",
    "Only the hub's owners and admins invite people, change roles and remove people.",
    "Ask an owner or admin of the hub, on the Hub pages of the app's Settings or with `fleetd invite` on the hub.",
  );
}

const unknownPerson = (id: string) =>
  new ToolError("not_found", `No person ${id} on this hub.`, "Call people_list to see the hub's people.");

/** What an admin may hand out: an owner gives any role; an admin, admin or member. */
function mayGrant(by: Person, role: HubRole): void {
  if (role === "owner" && by.role !== "owner") {
    throw new ToolError("forbidden", "Only an owner makes someone an owner.", "Pick admin or member, or ask an owner.");
  }
}

/** The Only-me projects removed people left, by name alone: what an owner or admin needs to delete them. */
function left(hub: Hub): LeftProject[] {
  // crates/fleetd/src/hub/navi/store.rs `left`.
  const rows = hub.db.all<{ machine_id: string; project_id: string; owner_person: string }>(
    `SELECT s.machine_id, s.project_id, s.owner_person FROM project_settings s
     JOIN people p ON p.person_id = s.owner_person
     WHERE s.only_me = 1 AND p.removed_ms IS NOT NULL ORDER BY s.created_ms, s.rowid`,
  );
  const out: LeftProject[] = [];
  for (const row of rows.slice(0, PEOPLE_MAX)) {
    const project = store(hub).projectGet({ machineId: row.machine_id, projectId: row.project_id });
    const owner = people(hub).personRef(row.owner_person);
    if (!project || !owner) continue;
    out.push({
      machineId: row.machine_id,
      owner,
      path: project.workspaceRoot,
      projectId: row.project_id,
      title: project.title,
    });
  }
  return out;
}

const humanDevices = (hub: Hub): AgentKeyInfo[] =>
  hub.auth.keys.list().filter((key) => key.kind === "human" && key.revokedAt === undefined);

export function register(tools: Registry): void {
  tools.add("people_list", (hub, caller, input) => {
    const admin = administrator(hub, caller) !== undefined;
    const list = people(hub).list(input.includeRemoved === true);
    const me = isHuman(caller) ? caller.person?.personId : undefined;
    const devices = humanDevices(hub).filter(
      (key) => admin || (me !== undefined && key.person?.personId === me),
    );
    return {
      devices,
      invites: admin ? pairCodes(hub).invites(false) : [],
      ...(admin ? { left: left(hub) } : {}),
      ...(me === undefined ? {} : { me }),
      people: list,
      ...(isHuman(caller) ? { thisDevice: caller.keyId } : {}),
    };
  });

  tools.add("invite_create", (hub, caller, input) => {
    const by = requireAdministrator(hub, caller);
    const all = people(hub);
    let person: Person;
    let fresh: boolean;
    if (input.personId !== undefined) {
      // The contract refuses a name or role with personId, and a new person without a name.
      const found = all.get(input.personId);
      if (!found || found.removedAt !== undefined) throw unknownPerson(input.personId);
      if (found.role === "owner" && by.role !== "owner") {
        throw new ToolError("forbidden", "Only an owner pairs a device for an owner.", "Ask an owner to invite their device.");
      }
      person = found;
      fresh = false;
    } else {
      const role = input.role ?? "member";
      mayGrant(by, role);
      const name = input.name === undefined ? undefined : cleanName(input.name);
      if (name === undefined) throw new ToolError("invalid", "A new person needs a name.", "Give the person's name.");
      person = all.create(name, role);
      fresh = true;
    }
    const { minted, invite } = pairCodes(hub).createInvite(person, by.personId);
    const hubUrl = hub.url();
    const summary = fresh
      ? `${by.name} invited ${person.name} as ${person.role}`
      : `${by.name} invited another device of ${person.name}`;
    announce(hub, { ...change("invited", refOf(person), refOf(by)), inviteId: invite.inviteId }, summary);
    return {
      code: minted.code,
      hubUrl,
      invite,
      link: deepLink(hubUrl, minted.code),
      next: `Send the link or the code to ${person.name}: it works once, until ${minted.expiresAt}.`,
    };
  });

  tools.add("invite_revoke", (hub, caller, input) => {
    const by = requireAdministrator(hub, caller);
    const revoked = pairCodes(hub).revokeInvite(input.inviteId);
    if (!revoked) {
      throw new ToolError("not_found", `No invite ${input.inviteId}.`, "Call people_list to see the open invites.");
    }
    const { invite } = revoked;
    // Revoking it again changes nothing and says nothing.
    if (revoked.revoked) {
      // Someone invited by it who never joined goes with it.
      const all = people(hub);
      const joined = hub.auth.keys.list().some((key) => key.person?.personId === invite.person.personId);
      const person = all.get(invite.person.personId);
      if (!joined && person && person.removedAt === undefined && person.role !== "owner") all.remove(person.personId);
      announce(
        hub,
        { ...change("invite_revoked", invite.person, refOf(by)), inviteId: invite.inviteId },
        `${by.name} revoked the invite for ${invite.person.name}`,
      );
    }
    return { invite };
  });

  tools.add("person_set", (hub, caller, input) => {
    const by = requireAdministrator(hub, caller);
    const all = people(hub);
    const id = input.personId;
    const person = all.get(id);
    if (!person || person.removedAt !== undefined) throw unknownPerson(id);
    let name: string | undefined;
    if (input.name !== undefined) {
      name = cleanName(input.name);
      if (name === undefined) throw new ToolError("invalid", "The name is empty.", "Give the person's name.");
    }
    const role = input.role !== undefined && input.role !== person.role ? input.role : undefined;
    if (role !== undefined) {
      if (person.role === "owner" && by.role !== "owner") {
        throw new ToolError("forbidden", "Only an owner changes an owner's role.", "Ask an owner.");
      }
      mayGrant(by, role);
      if (person.role === "owner" && all.owners() <= 1) {
        throw new ToolError("invalid", `${person.name} is the hub's only owner.`, "Make someone else an owner first.");
      }
    }
    const after = all.set(id, name, role);
    if (!after) throw unknownPerson(id);
    if (role !== undefined) {
      announce(hub, change("role_changed", refOf(after), refOf(by)), `${by.name} made ${after.name} ${role}`);
    }
    if (after.name !== person.name) {
      announce(hub, change("renamed", refOf(after), refOf(by)), `${by.name} renamed ${person.name} to ${after.name}`);
    }
    return { person: after };
  });

  tools.add("person_remove", async (hub, caller, input) => {
    const by = requireAdministrator(hub, caller);
    const all = people(hub);
    const id = input.personId;
    const found = all.get(id);
    if (!found || found.removedAt !== undefined) throw unknownPerson(id);
    if (found.role === "owner") {
      if (by.role !== "owner") throw new ToolError("forbidden", "Only an owner removes an owner.", "Ask an owner.");
      if (all.owners() <= 1) {
        throw new ToolError("invalid", `${found.name} is the hub's only owner.`, "Make someone else an owner first.");
      }
    }
    const removed = all.remove(id);
    if (!removed) throw unknownPerson(id);
    const { person, revoked } = removed;
    // Their devices' open app connections close now, not at their next call.
    hub.auth.revokedSome();
    // Their archived Only-me projects' leads, Claude subscription, 1Password token and GitHub connection go too.
    await forgetPerson(hub, person.personId);
    announce(hub, change("removed", refOf(person), refOf(by)), `${by.name} removed ${person.name} from the hub`);
    return { person, revoked };
  });

  tools.add("device_revoke", (hub, caller, input) => {
    const notFound = () =>
      new ToolError("not_found", `No device ${input.keyId}.`, "Call people_list to see the devices you may sign out.");
    const device = hub.auth.keys.list().find((key) => key.keyId === input.keyId && key.kind === "human");
    if (!device) throw notFound();
    const own =
      isHuman(caller) && caller.person !== undefined && device.person?.personId === caller.person.personId;
    const admin = administrator(hub, caller);
    if (!own && !admin) throw notFound();
    // As with changing or removing an owner: only an owner signs out an owner's device.
    if (!own && admin && admin.role !== "owner") {
      const owners = device.person !== undefined && people(hub).get(device.person.personId)?.role === "owner";
      if (owners) throw new ToolError("forbidden", "Only an owner signs out an owner's device.", "Ask an owner.");
    }
    try {
      // Its hub links go with it (Auth.keys.revoke).
      hub.auth.keys.revoke(device.keyId);
    } catch (error) {
      console.error("device revoke:", error);
      throw internalError();
    }
    if (device.person !== undefined) {
      const by = admin ? refOf(admin) : caller.person;
      announce(
        hub,
        { ...change("device_revoked", device.person, by), keyId: device.keyId },
        `${device.name} of ${device.person.name} was signed out`,
      );
    }
    const after = hub.auth.keys.get(input.keyId);
    if (!after) throw notFound();
    return { device: after };
  });
  avatar.register(tools);
}
