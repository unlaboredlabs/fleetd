// What React renders, by component name, read the way React DevTools' profiler reads it: from the DevTools hook,
// which React calls after every commit. Import this before anything that loads react-dom, so the renderer finds the
// hook as it starts.
//
// A component rendered in a commit if it mounted or did work (React's PerformedWork flag); a subtree whose child
// list React kept as it was rendered nothing, and the walk skips it.

interface Fiber {
  readonly tag: number;
  readonly type: unknown;
  readonly flags: number;
  readonly alternate: Fiber | null;
  readonly child: Fiber | null;
  readonly sibling: Fiber | null;
}

const PERFORMED_WORK = 1;
/** Function, class, forwardRef, memo and simple memo components: the fibers that run a render. */
const COMPONENTS = new Set([0, 1, 11, 14, 15]);

const nameOf = (type: unknown): string => {
  if (typeof type === "function") return (type as { displayName?: string }).displayName ?? type.name;
  if (typeof type === "object" && type !== null) {
    const t = type as { displayName?: string; type?: unknown; render?: unknown };
    return t.displayName ?? nameOf(t.type ?? t.render);
  }
  return "";
};

const counts = new Map<string, number>();
let commits = 0;

const walk = (first: Fiber | null): void => {
  const stack = [first];
  while (stack.length > 0) {
    for (let f = stack.pop() ?? null; f !== null; f = f.sibling) {
      if (COMPONENTS.has(f.tag) && (f.alternate === null || (f.flags & PERFORMED_WORK) !== 0)) {
        const name = nameOf(f.type) || "anonymous";
        counts.set(name, (counts.get(name) ?? 0) + 1);
      }
      if (f.child !== null && (f.alternate === null || f.child !== f.alternate.child)) stack.push(f.child);
    }
  }
};

let ids = 0;
(globalThis as { __REACT_DEVTOOLS_GLOBAL_HOOK__?: unknown }).__REACT_DEVTOOLS_GLOBAL_HOOK__ = {
  supportsFiber: true,
  renderers: new Map(),
  inject: () => ++ids,
  checkDCE: () => undefined,
  onScheduleFiberRoot: () => undefined,
  onCommitFiberUnmount: () => undefined,
  onPostCommitFiberRoot: () => undefined,
  onCommitFiberRoot: (_id: number, root: { current: Fiber }) => {
    commits += 1;
    walk(root.current.child);
  },
};

/** Counts from here on: each component's renders, and the commits. */
export const renders = {
  reset(): void {
    counts.clear();
    commits = 0;
  },
  /** Renders per component name since the last reset. */
  get counts(): ReadonlyMap<string, number> {
    return counts;
  },
  get commits(): number {
    return commits;
  },
};
