// The channel's release files beside the update feed (.github/release/publish.sh): changes.json for "what's new",
// and release.json for the newest CLI, which the hub runs. Plain download URLs, so no GitHub API, token or rate
// limit, as for the feed itself.
import { z } from "zod";
import { MAX_CHANGES, type Release } from "../shared/updates";

const ChangesJson = z.object({
  changes: z
    .array(
      z.object({
        commit: z.string().max(64),
        date: z.string().max(64),
        subject: z.string().max(2000),
        areas: z.array(z.string().max(32)).max(8),
      }),
    )
    .max(1000),
});
const ReleaseJson = z.object({ cliVersion: z.string().max(200).optional() });

/** changes.json's entries main keeps; none for a missing or broken file. */
export const parseChanges = (body: unknown): Release["changes"] => {
  const parsed = ChangesJson.safeParse(body);
  return parsed.success ? parsed.data.changes.slice(0, MAX_CHANGES) : [];
};

export const parseCli = (body: unknown): string | null => {
  const parsed = ReleaseJson.safeParse(body);
  return parsed.success ? (parsed.data.cliVersion ?? null) : null;
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

/** Never rejects: without them an update is still offered, just without its list or the hub's newest. */
export const fetchRelease = async (feed: string, fetcher: typeof fetch = fetch): Promise<Release> => {
  const [changes, release] = await Promise.all([read(`${feed}/changes.json`, fetcher), read(`${feed}/release.json`, fetcher)]);
  return { changes: parseChanges(changes), cli: parseCli(release) };
};
