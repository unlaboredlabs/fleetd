// Push notifications (D218, docs/design/push.md), the parts that don't touch the OS: registering this phone with the
// hub, opening a sealed notification, what to show for it and where tapping it goes. The phone's X25519 key pair is
// made at pairing and kept in secure storage (vault.ts); the hub seals each notification to its public key and the
// relay forwards the ciphertext as `c`. On iOS the Notification Service Extension opens it before it shows
// (plugins/notification-service); on Android the app's background task does and posts it (notifications.ts).
import type { HubError } from "./desktop";
import type { HubClient } from "./hub/client";
import { fromBase64, openSealed, toBase64, utf8, type KeyPair } from "./seal";
import { keyOf, type Key } from "./store";

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
  readonly urgent?: boolean;
  readonly quiet?: boolean;
  readonly at: string;
}

const KINDS = new Set(["message", "approval", "order", "alert"]);

const str = (v: unknown): string | undefined => (typeof v === "string" && v !== "" ? v : undefined);

/** A sealed notification (`c`, base64) opened with this phone's keys; null when it doesn't open or isn't version 1. */
export const openPayload = (sealed: string, keys: KeyPair): PushPayload | null => {
  const bytes = fromBase64(sealed);
  const plain = bytes === null ? null : openSealed(bytes, keys);
  const text = plain === null ? null : utf8(plain);
  if (text === null) return null;
  let json: Record<string, unknown>;
  try {
    json = JSON.parse(text) as Record<string, unknown>;
  } catch {
    return null;
  }
  if (typeof json !== "object" || json === null || json.v !== 1 || typeof json.title !== "string" || typeof json.body !== "string") return null;
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
    ...(json.urgent === true ? { urgent: true } : {}),
    ...(json.quiet === true ? { quiet: true } : {}),
    at: str(json.at) ?? "",
  };
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
export type Route = { readonly t: "chat"; readonly key: Key } | { readonly t: "approval"; readonly requestId: string; readonly key?: Key };

export interface Shown {
  readonly title: string;
  readonly body: string;
  readonly channel: Channel;
  /** Replaces the notification already shown under it: one per chat, one per request. */
  readonly id?: string;
  readonly urgent: boolean;
  readonly route?: Route;
}

/** What shows when a notification can't be opened: the relay's own generic alert. */
export const GENERIC: Shown = { title: "fleetd", body: "New activity", channel: "other", urgent: false };

export const routeOf = (p: PushPayload): Route | undefined => {
  const key = p.machineId !== undefined && p.projectId !== undefined ? keyOf({ machineId: p.machineId, projectId: p.projectId }) : undefined;
  if (p.kind === "approval" && p.requestId !== undefined) return key === undefined ? { t: "approval", requestId: p.requestId } : { t: "approval", requestId: p.requestId, key };
  return key === undefined ? undefined : { t: "chat", key };
};

/** The notification Android posts for a payload (iOS's extension does the same in Swift); GENERIC when it didn't open. */
export const shownOf = (p: PushPayload | null): Shown => {
  if (p === null) return GENERIC;
  const route = routeOf(p);
  const channel: Channel = p.quiet === true ? "quiet" : p.kind === "message" ? "chats" : p.kind === "approval" ? "approvals" : "other";
  const id = route?.t === "approval" ? `approval:${route.requestId}` : p.kind === "message" && route !== undefined ? `chat:${route.key}` : undefined;
  return {
    title: p.title || "fleetd",
    body: p.body,
    channel,
    urgent: p.urgent === true,
    ...(id === undefined ? {} : { id }),
    ...(route === undefined ? {} : { route }),
  };
};

const routeFrom = (v: unknown): Route | undefined => {
  if (typeof v !== "object" || v === null) return undefined;
  const r = v as Record<string, unknown>;
  const key = str(r.key);
  if (r.t === "chat" && key !== undefined && key.includes("/")) return { t: "chat", key };
  const requestId = str(r.requestId);
  if (r.t === "approval" && requestId !== undefined) return key === undefined ? { t: "approval", requestId } : { t: "approval", requestId, key };
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
  const sealed = sealedOf(push) ?? sealedOf(data);
  const payload = sealed === undefined || keys === null ? null : openPayload(sealed, keys);
  return payload === null ? undefined : routeOf(payload);
};
