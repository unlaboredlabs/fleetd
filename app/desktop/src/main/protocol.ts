import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { app } from "electron";

/**
 * Makes this app the fleetd:// handler once, on its first packaged run, so `fleetd pair` links open it. Only once:
 * if the user later picks another handler, a relaunch must not take it back. The packaging declares the scheme too
 * (CFBundleURLTypes on macOS; the .desktop file's MimeType, which the deb's postinst and the installer register), so
 * this mostly matters where another fleetd app was the default, and for the AppImage. On Linux Electron runs
 * `xdg-mime default` with the desktopName from package.json.
 */
export const claimProtocolOnce = (): void => {
  if (!app.isPackaged) return;
  const marker = join(app.getPath("userData"), "fleetd-protocol-claimed");
  if (existsSync(marker)) return;
  if (app.setAsDefaultProtocolClient("fleetd")) writeFileSync(marker, "");
};
