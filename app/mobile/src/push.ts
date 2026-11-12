// Push notifications (D218), the parts that don't touch the OS: registering this phone with the
// hub, opening a sealed notification, what to show for it and where tapping it goes. The phone's X25519 key pair is
// made at pairing and kept in secure storage (vault.ts); the hub seals each notification to its public key and the
// relay forwards the ciphertext as `c`. On iOS the Notification Service Extension opens it before it shows
// (plugins/notification-service); on Android the app's background task does and posts it (notifications.ts). A
// notification's buttons (Approve and Deny, Review, Reply) are its category, which the hub picks inside the sealed
// payload; what each does is `act`, over a connection of its own, since the app may have been started only for it.
// Reading a payload and what shows for it is pushPayload.ts's, which the package exports.
import type { HubError, HumanRequest } from "./desktop";
import { HubClient, READY_TIMEOUT_MS, type Transport } from "./hub/client";
import { categoryOf, openPayload as openWith, readPayload, routeFrom, routeOf, shownOf, type PushPayload, type Route, type Shown } from "./pushPayload";
import { openSealed, toBase64, type KeyPair } from "./seal";
import { keyOf, refOf, type Key } from "./store";
import { deviceZone } from "./zone";

export {
  CATEGORIES,
  CATEGORY_SUMMARIES,
  CHANNELS,
  categoryOf,
  shownOf,
  type Category,
  type CategoryAction,
  type Channel,
  type PushPayload,
  type PushRoute,
  type Route,
  type Shown,
} from "./pushPayload";

type Platform = "ios" | "android";

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
  /** The chat on screen (null: none), whose notifications don't show while the app is open (inApp). */
  readonly onScreen?: (key: Key | null) => void;
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
  // A hub seldom answers the revoke of the caller's own key: revoking it closes the very link the call came on (4401),
  // so the call fails and the hub then refuses the key, which is the revoke done.
  return revoked.ok || client.state.phase === "refused" ? { ok: true } : revoked;
};

/** A sealed notification (`c`, base64) opened with this phone's keys (pushPayload.ts `openPayload`). */
export const openPayload = (sealed: string, keys: KeyPair): PushPayload | null => openWith(sealed, (box) => openSealed(box, keys));

/**
 * Whether a notification shows while the app is open: not for the chat on screen, nor its approvals, whose messages
 * and cards are already there, as Messages shows no banner for the conversation you're in.
 */
export const inApp = (route: Route | undefined, onScreen: Key | null): boolean =>
  onScreen === null || route === undefined || route.t === "screen" || route.t === "devices" || route.key !== onScreen;

/** Whether a notification goes from Notification Center once `key` is read: its chat's messages, not what still waits for you. */
export const readClears = (route: Route | undefined, key: Key): boolean => route?.t === "chat" && route.key === key;

/** Where a route opens: a chat, an approval's at its card, a screen's with its live view over it. */
export interface ChatAt {
  readonly key: Key;
  readonly requestId?: string;
  readonly sessionId?: string;
}

/**
 * The chat a tapped notification opens: its own, or the approval's, scrolled to the card that answers it. An approval
 * that didn't say its chat is found among the open requests (`read`: read from the hub since the app started, not
 * only kept from before): undefined until they are read, null once they are and it isn't there (answered meanwhile),
 * when the app just opens.
 */
export const chatAt = (route: Route, requests: readonly HumanRequest[] | undefined, read = requests !== undefined): ChatAt | null | undefined => {
  if (route.t === "chat") return { key: route.key };
  if (route.t === "screen") return { key: route.key, sessionId: route.sessionId };
  // Settings' Devices, not a chat (App.tsx `go`).
  if (route.t === "devices") return null;
  const key = route.key ?? requests?.find((r) => r.requestId === route.requestId)?.projectRef;
  if (key === undefined) return read ? null : undefined;
  return { key: typeof key === "string" ? key : keyOf(key), requestId: route.requestId };
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

/** The sealed `c` of a raw push, wherever the OS put it (APNs userInfo, FCM data). */
const sealedOf = (raw: unknown): string | undefined => {
  if (typeof raw !== "object" || raw === null) return undefined;
  const r = raw as Record<string, unknown>;
  return typeof r.c === "string" && r.c !== "" ? r.c : sealedOf(r.data);
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

/** One connection for a few calls: dials, waits for the link, runs `use`, hangs up; an error when it doesn't come up in time. */
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
        // Up: the calls' own timeouts bound them from here, so an answer the hub took on a slow link is never cut off.
        clearTimeout(timer);
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
        ? await client.call("chat_send", { projectRef: refOf(a.key), text: a.text, clientRequestId: newId(), ...deviceZone() })
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
