// Which links leave the app for the user's browser: GitHub (PRs, commits, repos) and fleetd.sh (docs), over https,
// nothing else. Opening an arbitrary URL from a page that renders hub content (agent messages, markdown) would let
// that content launch any handler the OS knows.

export const MAX_EXTERNAL_URL_LENGTH = 2048;

const allowedHost = (host: string): boolean => host === "github.com" || host.endsWith(".github.com") || host === "fleetd.sh";

export type ExternalUrl = { readonly ok: true; readonly url: string } | { readonly ok: false; readonly message: string };

export const externalUrl = (input: string): ExternalUrl => {
  if (input.length > MAX_EXTERNAL_URL_LENGTH) return { ok: false, message: `The link is over ${MAX_EXTERNAL_URL_LENGTH} characters.` };
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    return { ok: false, message: "That isn't a link." };
  }
  if (url.protocol !== "https:") return { ok: false, message: "Only https links open in the browser." };
  if (url.username !== "" || url.password !== "") return { ok: false, message: "Links carrying a user name or password don't open." };
  // A non-default port isn't GitHub or fleetd.sh as anyone links to them.
  if (url.port !== "" || !allowedHost(url.hostname)) {
    return { ok: false, message: `Only github.com and fleetd.sh links open from the app, not ${url.host}.` };
  }
  return { ok: true, url: url.href };
};
