// Mounted once by the shell: the keymap, the default commands, the theme switches, the project list, whichever
// overlay is up, and the New screen picker with its "New screen…" (sessions/NewScreen). The palette, the shortcuts
// sheet and the picker (it brings the Screens page's model) are chunks of their own: the first chat draws none of them
// (web-check.ts's budget). The palette and the sheet load once the chat has shown; the picker at once on the desktop,
// once the first chat has shown on the web.

import { Suspense, useEffect, useMemo } from "react";
import { Boundary } from "../../src/Boundary";
import { useHubSet } from "../../src/data/react";
import { onWeb } from "../../src/web";
import { preloadable, preloadWhenIdle, useShownYet, useTheme } from "../../ui";
import { defaultCommands, themeCommands } from "./defaults";
import { installKeymap } from "./keymap";
import { projectSource } from "./projects";
import { registerCommands, useCommands, useSource } from "./registry";
import { closeOverlay, paletteOpen, useOverlay } from "./state";

const NewScreenHost = preloadable(() => import("../sessions/NewScreen").then((m) => m.NewScreenHost));
if (onWeb()) preloadWhenIdle(NewScreenHost);
else NewScreenHost.preload().catch(() => undefined);
/** On the web, the picker mounts once the first chat has shown (or this long), so it never shares the first load. */
const PICKER_AFTER_CHAT_MAX_MS = 30_000;

const Palette = preloadable(() => import("./Palette").then((m) => m.Palette));
const ShortcutsSheet = preloadable(() => import("./ShortcutsSheet").then((m) => m.ShortcutsSheet));

export function PaletteHost() {
  const overlay = useOverlay();
  const picker = useShownYet(PICKER_AFTER_CHAT_MAX_MS) || !onWeb();
  const hubs = useHubSet();
  useSource(useMemo(() => (hubs === undefined ? null : projectSource(hubs)), [hubs]));
  const { mode, setMode } = useTheme();
  useCommands(themeCommands(mode, setMode), []);

  useEffect(() => preloadWhenIdle(Palette, ShortcutsSheet), []);
  useEffect(() => {
    const offDefaults = registerCommands(defaultCommands());
    // Another shortcut pressed over the shortcuts sheet closes it first, so the command isn't hidden behind it.
    const offKeys = installKeymap(window.fleetd.platform, paletteOpen, (id) => {
      if (id !== "palette.toggle" && id !== "shortcuts.show") closeOverlay();
    });
    return () => {
      offKeys();
      offDefaults();
    };
  }, []);

  const body =
    overlay.kind === "palette" ? <Palette key={overlay.seq} initialQuery={overlay.query} /> : overlay.kind === "shortcuts" ? <ShortcutsSheet /> : null;
  // The keymap above stays up whatever the overlay does; an overlay that throws closes, and a toast says so.
  return (
    <>
      <Boundary part="the New screen picker">
        {picker ? (
          <Suspense fallback={null}>
            <NewScreenHost />
          </Suspense>
        ) : null}
      </Boundary>
      {body === null ? null : (
        <Boundary part={overlay.kind === "palette" ? "the command palette" : "the shortcuts sheet"} overlay={{ onError: closeOverlay }}>
          <Suspense fallback={null}>{body}</Suspense>
        </Boundary>
      )}
    </>
  );
}
