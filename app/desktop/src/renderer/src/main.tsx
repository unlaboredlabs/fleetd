import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { applyMotion } from "../screens/settings/prefs";
import { applyTheme, UiProvider } from "../ui";
import { App } from "./App";
import "./styles.css";

document.documentElement.dataset["platform"] = window.fleetd.platform;
// Before the first render, so the first paint is already in the right theme.
applyTheme();
applyMotion();

const root = document.getElementById("root");
if (root === null) throw new Error("index.html has no #root");
createRoot(root).render(
  <StrictMode>
    <UiProvider>
      <App />
    </UiProvider>
  </StrictMode>,
);
