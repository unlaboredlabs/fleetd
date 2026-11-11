// The two public values that turn fleetd cloud's Sign in on, fixed when the bundle is built and never read at run
// time: the accounts service's origin and the WorkOS client id the sign-in page is opened with. A build sets them as
//   MAIN_VITE_FLEETD_ACCOUNTS_URL=https://accounts.fleetd.dev MAIN_VITE_FLEETD_WORKOS_CLIENT_ID=client_… pnpm build
// and electron-vite inlines them. Releases set neither, so a released app offers only Use your own hub and depends on
// nothing fleetd runs.
import { RELEASE_BUILD } from "../build";

/** WorkOS's own sign-in page (AuthKit, PKCE): its address is WorkOS's, not fleetd's. */
export const WORKOS_AUTHORIZE_URL = "https://api.workos.com/user_management/authorize";

export interface CloudConfig {
  /** The accounts service's origin: https, no path. */
  readonly accountsUrl: string;
  readonly clientId: string;
  /** WorkOS's authorize page; a stand-in's in tests. */
  readonly authorizeUrl: string;
}

/** The values this bundle was built with; a development or test build may point at a stand-in on 127.0.0.1. */
export const builtCloudConfig = (): CloudConfig | null =>
  cloudConfig(import.meta.env.MAIN_VITE_FLEETD_ACCOUNTS_URL, import.meta.env.MAIN_VITE_FLEETD_WORKOS_CLIENT_ID, !RELEASE_BUILD);

const loopback = (url: URL): boolean => url.protocol === "http:" && url.hostname === "127.0.0.1";

/**
 * The values as built, checked: null (no Sign in) unless both are set and the address is an https origin. `local`
 * also takes http on 127.0.0.1, for a development or test build pointed at a stand-in.
 */
export const cloudConfig = (
  accounts: string | undefined,
  clientId: string | undefined,
  local: boolean,
  authorizeUrl: string = WORKOS_AUTHORIZE_URL,
): CloudConfig | null => {
  if (accounts === undefined || accounts === "" || clientId === undefined || !/^[A-Za-z0-9_-]{1,100}$/u.test(clientId)) return null;
  let url: URL;
  try {
    url = new URL(accounts);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" && !(local && loopback(url))) return null;
  if (url.username !== "" || url.password !== "" || url.search !== "" || url.hash !== "" || url.pathname !== "/") return null;
  return { accountsUrl: url.origin, clientId, authorizeUrl };
};

/** A team's hub address from the accounts service: an https origin, or (in a local build) http on 127.0.0.1. */
export const teamOrigin = (raw: string, local: boolean): string | null => {
  try {
    const url = new URL(raw);
    if (url.protocol !== "https:" && !(local && loopback(url))) return null;
    if (url.username !== "" || url.password !== "" || url.search !== "" || url.hash !== "" || url.pathname !== "/") return null;
    return url.origin;
  } catch {
    return null;
  }
};
