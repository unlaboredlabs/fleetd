// One button that updates this app, for a screen that found it too old for its hub (Set up this Mac for agents): it
// checks if nothing was found yet, downloads, and restarts into the update, the same main-side update as the updates
// sheet's (state.ts).
import { useEffect, useState } from "react";
import type { AppUpdate } from "../../../shared/updates";
import { Button } from "../../ui";
import { useAppUpdate } from "./state";

/** What the button says and does for the app's update state, once pressed (`asked`) or not. */
export const appButton = (app: AppUpdate | undefined, asked: boolean): { readonly label: string; readonly busy: boolean } => {
  switch (app?.kind) {
    case undefined:
    case "idle":
    case "failed":
      return { label: "Update the app", busy: false };
    case "checking":
      return { label: "Checking for an update…", busy: true };
    case "current":
      // Pressed again, it checks again.
      return { label: asked ? "No newer app yet: check again" : "Update the app", busy: false };
    case "available":
      return asked || app.restart ? { label: app.percent === null ? "Downloading…" : `Downloading ${String(app.percent)}%`, busy: true } : { label: "Update the app", busy: false };
    case "ready":
      return { label: "Restart to update", busy: false };
    case "manual":
      return { label: "Download the update", busy: false };
    case "unsupported":
      return { label: "This build doesn't update itself", busy: true };
  }
};

export function UpdateAppButton() {
  const app = useAppUpdate()?.app;
  const [asked, setAsked] = useState(false);
  const found = app?.kind === "available" || app?.kind === "ready" || app?.kind === "manual";
  // Pressed before anything was found: the update installs as soon as the check finds it.
  useEffect(() => {
    if (asked && found) void window.fleetd.updates.install();
  }, [asked, found]);
  const { label, busy } = appButton(app, asked);
  return (
    <Button
      variant="primary"
      size="md"
      disabled={busy}
      onClick={() => {
        setAsked(true);
        if (!found) void window.fleetd.updates.check();
      }}
    >
      {label}
    </Button>
  );
}
