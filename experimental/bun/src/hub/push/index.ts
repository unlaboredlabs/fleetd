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
  HumanRequest,
  PersonId,
  ProjectRef,
  PushDevice,
  PushPlatform,
} from "../../shared/contracts.ts";
import { openSealed, seal as sealBox } from "../../shared/sealed_box.ts";
import type { Hub } from "../api/hub.ts";
import { quietPolicy, quietUntil } from "../attention/index.ts";
import { base32 } from "../auth/nodes.ts";
import { boxKey } from "../hub_links/store.ts";
import { decisions } from "../ledger/decisions.ts";
import { ownerOn } from "../people/store.ts";
import { events } from "../store/events.ts";
import { store } from "../store/hub_store.ts";
import { isoMs } from "../store/time.ts";

/** The longest body before the payload is cut to PUSH_PAYLOAD_MAX. */
const BODY_MAX = 1000;
export const PUSH_PAYLOAD_MAX = 2400;
export const PUSH_DEVICES_MAX = 20;
/** Chat messages already sent, so a final message announced again isn't sent twice. */
const SENT_MEMORY = 500;
/** How long a failure logged stays quiet. */
const WARN_EVERY_MS = 60 * 60 * 1000;
const RELAY_TIMEOUT_MS = 15_000;
/** The waits before posting again a push that never reached the relay (no connection). */
const RECONNECT_MS = [1000, 3000];
/** The longest command a notification offers Approve for. */
const APPROVE_MAX = 200;

/**
 * The relay every hub sends through until `fleetd push-relay set` says otherwise (D225). Tests never reach it: they
 * set their own relay, or pass `defaultRelay` to `Follow`.
 */
export const DEFAULT_RELAY = "https://push.fleetd.sh";

const B64 = (bytes: Uint8Array) => Buffer.from(bytes).toString("base64");

/** A device's id: "pd_" and 8 base32 characters. */
const newId = () => `pd_${base32(crypto.getRandomValues(new Uint8Array(5)))}`;

const COLUMNS = "device_id, platform, name, created_ms, last_sent_ms";

type DeviceRow = { device_id: string; platform: string; name: string; created_ms: number; last_sent_ms: number | null };

/** A `Line`: one line of 1 to 200 characters. */
const isLine = (s: string) => s.trim() !== "" && [...s].length <= 200 && !/[\r\n]/.test(s);

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

/** The hub's push relay. */
export type RelaySetting = { url: string; keySealed?: string };

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

const hostOf = (u: string) => {
  try {
    const h = new URL(u).hostname.toLowerCase();
    return h === "" ? undefined : h;
  } catch {
    return undefined;
  }
};

/** Whether `url` points at the default relay's host: it gets no key, and only https. */
export const defaultHost = (url: string) => {
  const h = hostOf(url);
  return h !== undefined && h === hostOf(DEFAULT_RELAY);
};

/** The sealed key to send `r`, after `defaultHost`'s rule; a string error when it can't be sent at all. */
export function sendable(r: RelaySetting): { key?: string } | { error: string } {
  if (!defaultHost(r.url)) return r.keySealed === undefined ? {} : { key: r.keySealed };
  if (!r.url.startsWith("https://")) {
    return { error: `${r.url} is sent to over https only: set it again with \`fleetd push-relay set ${DEFAULT_RELAY}\`` };
  }
  return {};
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

export type PushKind = "message" | "approval" | "order" | "alert";
export type PushCategory = "approve" | "review" | "reply";

/** The plaintext a notification seals (fleetd-contracts push.rs `PushPayload`). */
export type PushPayload = {
  v: 1;
  kind: PushKind;
  title: string;
  body: string;
  hub: string;
  machineId?: string;
  projectId?: string;
  threadId?: string;
  messageId?: string;
  requestId?: string;
  sessionId?: string;
  urgent?: true;
  quiet?: true;
  category?: PushCategory;
  badge?: number;
  at: string;
};

/** The payload's JSON in the Rust struct's field order, absent fields left out. */
function payloadText(p: PushPayload): string {
  const order: (keyof PushPayload)[] = [
    "v", "kind", "title", "body", "hub", "machineId", "projectId", "threadId", "messageId", "requestId", "sessionId",
    "urgent", "quiet", "category", "badge", "at",
  ];
  const out: Record<string, unknown> = {};
  for (const k of order) if (p[k] !== undefined) out[k] = p[k];
  return JSON.stringify(out);
}

/** `text` on one line, at most `max` characters with "…" when cut. */
export function cut(text: string, max: number): string {
  const flat = text.split(/\s+/u).filter((w) => w !== "").join(" ");
  const chars = [...flat];
  if (chars.length <= max) return flat;
  return `${chars.slice(0, Math.max(0, max - 1)).join("")}…`;
}

/**
 * The payload's JSON, its body cut until it fits PUSH_PAYLOAD_MAX. An approval whose body had to be cut is no longer
 * its whole command, so it is reviewed in the app.
 */
export function payloadJson(payload: PushPayload): Uint8Array {
  const p = { ...payload };
  const whole = p.body;
  p.body = cut(p.body, BODY_MAX);
  for (;;) {
    if (p.category === "approve" && p.body !== whole) p.category = "review";
    const json = Buffer.from(payloadText(p), "utf8");
    const chars = [...p.body].length;
    if (json.length <= PUSH_PAYLOAD_MAX || chars === 0) return new Uint8Array(json);
    const over = json.length - PUSH_PAYLOAD_MAX;
    p.body = cut(p.body, Math.max(0, chars - Math.max(over, 8)));
  }
}

/** A notification before it is addressed and sealed. */
export type Notice = { payload: PushPayload; people: PersonId[]; collapse?: string };

/** The project an event names: at its top level, or (chat events) in `data.projectRef`. */
function projectOf(event: HubEvent): ProjectRef | undefined {
  if (event.machineId !== undefined && event.projectId !== undefined) {
    return { machineId: event.machineId, projectId: event.projectId };
  }
  const r = (event.data as { projectRef?: { machineId?: unknown; projectId?: unknown } } | undefined)?.projectRef;
  return r && typeof r.machineId === "string" && typeof r.projectId === "string"
    ? { machineId: r.machineId, projectId: r.projectId }
    : undefined;
}

/** A short opaque key: the relay and Apple see it, so it names nothing. */
const collapseKey = (what: string) => new Bun.CryptoHasher("sha256").update(what).digest("hex").slice(0, 16);

function finalLeadMessage(hub: Hub, event: HubEvent, r: ProjectRef): ChatMessage | undefined {
  const data = event.data as Record<string, unknown> | undefined;
  if (!data || data.author !== "lead" || data.state !== "final") return undefined;
  if (data.message !== undefined) return data.message as ChatMessage;
  // Too big for the event: read it from the chat.
  if (typeof data.seq !== "number") return undefined;
  try {
    const row = hub.db.conn
      .query<{ data: string }, [string, string, number]>(
        "SELECT data FROM chat_messages WHERE machine_id = ? AND project_id = ? AND seq = ?",
      )
      .get(r.machineId, r.projectId, data.seq);
    return row ? (JSON.parse(row.data) as ChatMessage) : undefined;
  } catch {
    return undefined;
  }
}

/** Whether `text` reads on a lock screen exactly as it runs: one line of at most APPROVE_MAX characters, plain. */
export const shownWhole = (text: string) => text.trim() !== "" && [...text].length <= APPROVE_MAX && plain(text);

/** The characters that hide or reorder text (push/mod.rs `plain`; app/desktop/src/shared/hidden.ts's class). */
const HIDDEN =
  /[\p{Cc}\u2028\u2029\u200E\u200F\u061C\u202A-\u202E\u2066-\u2069\u200B-\u200D\u2060-\u2064\uFEFF\u180E\u00AD\u034F\u115F\u1160\u3164\uFFA0\u17B4\u17B5\uFE00-\uFE0F\u{E0000}-\u{E007F}\u206A-\u206F\uFFF9-\uFFFB\u{1BCA0}-\u{1BCA3}\u{1D173}-\u{1D17A}]/u;

/** Whether `text` holds nothing that hides or reorders text. */
export const plain = (text: string) => !HIDDEN.test(text);

const PLAIN_WORD = /^[\p{L}\p{N}\p{M}\p{Pc}./:=@%+-]+$/u;

/** approvals `shown_argv`: each word bare when plain, else as a JSON string. */
export const shownArgv = (argv: string[]) => argv.map((w) => (PLAIN_WORD.test(w) ? w : JSON.stringify(w))).join(" ");

/**
 * An approval's body and what the notification may do about it: Approve and Deny only when the body is everything the
 * card would show, whole on one line (D183/D193). A secret is entered in the app, so it gets no action.
 */
export function approvalNotice(r: HumanRequest): [string, PushCategory | undefined] {
  const why = r.text.trim().replace(/[.:]+$/, "");
  let what = "";
  let answerable = false;
  if (r.gated) {
    const g = r.gated;
    const argv = shownArgv(g.argv);
    what = g.cwd !== undefined ? `${argv} (in ${g.cwd})` : argv;
    const isPlain = g.argv.every((w) => w === "" || shownWhole(w)) && shownWhole(what);
    const safe = isPlain && g.class !== "money" && g.class !== "irreversible";
    const secret = (g.secretEnv?.length ?? 0) > 0;
    answerable = safe && !secret;
  } else if (r.permission) {
    const p = r.permission;
    const input = p.input as { command?: unknown } | undefined;
    const command = typeof input?.command === "string" ? input.command : undefined;
    const whole = p.toolName === "Bash" && command === p.summary && shownWhole(p.summary);
    what = `${p.toolName} ${p.summary}`;
    answerable = whole && p.preview === undefined && p.site === undefined;
  }
  if (r.kind === "secret") return [why, undefined];
  const exact = what.trim() !== "" && cut(what, BODY_MAX) === what;
  const body = what === "" ? why : `${why}: ${what}`;
  // The reason shows just before the command: a right-to-left mark at its end would flip how the command reads.
  return [body, answerable && exact && plain(why) ? "approve" : "review"];
}

/** Open requests, newest first (approvals store `list` with states [open]); read-only. */
function openRequests(hub: Hub, limit: number): HumanRequest[] {
  return hub.db
    .all<{ data: string }>("SELECT data FROM requests WHERE state = 'open' ORDER BY n DESC LIMIT ?", [Math.max(1, limit)])
    .flatMap((r) => {
      try {
        return [JSON.parse(r.data) as HumanRequest];
      } catch {
        return [];
      }
    });
}

/** One request by its id (`Q<n>`), read-only. */
function requestGet(hub: Hub, id: string): HumanRequest | undefined {
  const m = /^Q([1-9][0-9]*)$/.exec(id);
  if (!m) return undefined;
  const row = hub.db.conn.query<{ data: string }, [number]>("SELECT data FROM requests WHERE n = ?").get(Number(m[1]));
  return row ? (JSON.parse(row.data) as HumanRequest) : undefined;
}

/**
 * Whether `r`'s chat waits on its person with no request open: the chat area's (`hub.area("chat_state")`, T2255's).
 * Until it is set, no chat counts.
 */
export const chatState = (hub: Hub) => hub.area("chat_state", () => ({ needsYou: (_r: ProjectRef) => false }));

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
    count += requests > 0 ? requests : chatState(hub).needsYou(r) ? 1 : 0;
  }
  return count;
}

/** The notification `event` makes, if it is one a person is pushed for. */
export function notice(hub: Hub, event: HubEvent): Notice | undefined {
  const project = projectOf(event);
  const data = event.data as Record<string, unknown> | undefined;
  const text = (k: string) => (typeof data?.[k] === "string" ? (data[k] as string) : undefined);
  let messageId: string | undefined;
  let requestId: string | undefined;
  let sessionId: string | undefined;
  let collapse: string | undefined;
  let category: PushCategory | undefined;
  let kind: PushKind;
  let body: string;
  if (event.type === "chat.message") {
    if (!project) return undefined;
    const m = finalLeadMessage(hub, event, project);
    // An inline item (a command to approve, a secret to give) has no text: its request is pushed instead.
    if (!m || m.text.trim() === "") return undefined;
    messageId = m.messageId;
    category = "reply";
    [kind, body] = ["message", m.text];
  } else if (event.type === "workstream.done") {
    // A Navi's automation run closed by itself (D277): its reply was the notification.
    if (text("by")?.startsWith("automation:")) return undefined;
    [kind, body] = ["order", event.summary];
  } else if (event.type === "workstream.state" && text("state") === "stopped") {
    [kind, body] = ["order", event.summary];
  } else if (event.attention !== undefined) {
    const id = event.type === "request.opened" ? text("requestId") : undefined;
    const screen = event.type === "browser.session" ? text("sessionId") : undefined;
    if (id !== undefined) {
      requestId = id;
      collapse = collapseKey(`request/${id}`);
      const r = requestGet(hub, id);
      if (r && r.state === "open") [body, category] = approvalNotice(r);
      else body = event.summary;
      kind = "approval";
    } else if (screen !== undefined) {
      // A screen whose agent asks for the person (`request_takeover`): one notification per screen.
      sessionId = screen;
      collapse = collapseKey(`screen/${screen}`);
      [kind, body] = ["alert", event.summary];
    } else [kind, body] = ["alert", event.summary];
  } else return undefined;
  const people = recipients(hub.db.conn, project);
  if (people.length === 0) return undefined;
  const found = project ? store(hub).projectGet(project)?.title : undefined;
  const title = found !== undefined && found.trim() !== "" ? found : "fleetd";
  // The title shows above the command too.
  if (category === "approve" && !plain(title)) category = "review";
  const urgent = event.attention === "urgent";
  const [tz, quietHours] = quietPolicy((k) => decisions(hub).globalValue(k));
  const quiet = !urgent && quietUntil(hub.clock.now(), tz, quietHours) !== undefined;
  return {
    payload: {
      v: 1,
      kind,
      title: cut(title, 80),
      body,
      hub: hub.url(),
      ...(project ? { machineId: project.machineId, projectId: project.projectId } : {}),
      ...(event.threadId === undefined ? {} : { threadId: event.threadId }),
      ...(messageId === undefined ? {} : { messageId }),
      ...(requestId === undefined ? {} : { requestId }),
      ...(sessionId === undefined ? {} : { sessionId }),
      ...(urgent ? { urgent: true as const } : {}),
      ...(quiet ? { quiet: true as const } : {}),
      ...(category === undefined ? {} : { category }),
      at: event.at,
    },
    people,
    ...(collapse === undefined ? {} : { collapse }),
  };
}

/**
 * Who an event about `project` (undefined: about no project) is for: a Navi's, its owner; another project's, the
 * person who last wrote in its chat, else the hub's owner; about no project, the hub's owners and admins.
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
  const navi = c
    .query<{ owner_person: string | null }, [string, string]>(
      "SELECT owner_person FROM project_settings WHERE machine_id = ? AND project_id = ? AND only_me = 1",
    )
    .get(project.machineId, project.projectId);
  let person: string | undefined;
  if (navi) {
    // A Navi is its owner's alone.
    person = navi.owner_person ?? undefined;
  } else {
    const writer = c
      .query<{ p: string }, [string, string]>(
        `SELECT json_extract(data, '$.person.personId') AS p FROM chat_messages
         WHERE machine_id = ? AND project_id = ? AND json_extract(data, '$.author') = 'human'
           AND json_extract(data, '$.person.personId') IS NOT NULL
         ORDER BY seq DESC LIMIT 1`,
      )
      .get(project.machineId, project.projectId);
    person = writer?.p ?? ownerOn(c)?.personId;
  }
  if (person === undefined) return [];
  const on = c.query<{ person_id: string }, [string]>("SELECT person_id FROM people WHERE person_id = ? AND removed_ms IS NULL").get(person);
  return on ? [on.person_id] : [];
}

/** What became of one push. */
export type Outcome = { kind: "sent" } | { kind: "dead" } | { kind: "failed"; why: string };

export type RelayPush = { platform: PushPlatform; token: string; ciphertext: string; collapseKey?: string };

/** Posts one sealed notification to the relay, with its key when it has one. */
export async function post(relayUrl: string, key: string | undefined, push: RelayPush): Promise<Outcome> {
  const url = `${relayUrl.replace(/\/+$/, "")}/v1/push`;
  const waits = [...RECONNECT_MS];
  let answer: Response;
  for (;;) {
    try {
      answer = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json", ...(key === undefined ? {} : { authorization: `Bearer ${key}` }) },
        body: JSON.stringify(push),
        signal: AbortSignal.timeout(RELAY_TIMEOUT_MS),
      });
      break;
    } catch (error) {
      const wait = waits.shift();
      const connect = (error as { code?: string }).code === "ConnectionRefused" || (error as { code?: string }).code === "ECONNREFUSED";
      if (wait === undefined || !connect) return { kind: "failed", why: `the relay can't be reached: ${(error as Error).message}` };
      await Bun.sleep(wait);
    }
  }
  const status = `${answer.status} ${answer.statusText}`.trim();
  let body: { status?: string; error?: string } | undefined;
  try {
    body = (await answer.json()) as typeof body;
  } catch {
    body = undefined;
  }
  if (body?.status === "sent" && answer.ok) return { kind: "sent" };
  if (body?.status === "dead") return { kind: "dead" };
  if (body?.status === "failed" && typeof body.error === "string") return { kind: "failed", why: `${status}: ${body.error}` };
  return { kind: "failed", why: `the relay answered ${status}` };
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
