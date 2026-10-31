import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { sendKept } from "../screens/checklist/removal";
import { registerSettingsCommands } from "../screens/settings/commands";
import { applyTheme, storedMode, UiProvider, type ThemeMode } from "../ui";
import { App } from "./App";
import { Boundary, reportError } from "./Boundary";
import { FIRST_HUB } from "../../shared/hubs";
import { createHubSet } from "./data/hubs";
import { HubsProvider } from "./data/react";
import "./styles.css";

document.documentElement.dataset["platform"] = window.fleetd.platform;
if (window.fleetd.vibrancy) document.documentElement.dataset["vibrancy"] = "";
// Before the first render, so the first paint is already in the right theme.
applyTheme();
// The window's own material (the translucent sidebar, menus, dialogs) follows the OS unless told the app's choice.
// Only an explicit choice is sent at startup: "system" is already where main starts.
const mirrorTheme = (mode: ThemeMode) => void window.fleetd.app.setTheme(mode);
if (storedMode() !== "system") mirrorTheme(storedMode());

// Errors outside React's render (handlers, timers, promises) don't unmount anything, but they go to the app log too.
window.addEventListener("error", (e) => reportError("Uncaught error", e.error ?? e.message));
window.addEventListener("unhandledrejection", (e) => reportError("Unhandled rejection", e.reason));

// One data layer per hub the app is paired with; main always has at least one.
// Main says which hubs as it opens the window, so the first render waits on no round trip (and the entry has no
// top-level await, which would split its modules into many chunks to load before the first paint). Should it ever say
// none, the first hub stands in until the set's own list() answers.
const initial = window.fleetd.hubs.initial;
const hubs = createHubSet(window.fleetd, initial.length > 0 ? initial : [{ id: FIRST_HUB, label: "" }]);
const first = hubs.getState().hubs[0]?.layer;
if (first !== undefined) registerSettingsCommands(first);
// Checklist removals the last run quit before sending, each to its own hub.
sendKept((hub) => hubs.getState().hubs.find((h) => h.id === hub)?.layer);

const root = document.getElementById("root");
if (root === null) throw new Error("index.html has no #root");
createRoot(root).render(
  <StrictMode>
    {/* The last line of defence: a card, never a blank window. The shell has a boundary per part inside it. */}
    <Boundary part="the app" root>
      <HubsProvider hubs={hubs}>
        <UiProvider onModeChange={mirrorTheme}>
          <App />
        </UiProvider>
      </HubsProvider>
    </Boundary>
  </StrictMode>,
);
