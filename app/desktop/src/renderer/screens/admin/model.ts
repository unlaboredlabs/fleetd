// Administration's rules, pure and tested: who sees the page, what each row of People offers the person looking at it,
// and the invites still open. The hub enforces all of it again (people_list, person_set, person_remove); these only
// keep the page from offering what it would refuse.
import type { AgentKeyInfo, HubInfoOutput, HubRole, Invite, PeopleListOutput, Person } from "../../../shared/contracts";

/**
 * Whether this app's person administers the hub: an owner or admin whose device isn't capped below admin. A hub from
 * before people names no person; there it is the key's own admin grant, as Settings asked before: a hub too old to
 * say leaves the app to try, and refuses a change it doesn't allow. False until hub_info answers.
 */
export function administers(info: Pick<HubInfoOutput, "admin" | "me"> | undefined): boolean {
  if (info === undefined) return false;
  if (info.me === undefined) return info.admin !== false;
  return (info.me.role === "owner" || info.me.role === "admin") && info.admin !== false;
}

export const ROLE_WORD: Readonly<Record<string, string>> = { owner: "Owner", admin: "Admin", member: "Member" };
export const roleWord = (role: HubRole): string => ROLE_WORD[role] ?? role;

/** What each role may do, in a line, under the role picker. */
export const ROLE_HELP: Readonly<Record<string, string>> = {
  owner: "Everything an admin does, and makes or removes owners.",
  admin: "Invites and removes people, and changes hub-wide settings.",
  member: "Works in every project. Sees no Administration.",
};

export interface PersonRow {
  readonly person: Person;
  readonly devices: ReadonlyArray<AgentKeyInfo>;
  readonly you: boolean;
  /** Invited and not joined yet: an open invite and no device. */
  readonly invited: boolean;
  /** The roles the viewer may set; empty when they may not change this person's. */
  readonly roles: ReadonlyArray<HubRole>;
  readonly removable: boolean;
  /** Why the row offers nothing, when it doesn't. */
  readonly why?: string;
}

/**
 * Every person not removed, oldest first as the hub lists them, each with their devices and what `me` may change.
 * Only an owner makes, unmakes or removes an owner; nobody changes their own role or removes themselves here, so the
 * hub always keeps an owner and nobody locks themselves out by a slip.
 */
export function peopleRows(list: Pick<PeopleListOutput, "people" | "devices" | "invites">, me: Person | undefined): PersonRow[] {
  const owner = me?.role === "owner";
  const admin = owner || me?.role === "admin";
  return list.people
    .filter((p) => p.removedAt === undefined)
    .map((person) => {
      const devices = list.devices.filter((d) => d.person?.personId === person.personId && d.revokedAt === undefined);
      const invited = devices.length === 0 && list.invites.some((i) => i.state === "open" && i.person.personId === person.personId);
      const you = me !== undefined && person.personId === me.personId;
      const base = { person, devices, you, invited };
      if (!admin) return { ...base, roles: [], removable: false };
      if (you) return { ...base, roles: [], removable: false, why: "Someone else changes your own role." };
      if (person.role === "owner" && !owner) return { ...base, roles: [], removable: false, why: "Only an owner changes an owner." };
      return { ...base, roles: owner ? ["owner", "admin", "member"] : ["admin", "member"], removable: true };
    });
}

/** The invites still waiting for a device, newest first. */
export const openInvites = (invites: ReadonlyArray<Invite>): Invite[] =>
  invites.filter((i) => i.state === "open").toSorted((a, b) => b.createdAt.localeCompare(a.createdAt));

/** "Expires in 6 days", "Expires in 5 h", "Expires within the hour", "Expired". */
export function expiresLine(expiresAt: string, nowMs: number): string {
  const left = Date.parse(expiresAt) - nowMs;
  if (Number.isNaN(left) || left <= 0) return "Expired";
  const h = Math.floor(left / 3_600_000);
  if (h < 1) return "Expires within the hour";
  if (h < 48) return `Expires in ${String(h)} h`;
  return `Expires in ${String(Math.floor(h / 24))} days`;
}

/** "2 devices", "1 device", "No device yet". */
export const devicesLine = (n: number): string => (n === 0 ? "No device yet" : `${String(n)} ${n === 1 ? "device" : "devices"}`);

/** A name the hub takes: 1 to 80 characters on one line. Undefined when it is fine. */
export function nameProblem(name: string): string | undefined {
  const t = name.trim();
  if (t === "") return "Give them a name.";
  if (/[\r\n]/u.test(t)) return "One line.";
  if (Array.from(t).length > 80) return "80 characters at most.";
  return undefined;
}
