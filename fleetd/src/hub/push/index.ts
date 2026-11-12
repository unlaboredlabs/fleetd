// Phone notifications, end-to-end encrypted (D218), as crates/fleetd/src/hub/push/mod.rs sends them. Each person
// registers their phones (`push_devices`: a push token and an X25519 public key). `run` follows the event log and,
// for what needs a person (an event with `attention`, a lead's final chat message, an order that landed or stopped),
// seals a payload to each of that person's devices and posts it to the hub's push relay. The relay sees a token and
// ciphertext, never the content. A token the relay reports dead is dropped, unless one notification would drop more
// than half of a person's phones that way. Each failure is logged once an hour at most.
import type { Database } from "bun:sqlite";
import type {
  ChatMessage,
  HubEvent,
  PersonId,
  ProjectRef,
  PushDevice,
  PushPlatform,
} from "../../shared/contracts.ts";
import { openSealed, seal as sealBox } from "../../shared/sealed_box.ts";
import type { Hub } from "../api/hub.ts";
import { quietPolicy, quietUntil } from "../attention/index.ts";
import { openRequests } from "../approvals/index.ts";
import { Requests } from "../approvals/store.ts";
import { base32 } from "../auth/nodes.ts";
import { chat } from "../chat/index.ts";
import { boxKey } from "../hub_links/store.ts";
import { decisions } from "../ledger/decisions.ts";
import { ownerOn } from "../people/store.ts";
import { events } from "../store/events.ts";
import { store } from "../store/hub_store.ts";
import { isoMs } from "../store/time.ts";
import {
  DEFAULT_RELAY,
  isLine,
  type Notice,
  noticeOf,
  noticeShape,
  type Outcome,
  outcomeOf,
  payloadJson,
  type RelayPush,
  relayRequest,
  type RelaySetting,
  sendable,
} from "./payload.ts";

export {
  approvalNotice,
  cut,
  DEFAULT_RELAY,
  defaultHost,
  type Notice,
  type Outcome,
  payloadJson,
  plain,
  PUSH_DEVICES_MAX,
  PUSH_PAYLOAD_MAX,
  type PushCategory,
  type PushKind,
  type PushPayload,
  type RelayPush,
  type RelaySetting,
  sendable,
  shownWhole,
} from "./payload.ts";

/** Chat messages already sent, so a final message announced again isn't sent twice. */
const SENT_MEMORY = 500;
/** How long a failure logged stays quiet. */
const WARN_EVERY_MS = 60 * 60 * 1000;
const RELAY_TIMEOUT_MS = 15_000;
/** The waits before posting again a push that never reached the relay (no connection). */
const RECONNECT_MS = [1000, 3000];

const B64 = (bytes: Uint8Array) => Buffer.from(bytes).toString("base64");

/** A device's id: "pd_" and 8 base32 characters. */
const newId = () => `pd_${base32(crypto.getRandomValues(new Uint8Array(5)))}`;

const COLUMNS = "device_id, platform, name, created_ms, last_sent_ms";

type DeviceRow = { device_id: string; platform: string; name: string; created_ms: number; last_sent_ms: number | null };

function readDevice(row: DeviceRow): PushDevice {
  return {
    createdAt: isoMs(row.created_ms),
    deviceId: row.device_id,
    ...(row.last_sent_ms === null ? {} : { lastSentAt: isoMs(row.last_sent_ms) }),
    name: isLine(row.name) ? row.name : "Phone",
    platform: row.platform === "android" ? "android" : "ios",
  };
}

export type NewDevice = {
  person: PersonId;
  keyId: string;
  platform: PushPlatform;
  token: string;
  publicKey: Uint8Array;
  name: string;
};

/** Saves a device, or updates the one with that token (moving it to `person`). */
export function register(c: Database, d: NewDevice, atMs: number): PushDevice {
  c.query(
    `INSERT INTO push_devices (device_id, person_id, key_id, platform, token, public_key, name, created_ms)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (token) DO UPDATE SET person_id = excluded.person_id, key_id = excluded.key_id,
       platform = excluded.platform, public_key = excluded.public_key, name = excluded.name`,
  ).run(newId(), d.person, d.keyId, d.platform, d.token, B64(d.publicKey), d.name, atMs);
  return readDevice(c.query<DeviceRow, [string]>(`SELECT ${COLUMNS} FROM push_devices WHERE token = ?`).get(d.token) as DeviceRow);
}

/** A person's devices, oldest first; a phone signed out of the hub isn't listed. */
export const list = (c: Database, person: PersonId): PushDevice[] =>
  c
    .query<DeviceRow, [string]>(
      `SELECT ${COLUMNS} FROM push_devices WHERE person_id = ?
       AND key_id IN (SELECT key_id FROM agent_keys WHERE revoked_ms IS NULL) ORDER BY created_ms, rowid`,
    )
    .all(person)
    .map(readDevice);

/** Removes one of `person`'s devices; undefined when they have no such device. */
export function remove(c: Database, person: PersonId, id: string): PushDevice | undefined {
  const row = c
    .query<DeviceRow, [string, string]>(`SELECT ${COLUMNS} FROM push_devices WHERE device_id = ? AND person_id = ?`)
    .get(id, person);
  if (!row) return undefined;
  c.query("DELETE FROM push_devices WHERE device_id = ?").run(id);
  return readDevice(row);
}

/**
 * The hub's push relay as set; `fallback` (normally DEFAULT_RELAY) without a key when never set; undefined when pushes
 * are turned off (a row with an empty URL).
 */
export function relay(c: Database, fallback: string): RelaySetting | undefined {
  const row = c.query<{ url: string; key_sealed: string | null }, []>("SELECT url, key_sealed FROM push_relay WHERE id = 1").get();
  if (!row) return { url: fallback };
  if (row.url === "") return undefined;
  return { url: row.url, ...(row.key_sealed === null ? {} : { keySealed: row.key_sealed }) };
}

/** Sets the hub's push relay: undefined goes back to DEFAULT_RELAY, an empty URL turns pushes off. */
export function setRelay(c: Database, r: RelaySetting | undefined): void {
  if (r) {
    c.query(
      `INSERT INTO push_relay (id, url, key_sealed) VALUES (1, ?, ?)
       ON CONFLICT (id) DO UPDATE SET url = excluded.url, key_sealed = excluded.key_sealed`,
    ).run(r.url, r.keySealed ?? null);
  } else c.query("DELETE FROM push_relay").run();
}

/** A device a notification goes to. */
export type Target = { deviceId: string; platform: PushPlatform; token: string; publicKey: Uint8Array };

/** `person`'s devices that may still get notifications: their key not revoked, the person still on the hub. */
function targets(c: Database, person: PersonId): Target[] {
  const rows = c
    .query<{ device_id: string; platform: string; token: string; public_key: string }, [string]>(
      `SELECT d.device_id, d.platform, d.token, d.public_key FROM push_devices d
       JOIN people p ON p.person_id = d.person_id AND p.removed_ms IS NULL
       JOIN agent_keys k ON k.key_id = d.key_id AND k.revoked_ms IS NULL
       WHERE d.person_id = ? ORDER BY d.created_ms, d.rowid`,
    )
    .all(person);
  return rows.flatMap((r) => {
    const key = Buffer.from(r.public_key, "base64");
    if (key.length !== 32) return [];
    return [{ deviceId: r.device_id, platform: r.platform === "android" ? "android" : "ios", token: r.token, publicKey: new Uint8Array(key) }];
  });
}

/** Seals `plain` to a device's X25519 public key: a libsodium sealed box, standard base64. */
export const seal = (publicKey: Uint8Array, plain: Uint8Array) => B64(sealBox(publicKey, plain));

const sameRef = (a: ProjectRef, b: ProjectRef) => a.machineId === b.machineId && a.projectId === b.projectId;

/**
 * The app icon's badge for `person`: each open request and each chat waiting on them with none open, of the projects
 * whose notifications are theirs.
 */
export function badge(hub: Hub, person: PersonId): number {
  const open = openRequests(hub, 1000);
  let count = 0;
  for (const project of store(hub).projectsShown()) {
    const r = { machineId: project.machineId, projectId: project.projectId };
    if (!recipients(hub.db.conn, r).includes(person)) continue;
    const requests = open.filter((q) => sameRef(q.projectRef, r)).length;
    count += requests > 0 ? requests : chat(hub).state(r, false).needsYou ? 1 : 0;
  }
  return count;
}

/** A lead's final message the event was too big to carry, read from the chat. */
function messageAt(hub: Hub, r: ProjectRef, seq: number): ChatMessage | undefined {
  try {
    const row = hub.db.conn
      .query<{ data: string }, [string, string, number]>(
        "SELECT data FROM chat_messages WHERE machine_id = ? AND project_id = ? AND seq = ?",
      )
      .get(r.machineId, r.projectId, seq);
    return row ? (JSON.parse(row.data) as ChatMessage) : undefined;
  } catch {
    return undefined;
  }
}

/** The notification `event` makes, if it is one a person is pushed for. */
export function notice(hub: Hub, event: HubEvent): Notice | undefined {
  const shape = noticeShape(event);
  if (!shape) return undefined;
  const project = shape.project;
  let message: ChatMessage | undefined;
  if (shape.kind === "message") {
    // Too big for the event: read it from the chat.
    message = shape.message ?? (shape.seq === undefined ? undefined : messageAt(hub, shape.project, shape.seq));
  }
  const [tz, quietHours] = quietPolicy((k) => decisions(hub).globalValue(k));
  return noticeOf(event, shape, {
    message,
    request: shape.kind === "approval" ? new Requests(hub.db).get(shape.requestId) : undefined,
    people: recipients(hub.db.conn, project),
    title: project ? store(hub).projectGet(project)?.title : undefined,
    quietNow: quietUntil(hub.clock.now(), tz, quietHours) !== undefined,
    hubUrl: hub.url(),
  });
}

/**
 * Who an event about `project` (undefined: about no project) is for: a project's, the person who last wrote in its
 * chat, else the hub's owner; about no project, the hub's owners and admins.
 */
export function recipients(c: Database, project: ProjectRef | undefined): PersonId[] {
  if (!project) {
    return c
      .query<{ person_id: string }, []>(
        `SELECT person_id FROM people WHERE role IN ('owner', 'admin') AND removed_ms IS NULL
         ORDER BY created_ms, rowid`,
      )
      .all()
      .map((r) => r.person_id);
  }
  const writer = c
    .query<{ p: string }, [string, string]>(
      `SELECT json_extract(data, '$.person.personId') AS p FROM chat_messages
       WHERE machine_id = ? AND project_id = ? AND json_extract(data, '$.author') = 'human'
         AND json_extract(data, '$.person.personId') IS NOT NULL
       ORDER BY seq DESC LIMIT 1`,
    )
    .get(project.machineId, project.projectId);
  const person = writer?.p ?? ownerOn(c)?.personId;
  if (person === undefined) return [];
  const on = c.query<{ person_id: string }, [string]>("SELECT person_id FROM people WHERE person_id = ? AND removed_ms IS NULL").get(person);
  return on ? [on.person_id] : [];
}

/** Posts one sealed notification to the relay, with its key when it has one. */
export async function post(relayUrl: string, key: string | undefined, push: RelayPush): Promise<Outcome> {
  const { url, init } = relayRequest(relayUrl, key, push);
  const waits = [...RECONNECT_MS];
  let answer: Response;
  for (;;) {
    try {
      answer = await fetch(url, { ...init, signal: AbortSignal.timeout(RELAY_TIMEOUT_MS) });
      break;
    } catch (error) {
      const wait = waits.shift();
      const connect = (error as { code?: string }).code === "ConnectionRefused" || (error as { code?: string }).code === "ECONNREFUSED";
      if (wait === undefined || !connect) return { kind: "failed", why: `the relay can't be reached: ${(error as Error).message}` };
      await Bun.sleep(wait);
    }
  }
  let body: unknown;
  try {
    body = await answer.json();
  } catch {
    body = undefined;
  }
  return outcomeOf(answer, body);
}

/** The loop's memory between pages. */
export class Follow {
  private readonly sent = new Set<string>();
  private readonly order: string[] = [];
  /** Each failure logged, and when. */
  private readonly warned = new Map<string, number>();

  /** `defaultRelay`: where pushes go when no relay is set; a fake one in tests. */
  constructor(readonly defaultRelay = DEFAULT_RELAY) {}

  /** False when `id` was sent already; remembers it otherwise. */
  first(id: string): boolean {
    if (this.sent.has(id)) return false;
    this.sent.add(id);
    this.order.push(id);
    if (this.order.length > SENT_MEMORY) this.sent.delete(this.order.shift() as string);
    return true;
  }

  /** Logs `why` unless it was logged in the last hour; never with a token or ciphertext. True when it logged. */
  warnOnce(why: string, nowMs: number): boolean {
    for (const [k, at] of this.warned) if (nowMs - at >= WARN_EVERY_MS) this.warned.delete(k);
    if (this.warned.has(why)) return false;
    console.warn(`push: ${why}`);
    this.warned.set(why, nowMs);
    return true;
  }
}

/** The relay's key, opened with the hub's box key. */
function openKey(hub: Hub, sealed: string): string | undefined {
  try {
    const plainKey = openSealed(boxKey(hub), Buffer.from(sealed, "base64"));
    return plainKey ? new TextDecoder("utf-8", { fatal: true }).decode(plainKey) : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Sends the notifications of the events after `cursor`: the cursor to resume from, whether more are ready, and what
 * each push came to, by device.
 */
export async function step(
  hub: Hub,
  follow: Follow,
  cursor: number,
): Promise<{ cursor: number; more: boolean; outcomes: [string, Outcome][] }> {
  const page = events(hub).page(cursor);
  const outcomes: [string, Outcome][] = [];
  const done = { cursor: page.cursor, more: page.more, outcomes };
  const r = relay(hub.db.conn, follow.defaultRelay);
  if (!r) return done;
  const sendableKey = sendable(r);
  if ("error" in sendableKey) {
    follow.warnOnce(sendableKey.error, hub.clock.now());
    return done;
  }
  let key: string | undefined;
  if (sendableKey.key !== undefined) {
    key = openKey(hub, sendableKey.key);
    if (key === undefined) {
      follow.warnOnce(
        "the push relay's key can't be opened with this hub's box key: set it again with " +
          "`fleetd push-relay set <url> --relay-key-file <path>`",
        hub.clock.now(),
      );
      return done;
    }
  }
  for (const event of page.events) {
    const n = notice(hub, event);
    if (!n) continue;
    if (n.payload.messageId !== undefined && !follow.first(n.payload.messageId)) continue;
    for (const person of n.people) {
      // A count that can't be read leaves the badge as it was rather than holding the notification back.
      let count: number | undefined;
      try {
        count = badge(hub, person);
      } catch (error) {
        console.warn("push: badge not counted:", error);
      }
      const plainJson = payloadJson({ ...n.payload, ...(count === undefined ? {} : { badge: count }) });
      const posted: [string, Outcome][] = [];
      for (const target of targets(hub.db.conn, person)) {
        const push: RelayPush = {
          platform: target.platform,
          token: target.token,
          ciphertext: seal(target.publicKey, plainJson),
          ...(n.collapse === undefined ? {} : { collapseKey: n.collapse }),
        };
        posted.push([target.deviceId, await post(r.url, key, push)]);
      }
      // A relay set up wrong answers every token dead: one notification never drops most of a person's phones.
      const dead = posted.filter(([, o]) => o.kind === "dead").length;
      if (dead * 2 > posted.length) {
        const why =
          `the push relay says ${dead} of ${person}'s ${posted.length} phones are gone at once: kept them, as a relay set ` +
          "up wrong (APNs environment or bundle id, Firebase project) is the likelier cause; check its log";
        for (const p of posted) if (p[1].kind === "dead") p[1] = { kind: "failed", why };
      }
      const now = hub.clock.now();
      for (const [deviceId, outcome] of posted) {
        if (outcome.kind === "failed") follow.warnOnce(outcome.why, now);
        else if (outcome.kind === "sent") hub.db.conn.query("UPDATE push_devices SET last_sent_ms = ? WHERE device_id = ?").run(now, deviceId);
        else hub.db.conn.query("DELETE FROM push_devices WHERE device_id = ?").run(deviceId);
      }
      outcomes.push(...posted);
    }
  }
  return done;
}

/**
 * Follows the event log from its head at the hub's start (what happened while the hub was down is old news) until
 * the hub stops: a step after each append, one at a time.
 */
export function run(hub: Hub, follow = new Follow()): void {
  let cursor = events(hub).head();
  let running = false;
  let again = false;
  const signal = hub.shutdown.signal;
  const drain = async () => {
    if (running) {
      again = true;
      return;
    }
    running = true;
    try {
      do {
        again = false;
        try {
          for (;;) {
            const out = await step(hub, follow, cursor);
            cursor = out.cursor;
            if (!out.more || signal.aborted) break;
          }
        } catch (error) {
          console.error("push: events not followed:", error);
          await Bun.sleep(5000);
          again = true;
        }
      } while (again && !signal.aborted);
    } finally {
      running = false;
    }
  };
  const unsubscribe = events(hub).subscribe(() => void drain());
  signal.addEventListener("abort", unsubscribe, { once: true });
}
