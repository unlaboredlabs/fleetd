// The command registry: everything the palette lists and every shortcut runs. Each screen adds its own from its own
// folder. Two ways in:
//
// - Commands: actions with a stable id. When the id is a ShortcutId (shared/shortcuts.ts), its key runs it and the
//   palette shows the key. Register while the screen that handles it is mounted (useCommands), so "Stop order" only
//   exists on the order view; when no registered command has an id, its key does nothing and falls through.
//   The same id registered again (a nested screen) overrides it until that one unmounts.
// - Sources: data the palette searches (orders, projects, machines, prompts). `items` is read only while the
//   palette is open, so a large list costs nothing the rest of the time.

import { useEffect, useRef } from "react";
import type { ShortcutId } from "../../../shared/shortcuts";

/** Listed in this order when nothing is typed; also the tie-break when two items score the same. */
export const GROUPS = ["needs-you", "orders", "go-to", "actions", "projects", "machines", "settings", "prompts"] as const;
export type Group = (typeof GROUPS)[number];

export const GROUP_LABELS: Readonly<Record<Group, string>> = {
  "needs-you": "Needs you",
  orders: "Orders",
  actions: "Actions",
  "go-to": "Go to",
  projects: "Projects",
  machines: "Machines",
  settings: "Settings",
  prompts: "Prompts",
};

export interface Command {
  /** Stable across renders and restarts: recents are stored by it. A ShortcutId binds the key. Data items use
   *  "<kind>:<key>", e.g. "order:W14". */
  readonly id: ShortcutId | (string & {});
  readonly title: string;
  readonly group: Group;
  /** One quiet line under the title: the project, the phase, what the action does. */
  readonly detail?: string;
  /** Extra words that should find it ("preferences" for Settings). */
  readonly keywords?: readonly string[];
  /** Shown only once something is typed: long lists (prompts) and per-item variants ("New order in api"). */
  readonly searchOnly?: boolean;
  /** Needs-you items: the ask's number in its open batch, so a typed reply ("1 go") shows what it answers. */
  readonly askNumber?: number;
  /** Read when the palette opens and when the key is pressed; false hides it and lets the key fall through. */
  readonly enabled?: () => boolean;
  readonly run: () => void;
}

export interface Source {
  readonly id: string;
  /** Called when the palette opens, and again after `subscribe` reports a change while it is open. */
  readonly items: () => readonly Command[];
  readonly subscribe?: (onChange: () => void) => () => void;
}

/** What the palette offers for typed text that is not a reply, as its last row ("New order: <text>"). */
export interface TextAction {
  readonly title: (text: string) => string;
  readonly run: (text: string) => void;
}

type Listener = () => void;

// Stacks, so a later registration of the same id wins and an unmount restores the one below it.
const commands = new Map<string, Command[]>();
const sources = new Map<string, Source>();
const textActions: TextAction[] = [];
const listeners = new Set<Listener>();
let version = 0;

const changed = () => {
  version += 1;
  for (const listener of listeners) listener();
};

export const subscribeRegistry = (listener: Listener): (() => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};

/** Bumps on every registration change; for useSyncExternalStore. */
export const registryVersion = (): number => version;

export const registerCommands = (list: readonly Command[]): (() => void) => {
  for (const command of list) {
    const stack = commands.get(command.id);
    if (stack) stack.push(command);
    else commands.set(command.id, [command]);
  }
  changed();
  return () => {
    for (const command of list) {
      const stack = commands.get(command.id);
      if (!stack) continue;
      const at = stack.lastIndexOf(command);
      if (at >= 0) stack.splice(at, 1);
      if (stack.length === 0) commands.delete(command.id);
    }
    changed();
  };
};

export const registerSource = (source: Source): (() => void) => {
  sources.set(source.id, source);
  changed();
  return () => {
    if (sources.get(source.id) === source) sources.delete(source.id);
    changed();
  };
};

export const registerTextAction = (action: TextAction): (() => void) => {
  textActions.push(action);
  changed();
  return () => {
    const at = textActions.lastIndexOf(action);
    if (at >= 0) textActions.splice(at, 1);
    changed();
  };
};

const isEnabled = (command: Command): boolean => command.enabled?.() ?? true;

/** The command a shortcut or a menu item runs right now, if one is registered and enabled. */
export const commandFor = (id: string): Command | undefined => {
  const top = commands.get(id)?.at(-1);
  return top && isEnabled(top) ? top : undefined;
};

/** Runs a command by id (a key press, a native menu item). False when nothing handles it. */
export const runCommand = (id: string): boolean => {
  const command = commandFor(id);
  if (!command) return false;
  command.run();
  return true;
};

/** Everything the palette can reach now: the enabled top of each command stack, then every source's items. */
export const snapshotItems = (): Command[] => {
  const out: Command[] = [];
  const seen = new Set<string>();
  for (const stack of commands.values()) {
    const top = stack.at(-1);
    if (top && isEnabled(top)) {
      out.push(top);
      seen.add(top.id);
    }
  }
  for (const source of sources.values()) {
    for (const item of source.items()) {
      if (seen.has(item.id) || !isEnabled(item)) continue;
      seen.add(item.id);
      out.push(item);
    }
  }
  return out;
};

export const currentTextAction = (): TextAction | undefined => textActions.at(-1);

/** Calls `onChange` when any registered source reports new data. */
export const subscribeSources = (onChange: () => void): (() => void) => {
  const offs = [...sources.values()].flatMap((source) => (source.subscribe ? [source.subscribe(onChange)] : []));
  return () => {
    for (const off of offs) off();
  };
};

/**
 * Registers commands while the calling component is mounted. Pass a fresh array each render if you like: the
 * registration only changes when `deps` do, and `run`/`enabled` always call the latest closures.
 */
export const useCommands = (list: readonly Command[], deps: readonly unknown[]): void => {
  const latest = useRef(list);
  useEffect(() => {
    latest.current = list;
  });
  useEffect(() => {
    const stable = latest.current.map(
      (command, index): Command => ({
        ...command,
        enabled: () => latest.current[index]?.enabled?.() ?? true,
        run: () => latest.current[index]?.run(),
      }),
    );
    return registerCommands(stable);
    // The caller's deps decide when ids and titles change; closures are read through `latest`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
};

/** Registers a source while the calling component is mounted. Keep `source` stable (module scope or useMemo). */
export const useSource = (source: Source): void => {
  useEffect(() => registerSource(source), [source]);
};
