import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { registerSettingsCommands } from "../screens/settings/commands";
import { applyMotion } from "../screens/settings/prefs";
import { applyTheme, storedMode, UiProvider, type ThemeMode } from "../ui";
import { App } from "./App";
import { createDataLayer } from "./data/queries";
import { DataProvider } from "./data/react";
import "./styles.css";

document.documentElement.dataset["platform"] = window.fleetd.platform;
if (window.fleetd.vibrancy) document.documentElement.dataset["vibrancy"] = "";
// Before the first render, so the first paint is already in the right theme.
applyTheme();
applyMotion();
// The window's own material (the translucent sidebar, menus, dialogs) follows the OS unless told the app's choice.
// Only an explicit choice is sent at startup: "system" is already where main starts.
const mirrorTheme = (mode: ThemeMode) => void window.fleetd.app.setTheme(mode);
if (storedMode() !== "system") mirrorTheme(storedMode());

const data = createDataLayer(window.fleetd.hub);
registerSettingsCommands(data);

const root = document.getElementById("root");
if (root === null) throw new Error("index.html has no #root");
createRoot(root).render(
  <StrictMode>
    <DataProvider layer={data}>
      <UiProvider onModeChange={mirrorTheme}>
        <App />
      </UiProvider>
    </DataProvider>
  </StrictMode>,
);
