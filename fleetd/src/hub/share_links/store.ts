// The workspace's share links (`share_links`, migration 202611261901) and its switch and preview address
// (`share_link_settings`). A link is open while it is neither revoked nor past `expires_ms`; ended rows go a week after.
import type { AuditActor, MachineId, ProjectRef, ShareLink, ThreadRef } from "../../shared/contracts.ts";
import type { Hub } from "../api/hub.ts";
import type { HubDb } from "../store/db.ts";
import { isoMs } from "../store/time.ts";
import { newLinkSecret, newPreviewName, previewUrl } from "./rules.ts";

/** How long an ended link's row stays, so a late visit still reads as ended. */
export const ENDED_KEEP_MS = 7 * 24 * 3600_000;

type Row = {
  name: string;
  machine_id: string;
  port: number;
  label: string | null;
  secret: string;
  actor_kind: string;
  actor_name: string;
  person_id: string | null;
  project_id: string | null;
  thread_id: string | null;
  created_ms: number;
  expires_ms: number;
  revoked_ms: number | null;
};

/** A link as the workspace holds it: its row's fields, and its secret for the cookies. */
export type Held = {
  name: string;
  machineId: MachineId;
  port: number;
  label?: string;
  secret: string;
  createdBy: AuditActor;
  projectId?: string;
  threadId?: string;
  createdMs: number;
  expiresMs: number;
  revokedMs?: number;
};

const held = (r: Row): Held => ({
  name: r.name,
  machineId: r.machine_id,
  port: r.port,
  ...(r.label !== null ? { label: r.label } : {}),
  secret: r.secret,
  createdBy: { kind: r.actor_kind as AuditActor["kind"], name: r.actor_name, ...(r.person_id !== null ? { personId: r.person_id } : {}) },
  ...(r.project_id !== null ? { projectId: r.project_id } : {}),
  ...(r.thread_id !== null ? { threadId: r.thread_id } : {}),
  createdMs: r.created_ms,
  expiresMs: r.expires_ms,
  ...(r.revoked_ms !== null ? { revokedMs: r.revoked_ms } : {}),
});

export const isOpen = (l: Held, now: number) => l.revokedMs === undefined && l.expiresMs > now;

/** A link as the apps and agents see it, at `base` (the preview address). */
export function shown(l: Held, base: string): ShareLink {
  return {
    name: l.name,
    url: previewUrl(base, l.name),
    machineId: l.machineId,
    port: l.port,
    ...(l.label !== undefined ? { label: l.label } : {}),
    createdBy: l.createdBy,
    createdAt: isoMs(l.createdMs),
    expiresAt: isoMs(l.expiresMs),
    ...(l.projectId !== undefined ? { projectRef: { machineId: l.machineId, projectId: l.projectId } as ProjectRef } : {}),
    ...(l.threadId !== undefined ? { threadRef: { machineId: l.machineId, threadId: l.threadId } as ThreadRef } : {}),
  };
}

export type NewLink = {
  machineId: MachineId;
  port: number;
  label?: string;
  createdBy: AuditActor;
  projectId?: string;
  threadId?: string;
  expiresMs: number;
};

export class ShareLinks {
  constructor(
    private readonly db: HubDb,
    private readonly now: () => number,
  ) {}

  get(name: string): Held | undefined {
    const r = this.db.conn.query<Row, [string]>("SELECT * FROM share_links WHERE name = ?").get(name);
    return r ? held(r) : undefined;
  }

  /** Open links, newest first. */
  open(): Held[] {
    return this.db.conn
      .query<Row, [number]>("SELECT * FROM share_links WHERE revoked_ms IS NULL AND expires_ms > ? ORDER BY created_ms DESC, name")
      .all(this.now())
      .map(held);
  }

  /** The open link of `port` on `machineId`, if one is. */
  openAt(machineId: MachineId, port: number): Held | undefined {
    const r = this.db.conn
      .query<Row, [string, number, number]>(
        "SELECT * FROM share_links WHERE machine_id = ? AND port = ? AND revoked_ms IS NULL AND expires_ms > ? ORDER BY created_ms DESC LIMIT 1",
      )
      .get(machineId, port, this.now());
    return r ? held(r) : undefined;
  }

  create(l: NewLink): Held {
    const name = newPreviewName();
    this.db.conn
      .query(
        `INSERT INTO share_links (name, machine_id, port, label, secret, actor_kind, actor_name, person_id, project_id, thread_id,
           created_ms, expires_ms) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        name,
        l.machineId,
        l.port,
        l.label ?? null,
        newLinkSecret(),
        l.createdBy.kind,
        l.createdBy.name,
        l.createdBy.personId ?? null,
        l.projectId ?? null,
        l.threadId ?? null,
        this.now(),
        l.expiresMs,
      );
    return this.get(name)!;
  }

  renew(name: string, expiresMs: number, label?: string): Held | undefined {
    this.db.conn
      .query("UPDATE share_links SET expires_ms = ?, label = coalesce(?, label) WHERE name = ? AND revoked_ms IS NULL")
      .run(expiresMs, label ?? null, name);
    return this.get(name);
  }

  revoke(name: string): void {
    this.db.conn.query("UPDATE share_links SET revoked_ms = ? WHERE name = ? AND revoked_ms IS NULL").run(this.now(), name);
  }

  /** Drops rows ended more than ENDED_KEEP_MS ago; returns how many. */
  prune(): number {
    const before = this.now() - ENDED_KEEP_MS;
    return this.db.conn.query("DELETE FROM share_links WHERE coalesce(revoked_ms, expires_ms) < ?").run(before).changes;
  }

  setting(key: "enabled" | "preview_url"): string | undefined {
    return this.db.conn.query<{ value: string }, [string]>("SELECT value FROM share_link_settings WHERE key = ?").get(key)?.value;
  }

  private previewUrl: { url: string | undefined } | undefined;

  /** The preview address, read once and kept until it is set again: every request's Host is checked against it. */
  cachedPreviewUrl(): string | undefined {
    this.previewUrl ??= { url: this.setting("preview_url") };
    return this.previewUrl.url;
  }

  set(key: "enabled" | "preview_url", value: string | undefined): void {
    if (key === "preview_url") this.previewUrl = undefined;
    if (value === undefined) this.db.conn.query("DELETE FROM share_link_settings WHERE key = ?").run(key);
    else this.db.conn.query("INSERT INTO share_link_settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value").run(key, value);
  }

  /** On unless an admin turned it off. */
  enabled(): boolean {
    return this.setting("enabled") !== "0";
  }
}

export const shareLinks = (hub: Hub) => hub.area("share_links", (h) => new ShareLinks(h.db, () => h.clock.now()));
