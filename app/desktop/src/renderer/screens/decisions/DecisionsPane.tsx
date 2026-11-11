// The panel's Decisions: everything settled in the project so far, by its lead or by you, one row per question with
// the answer in force on top; what it replaced, or that you revoked it, folds under it, and the revoked ones fold at
// the list's end. One line narrows the list: a search with, at its end, one filter menu (who decided, where it
// applies). A row opens to its why and history, and you can change or revoke a decision there. It opens from History's
// first line, and the way back is on its own one line, before the search. Read through the data layer (decisions_list, refetched on the hub's decision events); nothing polls.
import { useMemo, useState } from "react";
import { useData, useToolQuery } from "../../src/data/react";
import { ChevronLeft, ListFilter } from "lucide-react";
import { Button, Dot, Input, Menu, MenuContent, MenuRadioGroup, MenuRadioItem, MenuSeparator, MenuTrigger, Text, Tooltip } from "../../ui";
import { FoldLine, GroupLabel, ListNote, PanelEmpty, useFold } from "../panel/folds";
import { useNow } from "../live/clock";
import { navigate } from "../shell/navigation";
import { panelRoute, type ProjectKey } from "../shell/routes";
import { DecisionItem } from "./DecisionItem";
import { NO_FILTERS, applyFilters, filtered, liveCount, placesOf, threadsOf, type Filters, type Thread, type WhoFilter } from "./model";
import s from "./decisions.module.css";

/** The project's decisions, which the tab's count reads too: one read, shared. */
export const useDecisionsList = (project: ProjectKey, enabled = true) => {
  const title = useData((st) => st.projects[`${project.machineId}/${project.projectId}`]?.title);
  const fresh = useData((st) => st.fresh);
  // A link to a project the hub doesn't have (removed, or another hub's) says so instead of asking.
  const missing = fresh && title === undefined;
  const projectRef = { machineId: project.machineId, projectId: project.projectId };
  return { missing, list: useToolQuery("decisions_list", { projectRef }, { enabled: enabled && !missing }) };
};

/** The decisions in force, for the tab's count; undefined until read. */
export const useDecisionCount = (project: ProjectKey, enabled = true): number | undefined => {
  const data = useDecisionsList(project, enabled).list.data;
  return data === undefined ? undefined : liveCount(data.decisions);
};

const WHO: ReadonlyArray<{ value: WhoFilter; label: string }> = [
  { value: "anyone", label: "Anyone" },
  { value: "lead", label: "The lead" },
  { value: "you", label: "You" },
];

export function DecisionsPane({ project }: { project: ProjectKey }) {
  const fresh = useData((st) => st.fresh);
  const { missing, list } = useDecisionsList(project);
  const [filters, setFilters] = useState<Filters>(NO_FILTERS);
  const [open, setOpen] = useState<string | null>(null);
  const data = list.data;
  const threads = useMemo(() => (data === undefined ? undefined : threadsOf(data.decisions, data.orders)), [data]);
  const shown = useMemo(() => (threads === undefined ? undefined : applyFilters(threads, filters)), [threads, filters]);
  const state = data !== undefined ? "decisions" : list.isError ? "decisions.error" : "decisions.loading";

  if (missing) {
    return (
      <div className={s.screen} data-screen="decisions.missing">
        <div className={s.toolbar}>
          <Back project={project} />
        </div>
        <PanelEmpty title="This project isn’t on the hub" />
      </div>
    );
  }

  return (
    <div className={s.screen} data-screen={state}>
      {!fresh ? (
        <span className={s.liveness} role="status">
          <Dot color="var(--warning)" />
          <Text size="xs">Not live: reconnecting</Text>
        </span>
      ) : null}
      {threads !== undefined && threads.length > 0 ? (
        <Toolbar project={project} threads={threads} filters={filters} onFilters={setFilters} />
      ) : (
        <div className={s.toolbar}>
          <Back project={project} />
        </div>
      )}
      {threads === undefined || shown === undefined ? (
        !fresh ? (
          // Nothing held and no hub to ask: "Loading" would never finish.
          <div className={s.paneNote}>
            <Text tone="quiet">Decisions show once you’re connected.</Text>
          </div>
        ) : list.isError ? (
          <div className={s.paneNote} role="alert">
            <Text tone="quiet">Couldn’t read the decisions.</Text>
            <Button onClick={() => void list.refetch()}>Retry</Button>
          </div>
        ) : (
          <Skeleton />
        )
      ) : threads.length === 0 ? (
        <PanelEmpty title="Nothing decided yet" />
      ) : (
        <List
            threads={shown}
            cut={data?.truncated === true}
            open={open}
            onToggle={(id) => setOpen((at) => (at === id ? null : id))}
            onClear={filtered(filters) ? () => setFilters(NO_FILTERS) : undefined}
            onChanged={() => void list.refetch()}
            fold={`${project.machineId}/${project.projectId}`}
        />
      )}
    </div>
  );
}

/** The way back to History: a chevron before the search, with its word where there is nothing to search. */
function Back({ project, bare = false }: { project: ProjectKey; bare?: boolean }) {
  const back = () => navigate(panelRoute(project, { tab: "activity" }));
  return bare ? (
    <Tooltip content="Back to History">
      <Button variant="quiet" size="sm" iconOnly aria-label="History" icon={<ChevronLeft aria-hidden />} onClick={back} />
    </Tooltip>
  ) : (
    <Button variant="quiet" size="sm" icon={<ChevronLeft aria-hidden />} onClick={back}>
      History
    </Button>
  );
}

/** The one line above the list: the way back, the search, and at its end who decided and where it applies as one filter menu. */
function Toolbar({ project, threads, filters, onFilters }: { project: ProjectKey; threads: readonly Thread[]; filters: Filters; onFilters: (next: Filters) => void }) {
  const places = useMemo(() => placesOf(threads), [threads]);
  const narrowed = filters.who !== NO_FILTERS.who || filters.where !== NO_FILTERS.where;
  return (
    <div className={s.toolbar}>
      <Back project={project} bare />
      <Input
        type="search"
        className={s.search}
        placeholder="Search decisions"
        aria-label="Search decisions"
        value={filters.query}
        onChange={(e) => onFilters({ ...filters, query: e.currentTarget.value })}
      />
      <Menu>
        <Tooltip content="Who decided, and where it applies">
          <MenuTrigger asChild>
            <Button variant={narrowed ? "secondary" : "quiet"} size="sm" iconOnly aria-label="Filter decisions" aria-pressed={narrowed}>
              <ListFilter aria-hidden />
            </Button>
          </MenuTrigger>
        </Tooltip>
        <MenuContent align="end">
          <MenuRadioGroup aria-label="Decided by" value={filters.who} onValueChange={(who) => onFilters({ ...filters, who: who as WhoFilter })}>
            {WHO.map((w) => (
              <MenuRadioItem key={w.value} value={w.value}>
                {w.label}
              </MenuRadioItem>
            ))}
          </MenuRadioGroup>
          <MenuSeparator />
          <MenuRadioGroup aria-label="Applies to" value={filters.where} onValueChange={(where) => onFilters({ ...filters, where })}>
            <MenuRadioItem value="all">Everywhere</MenuRadioItem>
            {places.map((p) => (
              <MenuRadioItem key={p.id} value={p.id}>
                {p.label}
              </MenuRadioItem>
            ))}
          </MenuRadioGroup>
        </MenuContent>
      </Menu>
    </div>
  );
}

interface ListProps {
  readonly threads: readonly Thread[];
  /** The hub sent only the newest. */
  readonly cut: boolean;
  readonly open: string | null;
  readonly onToggle: (id: string) => void;
  /** Present while a search or filter narrows the list. */
  readonly onClear: (() => void) | undefined;
  readonly onChanged: () => void;
  /** The project, for what its list keeps unfolded. */
  readonly fold: string;
}

function List({ threads, cut, open, onToggle, onClear, onChanged, fold }: ListProps) {
  // "14:02" turns into "Mon 14:02" as days pass: a minute's step is enough.
  const nowMs = useNow(true, 60_000);
  // Revoked ones fold away, and open by themselves while a search or filter narrows the list or nothing is in force.
  const [unfolded, toggleRevoked] = useFold(`decisions:${fold}:revoked`);
  const revokedOpen = unfolded || onClear !== undefined || threads.every((t) => !t.live);
  if (threads.length === 0) {
    return (
      <div className={s.paneNote}>
        <Text tone="quiet">No decision matches.</Text>
        {onClear !== undefined ? (
          <Button variant="quiet" size="sm" onClick={onClear}>
            Clear search and filters
          </Button>
        ) : null}
      </div>
    );
  }
  const live = threads.filter((t) => t.live);
  const revoked = threads.filter((t) => !t.live);
  const rows = (items: readonly Thread[]) => (
    <ul className={s.rows}>
      {items.map((t) => (
        <DecisionItem key={t.id} thread={t} expanded={open === t.id} onToggle={() => onToggle(t.id)} nowMs={nowMs} onChanged={onChanged} />
      ))}
    </ul>
  );
  return (
    <div className={s.listScroll}>
      {live.length === 0 ? null : (
        <section aria-label="In force">
          <GroupLabel label="In force" count={live.length} />
          {rows(live)}
        </section>
      )}
      {revoked.length === 0 ? null : (
        <section aria-label="Revoked">
          <FoldLine label="Revoked" count={revoked.length} open={revokedOpen} onToggle={toggleRevoked} />
          {revokedOpen ? rows(revoked) : null}
        </section>
      )}
      {cut ? <ListNote>Only the most recent decisions are here.</ListNote> : null}
    </div>
  );
}

/** Row outlines, no shimmer, as the list loads. */
function Skeleton() {
  return (
    <div className={s.skeleton} aria-busy="true" aria-label="Loading the decisions">
      <span />
      <span />
      <span />
    </div>
  );
}
