// Over-the-air updates each time the app comes back from behind (appUpdate.ts says what it does). Nothing in a build
// that takes no updates (no certificate, app.config.ts) or under `expo start`.
import * as Updates from "expo-updates";
import { AppState } from "react-native";
import { cameBack } from "./appUpdate";

export const watchUpdates = (): (() => void) => {
  if (!Updates.isEnabled) return () => undefined;
  // Only from behind, as the hub's link (App.tsx): Control Center or Face ID make the app inactive a moment.
  let was = AppState.currentState;
  let leftAt = Date.now();
  let asking = false;
  const sub = AppState.addEventListener("change", (s) => {
    if (s === "background") leftAt = Date.now();
    if (s === "active" && was === "background" && !asking) {
      asking = true;
      void cameBack(
        {
          pending: () => Updates.latestContext.isUpdatePending,
          check: Updates.checkForUpdateAsync,
          fetch: Updates.fetchUpdateAsync,
          reload: () => Updates.reloadAsync(),
        },
        Date.now() - leftAt,
      )
        // Offline or the update host down: the bundle running stays, and the next return asks again.
        .catch(() => undefined)
        .finally(() => (asking = false));
    }
    was = s;
  });
  return () => sub.remove();
};
