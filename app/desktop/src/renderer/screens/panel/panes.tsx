// The panel's tabs as the row (Sections.tsx) loads them, each one list that takes every view landing in it: Agents
// (the agents, the screens among them, and one agent's work or one screen in the list's place), Shipping (the merge
// line and the pull requests, and one PR), Plan (the checklist and the asked work), History (what happened, and the
// decisions a row away), Artifacts and one skill. With them the counts on the row. The PR tab you read (Overview or
// Changes) is kept while the app runs, so reading diffs one PR after another stays on Changes; Changes, one screen,
// one artifact and one skill ask the frame for its wide width.
import { useLayoutEffect, useMemo, useState, type ReactNode } from "react";
import { useData, useToolQuery } from "../../src/data/react";
import { projectKey } from "../../src/data/store";
import { selectLiveAgents } from "../../src/data/selectors";
import { ActivityPane } from "../activity";
import { AgentsPane } from "../agents/AgentsPane";
import { projectAgents } from "../agents/model";
import { ArtifactsTabView } from "../artifacts/ArtifactsPane";
import { ChecklistPane } from "../checklist/ChecklistPane";
import { DecisionsPane } from "../decisions/DecisionsPane";
import type { PrTab } from "../prs/PrDetail";
import { PrsPane, usePrList } from "../prs/PrsPane";
import { openCount } from "../prs/words";
import { SessionView } from "../sessions/SessionView";
import { SkillsTabView } from "../skills/SkillsPane";
import type { CountProps, PaneProps } from "./tabs";

const ALL = {} as const;

/**
 * The agents and, among them, the screens; one agent's work; or one screen (live or its replay), which asks for the
 * frame's wide width so its page shows at a readable size.
 */
export function AgentsTab({ project, view, onWide }: PaneProps) {
  const session = view.tab === "sessions" ? view.session : null;
  useLayoutEffect(() => {
    onWide(session !== null);
  }, [session, onWide]);
  useLayoutEffect(() => () => onWide(false), [onWide]);
  if (session !== null) return <SessionView key={session} project={project} id={session} />;
  return <AgentsPane project={project} agent={view.tab === "agents" ? view.agent : null} at={view.tab === "sessions" ? "screens" : null} />;
}

/** The project's agents at work, the leads not counted; nothing until known. */
export function AgentCount({ project }: CountProps) {
  useToolQuery("agents_list", ALL);
  const all = useData(selectLiveAgents);
  const key = projectKey(project);
  const n = useMemo(() => (all === undefined ? 0 : projectAgents(all, key).length), [all, key]);
  return n > 0 ? String(n) : null;
}

let lastPrTab: PrTab = "overview";

/** The merge line and the pull requests in one list (`/train` opens it at the line), or one PR. */
export function ShippingTab({ project, view, onWide }: PaneProps) {
  const pr = view.tab === "prs" ? view.pr : null;
  const [tab, setTab] = useState<PrTab>(lastPrTab);
  // Changes takes the wide panel: a diff.
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
  return <PrsPane project={project} pr={pr} tab={tab} onTab={pick} at={view.tab === "train" ? "train" : null} />;
}

/** Its open PRs, once the list has been read: the count alone never asks GitHub. */
export function PrCount({ project, active }: CountProps) {
  const rows = usePrList(project, active).list.data?.prs;
  const n = rows === undefined ? 0 : openCount(rows);
  return n > 0 ? String(n) : null;
}

/** The lead's checklist with, at its foot, the work it asked other projects for (`/asked` opens it there). */
export function PlanTab({ project, view }: PaneProps) {
  return <ChecklistPane project={project} at={view.tab === "asked" ? "asked" : null} />;
}

/** What happened, or (a row away, with its way back) the decisions. */
export function HistoryTab({ project, view }: PaneProps) {
  return view.tab === "decisions" ? <DecisionsPane project={project} /> : <ActivityPane project={project} view={view} />;
}

/** One of a project's skills, which asks for the frame's wide width. */
export function SkillsTab({ project, view, onWide }: PaneProps): ReactNode {
  // ProjectPanel opens Agents for a skills view with none named.
  return view.tab === "skills" && view.skill !== null ? <SkillsTabView project={project} skill={view.skill} onWide={onWide} /> : null;
}

/** The chat's artifacts, or one of them, which asks for the frame's wide width. */
export function ArtifactsTab({ project, view, onWide }: PaneProps) {
  const one = view.tab === "artifacts" ? view : null;
  return <ArtifactsTabView project={project} artifact={one?.artifact ?? null} version={one?.version} onWide={onWide} />;
}
