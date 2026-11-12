// The paired hub, kept in the platform's secure storage (Keychain, Keystore): its address, its name and this phone's
// key; every hub this phone has a key for, the one shown among them; who is signed in to fleetd cloud; the phone's
// notification key; and which chats are muted, for the notification extension.
import { getRandomBytes } from "expo-crypto";
import * as SecureStore from "expo-secure-store";
import type { KeptHub, SavedAccount } from "./cloud/account";
import type { Paired } from "./hub/pair";
import { fromBase64, keyPairOf, toBase64, type KeyPair } from "./seal";

const KEY = "fleetd.hub";
// Readable once the phone has been unlocked since it started, as the notification key is, so a Shortcuts action an
// Apple automation runs on a locked phone reads it too (plugins/app-intents); never in a backup nor restored onto
// another phone: the key is this phone's alone. Its service stays expo-secure-store's own ("app:no-auth"), where the
// Share Extension and the Shortcuts actions read it.
const HUB = { keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY };

export const loadPaired = async (): Promise<Paired | null> => {
  const text = await SecureStore.getItemAsync(KEY);
  if (text === null) return null;
  try {
    const { hub, key, hubName } = JSON.parse(text) as Partial<Paired>;
    if (typeof hub !== "string" || typeof key !== "string") return null;
    // An older version kept it under the default, which a backup carries and only an unlocked phone reads: written
    // again, it stays here from now on.
    // Awaited, so a Disconnect that follows can't be undone by this write landing after it.
    await SecureStore.setItemAsync(KEY, text, HUB).catch(() => undefined);
    return { hub, key, hubName: typeof hubName === "string" ? hubName : hub };
  } catch {
    return null;
  }
};

const savePaired = (paired: Paired): Promise<void> => SecureStore.setItemAsync(KEY, JSON.stringify(paired), HUB);

export const forgetPaired = (): Promise<void> => SecureStore.deleteItemAsync(KEY);

// Every hub this phone keeps a key for, the shown one too, as one item of the same class as the shown hub's: a person
// with fleetd cloud's teams and a hub of their own switches between them in Settings. The shown one stays in
// "fleetd.hub" as well, which the extensions read.
const HUBS = "fleetd.hubs";
const ACCOUNT = "fleetd.account";

const keptOf = (o: unknown): KeptHub | null => {
  const { hub, key, hubName, cloud, invited } = (typeof o === "object" && o !== null ? o : {}) as Record<string, unknown>;
  if (typeof hub !== "string" || typeof key !== "string" || hub === "" || key === "") return null;
  return {
    hub,
    key,
    hubName: typeof hubName === "string" ? hubName : hub,
    ...(cloud === true ? { cloud: true as const } : {}),
    ...(invited === true ? { invited: true as const } : {}),
  };
};

/** The hubs kept, with `shown` among them: one paired before this list was kept is its only hub. */
export const loadHubs = async (shown: Paired | null): Promise<KeptHub[]> => {
  let list: KeptHub[] = [];
  try {
    const parsed: unknown = JSON.parse((await SecureStore.getItemAsync(HUBS, HUB)) ?? "[]");
    list = Array.isArray(parsed) ? parsed.flatMap((o) => keptOf(o) ?? []) : [];
  } catch {
    list = [];
  }
  return shown === null || list.some((h) => h.hub === shown.hub) ? list : [...list, shown];
};

export const saveHubs = (hubs: readonly KeptHub[]): Promise<void> =>
  hubs.length === 0 ? SecureStore.deleteItemAsync(HUBS, HUB) : SecureStore.setItemAsync(HUBS, JSON.stringify(hubs), HUB);

/** Who is signed in to fleetd cloud: the email and WorkOS's session id, nothing else of WorkOS. */
export const loadAccount = async (): Promise<SavedAccount | null> => {
  try {
    const { email, sessionId } = JSON.parse((await SecureStore.getItemAsync(ACCOUNT, HUB)) ?? "null") as Partial<SavedAccount>;
    return typeof email === "string" && typeof sessionId === "string" ? { email, sessionId } : null;
  } catch {
    return null;
  }
};

export const saveAccount = (account: SavedAccount | null): Promise<void> =>
  account === null ? SecureStore.deleteItemAsync(ACCOUNT, HUB) : SecureStore.setItemAsync(ACCOUNT, JSON.stringify(account), HUB);

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
const MUTED = "fleetd.muted-chats";

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
