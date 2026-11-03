// The Screens page's data: every screen the hub serves, of every project and Navi you can see, each with its project,
// its machine, a picture and what its agent does (preview.ts until the hub sends them), sorted as the page shows them.
import { useMemo } from "react";
import type { ProjectRef } from "../../../shared/contracts";
import { useData, useToolQueries, useToolQuery } from "../../src/data/react";
import { selectLiveAgents, selectProjects } from "../../src/data/selectors";
import { isNavi } from "../navi/model";
import { FEATURE, fromHub, ownerOf } from "../sessions/hub";
import { isLive, type BrowserSession } from "../sessions/model";
import { parseMs } from "../live/format";
import { EXTRA } from "./preview";

export type Kind = NonNullable<BrowserSession["kind"]> | "browser";

export interface PageScreen {
  readonly x: BrowserSession;
  readonly kind: Kind;
  readonly project: { readonly title: string; readonly navi: boolean };
  readonly machine: string;
  readonly thumb?: string;
  readonly doing?: string;
  readonly site?: string;
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

const ALL = {} as const;

export function useScreens(): readonly PageScreen[] {
  const on = useData((st) => st.features.includes(FEATURE));
  const projects = useData(selectProjects);
  const refs = useMemo<ProjectRef[]>(() => (projects ?? []).map((p) => ({ machineId: p.machineId, projectId: p.projectId })), [projects]);
  const answers = useToolQueries("browser_sessions", on ? refs.map((projectRef) => ({ projectRef })) : []);
  useToolQuery("agents_list", ALL, { enabled: on });
  const agents = useData(selectLiveAgents);
  const rows = answers.map((a) => a.data?.sessions);
  const key = rows.map((r) => (r === undefined ? "-" : String(r.length))).join(",") + String(agents?.length ?? 0);
  return useMemo(() => {
    const out: PageScreen[] = [];
    rows.forEach((list, i) => {
      const p = projects?.[i];
      if (list === undefined || p === undefined) return;
      for (const row of list) {
        const x = fromHub(row, ownerOf(agents, row));
        const extra = EXTRA[x.id];
        const navi = isNavi(p);
        const agent = navi && row.openedBy === undefined ? { laneId: x.agent.laneId, title: p.title } : x.agent;
        out.push({
          x: { ...x, agent },
          kind: x.kind ?? "browser",
          project: { title: p.title, navi },
          machine: x.kind === "mac" ? "mac" : (extra?.machine ?? p.machineId),
          ...(extra?.thumb === undefined ? {} : { thumb: extra.thumb }),
          ...(extra?.doing === undefined ? {} : { doing: extra.doing }),
          ...(extra?.site === undefined ? {} : { site: extra.site }),
        });
      }
    });
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, projects, agents]);
}

const startOf = (s: PageScreen) => parseMs(s.x.startedAt) ?? 0;
const endOf = (s: PageScreen) => parseMs(s.x.endedAt) ?? startOf(s);

/** Asking you first, then yours, then the rest live (oldest first, so a tile stays put), then the ended, newest first. */
export const split = (all: readonly PageScreen[]) => {
  const asking = all.filter((s) => s.x.state === "asking").sort((a, b) => startOf(a) - startOf(b));
  const live = all.filter((s) => isLive(s.x) && s.x.state !== "asking").sort((a, b) => startOf(a) - startOf(b));
  const recent = all.filter((s) => !isLive(s.x)).sort((a, b) => endOf(b) - endOf(a));
  return { asking, live, recent };
};

/** Who drives it now, in words: you, its agent (by title), or the agent waiting on you. */
export const whoLine = (s: PageScreen): string => {
  if (s.x.openedBy !== undefined) return s.x.state === "yours" ? "You" : s.x.openedBy;
  return s.x.agent.title;
};
