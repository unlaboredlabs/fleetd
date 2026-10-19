import { app, session, shell, type WebContents } from "electron";

/** What the renderer may load: the built index.html, or the dev server while developing. */
export const rendererOrigin = (): string => {
  const dev = process.env["ELECTRON_RENDERER_URL"];
  return dev !== undefined && !app.isPackaged ? new URL(dev).origin : "file://";
};

const isOwnUrl = (url: string): boolean => {
  const origin = rendererOrigin();
  return origin === "file://" ? url.startsWith("file://") : url.startsWith(`${origin}/`) || url === origin;
};

/**
 * Defence in depth around the CSP: the renderer gets no network (hub traffic goes through main), no permissions, no
 * new windows and no navigation away from the app. https links open in the user's browser.
 */
export const harden = (): void => {
  app.enableSandbox();
  app.on("web-contents-created", (_event, contents: WebContents) => {
    contents.setWindowOpenHandler(({ url }) => {
      if (url.startsWith("https://")) void shell.openExternal(url);
      return { action: "deny" };
    });
    contents.on("will-navigate", (event, url) => {
      if (!isOwnUrl(url)) event.preventDefault();
    });
    contents.on("will-attach-webview", (event) => event.preventDefault());
  });
};

/** Run once the app is ready (sessions exist then). */
export const lockSession = (): void => {
  const ses = session.defaultSession;
  // No permission at all, the clipboard included: Electron asks for "clipboard-read" on writeText too, so writes go
  // through window.fleetd.copy instead.
  ses.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  ses.setPermissionCheckHandler(() => false);
  // Pages get their own files and nothing else. Main's own requests (electron `net`, e.g. the updater) carry no
  // webContents and pass.
  ses.webRequest.onBeforeRequest((details, callback) => {
    const fromPage = details.webContentsId !== undefined;
    const allowed = !fromPage || isOwnUrl(details.url) || details.url.startsWith("devtools://") || details.url.startsWith("data:");
    callback({ cancel: !allowed });
  });
};
