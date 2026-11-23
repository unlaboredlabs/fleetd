const REPO = "unlaboredlabs/fleetd";
const LOOPBACK = new Set(["127.0.0.1", "localhost", "[::1]"]);

/**
 * Where the updater reads its feed: the rolling edge release, where every build is published (D701), its stage feeds
 * and latest-*.yml among them, as `fleetd update` reads it: plain download URLs, so no GitHub API, token or rate limit.
 * Builds numbered 0.MINOR.PATCH (release.version-scheme) read there too, though they aren't edge-named. `override`
 * (FLEETD_BASE_URL) points at another directory of release assets, but only over https or on this machine: the feed's
 * sha512 is all that vouches for an AppImage download, so a plain-http feed from elsewhere could hand the app any file.
 */
export const feedUrl = (override: string | undefined): string => {
  if (override !== undefined && isTrustedOverride(override)) return override;
  return `https://github.com/${REPO}/releases/download/edge`;
};

const isTrustedOverride = (raw: string): boolean => {
  if (!URL.canParse(raw)) return false;
  const url = new URL(raw);
  return url.protocol === "https:" || (url.protocol === "http:" && LOOPBACK.has(url.hostname));
};
