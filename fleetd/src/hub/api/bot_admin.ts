// A bot's safety settings are its workspace's owners' and admins' (W926): its approval mode, who merges its PRs and
// how, its max agents, the card it pays with, its automations, and deleting it. Members keep everything else. One
// rule, no per-bot roles: a person's own key passes when their role is owner or admin; any other key with an admin
// grant on the bot's machine; a lead's call when the person it acts for (whom.ts) is one, or no one is.
import type { MachineId, PersonId, ProjectRef } from "../../shared/contracts.ts";
import { ToolError } from "../../shared/errors.ts";
import { settingsPath } from "../../shared/settings_path.ts";
import { allows } from "../auth/allows.ts";
import { aboutFor } from "../chat/about.ts";
import { administers } from "../people/roles.ts";
import { getOn } from "../people/store.ts";
import { isHuman } from "./grants.ts";
import type { Hub } from "./hub.ts";
import type { Caller } from "./registry.ts";

/** What the apps show members in place of these settings' controls. */
export const BOT_ADMIN_ONLY = "Only admins can change this.";

/** The settings the rule guards. */
export type BotSetting = "approvals" | "merges" | "max_agents" | "card" | "automations" | "remove";

const WHAT: Record<Exclude<BotSetting, "remove">, string> = {
  approvals: "a bot's approvals",
  merges: "who merges a bot's PRs",
  max_agents: "a bot's max agents",
  card: "the card a bot pays with",
  automations: "a bot's automations",
};

const FIX = `Ask one of them to do it, or to make you an admin in ${settingsPath("People")}.`;

/** The refusal a member gets, the same words on the cloud. */
export function botAdminRefusal(setting: BotSetting): ToolError {
  const message =
    setting === "remove"
      ? "Only the workspace's owners and admins can delete a bot."
      : `Only the workspace's owners and admins can change ${WHAT[setting]}.`;
  return new ToolError("forbidden", message, FIX);
}

/** Whether `person` is still on the workspace as an owner or admin. */
export function isAdminPerson(hub: Hub, person: PersonId): boolean {
  const p = getOn(hub.db.conn, person);
  return p !== undefined && p.removedAt === undefined && administers(p.role);
}

/**
 * Whether the caller may change a bot's safety settings on `machine`. A person's key that names no one is from a hub
 * before people, whose keys were all its owner's.
 */
export function mayChangeBot(hub: Hub, caller: Caller, machine: MachineId): boolean {
  if (isHuman(caller)) return caller.person === undefined || isAdminPerson(hub, caller.person.personId);
  return allows(caller, "admin", machine);
}

/** Throws the refusal unless the caller may change the bot `r`'s `setting`. */
export function requireBotAdmin(hub: Hub, caller: Caller, r: ProjectRef, setting: BotSetting): void {
  if (!mayChangeBot(hub, caller, r.machineId)) throw botAdminRefusal(setting);
}

/**
 * Throws the refusal unless the person a lead of `r` acts for now may change its `setting`: its turn's order's
 * starter, else the person the turn answered. With no one (an automation's run, a wake), it acts for the owner.
 */
export function requireLeadForAdmin(hub: Hub, r: ProjectRef, setting: BotSetting): void {
  const person = aboutFor(hub, r, hub.clock.now()).for;
  if (person !== undefined && !isAdminPerson(hub, person.personId)) throw botAdminRefusal(setting);
}

/**
 * The people of the bot `r` other than `except`, still on the workspace: who wrote in its chat or started one of its
 * orders. Read before it is erased, to tell them.
 */
export function botPeople(hub: Hub, r: ProjectRef, except: PersonId | undefined): PersonId[] {
  const rows = hub.db.all<{ p: string | null }>(
    `SELECT json_extract(data, '$.person.personId') AS p FROM chat_messages
       WHERE machine_id = ?1 AND project_id = ?2 AND json_valid(data) AND json_extract(data, '$.author') = 'human'
     UNION
     SELECT json_extract(data, '$.startedBy.personId') AS p FROM workstreams
       WHERE machine_id = ?1 AND project_id = ?2 AND json_valid(data)`,
    [r.machineId, r.projectId],
  );
  const ids = new Set(rows.flatMap((row) => (typeof row.p === "string" ? [row.p] : [])));
  if (except !== undefined) ids.delete(except);
  return [...ids].filter((id) => {
    const p = getOn(hub.db.conn, id);
    return p !== undefined && p.removedAt === undefined;
  });
}
