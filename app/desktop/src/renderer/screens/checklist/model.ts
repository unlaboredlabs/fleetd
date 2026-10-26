// The checklist as the tab shows it: grouped by state (doing, then to do, then done), each group in the lead's
// order, and how far along it is. Only counts: nothing here estimates anything.
import type { TodoItem, TodoState } from "../../../shared/contracts";
import type { PrKey } from "../shell/routes";

export interface ChecklistGroup {
  readonly state: TodoState;
  readonly title: string;
  readonly items: readonly TodoItem[];
}

const GROUPS: readonly { readonly state: TodoState; readonly title: string }[] = [
  { state: "doing", title: "Doing" },
  { state: "todo", title: "To do" },
  { state: "done", title: "Done" },
];

/** Every state's group, empty ones too, so the tab can leave out the empty ones itself. */
export const groupItems = (items: readonly TodoItem[]): readonly ChecklistGroup[] =>
  GROUPS.map((g) => ({ ...g, items: items.filter((i) => i.state === g.state) }));

export interface Progress {
  readonly done: number;
  readonly doing: number;
  readonly total: number;
}

export const progressOf = (items: readonly TodoItem[]): Progress => ({
  done: items.filter((i) => i.state === "done").length,
  doing: items.filter((i) => i.state === "doing").length,
  total: items.length,
});

/** What the tab's badge says: the items still open, nothing once all are done. */
export const openItems = (items: readonly TodoItem[] | undefined): number => (items === undefined ? 0 : items.filter((i) => i.state !== "done").length);

/** A GitHub PR's url as the panel's PR route names it. */
export const prOf = (url: string): PrKey | null => {
  const m = /^https:\/\/github\.com\/([^/]+)\/([^/]+)\/pull\/([1-9][0-9]{0,9})(?:[/?#].*)?$/u.exec(url);
  return m === null ? null : { repo: `${m[1] ?? ""}/${m[2] ?? ""}`, number: Number(m[3]) };
};
