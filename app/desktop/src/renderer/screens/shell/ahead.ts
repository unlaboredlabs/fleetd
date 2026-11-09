// A list the hub keeps for you, changed here (your pins, pins.ts; your sections, sections.ts): the sidebar takes your
// change at once, the hub gets the whole list, one set at a time, and a refusal puts the hub's back and says why. The
// last list read is kept on this computer too, per hub, only so a launch shows it before the hub answers.
import type { QueryKey } from "@tanstack/react-query";
import { useCallback, useSyncExternalStore } from "react";
import type { DataLayer } from "../../src/data/queries";
import { toast } from "../../ui";

/**
 * Your changes on one hub not yet answered by a read of the list: what the sidebar shows meanwhile. `want` is the
 * newest; `sending` while a set is on its way, one at a time, so the hub takes them in the order you made them; `mark`
 * the layer's read mark (DataLayer.readsStarted) when the last one landed: a read numbered above it includes it, so
 * only that may take over. Until then an older read (the refetch your own earlier change's event made) never puts a
 * row back.
 */
interface Saving<T> {
  readonly want: T;
  readonly sending: boolean;
  readonly mark: number | undefined;
}

export interface Ahead<T> {
  /** Your newest change on `layer`'s hub while the read numbered `readNo` is from before it; undefined otherwise. */
  readonly useAhead: (layer: DataLayer, readNo: number | undefined) => T | undefined;
  /**
   * Saves `value` on `layer`'s hub. The sidebar takes it at once. Changes made while one is on its way go after it,
   * only the newest of them; a refusal puts the hub's list back and says why.
   */
  readonly save: (layer: DataLayer, value: T) => Promise<void>;
}

export const ahead = <T>(o: {
  /** Sends the list to the hub: undefined once the hub took it, else why it didn't, in words for the person. */
  readonly send: (layer: DataLayer, value: T) => Promise<string | undefined>;
  /** The list's read, asked again after a refusal. */
  readonly read: QueryKey;
  /** What a refusal's toast says first: "Couldn’t save your pins". */
  readonly refused: string;
}): Ahead<T> => {
  const savings = new WeakMap<DataLayer, Saving<T>>();
  const watchers = new WeakMap<DataLayer, Set<() => void>>();
  const set = (layer: DataLayer, next: Saving<T> | undefined) => {
    if (next === undefined) savings.delete(layer);
    else savings.set(layer, next);
    for (const w of watchers.get(layer) ?? []) w();
  };
  const useAhead = (layer: DataLayer, readNo: number | undefined): T | undefined => {
    const saving = useSyncExternalStore(
      useCallback(
        (onChange: () => void) => {
          const all = watchers.get(layer) ?? new Set();
          watchers.set(layer, all.add(onChange));
          return () => void all.delete(onChange);
        },
        [layer],
      ),
      () => savings.get(layer),
    );
    return saving !== undefined && (saving.mark === undefined || readNo === undefined || readNo <= saving.mark) ? saving.want : undefined;
  };
  const save = async (layer: DataLayer, value: T): Promise<void> => {
    const was = savings.get(layer);
    set(layer, { want: value, sending: was?.sending ?? false, mark: undefined });
    if (was?.sending === true) return;
    for (;;) {
      const sent = savings.get(layer)?.want ?? value;
      set(layer, { want: sent, sending: true, mark: undefined });
      const why = await o.send(layer, sent);
      if (why !== undefined) {
        set(layer, undefined);
        void layer.queryClient.invalidateQueries({ queryKey: o.read });
        toast({ title: o.refused, description: why, tone: "danger" });
        return;
      }
      const now = savings.get(layer);
      if (now === undefined || now.want === sent) {
        set(layer, { want: sent, sending: false, mark: layer.readsStarted() });
        return;
      }
    }
  };
  return { useAhead, save };
};

/** What was last read of a list, kept per hub under `name` in this computer's storage. */
export const keptPerHub = <T>(name: string, parse: (raw: unknown) => T | undefined) => ({
  read: (hub: string): T | undefined => {
    try {
      const all: unknown = JSON.parse(window.localStorage.getItem(name) ?? "{}");
      return typeof all === "object" && all !== null ? parse((all as Record<string, unknown>)[hub]) : undefined;
    } catch {
      return undefined;
    }
  },
  keep: (hub: string, value: T): void => {
    try {
      const all: unknown = JSON.parse(window.localStorage.getItem(name) ?? "{}");
      window.localStorage.setItem(name, JSON.stringify({ ...(typeof all === "object" && all !== null ? all : {}), [hub]: value }));
    } catch {
      // Without storage a launch shows none until the hub answers.
    }
  },
});
