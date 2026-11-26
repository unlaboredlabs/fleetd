// Over-the-air updates as the app takes them (D219, D800). expo-updates asks at launch (app.config.ts' checkAutomatically
// ON_LOAD) and runs what it downloads from the next start; coming back to the app asks again. A downloaded bundle runs
// as the app comes back only after a real stay away (AWAY_MS), as good as a start: Android reports the app's own photo
// picker, camera, document picker, permission prompts and sign-in page as the app going to the background, and a
// restart then would drop what they hand back (and, on iOS too, a form not yet saved). Otherwise it waits for the next
// such return or launch. A bundle that crashes as it starts goes back to the one before it (the embedded one at worst):
// expo-updates' own error recovery. appUpdateWatch.ts wires it to expo-updates.

/** How long the app must have been away before a downloaded bundle runs as it comes back. */
export const AWAY_MS = 5 * 60_000;

export type Updater = {
  /** Whether a new bundle is downloaded and waits for a restart. */
  pending: () => boolean;
  check: () => Promise<{ isAvailable: boolean }>;
  fetch: () => Promise<{ isNew: boolean }>;
  reload: () => Promise<void>;
};

/** Coming back to the app after `awayMs`: runs a bundle that waits once it was away long enough, else downloads a
 * newer one for next time. */
export async function cameBack(u: Updater, awayMs: number): Promise<"reloaded" | "waits" | "downloaded" | "none"> {
  if (u.pending()) {
    if (awayMs < AWAY_MS) return "waits";
    await u.reload();
    return "reloaded";
  }
  if (!(await u.check()).isAvailable) return "none";
  return (await u.fetch()).isNew ? "downloaded" : "none";
}
