import { app } from "electron";
import { linksIn, type Opener } from "./opener";

/**
 * Routes fleetd:// links to the opener. Call before `ready`: macOS sends a launch link as an
 * `open-url` event right after `will-finish-launching`. Returns false when another instance already runs (this
 * one handed its links over and should quit).
 */
export const listenForLinks = (opener: Opener): boolean => {
  if (!app.requestSingleInstanceLock()) return false;
  app.on("second-instance", (_event, argv) => {
    // Launching the app again while it runs brings its window forward, on the link if it came with one.
    opener.focus();
    for (const link of linksIn(argv)) opener.openLink(link);
  });
  app.on("open-url", (event, url) => {
    event.preventDefault();
    opener.openLink(url);
  });
  for (const link of linksIn(process.argv)) opener.openLink(link);
  // Claiming the scheme is linkHandlerMain.ts's job, and only at the moments it allows.
  return true;
};
