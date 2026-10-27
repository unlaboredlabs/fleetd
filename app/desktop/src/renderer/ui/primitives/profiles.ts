// The two task profiles (#290) in the app's words. Kept free of React, like roles.ts.
import type { TaskProfile } from "../../../shared/contracts";

/** A profile's one word on an agent's row. */
export const PROFILE_WORD: Record<TaskProfile, string> = { high: "high", medium: "medium" };

/** Each profile in a few words, on an agent's page. Its model and effort are settings (Administration's hub settings, and each project's). */
export const PROFILE_LINE: Record<TaskProfile, string> = {
  high: "High profile, the default",
  medium: "Medium profile, for mechanical work",
};
