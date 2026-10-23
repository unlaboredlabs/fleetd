// The hub shapes Settings uses, from the generated contracts (shared/contracts), under the names the screens read.
export type {
  Placeholder,
  ProjectRef,
  ProjectSummary,
  PromptGroup,
  PromptScope,
  PromptSetOutput,
  PromptSummary,
  PromptWarning,
  RetiredPromptOverride,
} from "../../../shared/contracts";
import type { PromptGetOutput } from "../../../shared/contracts";

/** `prompt_get {id}`'s prompt: every level of one prompt for the asked project (or hub-wide). */
export type PromptDetail = NonNullable<PromptGetOutput["prompt"]>;

/** The registry id of the human's own instructions; they have their own page, not a row in the prompt list. */
export const INSTRUCTIONS = "instructions";

