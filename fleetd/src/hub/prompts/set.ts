// The texts one message is rendered from (store.ts keeps the overrides and pins them): the shipped ones, or a
// session's pinned ones, each with its ref and scope.
import type { PromptScope, SessionPromptRef } from "../../shared/contracts.ts";
import { type Audience, ENTRIES, INSTRUCTIONS, type RegistryEntry } from "./entry.ts";
import { refOf, render, type Vars } from "./render.ts";

/** One resolved text. */
export type Resolved = { ref: string; scope: PromptScope; text: string };

export const defaultOf = (e: RegistryEntry): Resolved => ({ ref: refOf(e.id, e.default), scope: "default", text: e.default });

/** The texts one message is rendered from: a session's pinned ones, or the current ones for a project. */
export class PromptSet {
  constructor(
    readonly entries: Map<string, Resolved>,
    /** Global, then project; empty ones left out. */
    readonly instructions: Resolved[],
  ) {}

  /** The shipped texts and no instructions. */
  static defaults(): PromptSet {
    return new PromptSet(new Map(ENTRIES.map((e) => [e.id, defaultOf(e)])), []);
  }

  get(id: string): Resolved {
    const r = this.entries.get(id);
    if (!r) throw new Error(`no prompt ${id} in the registry`);
    return r;
  }

  render(id: string, vars: Vars): string {
    return render(this.get(id).text, vars);
  }

  /** A first message (lead or task) with the human's custom instructions appended. */
  withInstructions(first: string): string {
    if (this.instructions.length === 0) return first;
    return `${first}\n\n## Custom instructions from the human\n${this.instructions.map((r) => r.text.trim()).join("\n\n")}`;
  }

  /** What a session of `audience` pins: every entry it may receive, and the instructions. */
  refs(audience: Audience): [SessionPromptRef, string][] {
    const picked: [string, Resolved][] = [
      ...ENTRIES.filter((e) => e.audience === audience || e.audience === "any").map((e): [string, Resolved] => [e.id, this.get(e.id)]),
      ...this.instructions.map((r): [string, Resolved] => [INSTRUCTIONS, r]),
    ];
    return picked.map(([id, r]) => [{ id, ref: r.ref, scope: r.scope }, r.text]);
  }
}

