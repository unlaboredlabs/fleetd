// The real OS behind CredentialEnv: safeStorage, the GPUI app's keychain items, and the app's own code signature.
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import type { Entry as KeyringEntry } from "@napi-rs/keyring";
import { app, safeStorage } from "electron";
import { useOsEncryption, type CredentialEnv } from "./credentials";

interface Signature {
  readonly teamSigned: boolean;
  readonly identifier: string | null;
}

/** This Mac build's signature: a Team ID or not (ad-hoc and unsigned builds can't keep keychain trust across updates). */
const readSignature = (): Signature => {
  if (process.platform !== "darwin" || !app.isPackaged) return { teamSigned: false, identifier: null };
  try {
    // codesign -d reports on stderr, which execFileSync only hands back on failure; 2>&1 keeps it either way.
    const report = execFileSync("/bin/sh", ["-c", '/usr/bin/codesign -dv "$0" 2>&1', app.getPath("exe")], { encoding: "utf8" });
    return {
      teamSigned: /^TeamIdentifier=(?!not set)\S+/mu.test(report),
      identifier: /^Identifier=(\S+)/mu.exec(report)?.[1] ?? null,
    };
  } catch {
    return { teamSigned: false, identifier: null };
  }
};

/** Run after app ready (safeStorage needs it). `relocated`: FLEETD_HOME is set, so no OS store is ever touched. */
export const osCredentialEnv = (dir: string, relocated: boolean): CredentialEnv => {
  let signature: Signature | null = null;
  const signed = () => (signature ??= readSignature());
  const encrypted = useOsEncryption({
    platform: process.platform,
    relocated,
    teamSigned: () => signed().teamSigned,
    available: () => safeStorage.isEncryptionAvailable(),
    linuxBackend: () => safeStorage.getSelectedStorageBackend(),
  });
  return {
    dir,
    platform: process.platform,
    crypto: encrypted ? { encrypt: (text) => safeStorage.encryptString(text), decrypt: (blob) => safeStorage.decryptString(blob) } : null,
    keychain: relocated
      ? null
      : {
          get: (service, account) => {
            // Only the one-time migration needs this native module, so it loads only then.
            const { Entry } = createRequire(import.meta.url)("@napi-rs/keyring") as { Entry: typeof KeyringEntry };
            return new Entry(service, account).getPassword();
          },
        },
    teamSigned: () => signed().teamSigned,
    bundleId: () => signed().identifier,
  };
};
