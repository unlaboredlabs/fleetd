// A Navi's site gate (crates/fleetd/src/hub/navi/sites.rs): the site a URL is on, and the sites a person's own message
// links to. The relay's prompt parsing comes with the approvals hooks.

/** The characters a URL the gate reads may hold: a URL's own (RFC 3986). */
const plain = (url: string) => url !== "" && [...url].every((c) => /[\p{L}\p{N}]/u.test(c) || "-._~:/?#[]@!$&'()*+,;=%".includes(c));

/** Whether `url` names a scheme of its own: text before a `:` that isn't a host's port. */
function hasScheme(url: string): boolean {
  const at = url.indexOf(":");
  if (at < 0) return false;
  const scheme = url.slice(0, at);
  const rest = url.slice(at + 1);
  const port = rest.split(/[/?#]/)[0] ?? "";
  return !/[/.]/.test(scheme) && (rest.startsWith("//") || port === "" || !/^\d+$/.test(port));
}

const isLoopbackIp = (host: string) => /^127\.\d+\.\d+\.\d+$/.test(host) || host === "[::1]";

/**
 * The site `url` is on: its host as the URL parser reads it (lower case, IDN as punycode), without a leading `www.`;
 * a loopback host with its port. Undefined for anything but a plain http or https URL with no user in it.
 */
export function siteOf(url: string): string | undefined {
  if (!plain(url)) return undefined;
  let parsed: URL;
  try {
    parsed = new URL(hasScheme(url) ? url : `https://${url}`);
  } catch {
    return undefined;
  }
  if ((parsed.protocol !== "http:" && parsed.protocol !== "https:") || parsed.username !== "" || parsed.password !== "") return undefined;
  let host = parsed.hostname.replace(/\.+$/, "").toLowerCase();
  if (host.startsWith("www.")) host = host.slice(4);
  const loopback = host === "localhost" || host.endsWith(".localhost") || isLoopbackIp(host);
  if (loopback) host = `${host}:${parsed.port || (parsed.protocol === "https:" ? "443" : "80")}`;
  return host === "" ? undefined : host;
}

/** The sites of the http and https links in a person's own chat message, each once. */
export function pasted(text: string): string[] {
  const out: string[] = [];
  const lower = text.toLowerCase();
  for (let at = lower.indexOf("http"); at >= 0; at = lower.indexOf("http", at + 1)) {
    const rest = text.slice(at);
    const scheme = ["https://", "http://"].find((s) => rest.slice(0, s.length).toLowerCase() === s);
    if (!scheme) continue;
    let host = "";
    for (const c of rest.slice(scheme.length)) {
      if (!(/[\p{L}\p{N}]/u.test(c) || "-._~:[]@%".includes(c))) break;
      host += c;
    }
    host = host.replace(/[.:]+$/, "");
    const site = siteOf(`${scheme}${host}`);
    if (site !== undefined && !out.includes(site)) out.push(site);
  }
  return out;
}
