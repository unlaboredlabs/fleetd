// The device's human key, in IndexedDB under this origin.
//
// Protection: the browser's same-origin policy, nothing more. Wrapping the key with a non-extractable WebCrypto key
// was considered and left out: script running on this origin (the real threat) could ask WebCrypto to unwrap it just
// as easily, and anything that can read the browser profile can read the wrapping key too. What limits the damage is
// on the hub: the key is human-only, scoped to this device, and `fleetd hub key revoke` ends it at its next call.

export interface StoredKey {
  readonly key: string;
  /** From pairing; absent for a key pasted by hand. */
  readonly keyId?: string;
}

const DB = "fleetd";
const STORE = "kv";
const ENTRY = "humanKey";

const open = () =>
  new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(DB, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(STORE);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("IndexedDB is unavailable."));
  });

const run = async <T>(mode: IDBTransactionMode, body: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> => {
  const db = await open();
  try {
    return await new Promise<T>((resolve, reject) => {
      const request = body(db.transaction(STORE, mode).objectStore(STORE));
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error ?? new Error("IndexedDB request failed."));
    });
  } finally {
    db.close();
  }
};

export const loadKey = async (): Promise<StoredKey | undefined> => {
  const value: unknown = await run("readonly", (store) => store.get(ENTRY));
  return typeof value === "object" && value !== null && typeof (value as StoredKey).key === "string" ? (value as StoredKey) : undefined;
};

export const saveKey = (stored: StoredKey) => run("readwrite", (store) => store.put(stored, ENTRY)).then(() => undefined);

export const forgetKey = () => run("readwrite", (store) => store.delete(ENTRY)).then(() => undefined);
