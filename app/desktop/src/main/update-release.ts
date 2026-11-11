// The channel's release file beside the update feed (.github/release/publish.sh): release.json for the newest CLI,
// which the hub runs, and the newest app. A plain download URL, so no GitHub API, token or rate limit, as for the feed
// itself.
import { z } from "zod";
import type { Release } from "../shared/updates";

const ReleaseJson = z.object({ cliVersion: z.string().max(200).optional(), appVersion: z.string().max(200).optional() });

export const parseCli = (body: unknown): string | null => {
  const parsed = ReleaseJson.safeParse(body);
  return parsed.success ? (parsed.data.cliVersion ?? null) : null;
};

const Pins = z.object({ sha256: z.record(z.string().max(200), z.string().regex(/^[0-9a-f]{64}$/u)) });

/** The SHA-256 release.json pins `asset`'s build to (its sha256 map, publish.sh), or null for a release without one. */
export const parsePin = (body: unknown, asset: string): string | null => {
  const parsed = Pins.safeParse(body);
  return parsed.success ? (parsed.data.sha256[asset] ?? null) : null;
};

/** The name a release keeps `asset`'s build under for good (.github/release/pinned.sh): its SHA-256's first 16 hex
 * digits at the end, as the CLI builds have no extension. */
export const pinnedName = (asset: string, sha256: string): string => `${asset}-${sha256.slice(0, 16)}`;

export const parseApp = (body: unknown): string | null => {
  const parsed = ReleaseJson.safeParse(body);
  return parsed.success ? (parsed.data.appVersion ?? null) : null;
};

const read = async (url: string, fetcher: typeof fetch): Promise<unknown> => {
  try {
    const response = await fetcher(url, { signal: AbortSignal.timeout(15_000) });
    return response.ok ? await response.json() : null;
  } catch (error) {
    console.warn(`couldn't read ${url}:`, error instanceof Error ? error.message : error);
    return null;
  }
};

/** Never rejects: without it this app's update is still offered, just without the hub's newest. */
export const fetchRelease = async (feed: string, fetcher: typeof fetch = fetch): Promise<Release> => {
  const release = await read(`${feed}/release.json`, fetcher);
  return { cli: parseCli(release), app: parseApp(release) };
};
