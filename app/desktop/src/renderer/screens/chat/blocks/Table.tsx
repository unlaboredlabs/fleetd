// A table block, and the chart's data as one: plain-text cells, numbers right-aligned in tabular figures, scrolling
// sideways inside the bubble when it is wider than the column.
import type { TableBlock } from "../../../../shared/contracts";
import { Text } from "../../../ui";
import b from "./blocks.module.css";

const NUMBER = /^[−-]?[\d.,]+\s?(%|[a-zA-Z]{0,3})$/u;

export function DataTable({ columns, rows }: { columns: readonly string[]; rows: readonly (readonly string[])[] }) {
  const numeric = columns.map((_, c) => rows.length > 0 && rows.every((r) => NUMBER.test((r[c] ?? "").trim()) || (r[c] ?? "") === ""));
  return (
    <div className={b.tableScroll}>
      <table className={b.table}>
        <thead>
          <tr>
            {columns.map((c, i) => (
              <th key={i} className={numeric[i] === true ? b.num : undefined}>
                {c}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i}>
              {columns.map((_, c) => (
                <td key={c} className={numeric[c] === true ? b.num : undefined}>
                  {r[c] ?? ""}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function Table({ table }: { table: TableBlock }) {
  return (
    <div className={b.card}>
      {table.title !== undefined ? (
        <div className={b.head}>
          <Text size="sm" strong>
            {table.title}
          </Text>
        </div>
      ) : null}
      <DataTable columns={table.columns} rows={table.rows} />
    </div>
  );
}
