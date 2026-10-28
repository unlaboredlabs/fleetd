// The paired hub, kept in the platform's secure storage (Keychain, Keystore): its address, its name and this phone's
// key. Nothing else is stored.
import * as SecureStore from "expo-secure-store";
import type { Paired } from "./hub/pair";

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
