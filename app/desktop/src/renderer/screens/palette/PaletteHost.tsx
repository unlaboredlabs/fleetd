// Mounted once by the shell: the keymap, the default commands, the theme switches, the project list, and whichever
// overlay is up.

import { useEffect, useMemo } from "react";
import { Boundary } from "../../src/Boundary";
import { useDataLayer } from "../../src/data/react";
import { useTheme } from "../../ui";
import { defaultCommands, themeCommands } from "./defaults";
import { installKeymap } from "./keymap";
import { projectSource } from "./projects";
import { registerCommands, useCommands, useSource } from "./registry";
import { closeOverlay, paletteOpen, useOverlay } from "./state";
import { Palette } from "./Palette";
import { ShortcutsSheet } from "./ShortcutsSheet";

export function PaletteHost() {
  const overlay = useOverlay();
  const { store } = useDataLayer();
  useSource(useMemo(() => projectSource(store), [store]));
  const { mode, setMode } = useTheme();
  useCommands(themeCommands(mode, setMode), []);

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
  return body === null ? null : (
    <Boundary part={overlay.kind === "palette" ? "the command palette" : "the shortcuts sheet"} overlay={{ onError: closeOverlay }}>
      {body}
    </Boundary>
  );
}
