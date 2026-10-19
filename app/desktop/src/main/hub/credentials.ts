// Where the hub URL and key live. The key never reaches the renderer.
//
// - safeStorage when the OS offers real encryption (macOS Keychain, the Secret Service or KWallet on Linux): the
//   encrypted blob is a file in the fleetd dir. On macOS safeStorage's own keychain item is created by this app and
//   trusts it, so launches never prompt (as long as the build is signed with our Team ID; see #143 for why ad-hoc
//   signatures can't keep that trust across updates).
// - Otherwise (no keyring on Linux, or an ad-hoc/unsigned Mac build) a 0600 file in a 0700 dir, as `gh` and the GPUI
//   app's hub.json keep theirs.
//
// The GPUI app's key moves over once, ever (a marker is written before the read, so a denied or crashed read is
// never retried), and its store is left untouched: writing or deleting there could prompt.
import { chmodSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import type { KeyStore } from "../../shared/pairing";

export interface Saved {
  readonly url: string;
  readonly key: string;
}

export interface Loaded {
  readonly saved: Saved | null;
  /** A plain note for the pairing screen, e.g. that the old key couldn't be moved. */
  readonly note?: string;
}

export interface CredentialEnv {
  /** The fleetd dir: FLEETD_HOME, else `<appData>/fleetd` (shared with the CLI and the GPUI app). */
  readonly dir: string;
  readonly platform: NodeJS.Platform;
  /** Encryption the OS backs, or null when there is none worth the name. */
  readonly crypto: { encrypt(text: string): Buffer; decrypt(blob: Buffer): string } | null;
  /** The GPUI app's OS keychain items, or null when they must not be read (FLEETD_HOME relocates everything else). */
  readonly keychain: { get(service: string, account: string): string | null } | null;
  /** macOS: whether this build is signed with a Team ID (the GPUI app wrote its keychain item only then). */
  readonly teamSigned: () => boolean;
  /** macOS: this build's code-signing identifier. GPUI's item trusts `sh.fleetd.app` + the Team ID, nothing else. */
  readonly bundleId: () => string | null;
}

/** The GPUI app's bundle identifier; its keychain item opens without a prompt only for the same one. */
export const GPUI_BUNDLE_ID = "sh.fleetd.app";

/**
 * Whether to encrypt with safeStorage. On macOS the Team-ID check comes first: asking safeStorage anything reads or
 * creates its keychain item, whose trust an ad-hoc build loses at every update, and then every launch prompts (#143).
 * A relocated home (FLEETD_HOME) never touches the OS store.
 */
export const useOsEncryption = (os: OsFacts): boolean => osEncryption(os) === null;

interface OsFacts {
  readonly platform: NodeJS.Platform;
  readonly relocated: boolean;
  readonly teamSigned: () => boolean;
  readonly available: () => boolean;
  readonly linuxBackend: () => string;
}

/** Why the key can't be encrypted by the OS here, or null when it is. */
export type NoOsStore = "relocated" | "unsigned" | "no-keyring" | "unavailable";

export const osEncryption = (os: OsFacts): NoOsStore | null => {
  if (os.relocated) return "relocated";
  if (os.platform === "darwin" && !os.teamSigned()) return "unsigned";
  if (!os.available()) return os.platform === "linux" ? "no-keyring" : "unavailable";
  return os.platform === "linux" && os.linuxBackend() === "basic_text" ? "no-keyring" : null;
};

/** Where the key is kept, in words a person can check, with how to get it into the OS store when it isn't. */
export const keyStoreOf = (no: NoOsStore | null, platform: NodeJS.Platform, dir: string): KeyStore => {
  if (no === null) {
    return {
      kind: "os",
      where: platform === "darwin" ? "the macOS Keychain" : platform === "linux" ? "your keyring (Secret Service)" : "the OS's protected storage",
    };
  }
  const path = join(dir, PLAIN);
  switch (no) {
    case "relocated":
      return { kind: "file", path, why: "FLEETD_HOME is set, so this app keeps its key out of the OS keychain.", fix: "Start the app without FLEETD_HOME to keep the key in the keychain." };
    case "unsigned":
      return {
        kind: "file",
        path,
        why: "This build isn't signed with fleetd's Developer ID, so the Keychain would ask for your password after every update.",
        fix: "Install the signed app (`curl -fsSL https://fleetd.sh | sh`), then pair again to keep the key in the Keychain.",
      };
    case "no-keyring":
      return {
        kind: "file",
        path,
        why: "No keyring (Secret Service) is running on this computer.",
        fix: "Install and unlock GNOME Keyring or KWallet, restart the app, and pair again to keep the key there.",
      };
    case "unavailable":
      return { kind: "file", path, why: "The OS keychain isn't available to this app.", fix: "Pair again once the keychain is available to keep the key there." };
  }
};

const ENCRYPTED = "desktop-hub.bin";
const PLAIN = "desktop-hub.json";
const MIGRATED = "desktop-migrated";
/** The GPUI app's file on ad-hoc Mac builds. */
const GPUI_FILE = "hub.json";
const GPUI_SERVICE = "fleetd";
/** GPUI's item on Linux; on macOS its Developer ID builds used their own. */
const GPUI_ACCOUNT_LINUX = "hub";
const GPUI_ACCOUNT_MAC_SIGNED = "hub-developer-id";

export const PAIR_AGAIN = "The key the earlier fleetd app saved couldn't be moved to this version. Pair once more to continue.";

const SavedSchema = z.object({ url: z.string().min(1), key: z.string().min(1) });

const parse = (text: string): Saved | null => {
  try {
    const parsed = SavedSchema.safeParse(JSON.parse(text));
    return parsed.success ? { url: parsed.data.url, key: parsed.data.key } : null;
  } catch {
    return null;
  }
};

const read = (path: string): Buffer | null => {
  try {
    return readFileSync(path);
  } catch {
    return null;
  }
};

const makeDir = (dir: string): void => {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
};

/** 0600 from creation, renamed into place so a crash never leaves half a file. */
const writePrivate = (dir: string, name: string, body: Buffer | string): void => {
  makeDir(dir);
  const tmp = join(dir, `${name}.tmp`);
  rmSync(tmp, { force: true });
  writeFileSync(tmp, body, { mode: 0o600, flag: "wx" });
  renameSync(tmp, join(dir, name));
};

export const describeStore = (env: CredentialEnv): string =>
  env.crypto === null ? `in a file only you can read (${join(env.dir, PLAIN)})` : "encrypted with the OS keychain";

/** For scripted runs (the demo recorder, the lab): both set means use them and store nothing. */
export const fromEnv = (vars: NodeJS.ProcessEnv): Saved | null => {
  const url = vars["FLEETD_HUB_URL"];
  const key = vars["FLEETD_AGENT_KEY"];
  return url !== undefined && url !== "" && key !== undefined && key !== "" ? { url, key } : null;
};

export const loadCredentials = (env: CredentialEnv): Loaded => {
  const encrypted = read(join(env.dir, ENCRYPTED));
  if (encrypted !== null && env.crypto !== null) {
    let text: string | null = null;
    try {
      text = env.crypto.decrypt(encrypted);
    } catch {
      // The OS key changed (a new keyring, another user): the blob is unreadable for good.
    }
    const saved = text === null ? null : parse(text);
    return saved === null ? { saved: null, note: "The saved key couldn't be read. Pair again to continue." } : { saved };
  }
  const plain = read(join(env.dir, PLAIN));
  if (plain !== null) {
    const saved = parse(plain.toString("utf8"));
    if (saved !== null) return { saved };
  }
  return migrateOnce(env);
};

const migrateOnce = (env: CredentialEnv): Loaded => {
  const marker = join(env.dir, MIGRATED);
  if (read(marker) !== null) return { saved: null };
  try {
    writePrivate(env.dir, MIGRATED, "");
  } catch {
    return { saved: null };
  }
  let found: Saved | null;
  try {
    found = findGpuiKey(env);
  } catch {
    return { saved: null, note: PAIR_AGAIN };
  }
  if (found === null) return { saved: null };
  try {
    saveCredentials(env, found);
    return { saved: found };
  } catch (error) {
    return { saved: found, note: `${String(error)} Connected for this session only.` };
  }
};

/** Throws when a store that should hold the key can't be read. */
const findGpuiKey = (env: CredentialEnv): Saved | null => {
  if (env.platform === "darwin") {
    const file = read(join(env.dir, GPUI_FILE));
    if (file !== null) return parse(file.toString("utf8"));
    if (env.keychain === null || !env.teamSigned() || env.bundleId() !== GPUI_BUNDLE_ID) return null;
    const text = env.keychain.get(GPUI_SERVICE, GPUI_ACCOUNT_MAC_SIGNED);
    return text === null ? null : parse(text);
  }
  if (env.platform === "linux" && env.keychain !== null) {
    let text: string | null;
    try {
      text = env.keychain.get(GPUI_SERVICE, GPUI_ACCOUNT_LINUX);
    } catch {
      // No Secret Service: the GPUI app couldn't have saved a key there either, so there's nothing to move.
      return null;
    }
    return text === null ? null : parse(text);
  }
  return null;
};

/** Writes only when the value changed. A fresh pairing also settles the migration: it never runs after this. */
export const saveCredentials = (env: CredentialEnv, saved: Saved): void => {
  const text = JSON.stringify({ url: saved.url, key: saved.key });
  const current = loadStored(env);
  if (current?.url === saved.url && current.key === saved.key) return;
  if (env.crypto === null) {
    writePrivate(env.dir, PLAIN, text);
  } else {
    writePrivate(env.dir, ENCRYPTED, env.crypto.encrypt(text));
    rmSync(join(env.dir, PLAIN), { force: true });
  }
  if (read(join(env.dir, MIGRATED)) === null) writePrivate(env.dir, MIGRATED, "");
};

const loadStored = (env: CredentialEnv): Saved | null => {
  const encrypted = read(join(env.dir, ENCRYPTED));
  if (encrypted !== null && env.crypto !== null) {
    try {
      return parse(env.crypto.decrypt(encrypted));
    } catch {
      return null;
    }
  }
  const plain = read(join(env.dir, PLAIN));
  return plain === null ? null : parse(plain.toString("utf8"));
};

/** Forgets this app's key. The GPUI app's store stays as it was. */
export const clearCredentials = (env: CredentialEnv): void => {
  rmSync(join(env.dir, ENCRYPTED), { force: true });
  rmSync(join(env.dir, PLAIN), { force: true });
};
