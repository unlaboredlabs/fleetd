// Hub links (W104, D194), as crates/fleetd/src/hub/hub_links/mod.rs keeps them: a Navi on one hub opens and follows
// work in projects on another. On the hub whose projects it reaches, a person's device mints a link (`flk_…`, shown
// once, kept as its SHA-256) acting as that person at the lesser of their role and the device's grants, never above
// operate, only through /link/v1. On the hub with the Navi, the link's key is kept sealed to this hub's box key and
// opened only to call the other hub (client.ts).
import { isIP } from "node:net";
import type { AgentKeyInfo, Grant, HubLinkState, IssuedLink, PersonRef, ProjectRef } from "../../shared/contracts.ts";
import { ToolError } from "../../shared/errors.ts";
import { loadOrCreateBoxKey } from "../../shared/sealed_box.ts";
import type { Hub } from "../api/hub.ts";
import { sha256, stripBearer } from "../auth/index.ts";
import { base32, secret } from "../auth/nodes.ts";
import { roleCap } from "../people/roles.ts";
import { people, refOf } from "../people/store.ts";
import type { HubDb } from "../store/db.ts";
import { isoMs } from "../store/time.ts";
import { dead, IDLE_EXPIRY_MS, type Issued, type Kept, LINK_KEY_PREFIX, linkGrants, type LinkHello } from "./links.ts";

export {
  dead,
  FEED_WAIT_MAX_SEC,
  IDLE_EXPIRY_MS,
  type Issued,
  type Kept,
  keptInfo,
  LINK_KEY_PREFIX,
  linkAllows,
  linkAuthor,
  linkGrants,
  type LinkHello,
  linkLimits,
} from "./links.ts";

/** How often a link's last use is written, at most. */
const LAST_USED_EVERY_MS = 60_000;
const linkId = () => `hl_${base32(crypto.getRandomValues(new Uint8Array(5)))}`;

type IssuedRow = {
  link_id: string;
  prefix: string;
  label: string;
  projects: string | null;
  key_id: string;
  device: string;
  person: string | null;
  created_ms: number;
  last_used_ms: number | null;
  revoked_ms: number | null;
  grants: string | null;
};

const ISSUED_COLUMNS = "link_id, prefix, label, projects, key_id, device, person, created_ms, last_used_ms, revoked_ms, grants";

function issuedInfo(r: IssuedRow): IssuedLink {
  return {
    createdAt: isoMs(r.created_ms),
    device: r.device,
    keyId: r.key_id,
    label: r.label,
    ...(r.last_used_ms === null ? {} : { lastUsedAt: isoMs(r.last_used_ms) }),
    linkId: r.link_id,
    ...(r.person === null ? {} : { person: JSON.parse(r.person) as PersonRef }),
    prefix: r.prefix,
    ...(r.projects === null ? {} : { projects: JSON.parse(r.projects) as ProjectRef[] }),
    ...(r.revoked_ms === null ? {} : { revokedAt: isoMs(r.revoked_ms) }),
  };
}

const issuedRow = (db: HubDb, id: string) =>
  db.conn.query<IssuedRow, [string]>(`SELECT ${ISSUED_COLUMNS} FROM hub_links_issued WHERE link_id = ?`).get(id) ?? undefined;

/** PersonRef as Rust serializes it: personId, then name. */
const personJson = (p: PersonRef) => JSON.stringify({ personId: p.personId, name: p.name });
const refsJson = (rs: ProjectRef[]) => JSON.stringify(rs.map((r) => ({ machineId: r.machineId, projectId: r.projectId })));

/** Mints a link acting as `by`, limited to `projects` when given: the link and its key, which is never stored. */
export function mint(hub: Hub, by: AgentKeyInfo, label: string, projects: ProjectRef[] | undefined): { link: IssuedLink; key: string } {
  const key = secret(LINK_KEY_PREFIX);
  const row: IssuedRow = {
    link_id: linkId(),
    prefix: key.slice(0, LINK_KEY_PREFIX.length + 6),
    label,
    projects: projects === undefined ? null : refsJson(projects),
    key_id: by.keyId,
    device: by.name,
    person: by.person === undefined ? null : personJson(by.person),
    created_ms: hub.clock.now(),
    last_used_ms: null,
    revoked_ms: null,
    grants: JSON.stringify(by.grants),
  };
  hub.db.conn
    .query(
      `INSERT INTO hub_links_issued (link_id, hash, prefix, label, projects, key_id, device, person, created_ms,
       grants) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(row.link_id, sha256(key), row.prefix, row.label, row.projects, row.key_id, row.device, row.person, row.created_ms, row.grants);
  return { link: issuedInfo(row), key };
}

/** Links minted here: every one, or those minted by `keyId` (or its person), newest first. */
export function issued(db: HubDb, mine: { keyId: string; person?: PersonRef } | undefined): IssuedLink[] {
  return db
    .all<IssuedRow>(
      `SELECT ${ISSUED_COLUMNS} FROM hub_links_issued
       WHERE ?1 OR key_id = ?2 OR (?3 IS NOT NULL AND json_extract(person, '$.personId') = ?3)
       ORDER BY created_ms DESC, link_id LIMIT 500`,
      [mine === undefined ? 1 : 0, mine?.keyId ?? "", mine?.person?.personId ?? null],
    )
    .map(issuedInfo);
}

export function issuedGet(db: HubDb, id: string): IssuedLink | undefined {
  const r = issuedRow(db, id);
  return r ? issuedInfo(r) : undefined;
}

/** Revokes a link minted here; idempotent, keeping the first time. False for no such link. */
export const revokeIssued = (hub: Hub, id: string) =>
  hub.db.conn.query("UPDATE hub_links_issued SET revoked_ms = COALESCE(revoked_ms, ?) WHERE link_id = ?").run(hub.clock.now(), id)
    .changes > 0;

/** A store failure, as a link's caller hears it. */
export function failed(error: unknown): ToolError {
  console.error("hub links store:", error);
  return new ToolError("failed", "The hub failed to answer that request.");
}

/**
 * The link a bearer key belongs to, live: not revoked, its device not revoked, its person on the hub. Checked at
 * every request, so a revoke stops the next one. Throws a ToolError (`dead` for a link dead for good).
 */
export function verify(hub: Hub, bearer: string): Issued {
  const key = stripBearer(bearer);
  const row = hub.db.conn.query<IssuedRow, [string]>(`SELECT ${ISSUED_COLUMNS} FROM hub_links_issued WHERE hash = ?`).get(sha256(key));
  if (!row || !key.startsWith(LINK_KEY_PREFIX)) throw dead("This hub knows no such link key.");
  if (row.revoked_ms !== null) throw dead(`The link ${row.prefix} was revoked on this hub.`);
  const now = hub.clock.now();
  if (now - (row.last_used_ms ?? row.created_ms) >= IDLE_EXPIRY_MS) {
    revokeIssued(hub, row.link_id);
    throw dead(`The link ${row.prefix} went unused for 90 days and expired on this hub.`);
  }
  const device = hub.auth.keys.get(row.key_id);
  // The person who made it: as stored at minting, or its device's for a link minted before people.
  const personId = row.person !== null ? (JSON.parse(row.person) as PersonRef).personId : device?.person?.personId;
  let someone = undefined as ReturnType<ReturnType<typeof people>["get"]>;
  if (personId !== undefined) {
    someone = people(hub).get(personId);
    if (!someone || someone.removedAt !== undefined) {
      throw dead(`The person who made link ${row.prefix} was removed from this hub, and the link with them.`);
    }
  }
  // It dies with the device that made it (D337).
  if (!device || device.revokedAt !== undefined) {
    throw dead(`The device that made link ${row.prefix} was revoked on this hub, and the link with it.`);
  }
  let link: Issued;
  if (someone) {
    // The device's grants at minting; a link from before they were kept reads its device's now.
    const minted = row.grants !== null ? (JSON.parse(row.grants) as Grant[]) : device.grants;
    link = { linkId: row.link_id, label: row.label, person: refOf(someone), grants: linkGrants(minted, roleCap(someone.role)), who: someone.name };
  } else {
    link = { linkId: row.link_id, label: row.label, grants: linkGrants(device.grants, "operate"), who: device.name };
  }
  if (row.projects !== null) link.projects = JSON.parse(row.projects) as ProjectRef[];
  if (row.last_used_ms === null || now - row.last_used_ms >= LAST_USED_EVERY_MS) {
    hub.db.conn.query("UPDATE hub_links_issued SET last_used_ms = ? WHERE link_id = ?").run(now, row.link_id);
  }
  return link;
}

type KeptRow = {
  link_id: string;
  machine_id: string;
  project_id: string;
  label: string;
  url: string;
  sealed: Uint8Array;
  cursor: number;
  state: string;
  error: string | null;
  checked_ms: number | null;
  created_ms: number;
  who: string | null;
  projects: string | null;
};

const KEPT_COLUMNS = "link_id, machine_id, project_id, label, url, sealed, cursor, state, error, checked_ms, created_ms, who, projects";

function readKept(r: KeptRow): Kept {
  return {
    linkId: r.link_id,
    navi: { machineId: r.machine_id, projectId: r.project_id },
    label: r.label,
    url: r.url,
    sealed: r.sealed,
    cursor: r.cursor,
    state: r.state === "unreachable" ? "unreachable" : r.state === "revoked" ? "revoked" : "ok",
    ...(r.error === null ? {} : { error: r.error }),
    ...(r.checked_ms === null ? {} : { checkedMs: r.checked_ms }),
    createdMs: r.created_ms,
    ...(r.who === null ? {} : { who: r.who }),
    ...(r.projects === null ? {} : { projects: r.projects }),
  };
}

export function setHello(db: HubDb, id: string, hello: LinkHello): void {
  const projects =
    hello.limited === true
      ? JSON.stringify(hello.projects.map((p) => ({ projectRef: { machineId: p.projectRef.machineId, projectId: p.projectRef.projectId }, title: p.title })))
      : null;
  db.conn.query("UPDATE hub_links SET who = ?, projects = ? WHERE link_id = ?").run(hello.who ?? null, projects, id);
}

/** The links a project keeps, by label; every project's without one. */
export function kept(db: HubDb, navi: ProjectRef | undefined): Kept[] {
  const rows = navi
    ? db.all<KeptRow>(`SELECT ${KEPT_COLUMNS} FROM hub_links WHERE machine_id = ? AND project_id = ? ORDER BY label`, [navi.machineId, navi.projectId])
    : db.all<KeptRow>(`SELECT ${KEPT_COLUMNS} FROM hub_links ORDER BY created_ms`);
  return rows.map(readKept);
}

export function keptGet(db: HubDb, id: string): Kept | undefined {
  const r = db.conn.query<KeptRow, [string]>(`SELECT ${KEPT_COLUMNS} FROM hub_links WHERE link_id = ?`).get(id);
  return r ? readKept(r) : undefined;
}

/** A project's links as `factory_status` lists them. */
export const linked = (db: HubDb, navi: ProjectRef) =>
  kept(db, navi).map((k) => ({ label: k.label, state: k.state, ...(k.error === undefined ? {} : { error: k.error }) }));

/** Adds a link to a project: its id; undefined when the project has one by that label already. */
export function keep(hub: Hub, navi: ProjectRef, label: string, url: string, sealed: Uint8Array, cursor: number): string | undefined {
  const id = linkId();
  const now = hub.clock.now();
  const added = hub.db.conn
    .query(
      `INSERT OR IGNORE INTO hub_links (link_id, machine_id, project_id, label, url, sealed, cursor, state,
       checked_ms, created_ms) VALUES (?, ?, ?, ?, ?, ?, ?, 'ok', ?, ?)`,
    )
    .run(id, navi.machineId, navi.projectId, label, url, sealed, cursor, now, now).changes;
  return added > 0 ? id : undefined;
}

/** Deletes a kept link, its key with it: false for no such link. */
export const forget = (db: HubDb, id: string) => db.conn.query("DELETE FROM hub_links WHERE link_id = ?").run(id).changes > 0;

/** Records how the last call over a kept link went. */
export function setState(hub: Hub, id: string, state: HubLinkState, error: string | undefined): void {
  hub.db.conn
    .query("UPDATE hub_links SET state = ?, error = ?, checked_ms = ? WHERE link_id = ? AND state != 'revoked'")
    .run(state, error ?? null, hub.clock.now(), id);
}

export const setCursor = (db: HubDb, id: string, cursor: number) =>
  db.conn.query("UPDATE hub_links SET cursor = ? WHERE link_id = ?").run(cursor, id);

/** The hub's own X25519 box key, in its home (`node-box-key.pem`): what the app seals link and relay keys to. */
export const boxKey = (hub: Hub): Uint8Array => hub.area("box_key", (h) => loadOrCreateBoxKey(h.config.home));

/** `url`'s host, lowercased, IPv6 brackets dropped; undefined for no URL. */
function parseUrl(url: string): URL | undefined {
  try {
    return new URL(url.trim());
  } catch {
    return undefined;
  }
}

const bare = (host: string) => host.replace(/^\[|\]$/g, "").toLowerCase();

function isPrivateHost(host: string): boolean {
  const h = bare(host);
  if (isIP(h) === 4) {
    const [a = 0, b = 0] = h.split(".").map(Number);
    return a === 127 || (a === 100 && (b & 0xc0) === 64);
  }
  if (isIP(h) === 6) return h === "::1" || h.startsWith("fd7a:115c:a1e0:");
  return h === "localhost" || h.endsWith(".ts.net");
}

/**
 * A link key travels only where nobody else reads it: HTTPS, or plain HTTP to this machine or over a tailnet
 * (100.64.0.0/10, fd7a:115c:a1e0::/48 and *.ts.net names), which encrypts it. The parsed URL, or a refusal.
 */
export function checkUrl(url: string): URL {
  const bad = (why: string) =>
    new ToolError("invalid", why, "Use the other hub's URL as the app pairs with it: https://…, or http:// over a tailnet.");
  const parsed = parseUrl(url);
  if (!parsed) throw bad(`${url} is no URL: relative URL without a base.`);
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") throw bad(`${parsed.protocol.slice(0, -1)}: is not http or https.`);
  if (parsed.hostname === "") throw bad(`${url} names no host.`);
  if (parsed.protocol === "https:") return parsed;
  if (isPrivateHost(parsed.hostname)) return parsed;
  throw bad(`${url} is plain HTTP off a tailnet: the link key would cross the network in the clear.`);
}

/** The address another hub can reach this one at, from its own URL: never loopback or unspecified. */
export function reachableUrl(url: string): string | undefined {
  let parsed: URL;
  try {
    parsed = checkUrl(url);
  } catch {
    return undefined;
  }
  const h = bare(parsed.hostname);
  const local =
    h === "localhost" ||
    (isIP(h) === 4 && (h.startsWith("127.") || h === "0.0.0.0")) ||
    (isIP(h) === 6 && (h === "::1" || h === "::"));
  return local ? undefined : url.trim().replace(/\/+$/, "");
}
