// The panel's Checklist tab: the project's to-dos as its lead keeps them (the lead's `checklist` tool), with how far
// along they are, grouped as doing, to do and done; done folds away. The lead changes it, and each change
// (checklist.changed) reads it again, so it is live. You can only take items off: Delete on an item (on hover, or its
// right-click menu) and Clear done, each with Undo (removal.ts). An item's PR or agent opens in the panel, from its
// link or its right-click menu.
import { ChevronRight, Circle, CircleCheck, CircleDot, Trash2 } from "lucide-react";
import { useState } from "react";
import type { TodoItem, TodoState } from "../../../shared/contracts";
import { useData, useDataLayer, useToolQuery } from "../../src/data/react";
import { selectLiveAgent } from "../../src/data/selectors";
import { projectKey } from "../../src/data/store";
import { Button, ContextMenu, ContextMenuItem, ContextMenuSeparator, Dot, EmptyState, Text, Tooltip, cx } from "../../ui";
import { panelRoute, toHash, type ProjectKey } from "../shell/routes";
import { groupItems, openItems, progressOf, prOf, type ChecklistGroup } from "./model";
import { removeItems, useShown } from "./removal";
import s from "./checklist.module.css";

/** One read per project, shared by the tab and its badge, without what you just removed. */
const useChecklist = (project: ProjectKey) => {
  const title = useData((st) => st.projects[projectKey(project)]?.title);
  const fresh = useData((st) => st.fresh);
  const missing = fresh && title === undefined;
  const list = useToolQuery("checklist_get", { projectRef: project }, { enabled: !missing });
  return { missing, fresh, list, items: useShown(project, list.data?.items) };
};

/** Takes items off with Undo: one by its Delete, or the done ones by Clear done. */
const useRemove = (project: ProjectKey) => {
  const layer = useDataLayer();
  return {
    one: (item: TodoItem) => {
      removeItems(layer, project, [item], `Deleted “${item.text}”`);
    },
    done: (done: readonly TodoItem[]) => {
      removeItems(layer, project, done, `Cleared ${String(done.length)} done ${done.length === 1 ? "item" : "items"}`);
    },
  };
};

/** The tab's badge: the items still open. */
export function ChecklistCount({ project }: { project: ProjectKey }) {
  const n = openItems(useChecklist(project).items);
  return n > 0 ? String(n) : null;
}

// Whether Done is unfolded, while the app runs; until you choose, it folds while anything is still open.
let doneOpen: boolean | null = null;

export function ChecklistPane({ project }: { project: ProjectKey }) {
  const { missing, fresh, list, items } = useChecklist(project);
  const remove = useRemove(project);
  const [open, setOpen] = useState(doneOpen);

  if (missing) {
    return (
      <div className={s.screen} data-screen="checklist.missing">
        <EmptyState title="This project isn’t on the hub">It may have been removed.</EmptyState>
      </div>
    );
  }
  if (items === undefined) {
    return (
      <div className={s.screen} data-screen={list.isError ? "checklist.error" : "checklist.loading"}>
        {!fresh ? (
          <div className={s.note}>
            <Text tone="quiet">The checklist shows once you’re connected.</Text>
          </div>
        ) : list.isError ? (
          <div className={s.note} role="alert">
            <Text tone="quiet">Couldn’t read the checklist.</Text>
            <Button onClick={() => void list.refetch()}>Retry</Button>
          </div>
        ) : (
          <div className={s.note} aria-busy="true" aria-label="Loading the checklist" />
        )}
      </div>
    );
  }
  if (items.length === 0) {
    return (
      <div className={s.screen} data-screen="checklist.empty">
        <EmptyState title="No checklist yet">The lead keeps the project’s to-dos here as it plans and runs the work.</EmptyState>
      </div>
    );
  }

  const progress = progressOf(items);
  const foldDone = !(open ?? progress.done === progress.total);
  const toggleDone = () => {
    doneOpen = foldDone;
    setOpen(foldDone);
  };
  return (
    <div className={s.screen} data-screen="checklist">
      {!fresh ? (
        <span className={s.liveness} role="status">
          <Dot color="var(--warning)" />
          <Text size="xs">Not live: reconnecting</Text>
        </span>
      ) : null}
      <Summary
        done={progress.done}
        doing={progress.doing}
        total={progress.total}
        onClearDone={() => {
          remove.done(items.filter((i) => i.state === "done"));
        }}
      />
      <div className={s.scroll}>
        {groupItems(items)
          .filter((g) => g.items.length > 0)
          .map((g) =>
            g.state === "done" ? (
              <section key={g.state} className={s.group} aria-label={g.title}>
                <button type="button" className={s.fold} aria-expanded={!foldDone} onClick={toggleDone}>
                  <ChevronRight aria-hidden className={cx(s.chevron, !foldDone && s.chevronOpen)} />
                  <span className={s.groupTitle}>{g.title}</span>
                  <span className={s.groupCount}>{g.items.length}</span>
                </button>
                {foldDone ? null : <Rows group={g} project={project} onDelete={remove.one} />}
              </section>
            ) : (
              <section key={g.state} className={s.group} aria-label={g.title}>
                <h3 className={s.heading}>
                  <span className={s.groupTitle}>{g.title}</span>
                  <span className={s.groupCount}>{g.items.length}</span>
                </h3>
                <Rows group={g} project={project} onDelete={remove.one} />
              </section>
            ),
          )}
      </div>
    </div>
  );
}

/** The tab's header: how far along it is, and Clear done while anything is done. */
function Summary({ done, doing, total, onClearDone }: { done: number; doing: number; total: number; onClearDone: () => void }) {
  const pct = (n: number) => `${String(total === 0 ? 0 : (n / total) * 100)}%`;
  return (
    <div className={s.summary}>
      <div className={s.summaryLine}>
        <Text strong tabular>
          {done} of {total} done
        </Text>
        <span className={s.summaryEnd}>
          <Text size="xs" tone="quiet">
            {doing > 0 ? `${String(doing)} in progress · kept by the lead` : "Kept by the lead"}
          </Text>
          {done > 0 ? (
            <Button variant="quiet" size="sm" className={s.clear} onClick={onClearDone}>
              Clear done
            </Button>
          ) : null}
        </span>
      </div>
      <div className={s.meter} role="progressbar" aria-label="Checklist progress" aria-valuemin={0} aria-valuemax={total} aria-valuenow={done} aria-valuetext={`${String(done)} of ${String(total)} done`}>
        <span className={s.meterDone} style={{ width: pct(done) }} />
        <span className={s.meterDoing} style={{ width: pct(doing) }} />
      </div>
    </div>
  );
}

const MARK: Readonly<Record<TodoState, { readonly icon: typeof Circle; readonly word: string }>> = {
  doing: { icon: CircleDot, word: "Doing" },
  todo: { icon: Circle, word: "To do" },
  done: { icon: CircleCheck, word: "Done" },
};

function Rows({ group, project, onDelete }: { group: ChecklistGroup; project: ProjectKey; onDelete: (item: TodoItem) => void }) {
  return (
    <ul className={s.rows}>
      {group.items.map((item) => (
        <Row key={item.id} item={item} project={project} onDelete={onDelete} />
      ))}
    </ul>
  );
}

function Row({ item, project, onDelete }: { item: TodoItem; project: ProjectKey; onDelete: (item: TodoItem) => void }) {
  const { icon: Icon, word } = MARK[item.state];
  const pr = item.link?.pr === undefined ? null : prOf(item.link.pr);
  const taskId = item.link?.taskId;
  // Its right-click menu opens what it links to, then Delete.
  const menu = () => (
    <>
      {taskId !== undefined ? <ContextMenuItem onSelect={() => (window.location.hash = toHash(panelRoute(project, { tab: "agents", agent: taskId })))}>Open agent</ContextMenuItem> : null}
      {pr !== null ? <ContextMenuItem onSelect={() => (window.location.hash = toHash(panelRoute(project, { tab: "prs", pr })))}>{`Open PR #${String(pr.number)}`}</ContextMenuItem> : null}
      {pr !== null || taskId !== undefined ? <ContextMenuSeparator /> : null}
      <ContextMenuItem icon={<Trash2 />} danger onSelect={() => onDelete(item)}>
        Delete
      </ContextMenuItem>
    </>
  );
  return (
    <ContextMenu menu={menu}>
      <li className={s.row} data-state={item.state} data-item={item.id}>
        <Icon className={s.mark} role="img" aria-label={word} />
        <div className={s.main}>
          <span className={s.text}>{item.text}</span>
          {pr !== null || taskId !== undefined ? (
            <span className={s.links}>
              {taskId !== undefined ? <AgentLink project={project} laneId={taskId} /> : null}
              {pr !== null ? (
                <a className={s.link} href={toHash(panelRoute(project, { tab: "prs", pr }))}>
                  PR #{pr.number}
                </a>
              ) : null}
            </span>
          ) : null}
        </div>
        <Tooltip content="Delete">
          <Button variant="quiet" size="sm" iconOnly className={s.delete} aria-label={`Delete “${item.text}”`} onClick={() => onDelete(item)}>
            <Trash2 aria-hidden />
          </Button>
        </Tooltip>
      </li>
    </ContextMenu>
  );
}

/** The agent on an item, by its title while it is at work; its id only in the tooltip. */
function AgentLink({ project, laneId }: { project: ProjectKey; laneId: string }) {
  const agent = useData(selectLiveAgent(`${projectKey(project)}/${laneId}`));
  return (
    <a className={s.link} href={toHash(panelRoute(project, { tab: "agents", agent: laneId }))} title={laneId}>
      {agent === undefined ? "The agent" : <span className={s.agent}>{agent.row.title}</span>}
    </a>
  );
}
