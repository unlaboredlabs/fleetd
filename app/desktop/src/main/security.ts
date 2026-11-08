import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { app, protocol, session, shell, type WebContents } from "electron";
import { DEV_BUILD } from "./build";
import { externalUrl } from "./external";
import { ARTIFACT_SCHEME, artifactFrames } from "./artifactFrames";
import { APP_INDEX, APP_ORIGIN, APP_SCHEME, assetPath, assetType, originOf } from "./origin";

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
 * new windows and no navigation away from the app. http and https links open in the user's browser. Run before
 * app ready.
 */
export const harden = (): void => {
  protocol.registerSchemesAsPrivileged([
    // codeCache: V8 keeps the compiled scripts in the profile, so a launch after the first two compiles none of the page.
    { scheme: APP_SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true, codeCache: true } },
    // An HTML artifact's frame (artifactFrames.ts): its own origin, with no fetch or CORS.
    { scheme: ARTIFACT_SCHEME, privileges: { standard: true, secure: true } },
  ]);
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
    // An artifact's frame stays on its page: a link or a script sends it nowhere (a link's click goes to the app's
    // page instead, artifactFrames.ts), so the report stays on screen.
    contents.on("will-frame-navigate", (event) => {
      if (!event.isMainFrame && !event.url.startsWith(`${ARTIFACT_SCHEME}://`)) event.preventDefault();
    });
    // WebRTC traffic leaves only through the page session's proxy, which goes nowhere (lockSession): an artifact's STUN
    // or TURN, which no CSP or request filter sees, reaches nothing. The app's own page makes none.
    contents.setWebRTCIPHandlingPolicy("disable_non_proxied_udp");
  });
};

const notFound = () => new Response("Not found", { status: 404 });

/**
 * The built file under `rendererDir` that an app://fleetd/ request names, read by main itself, so the page sessions
 * can refuse file:// outright. The kinds the build makes are read straight from disk: through a session's fetch, each
 * of the ~40 files the window loads at launch cost main a network-service round trip. Any other kind still goes
 * through a session of main's own, for its type. Run once the app is ready (sessions exist then).
 */
export const appFile = async (url: string, rendererDir: string): Promise<Response> => {
  const file = assetPath(url, rendererDir);
  if (file === null) return notFound();
  const type = assetType(file);
  if (type === undefined) return session.fromPartition("fleetd-main-files").fetch(pathToFileURL(file).href);
  try {
    return new Response(await readFile(file), { headers: { "content-type": type } });
  } catch {
    return notFound();
  }
};

/** Run once the app is ready (sessions exist then). `rendererDir` holds the built index.html. */
export const lockSession = (rendererDir: string): void => {
  protocol.handle(APP_SCHEME, (request) => appFile(request.url, rendererDir));
  protocol.handle(ARTIFACT_SCHEME, (request) => artifactFrames.response(request.url));
  const ses = session.defaultSession;
  // No permission at all, the clipboard included: Electron asks for "clipboard-read" on writeText too, so writes go
  // through window.fleetd.copy instead.
  ses.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  ses.setPermissionCheckHandler(() => false);
  // The page session reaches its own origin and nothing else: no local files, no network. This holds for every request
  // in it, whether or not it names a webContents (workers and keepalive requests may not); main's own requests use
  // other sessions (the file reads above, electron-updater's partition). An artifact's frame loads from main too.
  ses.webRequest.onBeforeRequest((details, callback) => {
    const { url } = details;
    const allowed = isOwnPage(url) || isDevSocket(url) || url.startsWith("devtools://") || url.startsWith("data:") || url.startsWith(`${ARTIFACT_SCHEME}://`);
    callback({ cancel: !allowed });
  });
  // WebRTC's own sockets never pass that filter. With the IP policy set on every page (harden), WebRTC sends UDP only
  // through a proxy and TCP (TURN) only through the session's: this one goes nowhere, loopback included, so an
  // artifact's STUN or TURN reaches nothing. The dev server's socket, on loopback, still connects in a dev build.
  void ses.setProxy({ proxyRules: "socks5://0.0.0.0:9", proxyBypassRules: devUrl() === null ? "<-loopback>" : "" });
};
