import { app, dialog, shell } from "electron";
import { AppImageUpdater, DebUpdater, MacUpdater } from "electron-updater";
import { feedUrl } from "./update-feed";

const CHECK_EVERY_MS = 4 * 60 * 60 * 1000;
const DEB = "fleetd-desktop-linux-amd64.deb";

/**
 * Checks the release feed at launch and every few hours. The packaged macOS app and the AppImage download the update
 * and install it when the app quits (Squirrel.Mac requires it signed by the same team). Any other Linux install is
 * the deb (the installer only installs the AppImage), which can't update itself because dpkg needs root: it only
 * checks, and tells the user once per version where to get the new .deb and how to install it. Returns the updater,
 * so the shell can offer "restart to update" on its `update-downloaded` event.
 */
export const startUpdater = (): MacUpdater | AppImageUpdater | DebUpdater | null => {
  if (!app.isPackaged) return null;
  const url = feedUrl(app.getVersion(), process.env["FLEETD_BASE_URL"]);
  const options = { provider: "generic" as const, url };
  const deb = process.platform === "linux" && process.env["APPIMAGE"] === undefined;
  const updater =
    process.platform === "darwin"
      ? new MacUpdater(options)
      : process.platform === "linux"
        ? deb
          ? new DebUpdater(options)
          : new AppImageUpdater(options)
        : null;
  if (updater === null) return null;
  // The staple-later flow replaces a published zip, so blockmaps aren't published; always download the whole file.
  updater.disableDifferentialDownload = true;
  if (deb) {
    updater.autoDownload = false;
    updater.autoInstallOnAppQuit = false;
    let told: string | null = null;
    updater.on("update-available", ({ version }) => {
      if (told === version) return;
      told = version;
      console.info(`update notice: fleetd ${version} is available as ${DEB}`);
      void dialog
        .showMessageBox({
          type: "info",
          message: `fleetd ${version} is available`,
          detail: `Download ${DEB}, then install it with:\n\nsudo apt install ./${DEB}`,
          buttons: ["Download", "Later"],
          defaultId: 0,
          cancelId: 1,
        })
        .then(({ response }) => {
          if (response === 0) void shell.openExternal(`${url}/${DEB}`);
        });
    });
  } else {
    updater.autoInstallOnAppQuit = true;
  }
  const check = (): void => {
    updater.checkForUpdates().catch((error: unknown) => {
      console.warn("update check failed:", error instanceof Error ? error.message : error);
    });
  };
  check();
  setInterval(check, CHECK_EVERY_MS).unref();
  return updater;
};
