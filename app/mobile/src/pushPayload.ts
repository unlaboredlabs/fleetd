// What a phone notification says and where tapping it goes, as the phone reads it (push.ts has the rest): the hub's
// sealed payload opened and read, the notification shown for it with its channel, buttons and route. Pure, with no
// package or React Native import, so the package exports it (`fleetd/apps/push`) and fleetd cloud proves its own
// payloads through the phone's own reading.
import { fromBase64, utf8 } from "./bytes";
import { keyOf, type Key } from "./projectKey";

/** The plaintext the hub seals (the hub's `PushPayload`, fleetd/src/hub/push/payload.ts). */
export interface PushPayload {
  readonly v: 1;
  readonly kind: "message" | "approval" | "order" | "alert";
  readonly title: string;
  readonly body: string;
  readonly hub: string;
  readonly machineId?: string;
  readonly projectId?: string;
  readonly threadId?: string;
  readonly messageId?: string;
  readonly requestId?: string;
  /** A screen whose agent asks the person to take it over: tapping opens its live view. */
  readonly sessionId?: string;
  /** Where tapping goes when it isn't a chat: `devices`, this hub's Devices list (a new sign-in, to undo there). */
  readonly route?: PushRoute;
  readonly urgent?: boolean;
  readonly quiet?: boolean;
  /** What can be done from the notification: Approve and Deny, Review in the app, Reply. */
  readonly category?: "approve" | "review" | "reply";
  /** How many things need the person: the app icon's badge. */
  readonly badge?: number;
  readonly at: string;
}

/** What `route` names; one this app doesn't know is left out, and the notification just opens the app. */
export type PushRoute = "devices";

const KINDS = new Set(["message", "approval", "order", "alert"]);
const ROUTES = new Set(["devices"]);
const PAYLOAD_CATEGORIES = new Set(["approve", "review", "reply"]);

const str = (v: unknown): string | undefined => (typeof v === "string" && v !== "" ? v : undefined);

/**
 * A sealed notification (`c`, base64) opened with `open`, crypto_box_seal_open with this phone's keys; null when it
 * doesn't open or isn't version 1. Version 1 only ever gains optional fields: what this app doesn't know it leaves out.
 */
export const openPayload = (sealed: string, open: (box: Uint8Array) => Uint8Array | null): PushPayload | null => {
  const bytes = fromBase64(sealed);
  const plain = bytes === null ? null : open(bytes);
  const text = plain === null ? null : utf8(plain);
  if (text === null) return null;
  try {
    return readPayload(JSON.parse(text));
  } catch {
    return null;
  }
};

/** An opened payload's JSON, as this app reads it; null when it isn't version 1. */
export const readPayload = (value: unknown): PushPayload | null => {
  if (typeof value !== "object" || value === null) return null;
  const json = value as Record<string, unknown>;
  if (json.v !== 1 || typeof json.title !== "string" || typeof json.body !== "string") return null;
  const optional = (k: string): Record<string, string> => (str(json[k]) === undefined ? {} : { [k]: str(json[k])! });
  return {
    v: 1,
    kind: KINDS.has(json.kind as string) ? (json.kind as PushPayload["kind"]) : "alert",
    title: json.title,
    body: json.body,
    hub: str(json.hub) ?? "",
    ...optional("machineId"),
    ...optional("projectId"),
    ...optional("threadId"),
    ...optional("messageId"),
    ...optional("requestId"),
    ...optional("sessionId"),
    ...(ROUTES.has(json.route as string) ? { route: json.route as PushRoute } : {}),
    ...(json.urgent === true ? { urgent: true } : {}),
    ...(json.quiet === true ? { quiet: true } : {}),
    ...(PAYLOAD_CATEGORIES.has(json.category as string) ? { category: json.category as NonNullable<PushPayload["category"]> } : {}),
    ...(typeof json.badge === "number" && Number.isInteger(json.badge) && json.badge >= 0 ? { badge: json.badge } : {}),
    at: str(json.at) ?? "",
  };
};

/** A notification button, as expo-notifications takes it (setNotificationCategoryAsync). */
export interface CategoryAction {
  readonly identifier: "approve" | "deny" | "review" | "reply";
  readonly buttonTitle: string;
  readonly textInput?: { readonly submitButtonTitle: string; readonly placeholder: string };
  readonly options: { readonly isDestructive?: boolean; readonly isAuthenticationRequired?: boolean; readonly opensAppToForeground: boolean };
}

/**
 * The notification categories and their buttons, registered at launch (notifications.ts); the iOS extension sets the
 * same ids (Payload.swift). Every action that calls the hub needs the phone unlocked: it acts with the phone's own key,
 * which the Keychain gives out only then. Review opens the app on the approval's full card.
 */
export const CATEGORIES = {
  "fleetd.approve": [
    { identifier: "approve", buttonTitle: "Approve", options: { isAuthenticationRequired: true, opensAppToForeground: false } },
    { identifier: "deny", buttonTitle: "Deny", options: { isDestructive: true, isAuthenticationRequired: true, opensAppToForeground: false } },
  ],
  "fleetd.review": [{ identifier: "review", buttonTitle: "Review", options: { opensAppToForeground: true } }],
  "fleetd.reply": [
    { identifier: "reply", buttonTitle: "Reply", textInput: { submitButtonTitle: "Send", placeholder: "Message" }, options: { isAuthenticationRequired: true, opensAppToForeground: false } },
  ],
} as const satisfies Record<string, readonly CategoryAction[]>;

export type Category = keyof typeof CATEGORIES;

/** How iOS words a chat's stacked notifications: "3 more messages". */
export const CATEGORY_SUMMARIES: Record<Category, string> = {
  "fleetd.approve": "%u more approvals",
  "fleetd.review": "%u more approvals",
  "fleetd.reply": "%u more messages",
};

/**
 * A payload's category. Approve and Deny only for what the hub marked so; an urgent one (money or irreversible) is
 * always reviewed in the app on its full card, whatever it says (D183/D193).
 */
export const categoryOf = (p: PushPayload): Category | undefined => {
  if (p.kind === "approval" && p.requestId !== undefined && p.category !== undefined) {
    return p.category === "approve" && p.urgent !== true ? "fleetd.approve" : "fleetd.review";
  }
  if (p.kind === "message" && p.category === "reply" && routeOf(p)?.t === "chat") return "fleetd.reply";
  return undefined;
};

/** Android's channels: what the person turns on and off in the system's settings, one sound each. */
export const CHANNELS = {
  chats: { name: "Chats", sound: true },
  approvals: { name: "Approvals", sound: true },
  other: { name: "Orders and alerts", sound: true },
  quiet: { name: "Quiet hours", sound: false },
} as const;

export type Channel = keyof typeof CHANNELS;

/** Where tapping a notification goes; kept on it as its data. */
export type Route =
  | { readonly t: "chat"; readonly key: Key }
  | { readonly t: "approval"; readonly requestId: string; readonly key?: Key }
  /** A screen asking for the person: its live view, over its chat. */
  | { readonly t: "screen"; readonly key: Key; readonly sessionId: string }
  /** The Devices list of the hub at `hub` (the payload's), only while that hub is the one shown. */
  | { readonly t: "devices"; readonly hub: string };

export interface Shown {
  readonly title: string;
  readonly body: string;
  readonly channel: Channel;
  /** Replaces the notification already shown under it: one per chat, one per request. */
  readonly id?: string;
  readonly urgent: boolean;
  readonly route?: Route;
  readonly category?: Category;
  readonly badge?: number;
  /** What it was made from, kept on Android's notification for its buttons. */
  readonly payload: PushPayload;
}

/** Where tapping a payload goes; undefined: the app just opens. */
export const routeOf = (p: PushPayload): Route | undefined => {
  if (p.route === "devices") return p.hub === "" ? undefined : { t: "devices", hub: p.hub };
  const key = p.machineId !== undefined && p.projectId !== undefined ? keyOf({ machineId: p.machineId, projectId: p.projectId }) : undefined;
  if (p.kind === "approval" && p.requestId !== undefined) return key === undefined ? { t: "approval", requestId: p.requestId } : { t: "approval", requestId: p.requestId, key };
  if (key !== undefined && p.sessionId !== undefined && /^B[0-9a-f]{32}$/u.test(p.sessionId)) return { t: "screen", key, sessionId: p.sessionId };
  return key === undefined ? undefined : { t: "chat", key };
};

/** The notification Android posts for a payload (iOS's extension does the same in Swift). */
export const shownOf = (p: PushPayload): Shown => {
  const route = routeOf(p);
  const channel: Channel = p.quiet === true ? "quiet" : p.kind === "message" ? "chats" : p.kind === "approval" ? "approvals" : "other";
  const id = route?.t === "approval" ? `approval:${route.requestId}` : route?.t === "screen" ? `screen:${route.sessionId}` : p.kind === "message" && route?.t === "chat" ? `chat:${route.key}` : undefined;
  const category = categoryOf(p);
  return {
    title: p.title || "fleetd",
    body: p.body,
    channel,
    urgent: p.urgent === true,
    ...(id === undefined ? {} : { id }),
    ...(route === undefined ? {} : { route }),
    ...(category === undefined ? {} : { category }),
    ...(p.badge === undefined ? {} : { badge: p.badge }),
    payload: p,
  };
};

/** A route as Android's posted notification keeps it in its data. */
export const routeFrom = (v: unknown): Route | undefined => {
  if (typeof v !== "object" || v === null) return undefined;
  const r = v as Record<string, unknown>;
  const key = str(r.key);
  if (r.t === "chat" && key !== undefined && key.includes("/")) return { t: "chat", key };
  const requestId = str(r.requestId);
  if (r.t === "approval" && requestId !== undefined) return key === undefined ? { t: "approval", requestId } : { t: "approval", requestId, key };
  const sessionId = str(r.sessionId);
  if (r.t === "screen" && key !== undefined && key.includes("/") && sessionId !== undefined) return { t: "screen", key, sessionId };
  const hub = str(r.hub);
  if (r.t === "devices" && hub !== undefined) return { t: "devices", hub };
  return undefined;
};
