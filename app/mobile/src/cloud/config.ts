// The two public values that turn fleetd cloud's Sign In on, fixed when the bundle is built: the accounts service's
// origin and the WorkOS client id the sign-in page is opened with, as the desktop's MAIN_VITE_FLEETD_ACCOUNTS_URL and
// MAIN_VITE_FLEETD_WORKOS_CLIENT_ID (app/desktop/src/main/cloud/config.ts). A build sets them as
//   EXPO_PUBLIC_FLEETD_ACCOUNTS_URL=https://accounts.fleetd.dev EXPO_PUBLIC_FLEETD_WORKOS_CLIENT_ID=client_…
// and Metro inlines them (Expo's public env). Releases set neither, so a released app offers only its own hub's
// pairing and depends on nothing fleetd runs. Parsed by hand: React Native's URL has no searchParams.

/** WorkOS's own sign-in page (AuthKit, PKCE): its address is WorkOS's, not fleetd's. */
export const WORKOS_AUTHORIZE_URL = "https://api.workos.com/user_management/authorize";

export interface CloudConfig {
  /** The accounts service's origin: https, no path. */
  readonly accountsUrl: string;
  readonly clientId: string;
  /** WorkOS's authorize page; a stand-in's in tests. */
  readonly authorizeUrl: string;
}

/**
 * An origin and nothing else (no user, path, query or fragment), https, or with `local` http on 127.0.0.1 for a
 * development build pointed at a stand-in; null otherwise.
 */
const origin = (raw: string, local: boolean): string | null => {
  const m = /^(https?):\/\/([^/?#@\s]+?)\/?$/iu.exec(raw.trim());
  if (m === null) return null;
  const scheme = m[1]?.toLowerCase();
  const host = m[2] ?? "";
  if (!/^[A-Za-z0-9.-]+(?::\d{1,5})?$/u.test(host)) return null;
  const hostname = host.replace(/:\d+$/u, "").toLowerCase();
  if (scheme !== "https" && !(local && hostname === "127.0.0.1")) return null;
  return `${scheme ?? "https"}://${host.toLowerCase()}`;
};

/** The values as built, checked: null (no Sign In) unless both are set and the address is an https origin. */
export const cloudConfig = (accounts: string | undefined, clientId: string | undefined, local: boolean, authorizeUrl: string = WORKOS_AUTHORIZE_URL): CloudConfig | null => {
  if (accounts === undefined || accounts === "" || clientId === undefined || !/^[A-Za-z0-9_-]{1,100}$/u.test(clientId)) return null;
  const accountsUrl = origin(accounts, local);
  return accountsUrl === null ? null : { accountsUrl, clientId, authorizeUrl };
};

/** This bundle's values. Each is read whole by name, the only way Metro inlines it; a development build may point at a stand-in. */
export const builtCloudConfig = (): CloudConfig | null => cloudConfig(process.env.EXPO_PUBLIC_FLEETD_ACCOUNTS_URL, process.env.EXPO_PUBLIC_FLEETD_WORKOS_CLIENT_ID, typeof __DEV__ !== "undefined" && __DEV__);

/**
 * What the first screen offers: both ways in, a line each (decision hosted.first-screen), on a build with the cloud's
 * values; else, and on Use Your Own Hub, the pairing's Scan QR Code and Enter Code Manually as they always were.
 */
export const firstScreen = (config: CloudConfig | null, own: boolean): "ways" | "pair" => (config !== null && !own ? "ways" : "pair");
