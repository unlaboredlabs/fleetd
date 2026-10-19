import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { app } from "electron";
import type { LinkHandlerStatus } from "../shared/app";
import { RELEASE_BUILD } from "./build";
import { shouldClaim, type ClaimReason } from "./linkHandler";

const SCHEME = "fleetd";
const file = (): string => join(app.getPath("userData"), "link-handler.json");

const claimedBefore = (): boolean => {
  try {
    const saved: unknown = JSON.parse(readFileSync(file(), "utf8"));
    return typeof saved === "object" && saved !== null && "claimedAt" in saved;
  } catch {
    return false;
  }
};

const record = (): void => {
  try {
    const tmp = `${file()}.tmp`;
    writeFileSync(tmp, JSON.stringify({ claimedAt: new Date().toISOString() }));
    renameSync(tmp, file());
  } catch {
    // Unrecorded, the next launch claims again: the one-time claim repeats, nothing breaks.
  }
};

// A dev, test or QA bundle never claims, even packed: it would take fleetd:// from the tester's real install.
// RELEASE_BUILD is fixed at build time; app.isPackaged only reflects the executable's name.
const isHandler = (): boolean => RELEASE_BUILD && app.isDefaultProtocolClient(SCHEME);

export const linkHandlerStatus = (): LinkHandlerStatus => ({ packaged: RELEASE_BUILD, handler: isHandler() });

/**
 * At launch: claims fleetd:// the first time a release build runs, then never again. It checks the record before
 * asking the OS anything, because on Linux that question runs xdg-settings synchronously.
 */
export const claimOnFirstRun = (): void => {
  const before = claimedBefore();
  // A first-run claim doesn't depend on who holds the scheme now, so the OS isn't asked.
  if (!shouldClaim({ packaged: RELEASE_BUILD, reason: "first-run", claimedBefore: before, isHandler: false })) return;
  app.setAsDefaultProtocolClient(SCHEME);
  // Recorded even when the OS refuses, so a refusal isn't retried on every launch.
  record();
};

/** From Settings or onboarding: claims fleetd:// when `shouldClaim` says so, and reports where things stand. */
export const claimLinkHandler = (reason: Exclude<ClaimReason, "first-run">): LinkHandlerStatus => {
  if (shouldClaim({ packaged: RELEASE_BUILD, reason, claimedBefore: claimedBefore(), isHandler: isHandler() })) {
    app.setAsDefaultProtocolClient(SCHEME);
  }
  return linkHandlerStatus();
};
