// The real OS behind CredentialEnv: safeStorage, the GPUI app's keychain items, and the app's own code signature.
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { app, safeStorage } from "electron";
import type { Entry as KeyringEntry } from "@napi-rs/keyring";
import type { CredentialEnv } from "./credentials";

const TEAM_ID = /TeamIdentifier=(?!not set)\S+/u;

/** Whether this Mac build is signed with a Team ID. Ad-hoc and unsigned builds can't keep keychain trust across updates. */
const codesignTeam = (): boolean => {
  if (process.platform !== "darwin" || !app.isPackaged) return false;
  try {
    // codesign -d reports on stderr, which execFileSync only hands back on failure; 2>&1 keeps it either way.
    const report = execFileSync("/bin/sh", ["-c", '/usr/bin/codesign -dv "$0" 2>&1', app.getPath("exe")], { encoding: "utf8" });
    return TEAM_ID.test(report);
  } catch {
    return false;
  }
};

/** Run after app ready (safeStorage needs it). `relocated`: FLEETD_HOME is set, so the OS keychain is never read. */
export const osCredentialEnv = (dir: string, relocated: boolean): CredentialEnv => {
  let signed: boolean | null = null;
  const teamSigned = () => (signed ??= codesignTeam());
  const plainLinux = process.platform === "linux" && safeStorage.getSelectedStorageBackend() === "basic_text";
  const encrypted = safeStorage.isEncryptionAvailable() && !plainLinux && (process.platform !== "darwin" || teamSigned());
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
    teamSigned,
  };
};
