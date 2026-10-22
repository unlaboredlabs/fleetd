import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { registerSettingsCommands } from "../screens/settings/commands";
import { applyMotion } from "../screens/settings/prefs";
import { applyTheme, UiProvider } from "../ui";
import { App } from "./App";
import { Boundary, reportError } from "./Boundary";
import { createDataLayer } from "./data/queries";
import { DataProvider } from "./data/react";
import "./styles.css";

document.documentElement.dataset["platform"] = window.fleetd.platform;
// Before the first render, so the first paint is already in the right theme.
applyTheme();
applyMotion();

// Errors outside React's render (handlers, timers, promises) don't unmount anything, but they go to the app log too.
window.addEventListener("error", (e) => reportError("Uncaught error", e.error ?? e.message));
window.addEventListener("unhandledrejection", (e) => reportError("Unhandled rejection", e.reason));

const data = createDataLayer(window.fleetd.hub);
registerSettingsCommands(data);

const root = document.getElementById("root");
if (root === null) throw new Error("index.html has no #root");
createRoot(root).render(
  <StrictMode>
    {/* The last line of defence: a card, never a blank window. The shell has a boundary per part inside it. */}
    <Boundary part="the app" root>
      <DataProvider layer={data}>
        <UiProvider>
          <App />
        </UiProvider>
      </DataProvider>
    </Boundary>
  </StrictMode>,
);
