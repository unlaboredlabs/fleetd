import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { app } from "electron";
import type { LinkHandlerStatus } from "../shared/app";
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

export const linkHandlerStatus = (): LinkHandlerStatus => ({
  packaged: app.isPackaged,
  handler: app.isPackaged && app.isDefaultProtocolClient(SCHEME),
});

/** Claims fleetd:// when `shouldClaim` says so, and reports where things stand. */
export const claimLinkHandler = (reason: ClaimReason): LinkHandlerStatus => {
  const isHandler = app.isPackaged && app.isDefaultProtocolClient(SCHEME);
  if (shouldClaim({ packaged: app.isPackaged, reason, claimedBefore: claimedBefore(), isHandler })) {
    // Recorded even when the OS refuses, so a refusal isn't retried on every launch.
    app.setAsDefaultProtocolClient(SCHEME);
    if (reason === "first-run") record();
  }
  return linkHandlerStatus();
};
