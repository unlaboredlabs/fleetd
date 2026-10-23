import { pathToFileURL } from "node:url";
import { app, protocol, session, shell, type WebContents } from "electron";
import { DEV_BUILD } from "./build";
import { externalUrl } from "./external";
import { APP_INDEX, APP_ORIGIN, APP_SCHEME, assetPath, originOf } from "./origin";

/** The dev server under `electron-vite dev`; a built app never loads one, however it's launched. */
const devUrl = (): string | null => {
  const dev = process.env["ELECTRON_RENDERER_URL"];
  return dev !== undefined && DEV_BUILD ? dev : null;
};

/** The one origin whose top frame gets the bridge and may navigate. */
export const pageOrigin = (): string => {
  const dev = devUrl();
  return dev === null ? APP_ORIGIN : (originOf(dev) ?? APP_ORIGIN);
};

export const pageUrl = (): string => devUrl() ?? APP_INDEX;

export const isOwnPage = (url: string): boolean => originOf(url) === pageOrigin();

/** While developing, Vite's HMR socket on the dev server's host. */
const isDevSocket = (url: string): boolean => {
  const dev = devUrl();
  if (dev === null) return false;
  return originOf(url) === `ws://${new URL(dev).host}`;
};

/**
 * Defence in depth around the CSP: the renderer gets no network (hub traffic goes through main), no permissions, no
 * new windows and no navigation away from the app. GitHub and fleetd.sh links open in the user's browser. Run before
 * app ready.
 */
export const harden = (): void => {
  protocol.registerSchemesAsPrivileged([{ scheme: APP_SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true } }]);
  app.enableSandbox();
  app.on("web-contents-created", (_event, contents: WebContents) => {
    // A plain <a target=_blank> follows the same rule as window.fleetd.openExternal.
    contents.setWindowOpenHandler(({ url }) => {
      const checked = externalUrl(url);
      if (checked.ok) void shell.openExternal(checked.url);
      return { action: "deny" };
    });
    // Covers links, location changes and files dropped on the window.
    contents.on("will-navigate", (event, url) => {
      if (!isOwnPage(url)) event.preventDefault();
    });
    contents.on("will-redirect", (event, url) => {
      if (!isOwnPage(url)) event.preventDefault();
    });
    contents.on("will-attach-webview", (event) => event.preventDefault());
  });
};

/**
 * The built file under `rendererDir` that an app://fleetd/ request names. Main reads it through a session of its own,
 * so the page sessions can refuse file:// outright. Run once the app is ready (sessions exist then).
 */
export const appFile = (url: string, rendererDir: string): Promise<Response> | Response => {
  const file = assetPath(url, rendererDir);
  return file === null ? new Response("Not found", { status: 404 }) : session.fromPartition("fleetd-main-files").fetch(pathToFileURL(file).href);
};

/** Run once the app is ready (sessions exist then). `rendererDir` holds the built index.html. */
export const lockSession = (rendererDir: string): void => {
  protocol.handle(APP_SCHEME, (request) => appFile(request.url, rendererDir));
  const ses = session.defaultSession;
  // No permission at all, the clipboard included: Electron asks for "clipboard-read" on writeText too, so writes go
  // through window.fleetd.copy instead.
  ses.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  ses.setPermissionCheckHandler(() => false);
  // The page session reaches its own origin and nothing else: no local files, no network. This holds for every request
  // in it, whether or not it names a webContents (workers and keepalive requests may not); main's own requests use
  // other sessions (the file reads above, electron-updater's partition).
  ses.webRequest.onBeforeRequest((details, callback) => {
    const { url } = details;
    const allowed = isOwnPage(url) || isDevSocket(url) || url.startsWith("devtools://") || url.startsWith("data:");
    callback({ cancel: !allowed });
  });
};
