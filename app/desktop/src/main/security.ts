import { pathToFileURL } from "node:url";
import { app, protocol, session, shell, type WebContents } from "electron";
import { APP_INDEX, APP_ORIGIN, APP_SCHEME, assetPath, originOf } from "./origin";

/** The dev server while developing an unpackaged build; never in a packaged app. */
const devUrl = (): string | null => {
  const dev = process.env["ELECTRON_RENDERER_URL"];
  return dev !== undefined && !app.isPackaged ? dev : null;
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
 * new windows and no navigation away from the app. https links open in the user's browser. Run before app ready.
 */
export const harden = (): void => {
  protocol.registerSchemesAsPrivileged([{ scheme: APP_SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true } }]);
  app.enableSandbox();
  app.on("web-contents-created", (_event, contents: WebContents) => {
    contents.setWindowOpenHandler(({ url }) => {
      if (url.startsWith("https://")) void shell.openExternal(url);
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

/** Run once the app is ready (sessions exist then). `rendererDir` holds the built index.html. */
export const lockSession = (rendererDir: string): void => {
  // Main reads the built files through a session of its own, so the page session can refuse file:// outright.
  const files = session.fromPartition("fleetd-main-files");
  protocol.handle(APP_SCHEME, (request) => {
    const file = assetPath(request.url, rendererDir);
    return file === null ? new Response("Not found", { status: 404 }) : files.fetch(pathToFileURL(file).href);
  });
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
