// The two task profiles (#290) in the app's words. Kept free of React, like roles.ts.
import type { TaskProfile } from "../../../shared/contracts";

/** A profile's one word on an agent's row. */
export const PROFILE_WORD: Record<TaskProfile, string> = { high: "high", medium: "medium" };

/** Each profile in full, as Settings → Agents shows them. */
export const PROFILE_LINE: Record<TaskProfile, string> = {
  high: "High: Opus 5.5, high effort, the default",
  medium: "Medium: Opus 5.5, medium effort, for mechanical work",
};
