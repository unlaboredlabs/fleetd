// `fleetd invite` and `fleetd people`: the hub's people, from the hub machine. Like
// `hub key`, they open the hub home's database directly, so the hub need not be running.
import { ArgError, parse, type Parsed } from "./args.ts";
import { resolveHome } from "./common.ts";
import { deepLink, localHubUrls } from "./pair.ts";
import { type CliResult, err, ok } from "./result.ts";
import {
  announcePeople,
  cleanName,
  createInvite,
  createPerson,
  ensureOwner,
  getPerson,
  type HubRole,
  listKeys,
  listPeople,
  openHub,
  openInvites,
  owners,
  removePerson,
  revokeInvite,
  setPersonRole,
} from "./store.ts";
import { PEOPLE_USAGE } from "./usages.ts";
export { PEOPLE_USAGE };

type Db = ReturnType<typeof openHub>;
const fail = (message: string) => err(1, `fleetd: ${message}\n`);
const usage = (message: string) => err(2, `fleetd: ${message}\n\nusage:\n${PEOPLE_USAGE}`);
const parseHubRole = (t: string): HubRole | undefined => (t === "owner" || t === "admin" || t === "member" ? t : undefined);

/** The hub's database with its owner made, for `home`. Throws the message. */
function open(home?: string): { db: Db; home: string } {
  const dir = resolveHome(home);
  const db = openHub(dir);
  ensureOwner(db);
  return { db, home: dir };
}

/** Runs `fn` on the hub, its throw as `fleetd: <message>` exit 1. */
function withHub(home: string | undefined, fn: (o: { db: Db; home: string }) => string): CliResult {
  let o;
  try {
    o = open(home);
  } catch (error) {
    return fail((error as Error).message);
  }
  try {
    return ok(fn(o));
  } catch (error) {
    return fail((error as Error).message);
  } finally {
    o.db.conn.close();
  }
}

function parsed(argv: string[], options: Record<string, "str">): Parsed | CliResult {
  const v = parse(argv, { options, positionals: true });
  return v instanceof ArgError ? usage(v.message) : v;
}

export function inviteCommand(argv: string[], home?: string): CliResult {
  const v = parsed(argv, { name: "str", role: "str", person: "str" });
  if (!(v instanceof Object && "positionals" in v)) return v;
  const p = v.positionals;
  if (p.length === 0) return withHub(home, (o) => invite(v, o));
  if (p.length === 1 && p[0] === "list") return withHub(home, (o) => listInvites(o.db));
  if (p.length === 2 && p[0] === "revoke") return withHub(home, (o) => revoke(o.db, p[1]!));
  return usage("expected invite, invite list or invite revoke <inviteId>");
}

function invite(v: Parsed, o: { db: Db; home: string }): string {
  let person;
  const id = v.str("person");
  if (id !== undefined) {
    if (v.has("name") || v.has("role")) throw new Error("--person pairs another device of someone: it takes no --name or --role");
    if (!/^p_[a-z2-7]{8}$/.test(id)) throw new Error(`'${id}' is not a person id (p_…)`);
    person = getPerson(o.db, id);
    if (!person || person.removedAt !== undefined) throw new Error(`no person ${id}; \`fleetd people\` lists them`);
  } else {
    const roleText = v.str("role");
    const role = roleText === undefined ? "member" : parseHubRole(roleText);
    if (role === undefined) throw new Error("--role must be member, admin or owner");
    const name = v.str("name") === undefined ? undefined : cleanName(v.str("name")!);
    if (name === undefined) throw new Error("a new person needs a name: fleetd invite --name <name>");
    person = createPerson(o.db, name, role);
  }
  const { minted, inviteId } = createInvite(o.db, person.personId);
  announcePeople(o.db, "invited", person, `${person.name} was invited as ${person.role}`, inviteId);
  const urls = localHubUrls(o.home);
  const link = deepLink(urls[0]!, minted.code);
  let out = `Invited ${person.name} (${person.personId}) as ${person.role}.\nInvite link:  ${link}\nCode:         ${minted.code}  (single use, valid until ${minted.expiresAt})\nHub address:  ${urls[0]}\n`;
  if (urls.length > 1) out += `  or:         ${urls.slice(1).join(", ")}\n`;
  out += `\nSend ${person.name} the link, or the code and hub address to enter in the fleetd app. The device it pairs is theirs.\nTake it back with \`fleetd invite revoke ${inviteId}\`.\n`;
  return out;
}

function listInvites(db: Db): string {
  const invites = openInvites(db);
  if (invites.length === 0) return "No open invites. `fleetd invite` makes one.\n";
  return invites.map((i) => `${i.inviteId}  ${i.person.name}  until ${i.expiresAt}\n`).join("");
}

function revoke(db: Db, id: string): string {
  if (!/^inv_[a-z2-7]{8}$/.test(id)) throw new Error(`'${id}' is not an invite id (inv_…)`);
  const found = revokeInvite(db, id);
  if (!found) throw new Error(`no invite ${id}; \`fleetd invite list\` lists the open ones`);
  const [invite, revoked] = found;
  if (!revoked) return `Invite ${id} is ${invite.state}: nothing to revoke.\n`;
  const joined = listKeys(db).some((k) => k.person?.personId === invite.person.personId);
  const invited = getPerson(db, invite.person.personId);
  if (!joined && invited && invited.removedAt === undefined && invited.role !== "owner") {
    removePerson(db, invite.person.personId);
  }
  announcePeople(db, "invite_revoked", invite.person, `The invite for ${invite.person.name} was revoked`, id);
  return `Revoked the invite for ${invite.person.name}.\n`;
}

export function peopleCommand(argv: string[], home?: string): CliResult {
  const v = parsed(argv, {});
  if (!(v instanceof Object && "positionals" in v)) return v;
  const p = v.positionals;
  if (p.length === 0) return withHub(home, (o) => listAll(o.db));
  if (p.length === 3 && p[0] === "role") {
    const role = parseHubRole(p[2]!);
    if (role === undefined) return usage("the role must be owner, admin or member");
    return withHub(home, (o) => setRole(o.db, p[1]!, role));
  }
  if (p.length === 2 && p[0] === "remove") return withHub(home, (o) => remove(o.db, p[1]!));
  return usage("expected people, people role <personId> <role> or people remove <personId>");
}

function listAll(db: Db): string {
  const keys = listKeys(db);
  let out = "";
  for (const person of listPeople(db, false)) {
    out += `${person.personId}  ${person.name}  ${person.role}\n`;
    const devices = keys.filter((k) => k.kind === "human" && k.revokedAt === undefined && k.person?.personId === person.personId);
    if (devices.length === 0) out += "    no devices yet\n";
    for (const k of devices) out += `    ${k.keyId}  ${k.name}  last used ${k.lastUsedAt ?? "never"}\n`;
  }
  return out;
}

function personId(id: string): string {
  if (!/^p_[a-z2-7]{8}$/.test(id)) throw new Error(`'${id}' is not a person id (p_…); \`fleetd people\` lists them`);
  return id;
}

function setRole(db: Db, raw: string, role: HubRole): string {
  const id = personId(raw);
  const person = getPerson(db, id);
  if (!person || person.removedAt !== undefined) throw new Error(`no person ${id}`);
  if (person.role === "owner" && role !== "owner" && owners(db) <= 1) {
    throw new Error(`${person.name} is the hub's only owner: make someone else an owner first`);
  }
  const after = setPersonRole(db, id, role);
  if (!after) throw new Error(`no person ${id}`);
  announcePeople(db, "role_changed", after, `${after.name} is now ${role}`);
  return `${after.name} is now ${role}.\n`;
}

function remove(db: Db, raw: string): string {
  const id = personId(raw);
  const person = getPerson(db, id);
  if (!person || person.removedAt !== undefined) throw new Error(`no person ${id}`);
  if (person.role === "owner" && owners(db) <= 1) throw new Error(`${person.name} is the hub's only owner`);
  const removed = removePerson(db, id);
  if (!removed) throw new Error(`no person ${id}`);
  announcePeople(db, "removed", removed[0], `${removed[0].name} was removed from the hub`);
  return `Removed ${removed[0].name}; signed out ${removed[1]} device(s).\n`;
}
