import { app } from "electron";
import { AppImageUpdater, MacUpdater } from "electron-updater";

const REPO = "unlaboredlabs/fleetd";
const CHECK_EVERY_MS = 4 * 60 * 60 * 1000;

/**
 * Nightly builds follow the rolling nightly release and tagged builds the latest one, like `fleetd update`. The feed
 * is a plain download URL (latest-mac.yml / latest-linux.yml next to the assets): no GitHub API, so no token or rate
 * limit. FLEETD_BASE_URL points at another directory of release assets, as it does for the installer.
 */
const feedUrl = (version: string): string =>
  process.env["FLEETD_BASE_URL"] ??
  (version.includes("-nightly.")
    ? `https://github.com/${REPO}/releases/download/nightly`
    : `https://github.com/${REPO}/releases/latest/download`);

/**
 * Checks for an update at launch and every few hours, downloads it, and installs it when the app quits. Only the
 * packaged macOS app (Squirrel.Mac requires the update to be signed by the same team) and the AppImage update
 * themselves; the deb is updated by re-running the installer or by the package manager, because dpkg needs root.
 * Returns the updater, so the shell can offer "restart to update" on its `update-downloaded` event.
 */
export const startUpdater = (): MacUpdater | AppImageUpdater | null => {
  if (!app.isPackaged) return null;
  const options = { provider: "generic" as const, url: feedUrl(app.getVersion()) };
  const updater =
    process.platform === "darwin"
      ? new MacUpdater(options)
      : process.platform === "linux" && process.env["APPIMAGE"] !== undefined
        ? new AppImageUpdater(options)
        : null;
  if (updater === null) return null;
  // The staple-later flow replaces a published zip, so blockmaps aren't published; always download the whole file.
  updater.disableDifferentialDownload = true;
  updater.autoInstallOnAppQuit = true;
  const check = (): void => {
    updater.checkForUpdates().catch((error: unknown) => {
      console.warn("update check failed:", error instanceof Error ? error.message : error);
    });
  };
  check();
  setInterval(check, CHECK_EVERY_MS).unref();
  return updater;
};
