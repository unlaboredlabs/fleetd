// fleetd.sh/download/mac (vercel.json's rewrite here): the Mac app's disk image on the edge release once a build has
// made one, else that release's page (the app's .zip is there), so the link never ends on a 404 (before the first image, or a build whose
// image wasn't notarized in time). The answer is cached for five minutes at Vercel's edge.
export const DMG = "https://github.com/unlaboredlabs/fleetd/releases/download/edge/fleetd-desktop-macos-universal.dmg";
export const RELEASES = "https://github.com/unlaboredlabs/fleetd/releases/tag/edge";

/** Whether the image is there: GitHub answers a release asset with a redirect to its storage, a missing one with 404. */
export const dmgThere = async (fetcher = fetch) => {
  try {
    const r = await fetcher(DMG, { method: "HEAD", redirect: "manual", signal: AbortSignal.timeout(5_000) });
    return r.status === 200 || (r.status >= 300 && r.status < 400);
  } catch {
    return false;
  }
};

export async function GET() {
  const to = (await dmgThere()) ? DMG : RELEASES;
  return new Response(null, { status: 302, headers: { location: to, "cache-control": "public, max-age=0, s-maxage=300" } });
}

// The same redirect for HEAD, which link checkers and download managers try first (it answered 405).
export const HEAD = GET;
