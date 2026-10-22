// Mounted once by the shell: the keymap, the default commands, the theme switches, the project list, and whichever
// overlay is up.

import { useEffect, useMemo } from "react";
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
    // The lowest priority: this effect runs after the screens' own and the screen modules' (time, settings), and a
    // built-in must never shadow either.
    const offDefaults = registerCommands(defaultCommands(), "builtin");
    // Another shortcut pressed over the shortcuts sheet closes it first, so the command isn't hidden behind it.
    const offKeys = installKeymap(window.fleetd.platform, paletteOpen, (id) => {
      if (id !== "palette.toggle" && id !== "shortcuts.show") closeOverlay();
    });
    return () => {
      offKeys();
      offDefaults();
    };
  }, []);

  if (overlay.kind === "palette") return <Palette key={overlay.seq} initialQuery={overlay.query} />;
  if (overlay.kind === "shortcuts") return <ShortcutsSheet />;
  return null;
}
