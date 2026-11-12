// What a phone notification says and how it reaches the relay, without the hub: the payload and its cuts, what an
// event is pushed as (`noticeShape`, then `noticeOf` with what the hub looked up), the relay's address rules, and its
// request and answer. index.ts reads the database, seals and posts.
import type { ChatMessage, HubEvent, HumanRequest, PersonId, ProjectRef, PushPlatform } from "../../shared/contracts.ts";
import { shownArgv } from "../approvals/text.ts";

/** The longest body before the payload is cut to PUSH_PAYLOAD_MAX. */
const BODY_MAX = 1000;
export const PUSH_PAYLOAD_MAX = 2400;
export const PUSH_DEVICES_MAX = 20;
/** The longest command a notification offers Approve for. */
const APPROVE_MAX = 200;

/**
 * The relay every hub sends through until `fleetd push-relay set` says otherwise (D225). Tests never reach it: they
 * set their own relay, or pass `defaultRelay` to `Follow`.
 */
export const DEFAULT_RELAY = "https://push.fleetd.sh";

/** A `Line`: one line of 1 to 200 characters. */
export const isLine = (s: string) => s.trim() !== "" && [...s].length <= 200 && !/[\r\n]/.test(s);

/** The hub's push relay. */
export type RelaySetting = { url: string; keySealed?: string };

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

/** Whether `url` is an http(s) URL with a host and no query. */
export function httpUrl(url: string): boolean {
  try {
    const u = new URL(url);
    return (u.protocol === "http:" || u.protocol === "https:") && u.hostname !== "" && u.search === "" && !url.includes("?");
  } catch {
    return false;
  }
}

export type PushKind = "message" | "approval" | "order" | "alert";
export type PushCategory = "approve" | "review" | "reply";
/**
 * Where tapping goes when it isn't a chat: `devices`, the Devices list of the hub at the payload's `hub` (a new sign-in,
 * signed out there). An app that doesn't know a route leaves it out and just opens. The hub itself sends none: its keys
 * come only from a code made on one of the person's own devices already in (pair_code_create, `fleetd pair` on the hub's
 * machine) or an invite's, for a person with no device yet, so no sign-in here is one they didn't make. fleetd cloud,
 * where a sign-in is anyone's who gets into the account, sends it with its "New sign-in" notice.
 */
export type PushRoute = "devices";

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
  route?: PushRoute;
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
    "route", "urgent", "quiet", "category", "badge", "at",
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
export function projectOf(event: HubEvent): ProjectRef | undefined {
  if (event.machineId !== undefined && event.projectId !== undefined) {
    return { machineId: event.machineId, projectId: event.projectId };
  }
  const r = (event.data as { projectRef?: { machineId?: unknown; projectId?: unknown } } | undefined)?.projectRef;
  return r && typeof r.machineId === "string" && typeof r.projectId === "string"
    ? { machineId: r.machineId, projectId: r.projectId }
    : undefined;
}

/** A short opaque key: the relay and Apple see it, so it names nothing. */
export const collapseKey = (what: string) => new Bun.CryptoHasher("sha256").update(what).digest("hex").slice(0, 16);

/** Whether `text` reads on a lock screen exactly as it runs: one line of at most APPROVE_MAX characters, plain. */
export const shownWhole = (text: string) => text.trim() !== "" && [...text].length <= APPROVE_MAX && plain(text);

/** The characters that hide or reorder text (push/mod.rs `plain`; app/desktop/src/shared/hidden.ts's class). */
const HIDDEN =
  /[\p{Cc}\u2028\u2029\u200E\u200F\u061C\u202A-\u202E\u2066-\u2069\u200B-\u200D\u2060-\u2064\uFEFF\u180E\u00AD\u034F\u115F\u1160\u3164\uFFA0\u17B4\u17B5\uFE00-\uFE0F\u{E0000}-\u{E007F}\u206A-\u206F\uFFF9-\uFFFB\u{1BCA0}-\u{1BCA3}\u{1D173}-\u{1D17A}]/u;

/** Whether `text` holds nothing that hides or reorders text. */
export const plain = (text: string) => !HIDDEN.test(text);

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

/** What an event is pushed as, before anything is looked up for it (`noticeShape`). */
export type NoticeShape =
  /** A lead's final chat message: as the event carries it, else its `seq` in the project's chat (too big for the event). */
  | { kind: "message"; project: ProjectRef; message?: ChatMessage; seq?: number }
  /** An order that landed or stopped. */
  | { kind: "order"; project?: ProjectRef }
  /** A request that opened. */
  | { kind: "approval"; project?: ProjectRef; requestId: string }
  /** A screen whose agent asks for the person (`sessionId`), or anything else that wants attention. */
  | { kind: "alert"; project?: ProjectRef; sessionId?: string };

/** What `event` is pushed as, if it is one a person is pushed for. */
export function noticeShape(event: HubEvent): NoticeShape | undefined {
  const project = projectOf(event);
  const data = event.data as Record<string, unknown> | undefined;
  const text = (k: string) => (typeof data?.[k] === "string" ? (data[k] as string) : undefined);
  if (event.type === "chat.message") {
    if (!project) return undefined;
    if (!data || data.author !== "lead" || data.state !== "final") return undefined;
    if (data.message !== undefined) return { kind: "message", project, message: data.message as ChatMessage };
    return typeof data.seq === "number" ? { kind: "message", project, seq: data.seq } : undefined;
  }
  if (event.type === "workstream.done") {
    // An automation run closed by itself (D277): its reply was the notification.
    if (text("by")?.startsWith("automation:")) return undefined;
    return { kind: "order", ...(project ? { project } : {}) };
  }
  if (event.type === "workstream.state" && text("state") === "stopped") return { kind: "order", ...(project ? { project } : {}) };
  if (event.attention === undefined) return undefined;
  const id = event.type === "request.opened" ? text("requestId") : undefined;
  const screen = event.type === "browser.session" ? text("sessionId") : undefined;
  if (id !== undefined) return { kind: "approval", ...(project ? { project } : {}), requestId: id };
  return { kind: "alert", ...(project ? { project } : {}), ...(screen === undefined ? {} : { sessionId: screen }) };
}

/** What the hub looked up for a `NoticeShape`. */
export type NoticeFound = {
  /** A message's, read from the chat when the event didn't carry it. */
  message?: ChatMessage;
  /** An approval's request as it stands now. */
  request?: HumanRequest;
  /** Who it is for (index.ts `recipients`). */
  people: PersonId[];
  /** The project's title. */
  title?: string;
  /** Whether quiet hours are on now (`quietUntil` is defined). */
  quietNow: boolean;
  hubUrl: string;
};

/** The notification `event` makes, as `shape` and what was found for it say; undefined when nobody gets it. */
export function noticeOf(event: HubEvent, shape: NoticeShape, found: NoticeFound): Notice | undefined {
  const project = shape.project;
  let messageId: string | undefined;
  let requestId: string | undefined;
  let sessionId: string | undefined;
  let collapse: string | undefined;
  let category: PushCategory | undefined;
  let body: string;
  if (shape.kind === "message") {
    const m = found.message;
    // An inline item (a command to approve, a secret to give) has no text: its request is pushed instead.
    if (!m || m.text.trim() === "") return undefined;
    messageId = m.messageId;
    category = "reply";
    body = m.text;
  } else if (shape.kind === "approval") {
    requestId = shape.requestId;
    collapse = collapseKey(`request/${shape.requestId}`);
    const r = found.request;
    if (r && r.state === "open") [body, category] = approvalNotice(r);
    else body = event.summary;
  } else {
    if (shape.kind === "alert" && shape.sessionId !== undefined) {
      // A screen whose agent asks for the person (`request_takeover`): one notification per screen.
      sessionId = shape.sessionId;
      collapse = collapseKey(`screen/${shape.sessionId}`);
    }
    body = event.summary;
  }
  const people = found.people;
  if (people.length === 0) return undefined;
  const title = found.title !== undefined && found.title.trim() !== "" ? found.title : "fleetd";
  // The title shows above the command too.
  if (category === "approve" && !plain(title)) category = "review";
  const urgent = event.attention === "urgent";
  const quiet = !urgent && found.quietNow;
  return {
    payload: {
      v: 1,
      kind: shape.kind,
      title: cut(title, 80),
      body,
      hub: found.hubUrl,
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

/** What became of one push. */
export type Outcome = { kind: "sent" } | { kind: "dead" } | { kind: "failed"; why: string };

export type RelayPush = { platform: PushPlatform; token: string; ciphertext: string; collapseKey?: string };


/** The relay's request for one sealed notification, with its key when it has one; the caller adds its timeout. */
export function relayRequest(relayUrl: string, key: string | undefined, push: RelayPush): { url: string; init: RequestInit } {
  return {
    url: `${relayUrl.replace(/\/+$/, "")}/v1/push`,
    init: {
      method: "POST",
      headers: { "content-type": "application/json", ...(key === undefined ? {} : { authorization: `Bearer ${key}` }) },
      body: JSON.stringify(push),
    },
  };
}

/** What the relay's answer (its status and JSON body, undefined when it had none) says became of the push. */
export function outcomeOf(answer: { status: number; statusText: string; ok: boolean }, json: unknown): Outcome {
  const status = `${answer.status} ${answer.statusText}`.trim();
  const body = json as { status?: string; error?: string } | undefined;
  if (body?.status === "sent" && answer.ok) return { kind: "sent" };
  if (body?.status === "dead") return { kind: "dead" };
  if (body?.status === "failed" && typeof body.error === "string") return { kind: "failed", why: `${status}: ${body.error}` };
  return { kind: "failed", why: `the relay answered ${status}` };
}
