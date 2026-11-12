// How an export carries secrets: nothing sealed to the hub's own keys leaves as it is, and nothing leaves in the
// clear. The export has a random 32-byte key of its own, written to the header only wrapped under a key derived from
// the passphrase the person types at export and again at import (scrypt, then AES-256-GCM: the vault's own passphrase
// scheme, keys.ts). Under the export's key go:
// - a vault item: its envelope with the data key wrapped again (crypto.ts `rewrap`), the item's ciphertext untouched
//   and its row binding kept, so its plaintext is never made on either side;
// - a value that was sealed to the hub's box key: AES-256-GCM, bound to its table, column and row.
// The hub's root key and box key are never written.
import { randomBytes, scryptSync } from "node:crypto";
import type { HubExportKdf, HubExportSecrets } from "../../shared/contracts.ts";
import { type Binding, gcmOpen, gcmSeal, newKey, rewrap } from "../vault/crypto.ts";

/** scrypt's cost for a new export: 128 MiB of memory, as the vault's passphrase key. */
export const KDF_N = 131072;
/** The most a reader will spend on a file's own parameters. */
const KDF_N_MAX = 1 << 20;
export const PASSPHRASE_MIN = 12;
/** The key id a vault item's envelope names while it is in an export. */
export const EXPORT_KEY_ID = "export";

const WRAP_AAD = Buffer.from("fleetd-export/key/1");
const b64 = (b: Uint8Array) => Buffer.from(b).toString("base64");
const unb64 = (s: string) => new Uint8Array(Buffer.from(s, "base64"));

function derive(passphrase: string, kdf: HubExportKdf): Uint8Array {
  const sane = kdf.alg === "scrypt" && Number.isInteger(kdf.N) && kdf.N >= 2 && kdf.N <= KDF_N_MAX && (kdf.N & (kdf.N - 1)) === 0 && kdf.r >= 1 && kdf.r <= 16 && kdf.p >= 1 && kdf.p <= 4;
  if (!sane) throw new Error("the export's key derivation isn't one this fleetd knows");
  return new Uint8Array(
    scryptSync(passphrase.normalize("NFC"), unb64(kdf.salt), 32, { N: kdf.N, r: kdf.r, p: kdf.p, maxmem: 256 * kdf.N * kdf.r + 1024 * 1024 }),
  );
}

/** A fresh key for an export, and what the header keeps of it: the key wrapped under `passphrase`. */
export function newSecrets(passphrase: string, n = KDF_N): { key: Uint8Array; secrets: HubExportSecrets } {
  const kdf: HubExportKdf = { alg: "scrypt", N: n, r: 8, p: 1, salt: b64(randomBytes(16)) };
  const kek = derive(passphrase, kdf);
  try {
    const key = newKey();
    return { key, secrets: { kdf, wrapped: b64(gcmSeal(kek, key, WRAP_AAD)) } };
  } finally {
    kek.fill(0);
  }
}

/** The export's key; null for a passphrase that isn't the one it was written with. */
export function openSecrets(secrets: HubExportSecrets, passphrase: string): Uint8Array | null {
  const kek = derive(passphrase, secrets.kdf);
  try {
    const key = gcmOpen(kek, unb64(secrets.wrapped), WRAP_AAD);
    return key?.length === 32 ? key : null;
  } finally {
    kek.fill(0);
  }
}

/** Which value a seal belongs to: its table, its column (with the path inside a JSON one) and its row's key. */
export type SealedAt = { table: string; column: string; row: (string | number | null)[] };

const aad = (at: SealedAt) => Buffer.from(`fleetd-export/sealed/1|${at.table}|${at.column}|${JSON.stringify(at.row)}`);

/** `plain` under the export's key, as a row's `$sealed` carries it (base64). */
export const sealValue = (key: Uint8Array, at: SealedAt, plain: Uint8Array): string => b64(gcmSeal(key, plain, aad(at)));

/** null for another key, another place's value or any damage. */
export const openValue = (key: Uint8Array, at: SealedAt, sealed: string): Uint8Array | null => gcmOpen(key, unb64(sealed), aad(at));

type ItemAt = Pick<Binding, "itemId" | "version">;

/** A vault item's envelope under the export's key; null when `root` doesn't open it. */
export const itemToExport = (root: Uint8Array, key: Uint8Array, at: ItemAt, sealed: Uint8Array): Uint8Array | null =>
  rewrap(root, key, EXPORT_KEY_ID, at, sealed);

/** The envelope under the new hub's root key `root`, named `rootId`; null when the export's key doesn't open it. */
export const itemFromExport = (key: Uint8Array, root: Uint8Array, rootId: string, at: ItemAt, sealed: Uint8Array): Uint8Array | null =>
  rewrap(key, root, rootId, at, sealed);
