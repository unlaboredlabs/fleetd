// Whether iOS's App Transport Security lets the app load plain HTTP from a host, by Apple's rules for iOS 17 and later
// (the NSAppTransportSecurity, NSAllowsArbitraryLoads, NSAllowsLocalNetworking and NSExceptionDomains pages):
// - A host an NSExceptionDomains key names (a domain, with its subdomains if NSIncludesSubdomains; an IP address or
//   CIDR range) gets that entry's NSExceptionAllowsInsecureHTTPLoads, whatever the global keys say.
// - NSAllowsLocalNetworking allows unqualified names, .local names and local IP addresses.
// - NSAllowsArbitraryLoads is ignored when NSAllowsLocalNetworking, NSAllowsArbitraryLoadsForMedia or
//   NSAllowsArbitraryLoadsInWebContent is present at all, which once left every tailnet hub blocked.
// It errs towards blocked: which IP addresses Apple counts as local isn't written down, so only the plainly local ones
// count here.
//
// app.config.ts's test checks the resolved config with it, and the iOS builds check the built app's Info.plist:
//
//   node scripts/ats.ts <Info.plist as JSON (plutil -convert json)>
import { isIP } from "node:net";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

export type Ats = Readonly<Record<string, unknown>>;

/** Hubs the docs say the app reaches over plain HTTP: a tailnet's names and addresses, and the local network's. */
export const HUBS = ["devbox.tail1234.ts.net", "100.101.102.103", "fd7a:115c:a1e0::1", "devbox", "devbox.local", "192.168.1.20"];
/** Hosts that stay HTTPS-only. */
export const OTHERS = ["example.com", "notts.net", "8.8.8.8", "100.128.0.1", "2001:db8::1"];

const IGNORE_ARBITRARY = ["NSAllowsLocalNetworking", "NSAllowsArbitraryLoadsForMedia", "NSAllowsArbitraryLoadsInWebContent"];

/** An IP address as bits, most significant first. */
const bits = (ip: string): string | null => {
  if (isIP(ip) === 4) return ip.split(".").map((p) => Number(p).toString(2).padStart(8, "0")).join("");
  if (isIP(ip) !== 6) return null;
  const [head = "", tail = ""] = ip.split("::");
  const groups = (s: string) => (s === "" ? [] : s.split(":"));
  const h = groups(head);
  const t = groups(tail);
  const all = ip.includes("::") ? [...h, ...Array<string>(8 - h.length - t.length).fill("0"), ...t] : h;
  return all.map((g) => parseInt(g, 16).toString(2).padStart(16, "0")).join("");
};

const inRange = (ip: string, range: string): boolean => {
  const [base = "", len] = range.split("/");
  const a = bits(ip);
  const b = bits(base);
  if (a === null || b === null || a.length !== b.length) return false;
  const n = len === undefined ? a.length : Number(len);
  return a.slice(0, n) === b.slice(0, n);
};

const LOCAL_IPS = ["10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16", "169.254.0.0/16", "127.0.0.0/8", "::1/128", "fe80::/10"];

const isLocal = (host: string): boolean =>
  isIP(host) === 0 ? !host.includes(".") || host.endsWith(".local") : LOCAL_IPS.some((r) => inRange(host, r));

const exception = (domains: Ats, host: string): Ats | undefined => {
  for (const [key, value] of Object.entries(domains)) {
    const entry = (value ?? {}) as Ats;
    if (isIP(host) !== 0 ? inRange(host, key) : host === key || (entry.NSIncludesSubdomains === true && host.endsWith(`.${key}`))) return entry;
  }
  return undefined;
};

export const allowsHttp = (ats: Ats | undefined, typed: string): boolean => {
  const host = typed.toLowerCase().replace(/^\[(.*)\]$/u, "$1");
  if (ats === undefined) return false;
  const entry = exception((ats.NSExceptionDomains ?? {}) as Ats, host);
  if (entry !== undefined) return entry.NSExceptionAllowsInsecureHTTPLoads === true;
  if (ats.NSAllowsLocalNetworking === true && isLocal(host)) return true;
  if (IGNORE_ARBITRARY.some((k) => k in ats)) return false;
  return ats.NSAllowsArbitraryLoads === true;
};

/** What's wrong with an Info.plist's ATS settings for the app's hubs, if anything. */
export const problems = (infoPlist: Ats): string[] => {
  const ats = infoPlist.NSAppTransportSecurity as Ats | undefined;
  return [
    ...HUBS.filter((h) => !allowsHttp(ats, h)).map((h) => `ATS blocks plain HTTP to the hub at ${h}`),
    ...OTHERS.filter((h) => allowsHttp(ats, h)).map((h) => `ATS allows plain HTTP to ${h}, which isn't a tailnet or local hub`),
  ];
};

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const path = process.argv[2];
  if (path === undefined) throw new Error("usage: node scripts/ats.ts <Info.plist as JSON>");
  const found = problems(JSON.parse(readFileSync(path, "utf8")) as Ats);
  for (const p of found) console.error(`::error::${p}`);
  if (found.length > 0) process.exit(1);
  console.log(`ATS allows plain HTTP to ${HUBS.join(", ")} and to no other host checked`);
}
