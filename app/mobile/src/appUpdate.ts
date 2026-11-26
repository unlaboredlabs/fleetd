// Over-the-air updates as the app takes them (D219, D800). expo-updates asks at launch (app.config.ts' checkAutomatically
// ON_LOAD) and runs what it downloads from the next start; coming back to the app is a start too. Then a new bundle
// already downloaded runs at once, before the person does anything, else the app asks for a newer one, which runs the
// next time they come back or open the app. A bundle that crashes as it starts goes back to the one before it (the
// embedded one at worst): expo-updates' own error recovery. appUpdateWatch.ts wires it to expo-updates.

export type Updater = {
  /** Whether a new bundle is downloaded and waits for a restart. */
  pending: () => boolean;
  check: () => Promise<{ isAvailable: boolean }>;
  fetch: () => Promise<{ isNew: boolean }>;
  reload: () => Promise<void>;
};

/** Coming back to the app: runs a bundle that waits, else downloads a newer one for next time. */
export async function cameBack(u: Updater): Promise<"reloaded" | "downloaded" | "none"> {
  if (u.pending()) {
    await u.reload();
    return "reloaded";
  }
  if (!(await u.check()).isAvailable) return "none";
  return (await u.fetch()).isNew ? "downloaded" : "none";
}
