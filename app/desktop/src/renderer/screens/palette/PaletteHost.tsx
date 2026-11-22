// Mounted once by the shell: the keymap, the default commands, the theme switches, the project list, whichever
// overlay is up, and the New screen picker with its "New screen…" (sessions/NewScreen). The palette and the shortcuts
// sheet are chunks of their own, loaded once the chat has shown: the first chat draws neither (web-check.ts's budget).

import { Suspense, useEffect, useMemo } from "react";
import { Boundary } from "../../src/Boundary";
import { useHubSet } from "../../src/data/react";
import { preloadable, preloadWhenIdle, useTheme } from "../../ui";
import { defaultCommands, themeCommands } from "./defaults";
import { installKeymap } from "./keymap";
import { projectSource } from "./projects";
import { registerCommands, useCommands, useSource } from "./registry";
import { closeOverlay, paletteOpen, useOverlay } from "./state";
import { NewScreenHost } from "../sessions/NewScreen";

const Palette = preloadable(() => import("./Palette").then((m) => m.Palette));
const ShortcutsSheet = preloadable(() => import("./ShortcutsSheet").then((m) => m.ShortcutsSheet));

export function PaletteHost() {
  const overlay = useOverlay();
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
        <NewScreenHost />
      </Boundary>
      {body === null ? null : (
        <Boundary part={overlay.kind === "palette" ? "the command palette" : "the shortcuts sheet"} overlay={{ onError: closeOverlay }}>
          <Suspense fallback={null}>{body}</Suspense>
        </Boundary>
      )}
    </>
  );
}
