// The Agents, Browser sessions and Pull requests tabs as the tab list (tabs.ts) loads them: AgentsPane, SessionsPane
// and PrsPane with the state they share with their counts. The agents' scope (this project or all) is the panel's, so the tab's count follows the
// list; the PR tab you read (Overview or Changes) is kept while the app runs, so reading diffs one PR after another
// stays on Changes, and Changes asks the frame for its wide width.
import { createContext, useContext, useLayoutEffect, useMemo, useState, type ReactNode } from "react";
import { useData, useToolQuery } from "../../src/data/react";
import { projectKey } from "../../src/data/store";
import { selectLiveAgents } from "../../src/data/selectors";
import { AgentsPane, isLine, scopedAgents, useAgentScope, type AgentScope } from "../agents/AgentsPane";
import type { PrTab } from "../prs/PrDetail";
import { PrsPane, usePrList } from "../prs/PrsPane";
import { SessionsPane } from "../sessions/SessionsPane";
import { isLive } from "../sessions/model";
import { useBrowserSessions } from "../sessions/preview";
import { openCount } from "../prs/words";
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
  const n = useBrowserSessions(project).filter(isLive).length;
  return n > 0 ? String(n) : null;
}

let lastPrTab: PrTab = "overview";

export function PrsTab({ project, view, onWide }: PaneProps) {
  const [tab, setTab] = useState<PrTab>(lastPrTab);
  const pr = view.tab === "prs" ? view.pr : null;
  const wide = pr !== null && tab === "changes";
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
