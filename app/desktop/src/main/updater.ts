import { app, dialog, shell } from "electron";
import type { AppImageUpdater, DebUpdater, MacUpdater } from "electron-updater";
import { RELEASE_BUILD } from "./build";
import { feedUrl } from "./update-feed";
import { DEB, updateMessage, type UpdateOutcome } from "./update-messages";

const CHECK_EVERY_MS = 4 * 60 * 60 * 1000;

export interface Updates {
  /** Loads electron-updater and starts the periodic checks. Call once the window is up (the module costs ~20 ms). */
  readonly start: () => void;
  /**
   * "Check for Updates…": checks now and always answers, in a dialog. Settles once the answer is out and, when it
   * starts a download, once that ends; a click meanwhile joins it rather than asking again.
   */
  readonly checkNow: () => Promise<void>;
}

interface Check {
  /** The periodic check: quiet, its downloads install on quit. */
  readonly background: () => void;
  /** The menu's check: always answers. */
  readonly manual: () => Promise<void>;
}

const show = (outcome: UpdateOutcome, act: () => void): void => {
  const { buttons, ...text } = updateMessage(outcome, app.getVersion());
  void dialog.showMessageBox({ ...text, buttons: [...buttons], defaultId: 0, cancelId: buttons.length - 1 }).then(({ response }) => {
    if (response === 0) act();
  });
};

/**
 * Checks the release feed at launch and every few hours. The packaged macOS app and the AppImage download the update
 * and install it when the app quits (Squirrel.Mac requires it signed by the same team). Any other Linux install is
 * the deb (the installer only installs the AppImage), which can't update itself because dpkg needs root: it only
 * checks, and tells the user once per version where to get the new .deb and how to install it. Release builds on
 * macOS and Linux only: dev and test builds have nothing to update to, so they get null and no menu item.
 */
export const updates = (): Updates | null => {
  if (!RELEASE_BUILD || !app.isPackaged || (process.platform !== "darwin" && process.platform !== "linux")) return null;
  const url = feedUrl(app.getVersion(), process.env["FLEETD_BASE_URL"]);
  const deb = process.platform === "linux" && process.env["APPIMAGE"] === undefined;
  let loading: Promise<Check | null> | null = null;

  const load = async (): Promise<Check> => {
    const { AppImageUpdater, DebUpdater, MacUpdater } = await import("electron-updater");
    const options = { provider: "generic" as const, url };
    const updater: MacUpdater | AppImageUpdater | DebUpdater =
      process.platform === "darwin" ? new MacUpdater(options) : deb ? new DebUpdater(options) : new AppImageUpdater(options);
    // The staple-later flow replaces a published zip, so blockmaps aren't published; always download the whole file.
    updater.disableDifferentialDownload = true;
    updater.autoDownload = !deb;
    updater.autoInstallOnAppQuit = !deb;
    const tell = (outcome: UpdateOutcome): void => {
      show(outcome, () => {
        if (outcome.kind === "ready") updater.quitAndInstall();
        if (outcome.kind === "deb") void shell.openExternal(`${url}/${DEB}`);
      });
    };

    let ready: string | null = null;
    // A manual check whose download is still running: its end (ready or failed) gets a dialog too, then settles it.
    let downloadEnded: (() => void) | null = null;
    let toldDeb: string | null = null;
    updater.on("update-downloaded", ({ version }) => {
      ready = version;
      if (downloadEnded === null) return;
      tell({ kind: "ready", version });
      downloadEnded();
      downloadEnded = null;
    });
    updater.on("error", (error) => {
      if (downloadEnded === null) return;
      tell({ kind: "failed", error });
      downloadEnded();
      downloadEnded = null;
    });
    if (deb) {
      updater.on("update-available", ({ version }) => {
        if (toldDeb === version) return;
        toldDeb = version;
        console.info(`update notice: fleetd ${version} is available as ${DEB}`);
        tell({ kind: "deb", version });
      });
    }

    return {
      background: () => {
        updater.checkForUpdates().catch((error: unknown) => {
          console.warn("update check failed:", error instanceof Error ? error.message : error);
        });
      },
      manual: () =>
        new Promise<void>((done) => {
          if (ready !== null) {
            tell({ kind: "ready", version: ready });
            done();
            return;
          }
          // The update-available handler shows a deb notice for a version it hasn't told yet; this answers the rest.
          const toldBefore = toldDeb;
          updater.checkForUpdates().then(
            (result) => {
              const version = result?.updateInfo.version;
              if (result === null || !result.isUpdateAvailable || version === undefined) {
                tell({ kind: "current", version: app.getVersion() });
              } else if (deb) {
                if (toldBefore === version) tell({ kind: "deb", version });
              } else if (ready === null) {
                tell({ kind: "downloading", version });
                downloadEnded = done;
                return;
              } else {
                // The download finished before this check answered (update-downloaded came first): say so now.
                tell({ kind: "ready", version: ready });
              }
              done();
            },
            (error: unknown) => {
              tell({ kind: "failed", error });
              done();
            },
          );
        }),
    };
  };

  let loadError: unknown = null;
  const loaded = (): Promise<Check | null> =>
    (loading ??= load().catch((error: unknown) => {
      // Never an unhandled rejection: the app runs on without updates, and the menu says why.
      loadError = error;
      console.error("couldn't load the updater:", error instanceof Error ? error.message : error);
      return null;
    }));

  let inFlight: Promise<void> | null = null;
  return {
    start: () => {
      void loaded().then((check) => {
        if (check === null) return;
        check.background();
        setInterval(check.background, CHECK_EVERY_MS).unref();
      });
    },
    checkNow: () =>
      (inFlight ??= loaded()
        .then((check) => {
          if (check === null) show({ kind: "failed", error: loadError }, () => undefined);
          else return check.manual();
        })
        .finally(() => {
          inFlight = null;
        })),
  };
};
