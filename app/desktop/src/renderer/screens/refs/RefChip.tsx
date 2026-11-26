// One of fleetd's ids in words a person reads (shared/refs: "T5945 finished W890"), as a chip with the thing's name as
// the workspace has it now: an agent's or an order's title, live, and opening it (the agent's work; the order's agents
// under its title), a decision opening the bot's decisions. One whose name can't be known (gone, unreadable now, or a
// kind with no name) says its plain word ("an agent"). The id is only in its tooltip and its right-click menu.
import type { ReactElement } from "react";
import type { OrderCard } from "../../../shared/contracts";
import { useData, useHasData, useToolQuery } from "../../src/data/react";
import { ContextMenu, ContextMenuCopy, ContextMenuItem, ContextMenuSeparator, cx, Tooltip, type RenderRef } from "../../ui";
import { REF_NOUN, refWord, type Ref } from "../../../shared/refs";
import { useRoute } from "../shell/navigation";
import { panelRoute, toHash, type PanelView, type ProjectKey } from "../shell/routes";
import s from "./refs.module.css";

interface Named {
  /** Its title; undefined while it is read, or when it can't be. */
  readonly title?: string | undefined;
  /** Its project, where it opens. */
  readonly project?: ProjectKey | undefined;
}

const NO_TASK = { taskId: "" };
const NO_ORDER = { workstreamId: "" };

/** Whether a row or lane is the agent `id` (a task id, which is also its lane's id). */
const isAgent = (id: string) => (a: { readonly taskId?: string | undefined; readonly laneId: string }) => a.taskId === id || a.laneId === id;

/** The open order whose card lists the agent, if one does. */
const cardOf = (orders: Readonly<Record<string, OrderCard>>, id: string): OrderCard | undefined => Object.values(orders).find((c) => c.lanes.some(isAgent(id)));

/** An agent's or an order's title and project, live: the store's while it is at work, else the hub's read of it. */
function useNamed(r: Ref): Named {
  const agent = r.kind === "agent";
  const order = r.kind === "order";
  const row = useData((d) => (agent ? d.agents?.find(isAgent(r.id)) : undefined));
  // An agent at work is on its order's card too, whether or not the agents list was read.
  const working = useData((d) => (agent && d.orders !== undefined ? cardOf(d.orders, r.id) : undefined));
  const lane = working?.lanes.find(isAgent(r.id));
  const card = useData((d) => (order ? d.orders?.[r.id] : undefined));
  const boardRead = useData((d) => d.orders !== undefined);
  const task = useToolQuery("task_get", agent ? { taskId: r.id } : NO_TASK, { enabled: agent && row === undefined && lane === undefined });
  const opened = useToolQuery("order_get", order ? { workstreamId: r.id } : NO_ORDER, { enabled: order && boardRead && card === undefined });
  if (row !== undefined) return { title: row.title, project: row.projectRef };
  if (lane !== undefined && working !== undefined) return { title: lane.title, project: working.projectRef };
  if (card !== undefined) return { title: card.title, project: card.projectRef };
  const t = task.data?.task;
  if (agent && t !== undefined) return { title: t.title, project: t.projectRef };
  const o = opened.data?.order;
  if (order && o !== undefined) return { title: o.title, project: o.projectRef };
  return {};
}

/** Where it opens in its project, if it opens anywhere. */
const viewOf = (r: Ref): PanelView | undefined => {
  switch (r.kind) {
    case "agent":
      return { tab: "agents", agent: r.id };
    case "order":
      return { tab: "agents", agent: null };
    case "decision":
      return { tab: "decisions" };
    default:
      return undefined;
  }
};

export interface RefChipProps {
  readonly of: Ref;
  /** Inside a clickable row or a one-line slot: it only names the thing; the row keeps the click, the menu and the tooltip. */
  readonly inRow?: boolean;
  /** Its title as the text around it already says it (a DM's sender): shown until the live one is read. */
  readonly title?: string | undefined;
  /** Where it opens when its own project isn't known (a decision, a gone agent): the screen's. */
  readonly project?: ProjectKey | undefined;
}

export function RefChip(props: RefChipProps) {
  return useHasData() ? <LiveChip {...props} /> : <Chip {...props} named={{}} />;
}

function LiveChip(props: RefChipProps) {
  return <Chip {...props} named={useNamed(props.of)} />;
}

function Chip({ of: r, inRow = false, title, project, named }: RefChipProps & { named: Named }) {
  const route = useRoute();
  const name = named.title ?? title;
  const where = named.project ?? project ?? (route.id === "project" ? route.project : undefined);
  const view = viewOf(r);
  // A gone agent's or order's view has nothing on it: the chip only names it then.
  const opens = view !== undefined && where !== undefined && (name !== undefined || r.kind === "decision");
  const href = opens ? toHash(panelRoute(where, view)) : undefined;
  const label = name ?? refWord(r);
  const className = cx(s.chip, name === undefined && s.word);
  const tip = `${REF_NOUN[r.kind]} ${r.id}`;
  // In a row, or a cut line's slot, whose own tooltip and copy hold the words as written.
  if (inRow) {
    return (
      <span className={s.inRow} data-ref={r.id}>
        {label}
      </span>
    );
  }
  return (
    <IdMenu id={r.id} href={href}>
      <Tooltip content={tip}>
        {href === undefined ? (
          <span className={className} data-ref={r.id} tabIndex={0}>
            {label}
          </span>
        ) : (
          <a className={className} href={href} data-ref={r.id}>
            {label}
          </a>
        )}
      </Tooltip>
    </IdMenu>
  );
}

/** Its right-click menu: Open, when it opens, and Copy id. */
function IdMenu({ id, href, children }: { id: string; href?: string | undefined; children: ReactElement }) {
  return (
    <ContextMenu
      menu={() => (
        <>
          {href === undefined ? null : (
            <>
              <ContextMenuItem onSelect={() => (window.location.hash = href)}>Open</ContextMenuItem>
              <ContextMenuSeparator />
            </>
          )}
          <ContextMenuCopy text={id}>Copy id</ContextMenuCopy>
        </>
      )}
    >
      {children}
    </ContextMenu>
  );
}

/** The app's RenderRef (ui RefsContext): every id in words a person reads, as its chip. */
export const renderRef: RenderRef = (r, inRow) => <RefChip of={r} inRow={inRow} />;
