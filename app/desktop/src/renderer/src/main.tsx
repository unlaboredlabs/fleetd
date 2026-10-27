import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { sendKept } from "../screens/checklist/removal";
import { registerSettingsCommands } from "../screens/settings/commands";
import { applyTheme, storedMode, UiProvider, type ThemeMode } from "../ui";
import { App } from "./App";
import { Boundary, reportError } from "./Boundary";
import { createDataLayer } from "./data/queries";
import { DataProvider } from "./data/react";
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

const data = createDataLayer(window.fleetd.hub);
registerSettingsCommands(data);
// Checklist removals the last run quit before sending.
sendKept(data);

const root = document.getElementById("root");
if (root === null) throw new Error("index.html has no #root");
createRoot(root).render(
  <StrictMode>
    {/* The last line of defence: a card, never a blank window. The shell has a boundary per part inside it. */}
    <Boundary part="the app" root>
      <DataProvider layer={data}>
        <UiProvider onModeChange={mirrorTheme}>
          <App />
        </UiProvider>
      </DataProvider>
    </Boundary>
  </StrictMode>,
);
