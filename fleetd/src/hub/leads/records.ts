// Leads, project settings and workstreams as stored (tables `leads`,
// `lead_mcp`, `workstreams`).
import type { Database } from "bun:sqlite";
import type { IntakeChannel, ProjectRef, Workstream, WorkstreamState } from "../../shared/contracts.ts";
import type { HubDb } from "../store/db.ts";

/** A lead as stored; its `state` (and `parked`) is derived from the lead thread when read. */
export type StoredLead = {
  projectRef: ProjectRef;
  threadId: string;
  startedAt: string;
  lastWakeAt?: string;
  sessionGeneration: number;
};

export const isClosed = (state: WorkstreamState) => state !== "open";

export type NewWorkstream = {
  projectRef: ProjectRef;
  title: string;
  text: string;
  channel: IntakeChannel;
  by: string;
  at: string;
  clientRequestId?: string;
};

export type WorkstreamFilter = { projectRef?: ProjectRef; state?: WorkstreamState; limit: number };

type LeadRow = {
  machine_id: string;
  project_id: string;
  thread_id: string;
  started_at: string;
  last_wake_at: string | null;
  session_generation: number;
};

const leadOf = (row: LeadRow): StoredLead => ({
  projectRef: { machineId: row.machine_id, projectId: row.project_id },
  threadId: row.thread_id,
  startedAt: row.started_at,
  ...(row.last_wake_at === null ? {} : { lastWakeAt: row.last_wake_at }),
  sessionGeneration: row.session_generation,
});

export const workstreamNumber = (id: string) => Number.parseInt(id.slice(1), 10) || 0;

/** The workstream in the Rust struct's field order, so rows read the same. */
export function encodeWorkstream(w: Workstream): string {
  const o: Record<string, unknown> = { workstreamId: w.workstreamId, projectRef: w.projectRef, title: w.title, source: w.source };
  if (w.brief !== undefined) o.brief = w.brief;
  o.state = w.state;
  if (w.headline !== undefined) o.headline = w.headline;
  if (w.headlineAt !== undefined) o.headlineAt = w.headlineAt;
  o.createdAt = w.createdAt;
  o.updatedAt = w.updatedAt;
  if (w.startedBy !== undefined) o.startedBy = w.startedBy;
  return JSON.stringify(o);
}

export function readWorkstream(c: Database, id: string): Workstream | undefined {
  const row = c.query<{ data: string }, [number]>("SELECT data FROM workstreams WHERE n = ?").get(workstreamNumber(id));
  return row ? (JSON.parse(row.data) as Workstream) : undefined;
}

export class LeadRecords {
  constructor(private readonly db: HubDb) {}

  leadGet(r: ProjectRef): StoredLead | undefined {
    const row = this.db.all<LeadRow>("SELECT * FROM leads WHERE machine_id = ? AND project_id = ?", [r.machineId, r.projectId])[0];
    return row ? leadOf(row) : undefined;
  }

  leadPut(lead: StoredLead): void {
    this.db.conn
      .query(
        `INSERT INTO leads (machine_id, project_id, thread_id, started_at, last_wake_at, session_generation)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT (machine_id, project_id) DO UPDATE SET thread_id = excluded.thread_id, started_at = excluded.started_at,
           last_wake_at = excluded.last_wake_at, session_generation = excluded.session_generation,
           profile = CASE WHEN leads.thread_id = excluded.thread_id THEN leads.profile END`,
      )
      .run(
        lead.projectRef.machineId,
        lead.projectRef.projectId,
        lead.threadId,
        lead.startedAt,
        lead.lastWakeAt ?? null,
        lead.sessionGeneration,
      );
  }

  /** The profile the project's current lead session started on; undefined for one started before fleetd kept it. */
  leadProfileGet(r: ProjectRef): string | undefined {
    return (
      this.db.all<{ profile: string | null }>("SELECT profile FROM leads WHERE machine_id = ? AND project_id = ?", [r.machineId, r.projectId])[0]
        ?.profile ?? undefined
    );
  }

  /** Keeps the profile the lead session `threadId` started on, once its row is in. */
  leadProfilePut(r: ProjectRef, threadId: string, profile: string): void {
    this.db.conn
      .query("UPDATE leads SET profile = ? WHERE machine_id = ? AND project_id = ? AND thread_id = ?")
      .run(profile, r.machineId, r.projectId, threadId);
  }

  /** The MCP servers the project's lead thread started with; undefined for one started before fleetd kept them. */
  leadMcpGet(r: ProjectRef, threadId: string): unknown {
    const row = this.db.all<{ data: string }>("SELECT data FROM lead_mcp WHERE machine_id = ? AND project_id = ? AND thread_id = ?", [
      r.machineId,
      r.projectId,
      threadId,
    ])[0];
    if (!row) return undefined;
    try {
      return JSON.parse(row.data);
    } catch {
      return undefined;
    }
  }

  leadMcpPut(r: ProjectRef, threadId: string, set: unknown): void {
    this.db.conn
      .query(
        `INSERT INTO lead_mcp (machine_id, project_id, thread_id, data) VALUES (?, ?, ?, ?)
         ON CONFLICT (machine_id, project_id) DO UPDATE SET thread_id = excluded.thread_id, data = excluded.data`,
      )
      .run(r.machineId, r.projectId, threadId, JSON.stringify(set));
  }

  leadsList(): StoredLead[] {
    return this.db.all<LeadRow>("SELECT * FROM leads ORDER BY machine_id, project_id").map(leadOf);
  }

  /** Creates a draft: open, with no brief. A repeated `clientRequestId` in the same project returns the first one. */
  workstreamCreate(input: NewWorkstream): { workstream: Workstream; created: boolean } {
    return this.db.transaction((c) => {
      const r = input.projectRef;
      if (input.clientRequestId !== undefined) {
        const existing = c
          .query<{ data: string }, [string, string, string]>(
            "SELECT data FROM workstreams WHERE machine_id = ? AND project_id = ? AND client_request_id = ?",
          )
          .get(r.machineId, r.projectId, input.clientRequestId);
        if (existing) return { workstream: JSON.parse(existing.data) as Workstream, created: false };
      }
      const { n } = c
        .query<{ n: number }, [string, string, string | null]>(
          "INSERT INTO workstreams (machine_id, project_id, client_request_id, state, data) VALUES (?, ?, ?, 'open', '') RETURNING n",
        )
        .get(r.machineId, r.projectId, input.clientRequestId ?? null) as { n: number };
      const workstream: Workstream = {
        workstreamId: `W${n}`,
        projectRef: r,
        title: input.title,
        source: { text: input.text, channel: input.channel, by: input.by, at: input.at },
        state: "open",
        createdAt: input.at,
        updatedAt: input.at,
      };
      c.query("UPDATE workstreams SET state = ?, data = ? WHERE n = ?").run(workstream.state, encodeWorkstream(workstream), n);
      return { workstream, created: true };
    });
  }

  workstreamGet(id: string): Workstream | undefined {
    return readWorkstream(this.db.conn, id);
  }

  workstreamPut(w: Workstream): void {
    this.db.conn.query("UPDATE workstreams SET state = ?, data = ? WHERE n = ?").run(w.state, encodeWorkstream(w), workstreamNumber(w.workstreamId));
  }

  /** Newest first. */
  workstreamsList(filter: WorkstreamFilter): Workstream[] {
    return this.db
      .all<{ data: string }>(
        `SELECT data FROM workstreams
         WHERE ($machine IS NULL OR machine_id = $machine) AND ($project IS NULL OR project_id = $project)
           AND ($state IS NULL OR state = $state)
         ORDER BY n DESC LIMIT $limit`,
        {
          machine: filter.projectRef?.machineId ?? null,
          project: filter.projectRef?.projectId ?? null,
          state: filter.state ?? null,
          limit: filter.limit,
        },
      )
      .map((row) => JSON.parse(row.data) as Workstream);
  }

  /** Which project a workstream belongs to. */
  projectOf(id: string): ProjectRef | undefined {
    return this.workstreamGet(id)?.projectRef;
  }

  /** A project's open workstreams' ids, newest first. */
  openIn(r: ProjectRef, limit: number): string[] {
    return this.workstreamsList({ projectRef: r, state: "open", limit }).map((w) => w.workstreamId);
  }
}
