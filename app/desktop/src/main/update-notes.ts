// "What's new" for an update: release.json's `changes` (written by .github/release/publish.sh), read from the same
// directory as the update feed. Plain download URLs, so no GitHub API, token or rate limit, as for the feed itself.
import { z } from "zod";
import { notesSince } from "../shared/updates";

const ReleaseJson = z.object({
  changes: z.array(z.object({ version: z.string().max(200), text: z.string().max(500) })).max(200).optional(),
});

/** The notes new to `current` in a release.json body; none when it has no changes (releases before they were kept). */
export const parseNotes = (body: unknown, current: string): string[] => {
  const parsed = ReleaseJson.safeParse(body);
  return parsed.success ? notesSince(parsed.data.changes ?? [], current) : [];
};

/** Never rejects: without notes the update is still offered, just without its list. */
export const fetchNotes = async (feed: string, current: string, fetcher: typeof fetch = fetch): Promise<string[]> => {
  try {
    const response = await fetcher(`${feed}/release.json`, { signal: AbortSignal.timeout(15_000) });
    if (!response.ok) return [];
    return parseNotes(await response.json(), current);
  } catch (error) {
    console.warn("couldn't read the release notes:", error instanceof Error ? error.message : error);
    return [];
  }
};
