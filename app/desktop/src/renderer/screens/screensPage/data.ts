// The Screens page's data: every screen the hub serves, of every project you can see, each with its project,
// the machine it runs on and its agent's latest step (browser_sessions), and a live one's newest picture (the hub's
// screen_thumb feed, which runs only while the page shows: useThumbFeed), sorted as the page shows them.
import { useMemo } from "react";
import type { ProjectRef } from "../../../shared/contracts";
import { useData, useToolQueries, useToolQuery } from "../../src/data/react";
import { useScreenFeed } from "../sessions/feed";
import { selectLiveAgents, selectProjects } from "../../src/data/selectors";
import { FEATURE, fromHub, ownerOf } from "../sessions/hub";
import { isLive, type BrowserSession } from "../sessions/model";
import { parseMs } from "../live/format";

export { THUMBS, THUMB_EVERY_MS } from "../sessions/feed";

export type Kind = NonNullable<BrowserSession["kind"]> | "browser";

export interface PageScreen {
  readonly x: BrowserSession;
  readonly kind: Kind;
  readonly project: { readonly title: string };
  /** The machine it runs on; its project's from a hub too old to say. */
  readonly machine: string;
  /** Its newest picture, as a data URL, while it is live and the hub has taken one. */
  readonly thumb?: string;
  /** Its agent's latest step, in words, while it is live. */
  readonly doing?: string;
}

/** A screen's kind in words; `ios` for past iOS screens, which still show read-only (no new one opens, D298). */
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
    for (const row of list) {
      const x = fromHub(row, ownerOf(agents, row));
      const live = isLive(x);
      const thumb = live ? thumbs[row.sessionId] : undefined;
      out.push({
        x,
        kind: x.kind ?? "browser",
        project: { title: p.title },
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

/** The page's pictures and steps, while it shows (sessions/feed.ts): a hidden window, or the page left, stops both. */
export const useThumbFeed = (on: boolean): void => useScreenFeed(on);
