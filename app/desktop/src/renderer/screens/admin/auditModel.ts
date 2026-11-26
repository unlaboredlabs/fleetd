// Settings › Workspace › Audit log's words and filters (AuditLog.tsx): the kind groups a person picks from, the
// date ranges, how a row's time reads, and the file Export writes.
import type { AuditEvent, AuditListInput } from "../../../shared/contracts";

/** Each group of kinds, as `audit_list`'s `kind` takes it, and its name; the cloud's own after the workspace's. */
export const KIND_GROUPS: ReadonlyArray<{ value: string; label: string; cloud?: true }> = [
  { value: "person", label: "People" },
  { value: "invite", label: "Invites" },
  { value: "device", label: "Devices" },
  { value: "bot", label: "Bots" },
  { value: "vault", label: "Vault" },
  { value: "approval", label: "Approvals" },
  { value: "pr", label: "Merges" },
  { value: "workspace", label: "Workspace settings" },
  { value: "connection", label: "Connections" },
  { value: "signin", label: "Sign-ins", cloud: true },
  { value: "sso", label: "SSO", cloud: true },
  { value: "billing", label: "Billing", cloud: true },
  { value: "spend", label: "Spend limits", cloud: true },
  { value: "staff", label: "fleetd staff", cloud: true },
];

export const RANGES = [
  { value: "any", label: "Any time" },
  { value: "1", label: "Last 24 hours" },
  { value: "7", label: "Last 7 days" },
  { value: "30", label: "Last 30 days" },
  { value: "90", label: "Last 90 days" },
] as const;
export type Range = (typeof RANGES)[number]["value"];

/** `ALL` in a picker is no filter (a picker's value can't be empty). */
export const ALL = "all";
export type Filters = { person: string; bot: string; kind: string; range: Range };
export const NO_FILTERS: Filters = { person: ALL, bot: ALL, kind: ALL, range: "any" };

/** The filters as `audit_list` takes them, the range from `now`. */
export function inputOf(f: Filters, now: number): AuditListInput {
  return {
    ...(f.person !== ALL ? { personId: f.person } : {}),
    ...(f.bot !== ALL ? { projectId: f.bot } : {}),
    ...(f.kind !== ALL ? { kind: f.kind } : {}),
    ...(f.range !== "any" ? { since: new Date(now - Number(f.range) * 86_400_000).toISOString() } : {}),
  };
}

const sameDay = (a: Date, b: Date) => a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();

/** "14:05" today, "26 Nov 14:05" this year, "26 Nov 2025" before. */
export function whenText(iso: string, now: number): string {
  const at = new Date(iso);
  const today = new Date(now);
  const time = at.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
  if (sameDay(at, today)) return time;
  if (at.getFullYear() === today.getFullYear()) return `${at.toLocaleDateString("en-GB", { day: "numeric", month: "short" })} ${time}`;
  return at.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });
}

/** The row's full time, for its tooltip. */
export const fullTime = (iso: string): string =>
  new Date(iso).toLocaleString("en-GB", { weekday: "short", day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit", second: "2-digit" });

/** Who, as the row says it: an agent's and the workspace's names are quiet. */
export const actorQuiet = (e: AuditEvent): boolean => e.actor.kind !== "person";

/** The file Export writes: `fleetd-audit-<workspace>-<yyyy-mm-dd>.csv`. */
export function exportName(workspace: string, now: number): string {
  const slug = workspace.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "workspace";
  return `fleetd-audit-${slug}-${new Date(now).toISOString().slice(0, 10)}.csv`;
}
