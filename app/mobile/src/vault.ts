// The paired hub, kept in the platform's secure storage (Keychain, Keystore): its address, its name and this phone's
// key; the phone's notification key; and which chats are muted, for the notification extension.
import { getRandomBytes } from "expo-crypto";
import * as SecureStore from "expo-secure-store";
import type { Paired } from "./hub/pair";
import { fromBase64, keyPairOf, toBase64, type KeyPair } from "./seal";

const KEY = "fleetd.hub";
// Readable while the phone is unlocked, as before, and never in a backup nor restored onto another phone: the key is
// this phone's alone. Its service stays expo-secure-store's own ("app:no-auth"), where the Share Extension reads it.
const HUB = { keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY };

export const loadPaired = async (): Promise<Paired | null> => {
  const text = await SecureStore.getItemAsync(KEY);
  if (text === null) return null;
  try {
    const { hub, key, hubName } = JSON.parse(text) as Partial<Paired>;
    if (typeof hub !== "string" || typeof key !== "string") return null;
    // An older version kept it under the default, which a backup carries: written again, it stays here from now on.
    // Awaited, so a Disconnect that follows can't be undone by this write landing after it.
    await SecureStore.setItemAsync(KEY, text, HUB).catch(() => undefined);
    return { hub, key, hubName: typeof hubName === "string" ? hubName : hub };
  } catch {
    return null;
  }
};

export const savePaired = (paired: Paired): Promise<void> => SecureStore.setItemAsync(KEY, JSON.stringify(paired), HUB);

export const forgetPaired = (): Promise<void> => SecureStore.deleteItemAsync(KEY);

// This phone's notification key pair for the hub (push.ts): only its secret key is kept, under the service the iOS
// Notification Service Extension reads (plugins/notification-service), after first unlock so a locked phone still opens
// its notifications, and never in a backup. On iOS it lands in the access group the app and the extension share: the
// app's first keychain-access-groups entry, which the plugin sets. With it, the hub's id for this phone's registration.
const PUSH = { keychainService: "fleetd.push", keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY };
const SECRET_KEY = "secretKey";
const DEVICE = "deviceId";

export const loadPushKeys = async (): Promise<KeyPair | null> => {
  const secret = fromBase64((await SecureStore.getItemAsync(SECRET_KEY, PUSH)) ?? "");
  return secret?.length === 32 ? keyPairOf(secret) : null;
};

/** The key pair, made (crypto_box_keypair: 32 random bytes) when there is none. */
export const pushKeys = async (): Promise<KeyPair> => {
  const known = await loadPushKeys();
  if (known !== null) return known;
  const keys = keyPairOf(getRandomBytes(32));
  await SecureStore.setItemAsync(SECRET_KEY, toBase64(keys.secretKey), PUSH);
  return keys;
};

export const savePushDevice = (deviceId: string): Promise<void> => SecureStore.setItemAsync(DEVICE, deviceId, PUSH);

export const loadPushDevice = (): Promise<string | null> => SecureStore.getItemAsync(DEVICE, PUSH);

/**
 * The chats muted on this phone (prefs.ts), for the Notification Service Extension: account "fleetd.muted-chats" beside
 * the notification key (service "fleetd.push:no-auth", the shared access group), a JSON array of "machineId/projectId",
 * written each time Mute changes. The extension reads it once the notification-actions change (W182, T1251) lands;
 * until then Mute only greys the chat's count in the app, and its notifications still alert.
 */
export const MUTED = "fleetd.muted-chats";

export const saveMuted = (keys: readonly string[]): Promise<void> => SecureStore.setItemAsync(MUTED, JSON.stringify(keys), PUSH);

export const forgetPush = async (): Promise<void> => {
  await SecureStore.deleteItemAsync(SECRET_KEY, PUSH);
  await SecureStore.deleteItemAsync(DEVICE, PUSH);
};

/**
 * Keeps a newly paired hub, with a new notification key pair: a key pair is one hub's, so no hub this phone was paired
 * with before can seal a notification that opens here (and claim to come from another).
 */
export const pairWith = async (paired: Paired): Promise<void> => {
  await Promise.all([savePaired(paired), forgetPush().then(pushKeys)]);
};
