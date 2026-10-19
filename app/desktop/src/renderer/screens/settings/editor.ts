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
   * The default the text was written against, which a save sends as `base`: the hub keeps an override whose base
   * is not the current default stale and shows the 3-way update, so fleetd's change is never dropped silently. Null
   * when the hub has no record of it (a hand-made file).
   */
  readonly base: string | null;
}

/** The default the hub's text for `d` was written against: a stale override's own base, else today's default. */
export const fillBase = (d: PromptDetail): string | null => (d.stale ? (d.stale.base?.ref ?? null) : d.default.ref);

/**
 * What the editor holds after the hub sent `d` (see `refill`). A draft the hub's answer doesn't replace keeps the
 * base it was written against, even when fleetd's default moved meanwhile (a hub upgrade).
 */
export function synced(before: Filled | null, d: PromptDetail, scope: string, editor: string): { filled: Filled; refill: boolean } {
  return keepBase(before, { scope, id: d.id, ref: d.effective.ref, text: d.effective.text, base: fillBase(d) }, editor);
}

/**
 * The same for the Update view's merge: it is written against the new default it merges in, and a merge in
 * progress keeps that base when fleetd's default moves again, so a save of it comes back stale with the newer
 * change to merge instead of dropping it. Null when there is nothing stale to merge.
 */
export function syncedMerge(before: Filled | null, d: PromptDetail, scope: string, merged: string): { filled: Filled; refill: boolean } | null {
  if (!d.stale) return null;
  return keepBase(before, { scope, id: d.id, ref: d.stale.current.ref, text: d.stale.merged, base: d.stale.current.ref }, merged);
}

function keepBase(before: Filled | null, now: Filled, editor: string): { filled: Filled; refill: boolean } {
  const take = refill(before, now, editor);
  if (take || before === null || editor === before.text) return { filled: now, refill: take };
  return { filled: { ...now, base: before.base }, refill: false };
}

/** The level and project an Update action changes: the one that owns the stale override, whatever scope is shown. */
export function updateTarget(d: PromptDetail, s: Scope): { scope: PromptScope; projectRef?: ProjectRef } {
  return d.stale?.scope === "project" && s.kind === "project" ? { scope: "project", projectRef: s.ref } : { scope: "global" };
}

/** Where the page opens: the route, unless a kept draft for another prompt or scope would be dropped, in which case
 * it opens on the draft and asks before following the route. */
export function startOn(
  kept: { filled: Filled; text: string; mergedFilled?: Filled | null; merged?: string } | null,
  route: Pick<SettingsRoute, "prompt" | "for">,
): { scope: Scope; id: string | null; ask: { scope: Scope; id: string | null } | null } {
  const target = { scope: parseScope(route.for), id: route.prompt };
  const draft = kept !== null && (kept.text !== kept.filled.text || (kept.mergedFilled != null && kept.merged !== kept.mergedFilled.text));
  if (!kept || !draft) return { ...target, ask: null };
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
    ? `${projectName}'s own edit is gone; it uses the hub-wide text again. New sessions get it; running ones keep theirs.`
    : "Your hub-wide edit is gone; fleetd's default applies to every project without its own edit. New sessions get it; running ones keep theirs.";
}

export function savedLine(o: PromptSetOutput): string {
  const n = o.warnings.length;
  const warned = n === 0 ? "" : n === 1 ? " with 1 warning" : ` with ${n} warnings`;
  return `Saved${warned}. New sessions get it; running ones keep the text they started with.`;
}

/** What the "In effect" line says, and where a save lands. */
export function effectLines(d: PromptDetail, s: Scope, projectName: string | null): { inEffect: string; lands: string } {
  const name = projectName ?? "this project";
  const inEffect =
    d.scope === "default" ? "In effect: fleetd's default." : d.scope === "global" ? "In effect: your hub-wide edit." : `In effect: your edit for ${name}.`;
  const lands =
    editScope(d, s) === "project"
      ? `Saving changes it for ${name} only.`
      : s.kind === "project"
        ? "This prompt has one hub-wide text: saving changes it for every project."
        : "Saving changes it for every project without its own edit.";
  return { inEffect, lands };
}

export const hasConflictMarkers = (text: string): boolean => /^(<{7}|>{7})( |$)/mu.test(text);
