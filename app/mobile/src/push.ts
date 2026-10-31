// Push notifications (D218), the parts that don't touch the OS: registering this phone with the
// hub, opening a sealed notification, what to show for it and where tapping it goes. The phone's X25519 key pair is
// made at pairing and kept in secure storage (vault.ts); the hub seals each notification to its public key and the
// relay forwards the ciphertext as `c`. On iOS the Notification Service Extension opens it before it shows
// (plugins/notification-service); on Android the app's background task does and posts it (notifications.ts). A
// notification's buttons (Approve and Deny, Review, Reply) are its category, which the hub picks inside the sealed
// payload; what each does is `act`, over a connection of its own, since the app may have been started only for it.
import type { HubError, HumanRequest } from "./desktop";
import { HubClient, READY_TIMEOUT_MS, type Transport } from "./hub/client";
import { fromBase64, openSealed, toBase64, utf8, type KeyPair } from "./seal";
import { keyOf, refOf, type Key } from "./store";

export type Platform = "ios" | "android";

/** What the phone's OS and storage give the registration: real ones in notifications.ts and vault.ts, fakes in tests. */
export interface PushDeps {
  readonly platform: Platform;
  readonly deviceName: string;
  /** This phone's key pair for the hub, made if it has none. */
  readonly keys: () => Promise<KeyPair>;
  /** The OS's push token (APNs hex, FCM), or null: notifications not allowed, no Firebase config, a simulator. */
  readonly token: () => Promise<string | null>;
  /** Calls back with each new token the OS hands out; returns the unsubscribe. */
  readonly onToken: (listener: (token: string) => void) => () => void;
  /** The hub's id for this phone's registration (`pd_…`), kept to remove it at Disconnect. */
  readonly saveDevice: (deviceId: string) => Promise<void>;
  readonly loadDevice: () => Promise<string | null>;
}

export type Registered =
  | { readonly t: "registered"; readonly deviceId: string; readonly relay: boolean }
  | { readonly t: "no_token" }
  | { readonly t: "failed"; readonly error: HubError };

/** Registers {platform, token, public key, name} with the hub; the same token again updates its device. */
export const registerDevice = async (client: HubClient, deps: PushDeps, token?: string): Promise<Registered> => {
  let pushToken: string | null;
  try {
    pushToken = token ?? (await deps.token());
  } catch {
    pushToken = null;
  }
  if (pushToken === null || pushToken === "") return { t: "no_token" };
  const { publicKey } = await deps.keys();
  const r = await client.call("push_device_register", { platform: deps.platform, token: pushToken, publicKey: toBase64(publicKey), name: deviceName(deps.deviceName) });
  if (!r.ok) return { t: "failed", error: r.error };
  await deps.saveDevice(r.output.device.deviceId);
  return { t: "registered", deviceId: r.output.device.deviceId, relay: r.output.relay };
};

/** The hub takes 1 to 80 characters. */
const deviceName = (name: string): string => Array.from(name.trim() || "Phone").slice(0, 80).join("");

/**
 * Disconnect, on the hub: removes this phone's push registration, then revokes its key (device_revoke, as Settings ›
 * You signs a device out). The phone's own key is the device whose prefix it starts with.
 */
export const signOut = async (client: HubClient, deps: Pick<PushDeps, "loadDevice">, key: string): Promise<{ ok: true } | { ok: false; error: HubError }> => {
  const deviceId = await deps.loadDevice();
  if (deviceId !== null) {
    const removed = await client.call("push_device_remove", { deviceId });
    if (!removed.ok && removed.error.code !== "not_found") return removed;
  }
  const people = await client.call("people_list", {});
  if (!people.ok) return people;
  const mine = people.output.devices.find((d) => key.startsWith(d.prefix) && (people.output.me === undefined || d.person?.personId === people.output.me));
  if (mine === undefined) return { ok: false, error: { code: "not_found", message: "The hub doesn't list this phone's key." } };
  const revoked = await client.call("device_revoke", { keyId: mine.keyId });
  return revoked.ok ? { ok: true } : revoked;
};

/** The plaintext the hub seals (PushPayload in crates/fleetd-contracts/src/push.rs). */
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
  readonly urgent?: boolean;
  readonly quiet?: boolean;
  /** What can be done from the notification: Approve and Deny, Review in the app, Reply. */
  readonly category?: "approve" | "review" | "reply";
  /** How many things need the person: the app icon's badge. */
  readonly badge?: number;
  readonly at: string;
}

const KINDS = new Set(["message", "approval", "order", "alert"]);
const PAYLOAD_CATEGORIES = new Set(["approve", "review", "reply"]);

const str = (v: unknown): string | undefined => (typeof v === "string" && v !== "" ? v : undefined);

/**
 * A sealed notification (`c`, base64) opened with this phone's keys; null when it doesn't open or isn't version 1.
 * Version 1 only ever gains optional fields: what this app doesn't know it leaves out.
 */
export const openPayload = (sealed: string, keys: KeyPair): PushPayload | null => {
  const bytes = fromBase64(sealed);
  const plain = bytes === null ? null : openSealed(bytes, keys);
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
  | { readonly t: "screen"; readonly key: Key; readonly sessionId: string };

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

export const routeOf = (p: PushPayload): Route | undefined => {
  const key = p.machineId !== undefined && p.projectId !== undefined ? keyOf({ machineId: p.machineId, projectId: p.projectId }) : undefined;
  if (p.kind === "approval" && p.requestId !== undefined) return key === undefined ? { t: "approval", requestId: p.requestId } : { t: "approval", requestId: p.requestId, key };
  if (key !== undefined && p.sessionId !== undefined && /^B[0-9a-f]{32}$/u.test(p.sessionId)) return { t: "screen", key, sessionId: p.sessionId };
  return key === undefined ? undefined : { t: "chat", key };
};

/** Where a route opens: a chat, an approval's at its card, a screen's with its live view over it. */
export interface ChatAt {
  readonly key: Key;
  readonly requestId?: string;
  readonly sessionId?: string;
}

/**
 * The chat a tapped notification opens: its own, or the approval's, scrolled to the card that answers it. An approval
 * that didn't say its chat is found among the open requests: undefined until they are read, null once they are and it
 * isn't there (answered meanwhile), when the app just opens.
 */
export const chatAt = (route: Route, requests: readonly HumanRequest[] | undefined): ChatAt | null | undefined => {
  if (route.t === "chat") return { key: route.key };
  if (route.t === "screen") return { key: route.key, sessionId: route.sessionId };
  const key = route.key ?? requests?.find((r) => r.requestId === route.requestId)?.projectRef;
  if (key === undefined) return requests === undefined ? undefined : null;
  return { key: typeof key === "string" ? key : keyOf(key), requestId: route.requestId };
};

/** The notification Android posts for a payload (iOS's extension does the same in Swift). */
export const shownOf = (p: PushPayload): Shown => {
  const route = routeOf(p);
  const channel: Channel = p.quiet === true ? "quiet" : p.kind === "message" ? "chats" : p.kind === "approval" ? "approvals" : "other";
  const id = route?.t === "approval" ? `approval:${route.requestId}` : route?.t === "screen" ? `screen:${route.sessionId}` : p.kind === "message" && route !== undefined ? `chat:${route.key}` : undefined;
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

/**
 * What Android posts for an FCM data message: null, so nothing shows, when it carries no `c` or `c` doesn't open with
 * this phone's keys (another hub's, a newer version, or anyone who has the token and posts to the public relay).
 */
export const androidShown = (data: unknown, keys: KeyPair | null): Shown | null => {
  const sealed = sealedOf(data);
  const payload = sealed === undefined || keys === null ? null : openPayload(sealed, keys);
  return payload === null ? null : shownOf(payload);
};

const routeFrom = (v: unknown): Route | undefined => {
  if (typeof v !== "object" || v === null) return undefined;
  const r = v as Record<string, unknown>;
  const key = str(r.key);
  if (r.t === "chat" && key !== undefined && key.includes("/")) return { t: "chat", key };
  const requestId = str(r.requestId);
  if (r.t === "approval" && requestId !== undefined) return key === undefined ? { t: "approval", requestId } : { t: "approval", requestId, key };
  const sessionId = str(r.sessionId);
  if (r.t === "screen" && key !== undefined && key.includes("/") && sessionId !== undefined) return { t: "screen", key, sessionId };
  return undefined;
};

/** The sealed `c` of a raw push, wherever the OS put it (APNs userInfo, FCM data). */
export const sealedOf = (raw: unknown): string | undefined => {
  if (typeof raw !== "object" || raw === null) return undefined;
  const r = raw as Record<string, unknown>;
  return str(r.c) ?? sealedOf(r.data);
};

/**
 * Where a tapped notification goes: the route Android's posted notification carries, or, for one iOS showed (its
 * APNs payload, which still has `c`), the route of the payload opened again here. Undefined: the app just opens.
 */
export const tapRoute = (data: unknown, push: unknown, keys: KeyPair | null): Route | undefined => {
  const posted = typeof data === "object" && data !== null ? routeFrom((data as Record<string, unknown>).route) : undefined;
  if (posted !== undefined) return posted;
  const payload = pushedPayload(push, data, keys);
  return payload === null ? undefined : routeOf(payload);
};

/** The payload of a notification iOS showed (its APNs payload still has `c`), or of one Android posted (its data). */
export const pushedPayload = (push: unknown, data: unknown, keys: KeyPair | null): PushPayload | null => {
  const sealed = sealedOf(push) ?? sealedOf(data);
  if (sealed !== undefined) return keys === null ? null : openPayload(sealed, keys);
  return typeof data === "object" && data !== null ? readPayload((data as Record<string, unknown>).payload) : null;
};

/** A tap opens the app at the notification's route: the notification itself, or its Review button. */
export const opensRoute = (actionIdentifier: string, defaultAction: string): boolean => actionIdentifier === defaultAction || actionIdentifier === "review";

/** What a button on a notification asks for; undefined for a tap or Review, which open the app instead. */
export type Act =
  | { readonly t: "approve" | "deny"; readonly requestId: string; readonly route: Route }
  | { readonly t: "reply"; readonly key: Key; readonly text: string };

export const actOf = (actionIdentifier: string, userText: string | undefined, p: PushPayload): Act | undefined => {
  const route = routeOf(p);
  if ((actionIdentifier === "approve" || actionIdentifier === "deny") && route?.t === "approval") return { t: actionIdentifier, requestId: route.requestId, route };
  const text = userText?.trim() ?? "";
  if (actionIdentifier === "reply" && route?.t === "chat" && text !== "") return { t: "reply", key: route.key, text };
  return undefined;
};

/** The paired hub and this phone's key, and how to reach it. */
export interface HubLink {
  readonly hub: string;
  readonly key: string;
  readonly transport: Transport;
}

/** One connection for a few calls: dials, waits for the link, runs `use`, hangs up; an error when it never comes up. */
export const withHub = <T>(link: HubLink, use: (client: HubClient) => Promise<T>): Promise<{ readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: HubError }> =>
  new Promise((resolve) => {
    let started = false;
    let done = false;
    const finish = (outcome: { ok: true; value: T } | { ok: false; error: HubError }) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      client.stop();
      resolve(outcome);
    };
    const client = new HubClient({
      hub: link.hub,
      key: link.key,
      transport: link.transport,
      emit: (f) => {
        if (f.t !== "state" || done) return;
        if (f.state.phase === "refused") finish({ ok: false, error: { code: "unauthorized", message: f.state.message } });
        if (f.state.phase !== "live" || started) return;
        started = true;
        void use(client).then((value) => finish({ ok: true, value }));
      },
    });
    const timer = setTimeout(() => finish({ ok: false, error: { code: "offline", message: "The hub can't be reached." } }), READY_TIMEOUT_MS);
    client.start();
  });

/** What an action leaves on the phone: the notification shown in place of the one acted on (null: none), and the badge. */
export interface Acted {
  readonly followUp: { readonly title: string; readonly body: string; readonly route?: Route } | null;
  readonly badge?: number;
}

/**
 * Does what a notification's button asks, with this phone's key, and says what to show for it. Approve calls the hub
 * only for a notification that has the button (categoryOf): a money or irreversible request asks to be opened in the
 * app instead. Then the badge is read again, as acting changed what needs the person.
 */
export const act = async (a: Act, p: PushPayload, link: HubLink, newId: () => string): Promise<Acted> => {
  const title = p.title || "fleetd";
  if (a.t === "approve" && categoryOf(p) !== "fleetd.approve") {
    return { followUp: { title, body: `Open fleetd to review it on its full card: ${p.body}`, route: a.route } };
  }
  const r = await withHub(link, async (client) => {
    const done =
      a.t === "reply"
        ? await client.call("chat_send", { projectRef: refOf(a.key), text: a.text, clientRequestId: newId() })
        : await client.call("approval_answer", { requestId: a.requestId, decision: a.t });
    const badge = await client.call("push_badge", {});
    return { done, badge: badge.ok ? badge.output.badge : undefined };
  });
  const outcome = r.ok ? r.value.done : r;
  const badge = r.ok && r.value.badge !== undefined ? { badge: r.value.badge } : {};
  if (a.t === "reply") {
    return outcome.ok ? { followUp: null, ...badge } : { followUp: { title, body: `Your reply wasn't sent: ${outcome.error.message}`, route: { t: "chat", key: a.key } }, ...badge };
  }
  // An approved command whose machine couldn't take it goes back to open, with why in its evidence.
  const reopened = outcome.ok && "request" in outcome.output && outcome.output.request.state === "open";
  if (reopened) {
    const why = outcome.output.request.evidence ?? "not run: approve it again in fleetd";
    return { followUp: { title, body: `${why.charAt(0).toUpperCase()}${why.slice(1)}`, route: a.route }, ...badge };
  }
  if (outcome.ok) return { followUp: { title, body: `${a.t === "approve" ? "Approved" : "Denied"}: ${p.body}`, route: a.route }, ...badge };
  return { followUp: { title, body: `Not ${a.t === "approve" ? "approved" : "denied"}: ${outcome.error.message}`, route: a.route }, ...badge };
};
