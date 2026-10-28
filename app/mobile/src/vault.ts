// The paired hub, kept in the platform's secure storage (Keychain, Keystore): its address, its name and this phone's
// key; and the phone's notification key. Nothing else is stored.
import { getRandomBytes } from "expo-crypto";
import * as SecureStore from "expo-secure-store";
import type { Paired } from "./hub/pair";
import { fromBase64, keyPairOf, toBase64, type KeyPair } from "./seal";

const KEY = "fleetd.hub";

export const loadPaired = async (): Promise<Paired | null> => {
  const text = await SecureStore.getItemAsync(KEY);
  if (text === null) return null;
  try {
    const { hub, key, hubName } = JSON.parse(text) as Partial<Paired>;
    return typeof hub === "string" && typeof key === "string" ? { hub, key, hubName: typeof hubName === "string" ? hubName : hub } : null;
  } catch {
    return null;
  }
};

export const savePaired = (paired: Paired): Promise<void> => SecureStore.setItemAsync(KEY, JSON.stringify(paired));

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

export const forgetPush = async (): Promise<void> => {
  await SecureStore.deleteItemAsync(SECRET_KEY, PUSH);
  await SecureStore.deleteItemAsync(DEVICE, PUSH);
};
