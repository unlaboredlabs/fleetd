// A task profile (#290, W146) in the app's words: its name, which the hub's profiles page sets. Kept free of React,
// like roles.ts.
import type { ProfileName } from "../../../shared/contracts";

/** A profile's one word on an agent's row. */
export const profileWord = (profile: ProfileName): string => profile;

/** A profile in a few words, on an agent's page. Its model, effort and fast mode are the hub's settings. */
export const profileLine = (profile: ProfileName): string => `Profile ${profile}`;
