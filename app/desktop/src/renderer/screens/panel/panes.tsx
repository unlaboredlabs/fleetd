// The Agents, Sessions and Pull requests tabs as the tab list (tabs.ts) loads them: AgentsPane, SessionsPane and
// PrsPane with the state they share with their counts. The agents' scope (this project or all) is the panel's, so the
// tab's count follows the list; the PR tab you read (Overview or Changes) is kept while the app runs, so reading diffs
// one PR after another stays on Changes, and Changes asks the frame for its wide width. Try it (screens/tryit) takes
// the wide width too, and opens only for the PR it was pressed for.
import { createContext, useContext, useEffect, useLayoutEffect, useMemo, useState, type ReactNode } from "react";
import { useData, useToolQuery } from "../../src/data/react";
import { projectKey } from "../../src/data/store";
import { selectLiveAgents } from "../../src/data/selectors";
import { AgentsPane, isLine, scopedAgents, useAgentScope, type AgentScope } from "../agents/AgentsPane";
import type { PrTab } from "../prs/PrDetail";
import { PrsPane, usePrList } from "../prs/PrsPane";
import { SessionsPane } from "../sessions/SessionsPane";
import { isLive } from "../sessions/model";
import { useSessions } from "../sessions/hub";
import { openCount } from "../prs/words";
import { isWanted, shownTry, useWantedTry } from "../tryit/open";
import type { CountProps, PaneProps } from "./tabs";

const ALL = {} as const;

type Scope = readonly [AgentScope, (next: AgentScope) => void];
const ScopeContext = createContext<Scope>(["project", () => undefined]);

/** What the panes and their counts share, for as long as the panel shows. */
export function PanesProvider({ children }: { children: ReactNode }) {
  const [scope, setScope] = useAgentScope();
  const value = useMemo((): Scope => [scope, setScope], [scope, setScope]);
  return <ScopeContext.Provider value={value}>{children}</ScopeContext.Provider>;
}

export function AgentsTab({ project, view }: PaneProps) {
  const [scope, setScope] = useContext(ScopeContext);
  return <AgentsPane project={project} agent={view.tab === "agents" ? view.agent : null} scope={scope} onScope={setScope} />;
}

/** The agents the tab lists, the leads not counted; nothing until known. */
export function AgentCount({ project }: CountProps) {
  const [scope] = useContext(ScopeContext);
  useToolQuery("agents_list", ALL);
  const all = useData(selectLiveAgents);
  const key = projectKey(project);
  const n = useMemo(() => (all === undefined ? 0 : scopedAgents(all, key, scope).filter((a) => !isLine(a)).length), [all, key, scope]);
  return n > 0 ? String(n) : null;
}

/** One session opened (live or its replay) asks for the frame's wide width, so its page shows at a readable size. */
export function SessionsTab({ project, view, onWide }: PaneProps) {
  const session = view.tab === "sessions" ? view.session : null;
  useLayoutEffect(() => {
    onWide(session !== null);
  }, [session, onWide]);
  useLayoutEffect(() => () => onWide(false), [onWide]);
  return <SessionsPane project={project} session={session} />;
}

/** The sessions open now, the ones asking for you among them. */
export function SessionCount({ project }: CountProps) {
  const n = useSessions(project).filter(isLive).length;
  return n > 0 ? String(n) : null;
}

let lastPrTab: PrTab = "overview";

export function PrsTab({ project, view, onWide }: PaneProps) {
  const pr = view.tab === "prs" ? view.pr : null;
  // Try it pressed anywhere opens that PR's Try it (tryit/open.ts) once it is the one shown; another PR opens on its
  // overview rather than on a Try it of its own.
  const wanted = useWantedTry();
  const asked = pr !== null && isWanted(wanted, pr.repo, pr.number);
  const shown = pr === null ? null : `${pr.repo ?? ""}#${String(pr.number)}`;
  const [tab, setTab] = useState<PrTab>(asked ? "try" : lastPrTab === "try" ? "overview" : lastPrTab);
  const [seen, setSeen] = useState({ shown, wanted });
  if (seen.shown !== shown || seen.wanted !== wanted) {
    setSeen({ shown, wanted });
    const next = asked ? "try" : tab === "try" && seen.shown !== shown ? "overview" : tab;
    if (next !== tab) setTab(next);
  }
  useEffect(() => {
    if (asked) shownTry();
  }, [asked]);
  // Changes and Try it take the wide panel: a diff, and a page the person uses.
  const wide = pr !== null && (tab === "changes" || tab === "try");
  // Before paint, so the diff never shows at the narrow width first.
  useLayoutEffect(() => {
    onWide(wide);
  }, [wide, onWide]);
  useLayoutEffect(() => () => onWide(false), [onWide]);
  const pick = (next: PrTab) => {
    lastPrTab = next;
    setTab(next);
  };
  return <PrsPane project={project} pr={pr} tab={tab} onTab={pick} />;
}

/** Its open PRs, once the list has been read: the count alone never asks GitHub. */
export function PrCount({ project, active }: CountProps) {
  const rows = usePrList(project, active).list.data?.prs;
  const n = rows === undefined ? 0 : openCount(rows);
  return n > 0 ? String(n) : null;
}
