// The merge list: one row per landed change, the table every chart's numbers can be read from without a hover.
// Sorts by any column; "Copy as table" puts the rows on the clipboard as CSV. A click on a chart's column narrows it
// to those days, until "Show all". The first hundred rows show until you ask for the rest.
import { ArrowDown, ArrowUp } from "lucide-react";
import { useState } from "react";
import type { MetricsMerge, RepoCoverage } from "../../../shared/contracts";
import { Button, Text, Truncate, copyText, cx, toast } from "../../ui";
import { stampMs } from "../time/format";
import { ROUTE_LABEL, ROUTE_SLOT, fmtMs, knownRoute, mergeName, mergesCsv, type Sort, type SortKey } from "./model";
import s from "./Factory.module.css";

/** Rows shown before "Show all": a 90-day range can hold hundreds. */
export const FIRST_ROWS = 100;

const COLUMNS: readonly { key: SortKey; label: string; width: string; num?: boolean }[] = [
  { key: "date", label: "Merged", width: "11%" },
  { key: "change", label: "Change", width: "27%" },
  { key: "route", label: "Route", width: "15%" },
  { key: "order", label: "Order", width: "13%" },
  { key: "toMerged", label: "Order to merged", width: "9%", num: true },
  { key: "prOpen", label: "PR open to merged", width: "9%", num: true },
  { key: "lines", label: "Lines", width: "9%", num: true },
  { key: "touches", label: "Your acts", width: "7%", num: true },
];

export interface MergeListProps {
  readonly merges: readonly MetricsMerge[];
  /** Merges in the range; more than the list when the hub cut it. */
  readonly total: number;
  readonly coverage: readonly RepoCoverage[];
  readonly sort: Sort;
  readonly onSort: (s: Sort) => void;
  /** "Oct 12" when a chart's column narrowed the list. */
  readonly narrowed?: string | undefined;
  readonly onShowAll: () => void;
  readonly orderTitle: (workstreamId: string) => string | undefined;
  readonly orderHref: (m: MetricsMerge) => string | undefined;
}

export function MergeList({ merges, total, coverage, sort, onSort, narrowed, onShowAll, orderTitle, orderHref }: MergeListProps) {
  const [every, setEvery] = useState(false);
  const rows = every ? merges : merges.slice(0, FIRST_ROWS);
  const copy = () => {
    void copyText(mergesCsv(merges)).then((ok) =>
      toast({ title: ok ? `${merges.length} ${merges.length === 1 ? "row" : "rows"} copied as CSV` : "Couldn't copy the table", tone: ok ? "success" : "danger" }),
    );
  };
  return (
    <section className={cx(s.section)} aria-labelledby="factory-list">
      <div className={cx(s.sectionHead)}>
        <Text as="h2" strong id="factory-list">
          {narrowed === undefined ? "Every merge" : `Merges on ${narrowed}`}
        </Text>
        <Text size="xs" tone="quiet" tabular>
          {narrowed === undefined && total > merges.length ? `the latest ${merges.length} of ${total}` : `${merges.length}`}
        </Text>
        {narrowed !== undefined ? (
          <Button variant="ghost" onClick={onShowAll}>
            Show all
          </Button>
        ) : null}
        <span className={cx(s.grow)} />
        <Button variant="ghost" onClick={copy} disabled={merges.length === 0}>
          Copy as table
        </Button>
      </div>
      <div className={cx(s.tableWrap)}>
        <table className={cx(s.table)}>
          <colgroup>
            {COLUMNS.map((c) => (
              <col key={c.key} style={{ width: c.width }} />
            ))}
          </colgroup>
          <thead>
            <tr>
              {COLUMNS.map((c) => {
                const on = sort.key === c.key;
                return (
                  <th key={c.key} className={cx(c.num === true && s.num)} aria-sort={on ? (sort.desc ? "descending" : "ascending") : "none"}>
                    <button
                      type="button"
                      className={cx(s.sortButton)}
                      aria-pressed={on}
                      onClick={() => onSort({ key: c.key, desc: on ? !sort.desc : c.key === "date" })}
                    >
                      <Truncate size="xs" tone="inherit" expand="none">
                        {c.label}
                      </Truncate>
                      {on ? sort.desc ? <ArrowDown aria-hidden size={12} /> : <ArrowUp aria-hidden size={12} /> : null}
                    </button>
                  </th>
                );
              })}
            </tr>
          </thead>
          <tbody>
            {rows.map((m) => (
              <Row key={`${m.repo}#${m.prNumber ?? m.sha ?? m.mergedAt}`} m={m} coverage={coverage} orderTitle={orderTitle} orderHref={orderHref} />
            ))}
          </tbody>
        </table>
      </div>
      {rows.length < merges.length ? (
        <span>
          <Button variant="ghost" onClick={() => setEvery(true)}>
            {`Show all ${merges.length}`}
          </Button>
        </span>
      ) : null}
    </section>
  );
}

function Row({ m, coverage, orderTitle, orderHref }: { m: MetricsMerge } & Pick<MergeListProps, "coverage" | "orderTitle" | "orderHref">) {
  const route = knownRoute(m.route);
  const href = orderHref(m);
  // An order off the board (done before the last day) is named by its number.
  const order = m.workstreamId === undefined ? undefined : (orderTitle(m.workstreamId) ?? `Order ${m.workstreamId}`);
  const lines = m.additions === undefined && m.deletions === undefined ? "—" : `+${m.additions ?? 0} −${m.deletions ?? 0}`;
  return (
    <tr>
      <td>
        <Text size="xs" tone="quiet" tabular>
          {stampMs(Date.parse(m.mergedAt))}
        </Text>
      </td>
      <td>
        <span className={cx(s.cell)}>
          <Truncate size="xs" strong>
            {mergeName(m, coverage)}
          </Truncate>
          {m.title !== undefined ? <Truncate size="xs" tone="quiet">{m.title}</Truncate> : null}
        </span>
      </td>
      <td>
        <span className={cx(s.routeCell)}>
          <span className={cx(s.swatch, route === undefined ? undefined : s[`s${ROUTE_SLOT[route]}`])} aria-hidden />
          <Text size="xs">{route === undefined ? "Merged" : ROUTE_LABEL[route]}</Text>
        </span>
      </td>
      <td>
        {order === undefined ? (
          <Text size="xs" tone="quiet">
            No order
          </Text>
        ) : href !== undefined ? (
          <a href={href}>
            <Truncate size="xs" tone="accent" expand="none">
              {order}
            </Truncate>
          </a>
        ) : (
          <Truncate size="xs">{order}</Truncate>
        )}
      </td>
      <td className={cx(s.num)}>
        <Text size="xs" tabular>
          {m.orderToMergedMs === undefined ? "—" : fmtMs(m.orderToMergedMs)}
        </Text>
      </td>
      <td className={cx(s.num)}>
        <Text size="xs" tabular>
          {m.prOpenToMergedMs === undefined ? "—" : fmtMs(m.prOpenToMergedMs)}
        </Text>
      </td>
      <td className={cx(s.num)}>
        <Text size="xs" tabular>
          {lines}
        </Text>
      </td>
      <td className={cx(s.num)}>
        <Text size="xs" tabular>
          {m.touches === 0 ? "—" : m.touches}
        </Text>
      </td>
    </tr>
  );
}
