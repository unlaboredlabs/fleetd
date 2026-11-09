// The vault's values, in main (vault-design §4.6, §8). What the person types is sealed here to the hub's own box key
// (vault_status's hubBoxKey) with libsodium's crypto_box_seal, so the hub link and any proxy see only ciphertext, and
// the renderer never gets a value back from a save. A reveal makes a one-time X25519 key pair here, asks the hub to seal
// the fields to it (vault_reveal), opens them and wipes the secret half. Before either a reveal or a copy, the person
// proves they're here: Touch ID where this Mac has it, else one native confirm the page can't click for them; one
// that passed counts for that item for the next 30 seconds, so showing then copying asks once. A copy never passes the
// value through the renderer: main writes it to the clipboard and empties it a minute later, unless something else was
// copied since. Nothing here logs a value or keeps one.
import type { ToolInput } from "../shared/contracts";
import type { CallOutcome, HubError } from "../shared/hub";
import type { VaultCopyRequest, VaultRevealOutcome, VaultRevealRequest, VaultSaveRequest, VaultUnlockRequest } from "../shared/ipc";

/** How long a passed Touch ID (or confirm) covers the same item, and how long the clipboard keeps a copied value. */
export const UNLOCKED_MS = 30_000;
export const CLIPBOARD_MS = 60_000;

/** What this needs of the computer, so tests stand in for Touch ID, the confirm and the clipboard. */
export interface VaultPorts {
  /** Touch ID where it can, else a native confirm; whether the person passed it. `what`: "show Amazon's password". */
  authorize(what: string): Promise<boolean>;
  readClipboard(): Promise<string>;
  writeClipboard(text: string): Promise<void>;
  now(): number;
  later(fn: () => void, ms: number): void;
}

type Call = <T extends "vault_status" | "vault_save" | "vault_reveal" | "vault_unlock">(tool: T, input: ToolInput<T>) => Promise<CallOutcome>;

const refused = (message: string, fix?: string, code = "invalid"): { ok: false; error: HubError } => ({
  ok: false,
  error: { code, message, ...(fix === undefined ? {} : { fix }) },
});

const sodiumReady = async () => {
  // Loaded on the first use, not at startup: libsodium instantiates its WebAssembly on import.
  const { default: sodium } = await import("libsodium-wrappers");
  await sodium.ready;
  return sodium;
};

/** The hub's box key, from vault_status; or why not (a locked vault takes no new values). */
const hubKey = async (call: Call): Promise<{ ok: true; key: Uint8Array } | { ok: false; error: HubError }> => {
  const status = await call("vault_status", {});
  if (!status.ok) return status;
  const out = status.output as { hubBoxKey?: unknown; locked?: unknown };
  const key = typeof out.hubBoxKey === "string" ? Buffer.from(out.hubBoxKey, "base64") : Buffer.alloc(0);
  if (key.length !== 32) return refused("The hub sent no box key to seal to.", "Update fleetd on the hub, then try again.", "failed");
  return { ok: true, key: new Uint8Array(key) };
};

/** `value` as JSON sealed to `key`, base64; the plaintext bytes wiped after. */
const sealJson = async (key: Uint8Array, value: unknown): Promise<string> => {
  const sodium = await sodiumReady();
  const plain = new TextEncoder().encode(JSON.stringify(value));
  try {
    return Buffer.from(sodium.crypto_box_seal(plain, key)).toString("base64");
  } finally {
    plain.fill(0);
  }
};

/**
 * A new item, or a change to one: the typed fields sealed to the hub's key, then vault_save. No fields: only the
 * readable part changes (label, sites, secrecy). The hub's answer is the item's metadata, never a value.
 */
export const saveVaultItem = async (request: VaultSaveRequest, call: Call): Promise<CallOutcome> => {
  const { fields, ...rest } = request;
  // Parsed by the IPC schema, whose optional fields are absent rather than undefined.
  const input = rest as ToolInput<"vault_save">;
  if (fields === undefined || Object.keys(fields).length === 0) return call("vault_save", input);
  if (Object.values(fields).some((v) => v.includes("\0"))) return refused("A value holds a NUL character.", "Remove it, then save.");
  const key = await hubKey(call);
  if (!key.ok) return key;
  return call("vault_save", { ...input, sealed: await sealJson(key.key, fields) });
};

/** The hub's passphrase-mode vault opened after a start: the passphrase sealed to the hub's key, then vault_unlock. */
export const unlockVault = async (request: VaultUnlockRequest, call: Call): Promise<CallOutcome> => {
  const key = await hubKey(call);
  if (!key.ok) return key;
  return call("vault_unlock", { sealed: await sealJson(key.key, { passphrase: request.passphrase }) });
};

/** Touch ID or the confirm, unless one passed for this item a moment ago. */
export const authorizer = (ports: Pick<VaultPorts, "authorize" | "now">) => {
  const until = new Map<string, number>();
  return async (key: string, what: string): Promise<boolean> => {
    const now = ports.now();
    if ((until.get(key) ?? 0) > now) return true;
    for (const [k, t] of until) if (t <= now) until.delete(k);
    if (!(await ports.authorize(what))) return false;
    until.set(key, ports.now() + UNLOCKED_MS);
    return true;
  };
};

/** The fields asked for, opened: sealed by the hub to a key pair made for this one reveal, its secret half wiped. */
const openFields = async (request: VaultRevealRequest, call: Call): Promise<VaultRevealOutcome> => {
  const sodium = await sodiumReady();
  const keys = sodium.crypto_box_keypair();
  try {
    const out = await call("vault_reveal", { itemId: request.itemId, fields: request.fields, replyKey: Buffer.from(keys.publicKey).toString("base64") });
    if (!out.ok) return out;
    const sealed = (out.output as { sealed?: unknown }).sealed;
    let plain: Uint8Array;
    try {
      plain = sodium.crypto_box_seal_open(Buffer.from(typeof sealed === "string" ? sealed : "", "base64"), keys.publicKey, keys.privateKey);
    } catch {
      return refused("The hub's answer didn't open here.", "Try again; if it keeps failing, update fleetd on the hub.", "failed");
    }
    try {
      const parsed: unknown = JSON.parse(new TextDecoder().decode(plain));
      const fields: Record<string, string> = {};
      if (typeof parsed === "object" && parsed !== null) for (const [k, v] of Object.entries(parsed)) if (typeof v === "string") fields[k] = v;
      return { ok: true, fields };
    } catch {
      return refused("The hub's answer didn't open here.", "Try again; if it keeps failing, update fleetd on the hub.", "failed");
    } finally {
      plain.fill(0);
    }
  } finally {
    keys.privateKey.fill(0);
  }
};

const notPassed = (): { ok: false; error: HubError } => ({ ok: false, error: { code: "cancelled", message: "Not shown: you didn't confirm it." } });

/** Shows an item's fields to the page after Touch ID or the confirm; the page keeps them only while they're on screen. */
export const revealVaultItem = async (
  request: VaultRevealRequest,
  call: Call,
  authorize: (key: string, what: string) => Promise<boolean>,
  hub: string,
): Promise<VaultRevealOutcome> => {
  if (!(await authorize(`${hub}/${request.itemId}`, `show ${request.label}`))) return notPassed();
  return openFields(request, call);
};

/**
 * Copies one shown field to the clipboard without the page seeing it: a card's expiry as MM/YY, anything else as it
 * is. It's emptied after a minute, unless the person copied something else since.
 */
export const copyVaultField = async (
  request: VaultCopyRequest,
  call: Call,
  authorize: (key: string, what: string) => Promise<boolean>,
  hub: string,
  ports: Pick<VaultPorts, "readClipboard" | "writeClipboard" | "later">,
): Promise<{ ok: true } | { ok: false; error: HubError }> => {
  if (!(await authorize(`${hub}/${request.itemId}`, `copy ${request.label}`))) return notPassed();
  const fields = request.field === "expiry" ? ["month", "year"] : [request.field];
  const opened = await openFields({ itemId: request.itemId, label: request.label, fields }, call);
  if (!opened.ok) return opened;
  const f = opened.fields;
  const text = request.field === "expiry" ? (f["month"] !== undefined && f["year"] !== undefined ? `${f["month"]}/${f["year"].slice(-2)}` : "") : (f[request.field] ?? "");
  if (text === "") return refused("That field is empty.", undefined, "not_found");
  await ports.writeClipboard(text);
  ports.later(() => {
    void ports.readClipboard().then((now) => (now === text ? ports.writeClipboard("") : undefined));
  }, CLIPBOARD_MS);
  return { ok: true };
};
