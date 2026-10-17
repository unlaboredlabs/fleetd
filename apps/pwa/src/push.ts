import type { Hub } from "./hub.ts";

// Web Push: the service worker shows each push; the hub sends them (VAPID, coalesced, quiet hours).

export const pushSupported = () =>
  window.isSecureContext && "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;

export const b64urlToBytes = (text: string): Uint8Array<ArrayBuffer> => {
  const b64 = text.replace(/-/gu, "+").replace(/_/gu, "/").padEnd(Math.ceil(text.length / 4) * 4, "=");
  return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
};

const registration = () => navigator.serviceWorker.register("/sw.js");

export const currentSubscription = async () => (await registration()).pushManager.getSubscription();

/** Shown with the hub's push and key listings. */
const deviceName = () => /iPhone|iPad|Android/u.exec(navigator.userAgent)?.[0] ?? "browser";

export const subscribe = async (hub: Hub) => {
  if ((await Notification.requestPermission()) !== "granted") throw new Error("Notifications are blocked for this site.");
  const { publicKey } = await hub.call<{ publicKey: string }>("push_vapid_key", {});
  const reg = await registration();
  const sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64urlToBytes(publicKey) });
  const json = sub.toJSON();
  try {
    await hub.call("push_subscribe", { endpoint: sub.endpoint, keys: json.keys, deviceName: deviceName() });
  } catch (error) {
    await sub.unsubscribe();
    throw error;
  }
};

export const unsubscribe = async (hub: Hub, sub: PushSubscription) => {
  await hub.call("push_unsubscribe", { endpoint: sub.endpoint });
  await sub.unsubscribe();
};
