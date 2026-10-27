import { isEdge } from "../shared/pairing";

const REPO = "unlaboredlabs/fleetd";
const LOOPBACK = new Set(["127.0.0.1", "localhost", "[::1]"]);

/**
 * Where the updater reads latest-*.yml. Edge builds (and nightly ones, Edge's name until D203) follow the rolling edge
 * release and tagged builds the latest one, like `fleetd update`: plain download URLs, so no GitHub API, token or rate
 * limit. `override` (FLEETD_BASE_URL) points at another directory of release assets, but only over https or on this
 * machine: the feed's sha512 is all that vouches for an AppImage download, so a plain-http feed from elsewhere could
 * hand the app any file.
 */
export const feedUrl = (version: string, override: string | undefined): string => {
  if (override !== undefined && isTrustedOverride(override)) return override;
  return isEdge(version)
    ? `https://github.com/${REPO}/releases/download/edge`
    : `https://github.com/${REPO}/releases/latest/download`;
};

const isTrustedOverride = (raw: string): boolean => {
  if (!URL.canParse(raw)) return false;
  const url = new URL(raw);
  return url.protocol === "https:" || (url.protocol === "http:" && LOOPBACK.has(url.hostname));
};
