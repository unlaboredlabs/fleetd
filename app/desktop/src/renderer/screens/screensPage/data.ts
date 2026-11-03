// The Screens page's data: every screen the hub serves, of every project and Navi you can see, each with its project,
// the machine it runs on and its agent's latest step (browser_sessions), and a live one's newest picture (the hub's
// screen_thumb feed, which runs only while the page shows: useThumbFeed), sorted as the page shows them.
import { useEffect, useMemo, useSyncExternalStore } from "react";
import type { ProjectRef } from "../../../shared/contracts";
import { useData, useDataLayer, useToolQueries, useToolQuery } from "../../src/data/react";
import { selectLiveAgents, selectProjects } from "../../src/data/selectors";
import { isNavi } from "../navi/model";
import { FEATURE, fromHub, ownerOf } from "../sessions/hub";
import { isLive, type BrowserSession } from "../sessions/model";
import { parseMs } from "../live/format";

/** The hub feature that says it sends the page's pictures, and names each screen's machine and latest step. */
export const THUMBS = "screen_thumbs";
/** How often the hub takes a picture of each live screen while the page shows (contracts THUMB_EVERY_SECS). */
export const THUMB_EVERY_MS = 20_000;

export type Kind = NonNullable<BrowserSession["kind"]> | "browser";

export interface PageScreen {
  readonly x: BrowserSession;
  readonly kind: Kind;
  readonly project: { readonly title: string; readonly navi: boolean };
  /** The machine it runs on; its project's from a hub too old to say. */
  readonly machine: string;
  /** Its newest picture, as a data URL, while it is live and the hub has taken one. */
  readonly thumb?: string;
  /** Its agent's latest step, in words, while it is live. */
  readonly doing?: string;
}

export const KIND_WORD: Readonly<Record<Kind, string>> = {
  browser: "Browser",
  android: "Android",
  ios: "iOS simulator",
  linux_desktop: "Linux desktop",
  mac: "Agents’ Mac",
};

/** A phone's screen stands up; a browser's, a desktop's and the Mac's lie down. */
export const isPhone = (kind: Kind): boolean => kind === "android" || kind === "ios";

/** Where it runs, in words: the agents' Mac by name, else its kind on its machine. */
export const placeLine = (p: Pick<PageScreen, "kind" | "machine">): string => (p.kind === "mac" ? KIND_WORD.mac : `${KIND_WORD[p.kind]} · ${p.machine}`);

const ALL = {} as const;
const NO_THUMBS: Readonly<Record<string, never>> = {};

export function useScreens(): readonly PageScreen[] {
  const on = useData((st) => st.features.includes(FEATURE));
  const projects = useData(selectProjects);
  const refs = useMemo<ProjectRef[]>(() => (projects ?? []).map((p) => ({ machineId: p.machineId, projectId: p.projectId })), [projects]);
  const answers = useToolQueries("browser_sessions", on ? refs.map((projectRef) => ({ projectRef })) : []);
  useToolQuery("agents_list", ALL, { enabled: on });
  const agents = useData(selectLiveAgents);
  const thumbs = useData((st) => st.screenThumbs ?? NO_THUMBS);
  const lists = answers.map((a) => a.data?.sessions);
  // A few dozen rows at most, made again each render: cheaper than keeping each answer's identity.
  const out: PageScreen[] = [];
  lists.forEach((list, i) => {
    const p = projects?.[i];
    if (list === undefined || p === undefined) return;
    const navi = isNavi(p);
    for (const row of list) {
      const x = fromHub(row, ownerOf(agents, row));
      const live = isLive(x);
      const thumb = live ? thumbs[row.sessionId] : undefined;
      // A Navi's own screen is the Navi's: its name, not "Lead".
      const agent = navi && row.openedBy === undefined ? { laneId: x.agent.laneId, title: p.title } : x.agent;
      out.push({
        x: { ...x, agent },
        kind: x.kind ?? "browser",
        project: { title: p.title, navi },
        machine: row.machineId ?? p.machineId,
        ...(thumb === undefined ? {} : { thumb: `data:image/jpeg;base64,${thumb.jpegB64}` }),
        ...(x.now === undefined ? {} : { doing: x.now }),
      });
    }
  });
  return out;
}

const startOf = (s: PageScreen) => parseMs(s.x.startedAt) ?? 0;
const endOf = (s: PageScreen) => parseMs(s.x.endedAt) ?? startOf(s);

/**
 * The page's three groups: what asks you to take over, oldest first; the rest live, oldest first, so a tile stays put
 * as others come; and the ended, newest first.
 */
export const split = (all: readonly PageScreen[]) => {
  const asking = all.filter((s) => s.x.state === "asking").sort((a, b) => startOf(a) - startOf(b));
  const live = all.filter((s) => isLive(s.x) && s.x.state !== "asking").sort((a, b) => startOf(a) - startOf(b));
  const recent = all.filter((s) => !isLive(s.x)).sort((a, b) => endOf(b) - endOf(a));
  return { asking, live, recent };
};

const onVisibility = (change: () => void) => {
  document.addEventListener("visibilitychange", change);
  return () => document.removeEventListener("visibilitychange", change);
};
const isVisible = () => document.visibilityState === "visible";

/**
 * The page's pictures and steps, while it shows: the hub sends each live screen's picture a few times a minute
 * (screen_thumbs) and the lists are read again as often, for each agent's latest step. A hidden window, or the page
 * left, stops both.
 */
export function useThumbFeed(on: boolean): void {
  const layer = useDataLayer();
  const served = useData((st) => st.features.includes(THUMBS));
  const visible = useSyncExternalStore(onVisibility, isVisible);
  const feeding = on && served && visible;
  useEffect(() => {
    if (!feeding) return undefined;
    void window.fleetd.hub.thumbs(layer.hub, true);
    const steps = setInterval(() => void layer.queryClient.invalidateQueries({ queryKey: ["call", "browser_sessions"] }), THUMB_EVERY_MS);
    return () => {
      clearInterval(steps);
      void window.fleetd.hub.thumbs(layer.hub, false);
    };
  }, [layer, feeding]);
}
