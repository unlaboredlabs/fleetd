// A hub for hub-work's tests: a fresh in-memory database, keys of each kind, and rows the leads area would write.
import { Hub } from "../src/hub/api/hub.ts";
import type { Caller } from "../src/hub/api/registry.ts";
import { Registry } from "../src/hub/api/registry.ts";
import { registerAll } from "../src/hub/serve/areas.ts";
import { HubDb } from "../src/hub/store/db.ts";
import { store } from "../src/hub/store/hub_store.ts";
import type { PersonRef, ProjectRef, ProjectSummary, Role, Workstream } from "../src/shared/contracts.ts";

export const AT = "2026-10-17T10:00:00.000Z";

export function kit(now = Date.parse(AT)) {
  const clock = { ms: now, now: () => clock.ms };
  const hub = new Hub({ home: "", listen: { host: "127.0.0.1", port: 0 } }, HubDb.memory(), clock);
  const tools = new Registry();
  registerAll(tools);
  const call = async (caller: Caller, tool: string, input: unknown) => tools.call(hub, caller, tool, input);
  /** The output, or throws with the refusal. */
  const ok = async <T = Record<string, any>>(caller: Caller, tool: string, input: unknown): Promise<T> => {
    const result = await call(caller, tool, input);
    if ("error" in result) throw new Error(`${tool}: ${JSON.stringify(result.error)}`);
    return result.output as T;
  };
  /** The refusal's code. */
  const refused = async (caller: Caller, tool: string, input: unknown): Promise<string> => {
    const result = await call(caller, tool, input);
    if (!("error" in result)) throw new Error(`${tool} answered ${JSON.stringify(result.output)}`);
    return result.error.kind === "tool" ? result.error.error.code : result.error.kind;
  };
  return { hub, clock, tools, call, ok, refused };
}

export function key(role: Role, opts: { human?: boolean; machines?: "*" | string[]; person?: PersonRef; name?: string } = {}): Caller {
  return {
    keyId: `key_${opts.name ?? role}`,
    name: opts.name ?? (opts.human ? "desk" : "agent"),
    prefix: "fld_abcdef",
    grants: [{ role, machines: opts.machines ?? "*" }],
    createdAt: AT,
    ...(opts.human ? { kind: "human" as const } : {}),
    ...(opts.person ? { person: opts.person } : {}),
  };
}

export function project(hub: Hub, r: ProjectRef, extra: Partial<ProjectSummary> = {}): ProjectSummary {
  const summary: ProjectSummary = {
    machineId: r.machineId,
    projectId: r.projectId,
    title: extra.title ?? r.projectId,
    workspaceRoot: `/home/me/${r.projectId}`,
    threads: { running: 0, idle: 0, failed: 0 } as ProjectSummary["threads"],
    lastActivityAt: AT,
    ...extra,
  };
  store(hub).projectsUpsertMany(r.machineId, [summary]);
  return summary;
}

/** A workstream row as the leads area writes one. */
export function workstream(hub: Hub, r: ProjectRef, title: string, state: "open" | "done" | "stopped" = "open"): Workstream {
  const row = hub.db.conn
    .query<{ n: number }, [string, string, string]>(
      "INSERT INTO workstreams (machine_id, project_id, state, data) VALUES (?, ?, ?, '{}') RETURNING n",
    )
    .get(r.machineId, r.projectId, state);
  const w = {
    workstreamId: `W${row?.n}`,
    projectRef: r,
    title,
    source: { channel: "app", by: "human" },
    state,
    createdAt: AT,
    updatedAt: AT,
  } as unknown as Workstream;
  hub.db.conn.query("UPDATE workstreams SET data = ? WHERE n = ?").run(JSON.stringify(w), row?.n ?? 0);
  return w;
}
