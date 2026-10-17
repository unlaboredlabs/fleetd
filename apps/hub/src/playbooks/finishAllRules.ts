// Finish-all, pure: what counts as a child's value source, the inventory's ranking and text, and the idle rule.
// FinishAll.ts gathers the inputs (claims, GitHub issues, asks, a fixed `git grep`) and applies the result.
import type { Workstream, WorkstreamId } from "@fleetd/contracts";

export const FINISH_ALL_IDLE = "finish-all: nothing left with a value source";
export const DEFAULT_MAX_CHILDREN = 5;
/** Fixed, so the count means the same in every project. */
export const TODO_GREP = ["git", "grep", "-I", "-c", "-w", "-E", "TODO|FIXME"] as const;
/** The value sources a child workstream may serve. */
export const CHILD_SOURCES = ["issue:", "defect:", "done:"] as const;

export const isFinishAll = (w: Pick<Workstream, "playbook">) => w.playbook?.startsWith("finish-all@") === true;

export interface Refusal {
  readonly message: string;
  readonly fix: string;
}

/** Why `serves` cannot start a child of `parent`; undefined when it can. `openChildren` are the parent's open children. */
export const spawnRefusal = (
  serves: string,
  parent: Workstream,
  openChildren: ReadonlyArray<Workstream>,
  maxChildren: number,
): Refusal | undefined => {
  if (!CHILD_SOURCES.some((prefix) => serves.startsWith(prefix))) {
    return {
      message: `'${serves}' is not a value source a child can serve.`,
      fix: "Pass --serves issue:<#n|url> (an open issue), defect:<one line> (a failing check or error you saw) or done:<n> (a done-when check of the finish-all workstream). Never invent work.",
    };
  }
  const done = /^done:(\d+)$/u.exec(serves);
  const checks = parent.brief?.doneWhen.length ?? 0;
  if (done !== null && Number(done[1]) >= checks) {
    return {
      message: `${parent.workstreamId} has no done-when check ${serves}.`,
      fix: checks === 0 ? "Use issue: or defect:; the finish-all workstream has no done-when checks." : `Use done:0${checks > 1 ? ` to done:${checks - 1}` : ""}, or issue: or defect:.`,
    };
  }
  const same = openChildren.find((c) => c.parent?.serves === serves);
  if (same !== undefined) return { message: `${same.workstreamId} already serves ${serves}.`, fix: "Spawn a child for another item, or wait for it." };
  if (openChildren.length >= maxChildren) {
    return {
      message: `${parent.workstreamId} already has ${openChildren.length} open children, the most finishAll.maxChildren allows (${maxChildren}).`,
      fix: "Wait for one to finish; its result arrives in a wake.",
    };
  }
  return undefined;
};

export type ItemKind = "failing_check" | "issue" | "ask" | "todo";

export interface InventoryItem {
  readonly kind: ItemKind;
  readonly text: string;
  /** Its value source; absent for asks and TODO markers. */
  readonly serves?: string;
  /** The open workstream already working on it. */
  readonly servedBy?: WorkstreamId;
}

const RANK: Record<ItemKind, number> = { failing_check: 0, issue: 1, ask: 2, todo: 3 };
const LABEL: Record<ItemKind, string> = { failing_check: "failing check", issue: "open issue", ask: "open ask", todo: "TODO markers" };

/** Failing checks first (claimed work that is broken), then open issues, oldest first, then the rest. Stable. */
export const rankItems = (items: ReadonlyArray<InventoryItem>): ReadonlyArray<InventoryItem> =>
  items.map((item, i) => ({ item, i })).sort((a, b) => RANK[a.item.kind] - RANK[b.item.kind] || a.i - b.i).map((x) => x.item);

export const isSpawnable = (item: InventoryItem) => item.serves !== undefined && item.servedBy === undefined;

/** `owner/name` of a GitHub remote URL (https or ssh), lowercased; undefined for any other remote. */
export const githubRepoOf = (remote: string): string | undefined => {
  const m = /github\.com[/:]([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?\/?$/u.exec(remote.trim());
  return m === null ? undefined : `${m[1]}/${m[2]}`.toLowerCase();
};

/**
 * The TODO/FIXME count from `git grep -c` output (`path:count` per line). The node keeps only the output's tail, so a
 * long listing may have lost its first lines; then the count is a lower bound.
 */
export const todoCount = (output: string, truncated: boolean): { readonly count: number; readonly atLeast: boolean } => {
  const counts = output.split("\n").flatMap((line) => {
    const m = /:(\d+)$/u.exec(line.trim());
    return m === null ? [] : [Number(m[1])];
  });
  return { count: counts.reduce((a, b) => a + b, 0), atLeast: truncated };
};

export interface InventoryInput {
  readonly project: string;
  readonly parent?: { readonly workstreamId: WorkstreamId; readonly openChildren: number; readonly maxChildren: number };
  readonly items: ReadonlyArray<InventoryItem>;
  /** Sources that could not be read, with why; while any is unread, nothing can be called finished. */
  readonly unread: ReadonlyArray<string>;
}

/** The finish-all workstream goes idle when it has no open child and nothing it could start, as far as can be read. */
export const shouldIdle = (input: InventoryInput) =>
  input.parent !== undefined && input.parent.openChildren === 0 && input.unread.length === 0 && !input.items.some(isSpawnable);

export const renderInventory = (input: InventoryInput): string => {
  const ranked = rankItems(input.items);
  const sourced = ranked.filter((i) => i.serves !== undefined);
  const others = ranked.filter((i) => i.serves === undefined);
  const head = input.parent === undefined
    ? `Inventory of ${input.project}, ranked (no open finish-all workstream):`
    : `Inventory of ${input.project}, ranked; finish-all ${input.parent.workstreamId} has ${input.parent.openChildren} of at most ${input.parent.maxChildren} open children:`;
  const lines = [head];
  if (sourced.length === 0) lines.push("Nothing with a value source.");
  sourced.forEach((item, n) => {
    lines.push(`${n + 1}. ${item.serves} — ${item.text} [${LABEL[item.kind]}]${item.servedBy === undefined ? "" : ` (in progress: ${item.servedBy})`}`);
  });
  if (others.length > 0) {
    lines.push("Without a value source (never a child):");
    for (const item of others) lines.push(`- ${item.text}`);
  }
  for (const why of input.unread) lines.push(`Could not read ${why}`);
  if (shouldIdle(input)) lines.push(`${FINISH_ALL_IDLE}; ${input.parent!.workstreamId} is idle.`);
  return lines.join("\n");
};
