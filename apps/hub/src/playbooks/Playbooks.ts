// The playbooks a workstream can follow: fleetd's bundled ones with the user's overrides in `<hub home>/playbooks/`,
// read at start and again when the retro writes an override. A workstream pins `name@sha` at creation and the pinned text is kept, so a later edit of the
// file never changes the rules of a workstream already under way.
import fs from "node:fs";
import path from "node:path";
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
    /** The text of `<overrides>/<name>.md`; undefined when the bundled playbook is in use. */
    readonly override: (name: PlaybookName) => Effect.Effect<string | undefined>;
    /**
     * M12: writes `<overrides>/<name>.md` (undefined removes it, back to the bundled one) and makes the result
     * current. A text that does not parse is refused before anything is written.
     */
    readonly setOverride: (name: PlaybookName, text: string | undefined) => Effect.Effect<LoadedPlaybook, PlaybookError>;
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
    const bundled = options.bundledDir ?? bundledDir();
    const load = () =>
      Effect.try({
        try: () => new Map(loadAll(bundled, options.overridesDir)),
        catch: (error) => (error instanceof PlaybookError ? error : new PlaybookError({ message: String(error) })),
      });
    let current = yield* load();
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

    const overrideFile = (name: PlaybookName) =>
      options.overridesDir === undefined ? undefined : path.join(options.overridesDir, `${name}.md`);

    const override: Playbooks["Service"]["override"] = (name) =>
      Effect.sync(() => {
        const file = overrideFile(name);
        if (file === undefined) return undefined;
        try {
          return fs.readFileSync(file, "utf8");
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
          throw error;
        }
      });

    const setOverride: Playbooks["Service"]["setOverride"] = (name, text) =>
      Effect.gen(function* () {
        const file = overrideFile(name);
        if (file === undefined) return yield* new PlaybookError({ message: "this hub has no playbook overrides directory" });
        if (text !== undefined) yield* Effect.try({ try: () => parsePlaybook(text, file, name), catch: (error) => error as PlaybookError });
        yield* Effect.sync(() => {
          if (text === undefined) return fs.rmSync(file, { force: true });
          fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
          fs.writeFileSync(`${file}.tmp`, text);
          fs.renameSync(`${file}.tmp`, file);
        });
        current = yield* load();
        const loaded = current.get(name)!;
        cache.set(loaded.ref, loaded);
        return loaded;
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
      override,
      setOverride,
    });
  });

/** Needs HubDb. Fails to build when a playbook file is invalid, naming the file and the problem. */
export const layer = (options: PlaybooksOptions = {}) => Layer.effect(Playbooks, make(options));
