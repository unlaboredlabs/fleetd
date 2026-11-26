import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { sendKept } from "../screens/checklist/removal";
import { addLaterFonts, afterShown, applySeeThrough, applyTheme, preloadMarkdown, storedMode, UiProvider, type ThemeMode } from "../ui";
import { onWeb } from "./web";
import { App } from "./App";
import { Boundary, reportError } from "./Boundary";
import { FIRST_HUB } from "../../shared/hubs";
import { createHubSet } from "./data/hubs";
import { HubsProvider } from "./data/react";
import "./styles.css";

document.documentElement.dataset["platform"] = window.fleetd.platform;
if (window.fleetd.vibrancy) document.documentElement.dataset["vibrancy"] = "";
// The person's choice of a solid sidebar over the see-through one, before the first paint. It changes nothing where the
// sidebar is solid anyway.
applySeeThrough();
if (window.fleetd.softwareCompositing) document.documentElement.dataset["compositing"] = "software";
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
// Settings' palette commands, a chunk of their own: the desktop asks for them at once, the web once the first chat has
// shown, so they never share its first load.
const settingsCommands = () => void import("../screens/settings/commands").then((m) => first !== undefined && m.registerSettingsCommands(first));
if (onWeb()) afterShown(settingsCommands);
else settingsCommands();
// Chat reactions stayed on this device and nothing read them, so they're gone: so is what an older build kept of them.
try {
  window.localStorage.removeItem("fleetd.tapbacks");
} catch {
  // Storage off: there is nothing kept to clear.
}
// Checklist removals the last run quit before sending, each to its own hub.
sendKept((hub) => hubs.getState().hubs.find((h) => h.id === hub)?.layer);

// The chat's messages are markdown. On the desktop its parser loads alongside the first render and the hub's first data
// (from disk, at once), asked for before the render so it is handled first. On the web it loads once the first chat
// has shown, which draws its messages' plain words meanwhile: on a slow link the chat comes seconds sooner.
if (onWeb()) afterShown(preloadMarkdown);
else preloadMarkdown();
// Geist's Medium and SemiBold: the desktop's as the page starts, the web's once the first chat has shown (ui/laterFonts).
if (onWeb()) afterShown(() => addLaterFonts("swap"));
else addLaterFonts("block");

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
