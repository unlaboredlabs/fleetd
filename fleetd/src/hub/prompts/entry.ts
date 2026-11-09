// A registry entry and its derived parts.
import type { Enforcement, Placeholder, PromptGroup, PromptKind, SafetyRule } from "../../shared/contracts.ts";
import { ENTRIES } from "./registry.ts";

/** Which sessions pin an entry at their start; `none`: the custom instructions, appended to the others. */
export type Audience = "lead" | "task" | "any" | "none";

export type RegistryEntry = {
  id: string;
  title: string;
  kind: PromptKind;
  group: PromptGroup;
  audience: Audience;
  sentWhen: string;
  default: string;
  /** `name=description; …`, a `!` after the name marks it required. */
  placeholders: string;
  rules: { id: string; label: string; needle: string; enforced: Enforcement }[];
};

export const INSTRUCTIONS = "instructions";

/** Prompts a release renamed, old id first (D310). */
export const RENAMED: [string, string][] = [
  ["navi.start", "assistant.start"],
  ["navi.voice", "assistant.voice"],
  ["navi.checker", "approvals.checker"],
];

export const perProject = (e: RegistryEntry) => e.kind !== "oneshot";

export function placeholdersOf(e: RegistryEntry): Placeholder[] {
  return e.placeholders.split(";").flatMap((p) => {
    const at = p.trim().indexOf("=");
    if (at < 0) return [];
    const name = p.trim().slice(0, at);
    return [{ name: name.replace(/!+$/, ""), required: name.endsWith("!"), description: p.trim().slice(at + 1).trim() }];
  });
}

export const safetyRules = (e: RegistryEntry): SafetyRule[] =>
  e.rules.map((r) => ({ id: r.id, label: r.label, needle: r.needle, enforced: r.enforced }));

/** Past this many characters an edit gets a `too_long` warning. */
export const budget = (e: RegistryEntry) => [...e.default].length * 3 + 500;

/** The id `id` had before RENAMED, if it had another. */
export const oldId = (id: string) => RENAMED.find(([, now]) => now === id)?.[0];

export function getEntry(id: string): RegistryEntry | undefined {
  const now = RENAMED.find(([old]) => old === id)?.[1] ?? id;
  return ENTRIES.find((e) => e.id === now);
}

/** The entry, for ids the code names. */
export function entry(id: string): RegistryEntry {
  const e = getEntry(id);
  if (!e) throw new Error(`no prompt ${id} in the registry`);
  return e;
}

export { ENTRIES };
