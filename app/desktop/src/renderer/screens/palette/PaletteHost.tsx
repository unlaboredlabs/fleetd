// Mounted once by the shell: the keymap, the default commands, and whichever overlay is up.

import { useEffect } from "react";
import { defaultCommands } from "./defaults";
import { installKeymap } from "./keymap";
import { registerCommands } from "./registry";
import { closeOverlay, useOverlay } from "./state";
import { Palette } from "./Palette";
import { ShortcutsSheet } from "./ShortcutsSheet";

export function PaletteHost() {
  const overlay = useOverlay();

  useEffect(() => {
    const offDefaults = registerCommands(defaultCommands());
    // Any other shortcut closes the palette first, so ⌘N from the palette lands on the composer, not behind it.
    const offKeys = installKeymap(window.fleetd.platform, (id) => {
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
