// The Prompts editor's rules, kept pure so they are tested without a screen.
import type { PromptDetail, PromptScope, PromptSetOutput, PromptWarning, ProjectRef } from "./contracts";

/** Whose texts the page shows: hub-wide, or one project's (which falls back to hub-wide where it has no edit). */
export type Scope = { readonly kind: "hub" } | { readonly kind: "project"; readonly ref: ProjectRef };

export const HUB: Scope = { kind: "hub" };

export const scopeKey = (s: Scope): string => (s.kind === "hub" ? "hub" : `${s.ref.machineId}/${s.ref.projectId}`);

export const projectRefOf = (s: Scope): ProjectRef | undefined => (s.kind === "project" ? s.ref : undefined);

/** "devbox/storefront" (the route's form) → a scope; anything else is hub-wide. */
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
