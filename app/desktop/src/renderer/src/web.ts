// The one question the screens ask of the shell seam (preload/api.d.ts `shell`): does this page run in a browser, as
// fleetd cloud's web app, rather than in the desktop app? There the desktop-only parts (pairing a hub of your own,
// Set up this Mac, This computer as a machine, a vault value shown, GitHub's sign-in through 127.0.0.1, the app's own
// update, folder pickers, Show in folder) are left out or say they need the desktop app; the rest is the same app.
// Read when asked, never at import: a test's window.fleetd may come after, and without `shell` (or a bridge) it is the
// desktop.
export const onWeb = (): boolean => typeof window !== "undefined" && (window.fleetd as Partial<Window["fleetd"]> | undefined)?.shell === "web";

/** What a part left out on the web says, where the screen keeps a line for it. */
export const NEEDS_DESKTOP_APP = "This needs the fleetd desktop app.";
