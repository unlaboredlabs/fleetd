// The panel's Decisions: everything settled in the project so far, by its lead or by you, one row per question with
// the answer in force on top; what it replaced, or that you revoked it, folds under it. Search and two filters (who
// decided, where it applies) narrow the list, a row opens to its why and history, and you can change or revoke a
// decision there. Read through the data layer (decisions_list, refetched on the hub's decision events); nothing polls.
import { useMemo, useState } from "react";
import { useData, useToolQuery } from "../../src/data/react";
import { Button, Dot, EmptyState, Input, Select, Text } from "../../ui";
import { useNow } from "../live/clock";
import type { ProjectKey } from "../shell/routes";
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
        <EmptyState title="This project isn’t on the hub">It may have been removed.</EmptyState>
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
        <div className={s.empty}>
          <EmptyState title="Nothing decided yet">When you answer the lead, or it settles a question itself, the answer is kept here.</EmptyState>
        </div>
      ) : (
        <>
          <Toolbar threads={threads} filters={filters} onFilters={setFilters} />
          <List
            threads={shown}
            cut={data?.truncated === true}
            open={open}
            onToggle={(id) => setOpen((at) => (at === id ? null : id))}
            onClear={filtered(filters) ? () => setFilters(NO_FILTERS) : undefined}
            onChanged={() => void list.refetch()}
          />
        </>
      )}
    </div>
  );
}

function Toolbar({ threads, filters, onFilters }: { threads: readonly Thread[]; filters: Filters; onFilters: (next: Filters) => void }) {
  const places = useMemo(() => placesOf(threads), [threads]);
  const where = [{ value: "all", label: "Everywhere" }, ...places.map((p) => ({ value: p.id, label: p.label }))];
  return (
    <div className={s.toolbar}>
      <Input
        type="search"
        className={s.search}
        placeholder="Search decisions"
        aria-label="Search decisions"
        value={filters.query}
        onChange={(e) => onFilters({ ...filters, query: e.currentTarget.value })}
      />
      <div className={s.filters}>
        <Select aria-label="Decided by" className={s.filter} value={filters.who} options={WHO} onValueChange={(who) => onFilters({ ...filters, who })} />
        <Select aria-label="Applies to" className={s.filter} value={filters.where} options={where} onValueChange={(w) => onFilters({ ...filters, where: w })} />
      </div>
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
}

function List({ threads, cut, open, onToggle, onClear, onChanged }: ListProps) {
  // "14:02" turns into "Mon 14:02" as days pass: a minute's step is enough.
  const nowMs = useNow(true, 60_000);
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
  const group = (label: string, items: readonly Thread[]) =>
    items.length === 0 ? null : (
      <section className={s.section} aria-label={label}>
        <div className={s.group}>
          <Text size="xs" tone="quiet" strong>
            {label}
          </Text>
          <Text size="xs" tone="quiet" tabular>
            {items.length}
          </Text>
        </div>
        <ul className={s.rows}>
          {items.map((t) => (
            <DecisionItem key={t.id} thread={t} expanded={open === t.id} onToggle={() => onToggle(t.id)} nowMs={nowMs} onChanged={onChanged} />
          ))}
        </ul>
      </section>
    );
  return (
    <div className={s.listScroll}>
      {group("In force", live)}
      {group("Revoked", revoked)}
      {cut ? (
        <div className={s.group}>
          <Text size="xs" tone="quiet">
            Only the most recent decisions are here.
          </Text>
        </div>
      ) : null}
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
