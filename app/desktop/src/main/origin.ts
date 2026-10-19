// The renderer is served from app://fleetd/, a scheme only main answers, so "the app's own page" is one exact origin.
// file:// would make any local HTML file (a download dropped on the window, say) a trusted page.
import { resolve, sep } from "node:path";

export const APP_SCHEME = "app";
export const APP_ORIGIN = `${APP_SCHEME}://fleetd`;
export const APP_INDEX = `${APP_ORIGIN}/index.html`;

/** scheme://host of a URL, or null. Node's URL#origin is "null" for non-web schemes such as app:, so build it. */
export const originOf = (url: string): string | null => {
  try {
    const parsed = new URL(url);
    return parsed.host === "" ? null : `${parsed.protocol}//${parsed.host}`;
  } catch {
    return null;
  }
};

/** The file under `root` that app://fleetd/<path> serves, or null for another origin or a path escaping `root`. */
export const assetPath = (url: string, root: string): string | null => {
  if (originOf(url) !== APP_ORIGIN) return null;
  let pathname: string;
  try {
    pathname = decodeURIComponent(new URL(url).pathname);
  } catch {
    return null;
  }
  const base = resolve(root);
  const file = resolve(base, `.${pathname === "/" ? "/index.html" : pathname}`);
  return file.startsWith(`${base}${sep}`) ? file : null;
};
