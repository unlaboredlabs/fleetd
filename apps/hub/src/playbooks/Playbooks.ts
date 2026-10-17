// The playbooks a workstream can follow: fleetd's bundled ones with the user's overrides in `<hub home>/playbooks/`,
// read once at start. A workstream pins `name@sha` at creation and the pinned text is kept, so a later edit of the
// file never changes the rules of a workstream already under way.
import type { PlaybookName, PlaybookRef } from "@fleetd/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as HubDb from "../store/HubDb.ts";
import { bundledDir, type LoadedPlaybook, loadAll, parsePlaybook, PlaybookError } from "./load.ts";

export class Playbooks extends Context.Service<
  Playbooks,
  {
    /** The current version of `name`; new workstreams pin this one. */
    readonly current: (name: PlaybookName) => LoadedPlaybook;
    /** Records the current version of `name` as pinned and returns it. */
    readonly pin: (name: PlaybookName) => Effect.Effect<LoadedPlaybook>;
    /** A pinned version; undefined for a ref that was never pinned here. */
    readonly byRef: (ref: PlaybookRef) => Effect.Effect<LoadedPlaybook | undefined>;
  }
>()("fleetd/playbooks/Playbooks") {}

export interface PlaybooksOptions {
  /** The user's overrides, `<hub home>/playbooks`; absent means the bundled playbooks only. */
  readonly overridesDir?: string;
  /** Defaults to the bundled playbooks. */
  readonly bundledDir?: string;
}

export const make = (options: PlaybooksOptions = {}) =>
  Effect.gen(function* () {
    const { db } = yield* HubDb.HubDb;
    const current = yield* Effect.try({
      try: () => loadAll(options.bundledDir ?? bundledDir(), options.overridesDir),
      catch: (error) => (error instanceof PlaybookError ? error : new PlaybookError({ message: String(error) })),
    });
    const sql = {
      put: db.prepare("INSERT OR IGNORE INTO playbook_versions (ref, text) VALUES (?, ?)"),
      get: db.prepare("SELECT text FROM playbook_versions WHERE ref = ?"),
    };
    const cache = new Map<string, LoadedPlaybook>([...current.values()].map((p) => [p.ref, p]));

    const byRef: Playbooks["Service"]["byRef"] = (ref) =>
      Effect.suspend(() => {
        const cached = cache.get(ref);
        if (cached !== undefined) return Effect.succeed(cached);
        const row = sql.get.get(ref);
        if (row === undefined) return Effect.succeed(undefined);
        try {
          const loaded = parsePlaybook(String(row.text), ref);
          cache.set(ref, loaded);
          return Effect.succeed(loaded);
        } catch (error) {
          // Valid when pinned; only a later schema change can get here.
          return Effect.as(Effect.logWarning("pinned playbook no longer parses", { ref, error: String(error) }), undefined);
        }
      });

    return Playbooks.of({
      current: (name) => current.get(name)!,
      pin: (name) =>
        Effect.sync(() => {
          const loaded = current.get(name)!;
          sql.put.run(loaded.ref, loaded.text);
          return loaded;
        }),
      byRef,
    });
  });

/** Needs HubDb. Fails to build when a playbook file is invalid, naming the file and the problem. */
export const layer = (options: PlaybooksOptions = {}) => Layer.effect(Playbooks, make(options));
