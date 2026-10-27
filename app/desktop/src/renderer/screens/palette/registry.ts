// The command registry: everything the palette lists and every shortcut runs. Each screen adds its own from its own
// folder. Two ways in:
//
// - Commands: actions with a stable id. When the id is a ShortcutId (shared/shortcuts.ts), its key runs it and the
//   palette shows the key. Register while the screen that handles it is mounted (useCommands), so "Attach a file" only
//   exists while a chat composer is on screen; when no registered command has an id, its key does nothing and falls through.
//   Each id has one definition. If two mounted copies of a screen register it, the later wins until it unmounts.
// - Sources: data the palette searches (projects, machines, prompts). `items` is read only while the
//   palette is open, so a large list costs nothing the rest of the time.

import { useEffect, useRef } from "react";
import type { ShortcutId } from "../../../shared/shortcuts";

/**
 * Listed in this order when nothing is typed; also the tie-break when two items score the same. Projects first:
 * opening a lead's chat is what the palette is mostly for.
 */
export const GROUPS = ["projects", "go-to", "actions", "prs", "machines", "settings", "prompts"] as const;
export type Group = (typeof GROUPS)[number];

export const GROUP_LABELS: Readonly<Record<Group, string>> = {
  actions: "Actions",
  "go-to": "Go to",
  projects: "Projects",
  prs: "Pull requests",
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
  /** Shown only once something is typed: long lists such as prompts. */
  readonly searchOnly?: boolean;
  /** Read when the palette opens and when the key is pressed; false hides it and lets the key fall through. */
  readonly enabled?: () => boolean;
  readonly run: () => void;
  /** More things to do with this item, after `run`: the palette lists them on ⌘K, as Raycast does. */
  readonly actions?: readonly Action[];
}

export interface Action {
  /** A verb first, short: "Open in Settings", "Copy link". */
  readonly title: string;
  readonly run: () => void;
}

export interface Source {
  readonly id: string;
  /** Called when the palette opens, and again after `subscribe` reports a change while it is open. */
  readonly items: () => readonly Command[];
  readonly subscribe?: (onChange: () => void) => () => void;
}

type Listener = () => void;

// Stacks, top last, in registration order: an unmount restores the one below.
const commands = new Map<string, Command[]>();
const sources = new Map<string, Source>();
const listeners = new Set<Listener>();

const changed = () => {
  for (const listener of listeners) listener();
};

export const subscribeRegistry = (listener: Listener): (() => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};

export const registerCommands = (list: readonly Command[]): (() => void) => {
  // Copies, so the same object registered twice still unregisters once each.
  const entries = list.map((command): Command => ({ ...command }));
  for (const entry of entries) commands.set(entry.id, [...(commands.get(entry.id) ?? []), entry]);
  changed();
  return () => {
    for (const entry of entries) {
      const stack = commands.get(entry.id)?.filter((c) => c !== entry) ?? [];
      if (stack.length === 0) commands.delete(entry.id);
      else commands.set(entry.id, stack);
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


/** Calls `onChange` when any registered source reports new data. */
export const subscribeSources = (onChange: () => void): (() => void) => {
  const offs = [...sources.values()].flatMap((source) => (source.subscribe ? [source.subscribe(onChange)] : []));
  return () => {
    for (const off of offs) off();
  };
};

/**
 * Stable registrations for useCommands: each runs (its actions too), and is enabled by, the latest closure with its id. An id gone
 * from the latest list is disabled.
 */
export const bindLatest = (latest: { readonly current: readonly Command[] }): Command[] => {
  const current = (id: string) => latest.current.find((c) => c.id === id);
  return latest.current.map(
    (command): Command => ({
      ...command,
      enabled: () => {
        const now = current(command.id);
        return now !== undefined && (now.enabled?.() ?? true);
      },
      run: () => current(command.id)?.run(),
      ...(command.actions === undefined
        ? {}
        : { actions: command.actions.map((action, i): Action => ({ title: action.title, run: () => current(command.id)?.actions?.[i]?.run() })) }),
    }),
  );
};

/**
 * Registers commands while the calling component is mounted. Pass a fresh array each render if you like: the
 * registered ids and titles change when `deps` do, and `run`/`enabled` always call the latest closure with the
 * same id. An id missing from the latest list counts as disabled, so its key falls through.
 */
export const useCommands = (list: readonly Command[], deps: readonly unknown[]): void => {
  const latest = useRef(list);
  useEffect(() => {
    latest.current = list;
  });
  useEffect(() => {
    return registerCommands(bindLatest(latest));
    // The caller's deps decide when ids and titles change; closures are read through `latest`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
};

/** Registers a source (none: nothing) while the calling component is mounted. Keep `source` stable (module scope or useMemo). */
export const useSource = (source: Source | null): void => {
  useEffect(() => (source === null ? undefined : registerSource(source)), [source]);
};
