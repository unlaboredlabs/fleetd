// The Prompts editor's rules, kept pure so they are tested without a screen.
import type { PromptDetail, PromptScope, PromptSetOutput, PromptWarning, ProjectRef } from "./contracts";
import type { SettingsRoute } from "./route";

/** Whose texts the page shows: hub-wide, or one project's (which falls back to hub-wide where it has no edit). */
export type Scope = { readonly kind: "hub" } | { readonly kind: "project"; readonly ref: ProjectRef };

export const HUB: Scope = { kind: "hub" };

export const scopeKey = (s: Scope): string => (s.kind === "hub" ? "hub" : `${s.ref.machineId}/${s.ref.projectId}`);

export const projectRefOf = (s: Scope): ProjectRef | undefined => (s.kind === "project" ? s.ref : undefined);

/** "devbox/storefront" (the route's form, and `scopeKey`'s) → a scope; anything else is hub-wide. */
export function parseScope(raw: string | null): Scope {
  const m = raw ? /^([^/]+)\/([^/]+)$/u.exec(raw) : null;
  return m?.[1] && m[2] ? { kind: "project", ref: { machineId: m[1], projectId: m[2] } } : HUB;
}

/** The level a save lands on: the project's own text, or hub-wide for prompts that only have that level. */
export const editScope = (d: PromptDetail, s: Scope): PromptScope => (s.kind === "project" && d.perProject ? "project" : "global");

export function hasOverride(d: PromptDetail, scope: PromptScope): boolean {
  if (scope === "project") return d.project !== undefined;
  if (scope === "global") return d.global !== undefined;
  return false;
}

/** What the editor was filled from: the scope, the prompt, and the text the hub had for them. */
export interface Filled {
  readonly scope: string;
  readonly id: string;
  readonly ref: string;
  readonly text: string;
  /**
   * The built-in text the editor's was written against, which a save sends as `base`: the hub keeps an edit whose base
   * is not the current built-in out of date and answers with both changes to merge, so fleetd's change is never
   * dropped silently.
   */
  readonly base: string;
}

/**
 * What the editor holds after the hub sent `d` (see `refill`): the text in effect, or for an edit whose built-in
 * changed since, both changes together, written against the new built-in. A draft the hub's answer doesn't replace
 * keeps the base it was written against, even when fleetd's built-in moved meanwhile (a hub upgrade), so a save of it
 * comes back out of date with the newer change to merge.
 */
export function synced(before: Filled | null, d: PromptDetail, scope: string, editor: string): { filled: Filled; refill: boolean } {
  const now: Filled = d.stale
    ? { scope, id: d.id, ref: d.stale.current.ref, text: d.stale.merged, base: d.stale.current.ref }
    : { scope, id: d.id, ref: d.effective.ref, text: d.effective.text, base: d.default.ref };
  const take = refill(before, now, editor);
  if (take || before === null || editor === before.text) return { filled: now, refill: take };
  return { filled: { ...now, base: before.base }, refill: false };
}

/** The level and project a save or reset of an out-of-date edit changes: the one that owns it, whatever scope is shown. */
export function updateTarget(d: PromptDetail, s: Scope): { scope: PromptScope; projectRef?: ProjectRef } {
  return d.stale?.scope === "project" && s.kind === "project" ? { scope: "project", projectRef: s.ref } : { scope: "global" };
}

/** Where the page opens: the route, unless a kept draft for another prompt or scope would be dropped, in which case
 * it opens on the draft and asks before following the route. */
export function startOn(
  kept: { filled: Filled; text: string } | null,
  route: Pick<SettingsRoute, "prompt" | "for">,
): { scope: Scope; id: string | null; ask: { scope: Scope; id: string | null } | null } {
  const target = { scope: parseScope(route.for), id: route.prompt };
  if (!kept || kept.text === kept.filled.text) return { ...target, ask: null };
  const here = { scope: parseScope(kept.filled.scope), id: kept.filled.id };
  const to = { scope: target.scope, id: target.id ?? here.id };
  const same = scopeKey(to.scope) === kept.filled.scope && to.id === here.id;
  return { ...here, ask: same ? null : to };
}

/**
 * Whether the editor takes the hub's text `now`. Always for another prompt or scope: a draft written for one scope
 * must never sit under another scope's Save. For the same prompt and scope, only when the hub's text changed and the
 * editor holds no unsaved edit of the old one.
 */
export function refill(before: Filled | null, now: Filled, editor: string): boolean {
  if (before === null || before.scope !== now.scope || before.id !== now.id) return true;
  return before.ref !== now.ref && editor === before.text;
}

/** A field and the text it was last filled from; a field you typed in keeps your text when the hub's changes. */
export interface Draft {
  readonly from: string;
  readonly text: string;
}

/**
 * What a field shows: everything once the hub has answered for this connection; before that (a reconnect, a
 * failed re-read) only text you typed and haven't saved, since an untouched one is the last connection's answer.
 */
export const shownDraft = (ready: boolean, draft: Draft | null): Draft | null =>
  ready || (draft !== null && draft.text !== draft.from) ? draft : null;

export const isDirty = (from: Filled | null, editor: string): boolean => from !== null && editor !== from.text;

/** Save is a real choice only when the text differs from what is in effect, is not empty, and nothing is out. */
export const canSave = (editor: string, effective: string, busy: boolean): boolean => !busy && editor !== effective && editor.trim() !== "";

export const token = (name: string): string => `{{${name}}}`;

/** Inserts `text` over the selection and returns the caret after it. */
export function insertAt(value: string, start: number, end: number, text: string): { value: string; caret: number } {
  const a = Math.max(0, Math.min(start, value.length));
  const b = Math.max(a, Math.min(end, value.length));
  return { value: value.slice(0, a) + text + value.slice(b), caret: a + text.length };
}

/** A warning as one line: what is wrong, and for a safety rule, who still keeps it. */
export function warningLine(w: PromptWarning): string {
  if (w.code !== "safety_rule_missing" || w.message.includes("enforces")) return w.message;
  if (w.enforced === "code") return `${w.message} fleetd still enforces this; agents will hit refusals they were not warned about.`;
  if (w.enforced === "prompt") return `${w.message} Nothing else enforces this.`;
  return w.message;
}

/** What a reset at `level` did, said plainly (resetting a project's level brings back the hub-wide text, if any). */
export function resetLine(level: PromptScope, projectName: string): string {
  return level === "project"
    ? `${projectName}'s own edit is gone; it uses the hub-wide text again. New agents get it; running ones keep theirs.`
    : "The hub-wide edit is gone; fleetd's built-in text applies to every project without its own edit. New agents get it; running ones keep theirs.";
}

export function savedLine(o: PromptSetOutput): string {
  const n = o.warnings.length;
  const warned = n === 0 ? "" : n === 1 ? " with 1 warning" : ` with ${n} warnings`;
  return `Saved${warned}. New agents get it; running ones keep the text they started with.`;
}

/** The editor's one quiet line: which text is in effect, and where a save lands. */
export function effectLine(d: PromptDetail, s: Scope, projectName: string | null): string {
  const name = projectName ?? "this project";
  const inEffect = d.scope === "default" ? "fleetd's built-in text" : d.scope === "global" ? "the hub-wide edit" : `${name}'s own edit`;
  const lands =
    editScope(d, s) === "project"
      ? `Saving changes it for ${name} only.`
      : s.kind === "project"
        ? "This prompt has one hub-wide text: saving changes it for every project."
        : "Saving changes it for every project without its own edit.";
  return `In effect: ${inEffect}. ${lands}`;
}

export const hasConflictMarkers = (text: string): boolean => /^(<{7}|>{7})( |$)/mu.test(text);
