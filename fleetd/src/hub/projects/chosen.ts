// A launch's profile as the node gets it (profiles.ts resolves it).
import type { Effort } from "../../shared/contracts.ts";

/** What a launch on one profile sends the node. */
export type Chosen = { profile: string; model?: string; effort: Effort; fast: boolean; helperModel?: string };
