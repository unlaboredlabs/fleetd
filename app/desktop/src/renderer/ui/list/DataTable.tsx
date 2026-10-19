import type { KeyboardEvent, ReactNode } from "react";
import { cx } from "../lib/cx";
import { Text, type TextStyleProps } from "../text/Text";
import { Truncate } from "../text/Truncate";
import { VirtualList } from "./VirtualList";
import s from "./DataTable.module.css";

export interface Column<T> {
  key: string;
  header: string;
  /** A CSS grid track: "minmax(0, 2fr)", "120px", "auto". Default: an equal share that can shrink. */
  width?: string;
  align?: "start" | "end";
  /** Plain text for the cell; shown wrapped (default) or truncated with a tooltip, per `mode`. */
  text?: (row: T) => string;
  mode?: "wrap" | "truncate";
  style?: TextStyleProps;
  /** A custom cell, when it is more than text. Keep its text in <Text> or <Truncate>. */
  cell?: (row: T) => ReactNode;
}

export interface DataTableProps<T> {
  columns: ReadonlyArray<Column<T>>;
  rows: ReadonlyArray<T>;
  getKey: (row: T) => string;
  onRowClick?: (row: T) => void;
  selectedKey?: string | null;
  /** What to say when there are no rows. */
  empty?: ReactNode;
  /** Render only the visible rows (long tables); the table then fills its parent's height. */
  virtual?: boolean;
  "aria-label": string;
  className?: string;
}

/**
 * A table whose rows grow to their tallest cell: text wraps by default, single-line columns truncate with a
 * tooltip. Columns line up because every row shares one grid template.
 */
export function DataTable<T>(props: DataTableProps<T>) {
  const { columns, onRowClick } = props;
  const template = columns.map((c) => c.width ?? "minmax(0, 1fr)").join(" ");

  const renderRow = (row: T) => {
    const key = props.getKey(row);
    const selected = props.selectedKey === key;
    const open = onRowClick ? () => onRowClick(row) : undefined;
    return (
      <div
        key={key}
        role="row"
        className={cx(s.row, open && s.clickable)}
        style={{ gridTemplateColumns: template }}
        aria-selected={props.selectedKey !== undefined ? selected : undefined}
        {...(open
          ? {
              tabIndex: 0,
              onClick: open,
              onKeyDown: (e: KeyboardEvent) => {
                if (e.key === "Enter") open();
              },
            }
          : {})}
      >
        {columns.map((c) => (
          <div key={c.key} role="cell" className={cx(s.cell, c.align === "end" && s.end)}>
            {c.cell ? (
              c.cell(row)
            ) : c.text ? (
              c.mode === "truncate" ? (
                <Truncate expand={open ? "none" : "popover"} {...c.style}>
                  {c.text(row)}
                </Truncate>
              ) : (
                <Text as="div" {...c.style}>
                  {c.text(row)}
                </Text>
              )
            ) : null}
          </div>
        ))}
      </div>
    );
  };

  const header = (
    <div role="row" className={cx(s.row, s.head)} style={{ gridTemplateColumns: template }}>
      {columns.map((c) => (
        <div key={c.key} role="columnheader" className={cx(s.cell, c.align === "end" && s.end)}>
          <Truncate size="xs" tone="quiet" expand="none">
            {c.header}
          </Truncate>
        </div>
      ))}
    </div>
  );

  return (
    <div
      role="table"
      aria-label={props["aria-label"]}
      className={cx(s.table, props.className)}
      style={props.virtual ? { display: "flex", flexDirection: "column", height: "100%" } : undefined}
    >
      {header}
      {props.rows.length === 0 ? (
        <div className={s.empty}>
          <Text tone="quiet">{props.empty ?? "Nothing here yet."}</Text>
        </div>
      ) : props.virtual ? (
        <div style={{ flex: 1, minHeight: 0 }}>
          <VirtualList items={props.rows} getKey={props.getKey} renderItem={renderRow} estimateSize={29} />
        </div>
      ) : (
        <div role="rowgroup">{props.rows.map(renderRow)}</div>
      )}
    </div>
  );
}
