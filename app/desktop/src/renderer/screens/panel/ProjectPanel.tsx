// The panel beside a project's chat: its agents (or every project's) and its pull requests, a tab each. A row opens one agent's live work
// or one PR in the list's place, with a way back above it. Tabs, rows and Back are all routes (shell/routes.ts), so
// links from the chat, Status and the palette open the same views. Only the open tab reads from the hub.
import { ChevronLeft } from "lucide-react";
import { useMemo, useState } from "react";
import { useData, useToolQuery } from "../../src/data/react";
import { projectKey } from "../../src/data/store";
import { selectLiveAgents } from "../../src/data/selectors";
import { Button, Tab, TabList, TabPanel, Tabs, cx } from "../../ui";
import { AgentsPane, isLine, scopedAgents, useAgentScope, type AgentScope } from "../agents/AgentsPane";
import type { PrTab } from "../prs/PrDetail";
import { PrsPane, usePrList } from "../prs/PrsPane";
import { openCount } from "../prs/words";
import { navigate } from "../shell/navigation";
import { panelRoute, type PanelView, type ProjectKey } from "../shell/routes";
import s from "./panel.module.css";

const ALL = {} as const;

// A PR's tab is the reader's, kept while the app runs: reading diffs one PR after another stays on Changes.
let lastPrTab: PrTab = "overview";

const LIST: Readonly<Record<PanelView["tab"], PanelView>> = { agents: { tab: "agents", agent: null }, prs: { tab: "prs", pr: null } };

export function ProjectPanel({ project, view }: { project: ProjectKey; view: PanelView }) {
  const [prTab, setPrTab] = useState<PrTab>(lastPrTab);
  const [scope, setScope] = useAgentScope();
  const pickPrTab = (next: PrTab) => {
    lastPrTab = next;
    setPrTab(next);
  };
  const item = view.tab === "agents" ? view.agent !== null : view.pr !== null;
  // Reading a PR's changes, the panel widens so the diff has room; the PR's Overview or Back narrows it again.
  const wide = view.tab === "prs" && view.pr !== null && prTab === "changes";

  return (
    <Tabs
      className={cx(s.panel, wide && s.wide)}
      value={view.tab}
      onValueChange={(tab) => navigate(panelRoute(project, LIST[tab === "prs" ? "prs" : "agents"]), { replace: true })}
    >
      <div className={s.head}>
        <TabList aria-label="Agents and pull requests">
          <Tab value="agents" count={<AgentCount project={project} scope={scope} />}>
            Agents
          </Tab>
          <Tab value="prs" count={<PrCount project={project} reading={view.tab === "prs"} />}>
            Pull requests
          </Tab>
        </TabList>
      </div>
      {item ? (
        <div className={s.back}>
          <Button variant="quiet" size="sm" icon={<ChevronLeft aria-hidden />} onClick={() => navigate(panelRoute(project, LIST[view.tab]))}>
            {view.tab === "agents" ? "All agents" : "All pull requests"}
          </Button>
        </div>
      ) : null}
      <TabPanel value="agents" className={s.body}>
        {view.tab === "agents" ? <AgentsPane project={project} agent={view.agent} scope={scope} onScope={setScope} /> : null}
      </TabPanel>
      <TabPanel value="prs" className={s.body}>
        {view.tab === "prs" ? <PrsPane project={project} pr={view.pr} tab={prTab} onTab={pickPrTab} /> : null}
      </TabPanel>
    </Tabs>
  );
}

/** The agents the tab lists, the leads not counted; nothing until known. */
function AgentCount({ project, scope }: { project: ProjectKey; scope: AgentScope }) {
  useToolQuery("agents_list", ALL);
  const all = useData(selectLiveAgents);
  const key = projectKey(project);
  const n = useMemo(() => (all === undefined ? 0 : scopedAgents(all, key, scope).filter((a) => !isLine(a)).length), [all, key, scope]);
  return n > 0 ? String(n) : null;
}

/** Its open PRs, once the list has been read: the count alone never asks GitHub. */
function PrCount({ project, reading }: { project: ProjectKey; reading: boolean }) {
  const rows = usePrList(project, reading).list.data?.prs;
  const n = rows === undefined ? 0 : openCount(rows);
  return n > 0 ? String(n) : null;
}
