// `workspace_usage`: Settings › Workspace › Usage, for the workspace's owners and admins only (anyone else is refused,
// as Workspace's other pages are). It folds what is new first, so the answer counts what just happened; the loop
// (loops.ts) keeps the rest folded, so that is little.
import type { Database } from "bun:sqlite";
import { ToolError } from "../../shared/errors.ts";
import type { Hub } from "../api/hub.ts";
import type { Registry } from "../api/registry.ts";
import { zone } from "../metrics/zone.ts";
import { administrator } from "../people/tools.ts";
import { people } from "../people/store.ts";
import { fold } from "./fold.ts";
import { read } from "./read.ts";

/** Each bot's name by "<machine>/<project>", as the projects list reads it. */
export function botNames(c: Database): Map<string, string> {
  const rows = c
    .query<{ m: string; p: string; title: string | null }, []>(
      "SELECT machine_id AS m, project_id AS p, json_extract(data, '$.title') AS title FROM projects",
    )
    .all();
  return new Map(rows.map((r) => [`${r.m}/${r.p}`, r.title ?? r.p]));
}

export function register(tools: Registry): void {
  tools.add("workspace_usage", async (hub: Hub, caller, input) => {
    if (administrator(hub, caller) === undefined) {
      throw new ToolError(
        "forbidden",
        "Usage is for the workspace's owners and admins.",
        "Ask an owner or admin of the workspace: it is on the Workspace pages of the app's Settings.",
      );
    }
    // Whatever the loop hasn't folded yet (a year of history, the first time), a batch at a time between other work.
    while (hub.db.transaction((c) => fold(c))) await Bun.sleep(0);
    return read(<T>(sql: string, params: (string | number)[]) => hub.db.read<T>(sql, params), {
      now: hub.clock.now(),
      tz: zone(input.tz),
      days: input.days,
      people: people(hub).list(true),
      bots: botNames(hub.db.conn),
    });
  });
}
