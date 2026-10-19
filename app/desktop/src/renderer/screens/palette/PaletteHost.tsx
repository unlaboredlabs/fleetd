// Mounted once by the shell: the keymap, the default commands, and whichever overlay is up.

import { useEffect } from "react";
import { defaultCommands } from "./defaults";
import { installKeymap } from "./keymap";
import { registerCommands } from "./registry";
import { closeOverlay, paletteOpen, useOverlay } from "./state";
import { Palette } from "./Palette";
import { ShortcutsSheet } from "./ShortcutsSheet";

export function PaletteHost() {
  const overlay = useOverlay();

  useEffect(() => {
    // Default priority: this effect runs after the screens' own (React runs a parent's effects last), and a
    // built-in must still never shadow a screen's command.
    const offDefaults = registerCommands(defaultCommands(), "default");
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
