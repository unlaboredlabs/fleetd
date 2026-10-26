// The PR list past its first page: pr_list hands a nextCursor with each page that has more after it, and Load more
// reads the next. The first page is the query the hub's events refetch; the older ones are kept beside it until the
// project changes.
import { useCallback, useState } from "react";
import type { PrListOutput, PrRow, ProjectRef } from "../../../shared/contracts";
import type { DataLayer } from "../../src/data/queries";
import { useDataLayer } from "../../src/data/react";

export interface Older {
  readonly rows: readonly PrRow[];
  /** Where the last page read ended; undefined before Load more, or once the last page is in. */
  readonly cursor?: string;
  /** Load more was pressed at least once, so `cursor` says whether there is more. */
  readonly read: boolean;
  readonly loading: boolean;
  readonly error?: string;
}

export const noOlder: Older = { rows: [], read: false, loading: false };

const keyOf = (r: Pick<PrRow, "repo" | "number">) => `${r.repo.toLowerCase()}#${r.number}`;

/** The first page, then the older rows not already on it: a PR moves up when it changes, and the first page's copy is the freshest. */
export const withOlder = (first: readonly PrRow[], older: readonly PrRow[]): readonly PrRow[] => {
  if (older.length === 0) return first;
  const seen = new Set(first.map(keyOf));
  return [...first, ...older.filter((r) => !seen.has(keyOf(r)))];
};

/** Where the next page starts, or undefined when the list is all in. */
export const nextCursor = (first: Pick<PrListOutput, "nextCursor">, older: Older): string | undefined =>
  older.read ? older.cursor : first.nextCursor;

/** Reads the page after `cursor` and adds it to `older`. */
export async function loadOlder(layer: Pick<DataLayer, "call">, projectRef: ProjectRef, cursor: string, older: Older): Promise<Older> {
  const o = await layer.call("pr_list", { projectRef, cursor });
  if (!o.ok) return { ...older, loading: false, error: o.error.message };
  return { rows: [...older.rows, ...o.output.prs], read: true, loading: false, ...(o.output.nextCursor === undefined ? {} : { cursor: o.output.nextCursor }) };
}

/** The older pages of `project`'s list and Load more; `more` is undefined when there is nothing past what is shown. */
export function useOlderPrs(project: ProjectRef, first: PrListOutput | undefined) {
  const layer = useDataLayer();
  const { machineId, projectId } = project;
  const key = `${machineId}/${projectId}`;
  // Kept with the project they were read for: another project's start with none.
  const [held, setHeld] = useState<{ readonly key: string; readonly older: Older }>({ key, older: noOlder });
  const older = held.key === key ? held.older : noOlder;
  const cursor = first === undefined ? undefined : nextCursor(first, older);
  const more = useCallback(() => {
    if (cursor === undefined) return;
    setHeld({ key, older: { ...older, loading: true } });
    void loadOlder(layer, { machineId, projectId }, cursor, older).then((next) => setHeld((h) => (h.key === key ? { key, older: next } : h)));
  }, [cursor, key, layer, machineId, projectId, older]);
  return { rows: first === undefined ? undefined : withOlder(first.prs, older.rows), more: cursor === undefined ? undefined : more, older };
}
