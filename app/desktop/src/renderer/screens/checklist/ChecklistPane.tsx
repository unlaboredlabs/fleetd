// The panel's Plan: the project's to-dos as its lead keeps them (the lead's `checklist` tool), with how far along they
// are, grouped as doing, to do and done (done folds away), and under them the work its lead asked other projects for
// (asked/AskedRows; `at` "asked" opens the list there). The lead changes the checklist, and each change
// (checklist.changed) reads it again, so it is live. You can only take items off: Delete on an item (on hover, or its
// right-click menu) and Clear on the done ones, each with Undo (removal.ts). An item's PR or agent opens in the panel,
// from its link or its right-click menu.
import { Circle, CircleCheck, CircleDot, Trash2 } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import type { TodoItem, TodoState } from "../../../shared/contracts";
import { useData, useDataLayer, useToolQuery } from "../../src/data/react";
import { selectLiveAgent } from "../../src/data/selectors";
import { projectKey } from "../../src/data/store";
import { Button, ContextMenu, ContextMenuItem, ContextMenuSeparator, Dot, Text, Tooltip } from "../../ui";
import { AskedRows, useAskedWork } from "../asked/AskedRows";
import { askRows } from "../asked/askedModel";
import { FoldLine, GroupLabel, ListNote, PanelEmpty, useFold } from "../panel/folds";
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

/** What the pane is, for the route it was opened by: the checklist's read, or at `/asked` the asks'. */
const screenOf = (at: "asked" | null, list: "ready" | "empty" | "loading" | "error", asks: "ready" | "loading" | "error"): string => {
  if (at === "asked") return asks === "ready" ? "asked" : `asked.${asks}`;
  return list === "ready" ? "checklist" : `checklist.${list}`;
};

export function ChecklistPane({ project, at = null }: { project: ProjectKey; at?: "asked" | null }) {
  const { missing, fresh, list, items } = useChecklist(project);
  const remove = useRemove(project);
  const asked = useAskedWork(project, !missing);
  const asks = asked.data?.asks;
  const rows = useMemo(() => (asks === undefined ? undefined : askRows(asks)), [asks]);
  // "2d ago": read once a mount.
  const [now] = useState(() => Date.now());
  const progress = progressOf(items ?? []);
  // Until you choose, Done folds while anything is still open.
  const [doneOpen, toggleDone] = useFold(`plan:${projectKey(project)}:done`, progress.total > 0 && progress.done === progress.total);

  // A link to the asked work opens the list at it.
  const askedAt = useRef<HTMLDivElement>(null);
  const there = at === "asked" && rows !== undefined;
  useEffect(() => {
    if (there) askedAt.current?.scrollIntoView({ block: "start" });
  }, [there]);

  if (missing) {
    return (
      <div className={s.screen} data-screen="checklist.missing">
        <PanelEmpty title="This project isn’t on the hub" />
      </div>
    );
  }
  const screen = screenOf(at, items === undefined ? (list.isError ? "error" : "loading") : items.length === 0 ? "empty" : "ready", rows !== undefined ? "ready" : asked.isError ? "error" : "loading");
  const liveness = !fresh ? (
    <span className={s.liveness} role="status">
      <Dot color="var(--warning)" />
      <Text size="xs">Not live: reconnecting</Text>
    </span>
  ) : null;
  // The checklist's own place while it isn't read: why, and Retry when the read failed.
  const unread =
    items !== undefined ? null : !fresh ? (
      <div className={s.note}>
        <Text tone="quiet">The plan shows once you’re connected.</Text>
      </div>
    ) : list.isError ? (
      <div className={s.note} role="alert">
        <Text tone="quiet">Couldn’t read the checklist.</Text>
        <Button onClick={() => void list.refetch()}>Retry</Button>
      </div>
    ) : (
      <div className={s.note} aria-busy="true" aria-label="Loading the checklist" />
    );
  const none = rows === undefined || rows.length === 0;
  // The asked work shows whatever the checklist's read did, once there is some or its link opened the tab.
  const withAsked = !none || at === "asked";
  if (items === undefined && !withAsked) {
    return (
      <div className={s.screen} data-screen={screen}>
        {unread}
      </div>
    );
  }
  if (items?.length === 0 && none && !(at === "asked" && rows === undefined)) {
    return (
      <div className={s.screen} data-screen={screen}>
        {liveness}
        <PanelEmpty title={at === "asked" ? "Nothing asked yet" : "No plan yet"} />
      </div>
    );
  }

  return (
    <div className={s.screen} data-screen={screen}>
      {items === undefined ? null : liveness}
      <div className={s.scroll}>
        {items === undefined ? unread : items.length === 0 ? <ListNote>No checklist yet.</ListNote> : <Summary done={progress.done} doing={progress.doing} total={progress.total} />}
        {groupItems(items ?? [])
          .filter((g) => g.items.length > 0)
          .map((g) => (
            <section key={g.state} aria-label={g.title}>
              {g.state === "done" ? (
                <FoldLine
                  label={g.title}
                  count={g.items.length}
                  open={doneOpen}
                  onToggle={toggleDone}
                  end={
                    <Tooltip content="Take the done ones off the list">
                      <Button variant="quiet" size="sm" aria-label="Clear done" onClick={() => remove.done(g.items)}>
                        Clear
                      </Button>
                    </Tooltip>
                  }
                />
              ) : (
                <GroupLabel label={g.title} count={g.items.length} />
              )}
              {g.state === "done" && !doneOpen ? null : <Rows group={g} project={project} onDelete={remove.one} />}
            </section>
          ))}
        {!withAsked ? null : (
          <section aria-label="Asked of other projects" ref={askedAt}>
            <GroupLabel label="Asked of other projects" count={rows?.length} />
            {rows === undefined ? (
              asked.isError ? (
                <div className={s.askedNote} role="alert">
                  <Text size="sm" tone="quiet">
                    Couldn’t read the asked work.
                  </Text>
                  <Button variant="quiet" size="sm" onClick={() => void asked.refetch()}>
                    Retry
                  </Button>
                </div>
              ) : (
                <div className={s.askedNote} aria-busy="true" aria-label="Loading the asked work" />
              )
            ) : rows.length === 0 ? (
              <ListNote>Nothing asked yet.</ListNote>
            ) : (
              <AskedRows rows={rows} now={now} />
            )}
            {asked.data?.truncated === true && rows !== undefined ? <ListNote>{`The newest ${String(rows.length)}.`}</ListNote> : null}
          </section>
        )}
      </div>
    </div>
  );
}

/** How far along it is: a thin meter and its figures on one line. */
function Summary({ done, doing, total }: { done: number; doing: number; total: number }) {
  const pct = (n: number) => `${String(total === 0 ? 0 : (n / total) * 100)}%`;
  return (
    <div className={s.summary}>
      <div className={s.meter} role="progressbar" aria-label="Checklist progress" aria-valuemin={0} aria-valuemax={total} aria-valuenow={done} aria-valuetext={`${String(done)} of ${String(total)} done`}>
        <span className={s.meterDone} style={{ width: pct(done) }} />
        <span className={s.meterDoing} style={{ width: pct(doing) }} />
      </div>
      <Text size="xs" tone="quiet" tabular>
        {done} of {total} done
      </Text>
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
