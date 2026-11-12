// Artifacts (W367, D292): the reports a lead or task publishes for the
// person with `artifact_publish`, a Markdown or HTML document under a name in its project. Each publish keeps a version
// in `artifact_versions` (the newest ARTIFACT_VERSIONS_KEPT of a name), posts a system line with the artifact as a card
// in the project's chat, and announces `artifacts.changed`. The content is stored and served as written. A lead or task
// reads one of its own project's back with `artifact_read`, cut at ARTIFACT_READ_CAP.
import type { Database } from "bun:sqlite";
import type { ArtifactFormat, ArtifactSummary, ArtifactVersion, ProjectRef } from "../../shared/contracts.ts";
import { ToolError } from "../../shared/errors.ts";
import type { Hub } from "../api/hub.ts";
import { chat } from "../chat/index.ts";
import type { LeadCall, LeadCaller } from "../leads/seams.ts";
import type { HubDb } from "../store/db.ts";
import { events } from "../store/events.ts";
import { store } from "../store/hub_store.ts";
import { isoMs, nowMs } from "../store/time.ts";

export const ARTIFACT_VERSIONS_KEPT = 50;
export const ARTIFACTS_LISTED = 500;
/** What `artifact_read` returns of one artifact's content, in UTF-16 units; a longer one is cut with a note saying so. */
export const ARTIFACT_READ_CAP = 64 * 1024;

export const formatOfPath = (path: string): ArtifactFormat => (/\.html?$/i.test(path) ? "html" : "md");

/** Whitespace runs as one space, at most `cap` characters. */
const clip = (s: string, cap: number) => [...s.split(/\s+/u).filter(Boolean).join(" ")].slice(0, cap).join("");

const COLUMNS = "version, title, format, by_name, at_ms, length(CAST(content AS BLOB)) AS bytes";

type VersionRow = { version: number; title: string; format: string; by_name: string; at_ms: number; bytes: number };

const versionOf = (row: VersionRow): ArtifactVersion => ({
  version: row.version,
  title: row.title || "Untitled",
  format: row.format === "html" ? "html" : "md",
  by: row.by_name || "someone",
  at: isoMs(row.at_ms),
  bytes: row.bytes,
});

type NewVersion = { title: string; format: ArtifactFormat; by: string; content: string; atMs: number };

/** A new version of `name`; returns its number. Only the newest ARTIFACT_VERSIONS_KEPT stay. */
function keep(c: Database, r: ProjectRef, name: string, v: NewVersion): number {
  const last = (
    c
      .query<{ v: number | null }, [string, string, string]>(
        "SELECT MAX(version) AS v FROM artifact_versions WHERE machine_id = ? AND project_id = ? AND name = ?",
      )
      .get(r.machineId, r.projectId, name) as { v: number | null }
  ).v;
  const version = (last ?? 0) + 1;
  c.query(
    `INSERT INTO artifact_versions (machine_id, project_id, name, version, title, format, by_name, content, at_ms)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(r.machineId, r.projectId, name, version, clip(v.title, 120), v.format, clip(v.by, 200), v.content, v.atMs);
  c.query("DELETE FROM artifact_versions WHERE machine_id = ? AND project_id = ? AND name = ? AND version <= ?").run(
    r.machineId,
    r.projectId,
    name,
    version - ARTIFACT_VERSIONS_KEPT,
  );
  return version;
}

/** The project's artifacts, each with its newest version, the newest published first. */
export function list(db: HubDb, r: ProjectRef): ArtifactSummary[] {
  return db
    .all<VersionRow & { name: string }>(
      `SELECT name, ${COLUMNS} FROM artifact_versions a WHERE machine_id = ?1 AND project_id = ?2
       AND version = (SELECT MAX(version) FROM artifact_versions b
                      WHERE b.machine_id = a.machine_id AND b.project_id = a.project_id AND b.name = a.name)
       ORDER BY at_ms DESC, rowid DESC LIMIT ?3`,
      [r.machineId, r.projectId, ARTIFACTS_LISTED],
    )
    .map((row) => ({ name: row.name, newest: versionOf(row) }));
}

/** The artifact's versions, newest first, without their content. */
export function versions(db: HubDb, r: ProjectRef, name: string): ArtifactVersion[] {
  return db
    .all<VersionRow>(
      `SELECT ${COLUMNS} FROM artifact_versions WHERE machine_id = ? AND project_id = ? AND name = ? ORDER BY version DESC`,
      [r.machineId, r.projectId, name],
    )
    .map(versionOf);
}

/** One version with its content: `version`, or the newest. */
export function get(db: HubDb, r: ProjectRef, name: string, version?: number): { artifact: ArtifactVersion; content: string } | undefined {
  const row = db.all<VersionRow & { content: string }>(
    `SELECT ${COLUMNS}, content FROM artifact_versions WHERE machine_id = ?1 AND project_id = ?2
     AND name = ?3 AND (?4 IS NULL OR version = ?4) ORDER BY version DESC LIMIT 1`,
    [r.machineId, r.projectId, name, version ?? null],
  )[0];
  return row ? { artifact: versionOf(row), content: row.content } : undefined;
}

/** A project's title, as everything a person reads names it (skills/calls.rs `title_of`). */
export const titleOf = (hub: Hub, r: ProjectRef) => store(hub).projectGet(r)?.title ?? r.projectId;

/** Who a version names: a task by its title, a project's lead as "Lead". */
function publisher(hub: Hub, caller: LeadCaller): string {
  if (caller.agent.kind === "task") {
    const n = Number.parseInt(caller.agent.taskId.slice(1), 10) || 0;
    const row = hub.db.all<{ title: string | null }>("SELECT json_extract(data, '$.title') AS title FROM tasks WHERE n = ?", [n])[0];
    if (row?.title) return row.title;
  }
  return "Lead";
}

/** The contracts' checks on an `artifact_publish` call. */
function checkPublish(call: LeadCall): { name: string; title: string; format?: ArtifactFormat; content?: string; path?: string } {
  const invalid = (why: string) => new ToolError("invalid", `Invalid artifact_publish call: ${why}.`);
  const { name, title, format, content, path } = call as Record<string, unknown>;
  if (typeof name !== "string" || !/^[a-z0-9]+(-[a-z0-9]+)*$/.test(name) || name.length > 64) {
    throw invalid("name is lowercase words with hyphens, like sweep-report");
  }
  if (typeof title !== "string" || title.length < 1 || title.length > 120 || /[\r\n]/.test(title)) {
    throw invalid("title is one line of 1 to 120 characters");
  }
  if (format !== undefined && format !== "md" && format !== "html") throw invalid("format is md or html");
  return {
    name,
    title,
    ...(format === undefined ? {} : { format: format as ArtifactFormat }),
    ...(typeof content === "string" ? { content } : {}),
    ...(typeof path === "string" ? { path } : {}),
  };
}

export function publish(hub: Hub, caller: LeadCaller, raw: LeadCall): Record<string, unknown> {
  const call = checkPublish(raw);
  if (call.content === undefined) {
    throw new ToolError(
      "invalid",
      "The artifact has no content: give content, or path from your own session's publish_artifact tool, which reads the file.",
      "Call publish_artifact with content, or with path to a file it can read.",
    );
  }
  const r = caller.projectRef;
  const format = call.format ?? (call.path === undefined ? "md" : formatOfPath(call.path));
  const by = publisher(hub, caller);
  const atMs = nowMs(hub.clock);
  const content = call.content;
  const version = hub.db.transaction((c) => keep(c, r, call.name, { title: call.title, format, by, content, atMs }));
  const title = call.title;
  chat(hub).add(r, {
    author: "system",
    text: version === 1 ? `${by} published ${title}` : `${by} published ${title}, version ${version}`,
    artifact: { name: call.name, version, title, format, by: clip(by, 200) },
  });
  events(hub).append({
    at: isoMs(atMs),
    type: "artifacts.changed",
    machineId: r.machineId,
    projectId: r.projectId,
    summary: `artifact ${call.name} of ${r.machineId}/${r.projectId} published, version ${version}`,
    data: { projectRef: r, name: call.name, version, by: caller.by },
  });
  const link = `[${title}](artifact:${call.name})`;
  const next =
    caller.agent.kind === "task"
      ? `Published as version ${version}: the chat shows a card and its Artifacts tab has it. Put ${link} in your result, so your lead can link to it.`
      : `Published as version ${version}: the chat shows a card and its Artifacts tab has it. Link to it in any message as ${link} (artifact:${call.name}@${version} for this version). Publish the same name again for a new version; older ones stay.`;
  return { name: call.name, version, next };
}

/** `content`, whole when it fits in `cap` UTF-16 units, else its first `cap` and a last line saying where it was cut. */
export function cut(content: string, cap: number): { content: string; truncated: boolean } {
  const units = content.length;
  if (units <= cap) return { content, truncated: false };
  let kept = 0;
  let head = "";
  for (const c of content) {
    kept += c.length;
    if (kept > cap) break;
    head += c;
  }
  return { content: `${head}\n\n[cut at ${cap / 1024} KB of ${Math.ceil(units / 1024)} KB]`, truncated: true };
}

/** `artifact_read`: one of the caller's own project's artifacts, `version` or the newest, as published. */
export function read(hub: Hub, caller: LeadCaller, raw: LeadCall): Record<string, unknown> {
  const r = caller.projectRef;
  const { name, version } = raw as unknown as { name: string; version?: number };
  const found = get(hub.db, r, name, version);
  if (!found) {
    const names = list(hub.db, r)
      .slice(0, 20)
      .map((a) => a.name);
    const fix =
      names.length === 0
        ? "This project has no artifacts yet: only its own are readable here."
        : `This project's newest artifacts: ${names.join(", ")}.`;
    throw new ToolError(
      "not_found",
      version !== undefined ? `${name} has no version ${version} in this project.` : `No artifact ${name} in this project.`,
      fix,
    );
  }
  const { content, truncated } = cut(found.content, ARTIFACT_READ_CAP);
  return {
    name,
    artifact: found.artifact,
    content,
    ...(truncated ? { truncated: true } : {}),
    versions: versions(hub.db, r, name).map((v) => v.version),
  };
}
