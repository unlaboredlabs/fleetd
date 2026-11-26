// Live screens' small pictures and latest steps, for whatever shows them: the Screens page, a screen's card in the chat
// and its row in the panel. While any of them shows in a visible window, the hub sends each live screen's picture a few
// times a minute (`screen_thumbs`, kept in the store's screenThumbs) and the screen lists are read again as often, for
// each agent's latest step (its now-line). One feed for them all: each holds it while it shows, and it stops with the
// last one, or while the window is hidden.
import { useEffect, useSyncExternalStore } from "react";
import { useData, useDataLayer } from "../../src/data/react";
import type { DataLayer } from "../../src/data/queries";

/** The hub feature that says it sends the pictures, and names each screen's machine and latest step. */
export const THUMBS = "screen_thumbs";
/** How often the hub takes a picture of each live screen while one shows (contracts THUMB_EVERY_SECS). */
export const THUMB_EVERY_MS = 20_000;

interface Feed {
  holders: number;
  steps: ReturnType<typeof setInterval>;
}

/** The running feed of each hub's data layer. */
const feeds = new Map<DataLayer, Feed>();

/** Holds the feed for `layer` until the returned release; the first holder starts it, the last one's release stops it. */
export const holdFeed = (layer: DataLayer): (() => void) => {
  let feed = feeds.get(layer);
  if (feed === undefined) {
    void window.fleetd.hub.thumbs(layer.hub, true);
    const steps = setInterval(() => void layer.queryClient.invalidateQueries({ queryKey: ["call", "browser_sessions"] }), THUMB_EVERY_MS);
    feed = { holders: 0, steps };
    feeds.set(layer, feed);
  }
  feed.holders += 1;
  let held = true;
  return () => {
    if (!held) return;
    held = false;
    const f = feeds.get(layer);
    if (f === undefined) return;
    f.holders -= 1;
    if (f.holders > 0) return;
    clearInterval(f.steps);
    feeds.delete(layer);
    void window.fleetd.hub.thumbs(layer.hub, false);
  };
};

const onVisibility = (change: () => void) => {
  document.addEventListener("visibilitychange", change);
  return () => document.removeEventListener("visibilitychange", change);
};
const isVisible = () => document.visibilityState === "visible";

/** Holds the feed while `on`, the window shows and the hub serves it. */
export function useScreenFeed(on: boolean): void {
  const layer = useDataLayer();
  const served = useData((st) => st.features.includes(THUMBS));
  const visible = useSyncExternalStore(onVisibility, isVisible);
  const feeding = on && served && visible;
  useEffect(() => (feeding ? holdFeed(layer) : undefined), [layer, feeding]);
}

/** A live screen's newest picture as a data URL, once the hub has sent one; the last one kept after it ends. */
export const useThumb = (sessionId: string): string | undefined => {
  const thumb = useData((st) => st.screenThumbs?.[sessionId]?.jpegB64);
  return thumb === undefined ? undefined : `data:image/jpeg;base64,${thumb}`;
};
