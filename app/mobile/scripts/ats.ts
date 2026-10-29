// Whether iOS's App Transport Security lets the app load plain HTTP from a host, by Apple's rules for iOS 17 and later
// (the NSAppTransportSecurity, NSAllowsArbitraryLoads, NSAllowsLocalNetworking and NSExceptionDomains pages):
// - A domain an NSExceptionDomains key names (with its subdomains if NSIncludesSubdomains) gets that entry's
//   NSExceptionAllowsInsecureHTTPLoads, whatever the global keys say. IP addresses never match one here.
// - NSAllowsLocalNetworking allows unqualified names and .local names.
// - NSAllowsArbitraryLoads is ignored when NSAllowsLocalNetworking, NSAllowsArbitraryLoadsForMedia or
//   NSAllowsArbitraryLoadsInWebContent is present at all, which once left every tailnet hub blocked.
// It errs towards blocked where Apple's rules are unclear, as for which IP addresses count as local.
//
// The app's hubs are self-hosted at any address, so it needs arbitrary loads with nothing cancelling them.
// app.config.ts's test checks the resolved config with it, and the iOS builds check the built app's Info.plist:
//
//   node scripts/ats.ts <Info.plist as JSON (plutil -convert json)>
import { readFileSync } from "node:fs";
import { isIP } from "node:net";
import { pathToFileURL } from "node:url";

export type Ats = Readonly<Record<string, unknown>>;

/** Hubs the app must reach over plain HTTP: a tailnet's names and addresses, the local network's, and any other. */
export const HUBS = [
  "100.101.102.103",
  "devbox.tail1234.ts.net",
  "fd7a:115c:a1e0::1",
  "devbox",
  "devbox.local",
  "192.168.1.20",
  "hub.example.com",
  "203.0.113.7",
];

/** The keys whose presence makes iOS ignore NSAllowsArbitraryLoads. */
export const CANCELS_ARBITRARY = ["NSAllowsLocalNetworking", "NSAllowsArbitraryLoadsForMedia", "NSAllowsArbitraryLoadsInWebContent"];

const exception = (domains: Ats, host: string): Ats | undefined => {
  if (isIP(host) !== 0) return undefined;
  for (const [key, value] of Object.entries(domains)) {
    const entry = (value ?? {}) as Ats;
    if (host === key || (entry.NSIncludesSubdomains === true && host.endsWith(`.${key}`))) return entry;
  }
  return undefined;
};

export const allowsHttp = (ats: Ats | undefined, typed: string): boolean => {
  const host = typed.toLowerCase().replace(/^\[(.*)\]$/u, "$1");
  if (ats === undefined) return false;
  const entry = exception((ats.NSExceptionDomains ?? {}) as Ats, host);
  if (entry !== undefined) return entry.NSExceptionAllowsInsecureHTTPLoads === true;
  if (ats.NSAllowsLocalNetworking === true && isIP(host) === 0 && (!host.includes(".") || host.endsWith(".local"))) return true;
  if (CANCELS_ARBITRARY.some((k) => k in ats)) return false;
  return ats.NSAllowsArbitraryLoads === true;
};

/** What's wrong with an Info.plist's ATS settings for the app's hubs, if anything. */
export const problems = (infoPlist: Ats): string[] => {
  const ats = infoPlist.NSAppTransportSecurity as Ats | undefined;
  return [
    ...CANCELS_ARBITRARY.filter((k) => ats !== undefined && k in ats).map((k) => `${k} makes iOS ignore NSAllowsArbitraryLoads`),
    ...HUBS.filter((h) => !allowsHttp(ats, h)).map((h) => `ATS blocks plain HTTP to the hub at ${h}`),
  ];
};

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const path = process.argv[2];
  if (path === undefined) throw new Error("usage: node scripts/ats.ts <Info.plist as JSON>");
  const found = problems(JSON.parse(readFileSync(path, "utf8")) as Ats);
  for (const p of found) console.error(`::error::${p}`);
  if (found.length > 0) process.exit(1);
  console.log(`ATS allows plain HTTP to ${HUBS.join(", ")}`);
}
